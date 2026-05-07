import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Constants ─────────────────────────────────────────────────────────────────
export const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".idea", "dist", "build", "out", "__pycache__",
  ".cache", ".next", "coverage", ".svelte-kit", ".turbo", ".parcel-cache",
]);

export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".cpp", ".c", ".h",
  ".java", ".go", ".rs", ".rb", ".cs", ".swift", ".kt", ".vue", ".svelte",
]);

const TEXT_EXTS = new Set([
  ...CODE_EXTS,
  ".json", ".yaml", ".yml", ".md", ".txt", ".html", ".css", ".scss",
  ".xml", ".sh", ".bash", ".zsh", ".env",
]);

// ── Types ─────────────────────────────────────────────────────────────────────
export interface FileNode {
  type: "file" | "dir";
  name: string;
  path: string;
  depth: number;
  ext?: string;
  lines?: number;
  children?: FileNode[];
}

export interface FileStats {
  ext: string;
  count: number;
  lines: number;
}

export interface Hotspot {
  file: string;
  edits: number;
}

export interface DepNode {
  id: number;
  name: string;
  path: string;
  lines: number;
  ext: string;
}

export interface DepLink {
  source: number;
  target: number;
}

export interface DepGraph {
  nodes: DepNode[];
  links: DepLink[];
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface AnalysisResult {
  tree: FileNode[];
  flat: FileNode[];
  fileStats: FileStats[];
  hotspots: Hotspot[];
  gitLog: GitCommit[];
  depGraph: DepGraph;
  totalFiles: number;
  totalDirs: number;
  totalLines: number;
  codeFileCount: number;
  rootDir: string;
}

// ── File walking ──────────────────────────────────────────────────────────────
export function walkDirFromRoot(rootDir: string, depth = 0): FileNode[] {
  const results: FileNode[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      results.push({
        type: "dir",
        name: entry.name,
        path: relPath,
        depth,
        children: walkDirFromRoot(fullPath, depth + 1),
      });
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      let lines = 0;
      if (TEXT_EXTS.has(ext)) {
        try { lines = fs.readFileSync(fullPath, "utf8").split("\n").length; } catch { /* ignore */ }
      }
      results.push({ type: "file", name: entry.name, path: relPath, depth, ext, lines });
    }
  }
  return results;
}

export function flattenTree(nodes: FileNode[], acc: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    acc.push(n);
    if (n.children) { flattenTree(n.children, acc); }
  }
  return acc;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getFileStats(flat: FileNode[]): FileStats[] {
  const byExt: Record<string, { count: number; lines: number }> = {};
  for (const f of flat.filter((n) => n.type === "file")) {
    const ext = f.ext || "(none)";
    if (!byExt[ext]) { byExt[ext] = { count: 0, lines: 0 }; }
    byExt[ext].count++;
    byExt[ext].lines += f.lines || 0;
  }
  return Object.entries(byExt)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ext, data]) => ({ ext, ...data }));
}

// ── Git helpers ───────────────────────────────────────────────────────────────
export function getGitHotspots(rootDir: string, limit = 20): Hotspot[] {
  try {
    const out = execSync(
      `git -C "${rootDir}" log --name-only --pretty=format: --diff-filter=M`,
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    const counts: Record<string, number> = {};
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) { counts[f] = (counts[f] || 0) + 1; }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([file, edits]) => ({ file, edits }));
  } catch {
    return [];
  }
}

export function getGitLog(rootDir: string, limit = 30): GitCommit[] {
  try {
    const out = execSync(
      `git -C "${rootDir}" log --pretty=format:"%h|%an|%ad|%s" --date=short -n ${limit}`,
      { encoding: "utf8" }
    );
    return out.trim().split("\n").filter(Boolean).map((line) => {
      const [hash, author, date, ...msgParts] = line.split("|");
      return { hash: hash || "", author: author || "", date: date || "", message: msgParts.join("|") };
    });
  } catch {
    return [];
  }
}

// ── Dependency graph ──────────────────────────────────────────────────────────
function extractImports(filePath: string): string[] {
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const imports: string[] = [];
    const esRe = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    let m: RegExpExecArray | null;
    while ((m = esRe.exec(src)) !== null) { imports.push(m[1]); }
    while ((m = reqRe.exec(src)) !== null) { imports.push(m[1]); }
    return imports.filter((i) => i.startsWith(".") || i.startsWith("/"));
  } catch {
    return [];
  }
}

export function buildDependencyGraph(rootDir: string, flat: FileNode[]): DepGraph {
  const nodeMap = new Map<string, number>();
  const codeFiles = flat.filter((n) => n.type === "file" && CODE_EXTS.has(n.ext || ""));
  codeFiles.forEach((f, i) => nodeMap.set(f.path, i));

  const links: DepLink[] = [];
  for (const f of codeFiles) {
    const absPath = path.join(rootDir, f.path);
    const dir = path.dirname(absPath);
    for (const imp of extractImports(absPath)) {
      const resolved = path.resolve(dir, imp);
      let target: string | undefined;
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
        const rel = path.relative(rootDir, resolved + ext);
        if (nodeMap.has(rel)) { target = rel; break; }
      }
      if (!target) {
        for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
          const rel = path.relative(rootDir, path.join(resolved, "index" + ext));
          if (nodeMap.has(rel)) { target = rel; break; }
        }
      }
      if (target && target !== f.path) {
        links.push({ source: nodeMap.get(f.path)!, target: nodeMap.get(target)! });
      }
    }
  }

  return {
    nodes: codeFiles.map((f, i) => ({
      id: i, name: f.name, path: f.path,
      lines: f.lines || 0, ext: f.ext || "",
    })),
    links,
  };
}

// ── Full analysis ─────────────────────────────────────────────────────────────
export function analyzeWorkspace(rootDir: string): AnalysisResult {
  const tree = walkDirFromRoot(rootDir);
  const flat = flattenTree(tree);
  return {
    tree,
    flat,
    fileStats: getFileStats(flat),
    hotspots: getGitHotspots(rootDir),
    gitLog: getGitLog(rootDir),
    depGraph: buildDependencyGraph(rootDir, flat),
    totalFiles: flat.filter((n) => n.type === "file").length,
    totalDirs: flat.filter((n) => n.type === "dir").length,
    totalLines: flat.reduce((s, n) => s + (n.lines || 0), 0),
    codeFileCount: flat.filter((n) => n.type === "file" && CODE_EXTS.has(n.ext || "")).length,
    rootDir,
  };
}

// ── Static code analysis (no AI) ─────────────────────────────────────────────
export interface StaticCodeInfo {
  language: string;
  lines: number;
  functions: string[];
  classes: string[];
  imports: string[];
  exports: string[];
  todos: string[];
  complexity: number;
}

export function staticAnalyzeCode(code: string, languageId: string): StaticCodeInfo {
  const lines = code.split("\n");
  const functions: string[] = [];
  const classes: string[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const todos: string[] = [];

  // Pattern sets for common languages
  const patterns: Record<string, { fn: RegExp; cls: RegExp }> = {
    typescript:  { fn: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{])/g, cls: /class\s+(\w+)/g },
    javascript:  { fn: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{])/g, cls: /class\s+(\w+)/g },
    python:      { fn: /def\s+(\w+)/g, cls: /class\s+(\w+)/g },
    java:        { fn: /(?:public|private|protected|static).*\s+(\w+)\s*\(/g, cls: /(?:class|interface|enum)\s+(\w+)/g },
    cpp:         { fn: /\b(\w+)\s*\([^;]*\)\s*\{/g, cls: /(?:class|struct)\s+(\w+)/g },
  };

  const lang = languageId.replace("typescriptreact", "typescript").replace("javascriptreact", "javascript");
  const p = patterns[lang] || patterns.javascript;

  let m: RegExpExecArray | null;
  const fnRe = new RegExp(p.fn.source, "g");
  while ((m = fnRe.exec(code)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && name.length > 1 && !["if", "for", "while", "switch", "catch"].includes(name)) {
      functions.push(name);
    }
  }

  const clsRe = new RegExp(p.cls.source, "g");
  while ((m = clsRe.exec(code)) !== null) {
    if (m[1]) { classes.push(m[1]); }
  }

  // Imports
  const impRe = /(?:import|require)\s*(?:\(['"](.*?)['"]\)|.*?from\s+['"](.*?)['"])/g;
  while ((m = impRe.exec(code)) !== null) {
    const imp = m[1] || m[2];
    if (imp) { imports.push(imp); }
  }

  // Exports
  const expRe = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)?\s*(\w+)/g;
  while ((m = expRe.exec(code)) !== null) {
    if (m[1]) { exports.push(m[1]); }
  }

  // TODOs / FIXMEs
  for (const line of lines) {
    const t = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)[:\s]*(.*)/i);
    if (t) { todos.push(`${t[1]}: ${t[2].trim()}`); }
  }

  // Cyclomatic complexity approximation
  const branches = (code.match(/\b(?:if|else|for|while|case|catch|&&|\|\||\?)\b/g) || []).length;
  const complexity = 1 + branches;

  return {
    language: languageId,
    lines: lines.length,
    functions: [...new Set(functions)].slice(0, 30),
    classes: [...new Set(classes)],
    imports: [...new Set(imports)].slice(0, 20),
    exports: [...new Set(exports)].slice(0, 20),
    todos,
    complexity,
  };
}
