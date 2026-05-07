import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { walkDirFromRoot, flattenTree, IGNORE_DIRS, CODE_EXTS } from "./analyzer";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "method";
  line: number;
  isExported: boolean;
  jsdocExists: boolean;
}

export interface FileIndex {
  path: string;
  ext: string;
  lines: number;
  symbols: SymbolInfo[];
  imports: string[];
  lastModified: number;
  contentHash: string;
}

export interface WorkspaceIndex {
  rootDir: string;
  indexedAt: number;
  totalFiles: number;
  files: FileIndex[];
  moduleGraph: Record<string, string[]>;
  entryPoints: string[];
  projectType: "node" | "python" | "java" | "mixed" | "unknown";
  frameworkHints: string[];
}

const INDEX_KEY = "codeAnalyzer.index.v1";
const STALE_MS = 5 * 60 * 1000;

export function isIndexStale(stored: WorkspaceIndex): boolean {
  if (Date.now() - stored.indexedAt > STALE_MS) { return true; }
  try {
    const mtime = fs.statSync(stored.rootDir).mtimeMs;
    return mtime > stored.indexedAt;
  } catch {
    return true;
  }
}

export async function buildIndex(
  rootDir: string,
  context: vscode.ExtensionContext,
  forceRefresh = false
): Promise<WorkspaceIndex> {
  if (!forceRefresh) {
    const cached = context.workspaceState.get<WorkspaceIndex>(INDEX_KEY);
    if (cached && cached.rootDir === rootDir && !isIndexStale(cached)) {
      return cached;
    }
  }

  const tree = walkDirFromRoot(rootDir);
  const flat = flattenTree(tree);
  const codeFiles = flat.filter((n) => n.type === "file" && CODE_EXTS.has(n.ext || ""));

  const files: FileIndex[] = [];
  const moduleGraph: Record<string, string[]> = {};

  for (const f of codeFiles) {
    const absPath = path.join(rootDir, f.path);
    let content = "";
    try { content = fs.readFileSync(absPath, "utf8"); } catch { continue; }

    const contentHash = crypto.createHash("sha256").update(content.slice(0, 8192)).digest("hex").slice(0, 16);
    let lastModified = 0;
    try { lastModified = fs.statSync(absPath).mtimeMs; } catch { /* ignore */ }

    const symbols = extractSymbols(content, f.ext || "");
    const imports = extractRelativeImports(content, f.ext || "", absPath, rootDir, flat.map((n) => n.path));

    files.push({
      path: f.path,
      ext: f.ext || "",
      lines: f.lines || 0,
      symbols,
      imports,
      lastModified,
      contentHash,
    });

    moduleGraph[f.path] = imports;
  }

  const entryPoints = computeEntryPoints(files, moduleGraph);
  const projectType = detectProjectType(rootDir);
  const frameworkHints = detectFrameworks(rootDir);

  const index: WorkspaceIndex = {
    rootDir,
    indexedAt: Date.now(),
    totalFiles: files.length,
    files,
    moduleGraph,
    entryPoints,
    projectType,
    frameworkHints,
  };

  await context.workspaceState.update(INDEX_KEY, index);
  return index;
}

export async function updateFileInIndex(
  savedPath: string,
  rootDir: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const index = context.workspaceState.get<WorkspaceIndex>(INDEX_KEY);
  if (!index || index.rootDir !== rootDir) { return; }

  const relPath = path.relative(rootDir, savedPath);
  const ext = path.extname(savedPath).toLowerCase();
  if (!CODE_EXTS.has(ext)) { return; }

  let content = "";
  try { content = fs.readFileSync(savedPath, "utf8"); } catch { return; }

  const contentHash = crypto.createHash("sha256").update(content.slice(0, 8192)).digest("hex").slice(0, 16);
  const existing = index.files.find((f) => f.path === relPath);
  if (existing && existing.contentHash === contentHash) { return; }

  const allPaths = index.files.map((f) => f.path);
  const symbols = extractSymbols(content, ext);
  const imports = extractRelativeImports(content, ext, savedPath, rootDir, allPaths);
  const lines = content.split("\n").length;

  const updated: FileIndex = {
    path: relPath, ext, lines, symbols, imports,
    lastModified: Date.now(),
    contentHash,
  };

  const idx = index.files.findIndex((f) => f.path === relPath);
  if (idx >= 0) { index.files[idx] = updated; } else { index.files.push(updated); }

  index.moduleGraph[relPath] = imports;
  index.indexedAt = Date.now();

  await context.workspaceState.update(INDEX_KEY, index);
}

export function getCachedIndex(context: vscode.ExtensionContext): WorkspaceIndex | undefined {
  return context.workspaceState.get<WorkspaceIndex>(INDEX_KEY);
}

export function extractSymbols(content: string, ext: string): SymbolInfo[] {
  const lines = content.split("\n");
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  const add = (name: string, kind: SymbolInfo["kind"], lineNum: number, isExported: boolean) => {
    if (!name || seen.has(`${name}:${lineNum}`)) { return; }
    seen.add(`${name}:${lineNum}`);
    const jsdocExists = hasDocComment(lines, lineNum);
    symbols.push({ name, kind, line: lineNum + 1, isExported, jsdocExists });
  };

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    extractTsJsSymbols(lines, add);
  } else if (ext === ".py") {
    extractPythonSymbols(lines, add);
  } else if (ext === ".java" || ext === ".kt") {
    extractJavaSymbols(lines, add);
  } else if (ext === ".go") {
    extractGoSymbols(lines, add);
  }

  return symbols;
}

function extractTsJsSymbols(
  lines: string[],
  add: (name: string, kind: SymbolInfo["kind"], line: number, exported: boolean) => void
): void {
  const exportedFn   = /^export\s+(?:async\s+)?function\s+(\w+)/;
  const plainFn      = /^(?:async\s+)?function\s+(\w+)/;
  const exportConst  = /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/;
  const exportClass  = /^export\s+(?:abstract\s+)?class\s+(\w+)/;
  const plainClass   = /^class\s+(\w+)/;
  const exportIface  = /^export\s+interface\s+(\w+)/;
  const exportType   = /^export\s+type\s+(\w+)\s*=/;
  const exportDefault = /^export\s+default\s+(?:async\s+)?(?:function\s+)?(\w+)/;
  const methodRe     = /^\s{2,}(?:public|private|protected|static|async|override|\s)*(?:async\s+)?(\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    if ((m = line.match(exportedFn)))  { add(m[1], "function",  i, true);  continue; }
    if ((m = line.match(exportConst))) { add(m[1], "const",     i, true);  continue; }
    if ((m = line.match(exportClass))) { add(m[1], "class",     i, true);  continue; }
    if ((m = line.match(exportIface))) { add(m[1], "interface", i, true);  continue; }
    if ((m = line.match(exportType)))  { add(m[1], "type",      i, true);  continue; }
    if ((m = line.match(exportDefault)) && m[1] && m[1] !== "function" && m[1] !== "class") {
      add(m[1], "function", i, true);  continue;
    }
    if ((m = line.match(plainFn)))    { add(m[1], "function", i, false); continue; }
    if ((m = line.match(plainClass))) { add(m[1], "class",    i, false); continue; }
    if ((m = line.match(methodRe))) {
      const name = m[1];
      if (!["if", "for", "while", "switch", "catch", "return", "const", "let", "var", "new"].includes(name)) {
        add(name, "method", i, false);
      }
    }
  }
}

function extractPythonSymbols(
  lines: string[],
  add: (name: string, kind: SymbolInfo["kind"], line: number, exported: boolean) => void
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:async\s+)?def\s+(\w+)/)))   { add(m[1], "function", i, !m[1].startsWith("_")); }
    if ((m = line.match(/^class\s+(\w+)/)))               { add(m[1], "class",    i, !m[1].startsWith("_")); }
    if ((m = line.match(/^\s{4}(?:async\s+)?def\s+(\w+)/))){ add(m[1], "method",  i, !m[1].startsWith("_")); }
  }
}

function extractJavaSymbols(
  lines: string[],
  add: (name: string, kind: SymbolInfo["kind"], line: number, exported: boolean) => void
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/(?:public|protected)?\s*(?:abstract|final)?\s*(?:class|interface|enum)\s+(\w+)/))) {
      add(m[1], "class", i, line.includes("public"));
    }
    if ((m = line.match(/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/))) {
      if (!["if", "for", "while", "switch", "catch"].includes(m[1])) {
        add(m[1], "method", i, line.includes("public"));
      }
    }
  }
}

function extractGoSymbols(
  lines: string[],
  add: (name: string, kind: SymbolInfo["kind"], line: number, exported: boolean) => void
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/))) {
      add(m[1], "function", i, /^[A-Z]/.test(m[1]));
    }
    if ((m = line.match(/^type\s+(\w+)\s+struct/)))    { add(m[1], "class",     i, /^[A-Z]/.test(m[1])); }
    if ((m = line.match(/^type\s+(\w+)\s+interface/))) { add(m[1], "interface", i, /^[A-Z]/.test(m[1])); }
  }
}

function hasDocComment(lines: string[], lineIndex: number): boolean {
  for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 4); i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith('"""') || trimmed.startsWith("#")) {
      return true;
    }
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("@")) { break; }
  }
  return false;
}

function extractRelativeImports(
  content: string,
  ext: string,
  absFilePath: string,
  rootDir: string,
  knownPaths: string[]
): string[] {
  const dir = path.dirname(absFilePath);
  const imports: string[] = [];

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const esRe  = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    const raw: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = esRe.exec(content))  !== null) { raw.push(m[1]); }
    while ((m = reqRe.exec(content)) !== null) { raw.push(m[1]); }

    for (const imp of raw) {
      if (!imp.startsWith(".") && !imp.startsWith("/")) { continue; }
      const resolved = path.resolve(dir, imp);
      for (const ext2 of [".ts", ".tsx", ".js", ".jsx", ""]) {
        const rel = path.relative(rootDir, resolved + ext2);
        if (knownPaths.includes(rel)) { imports.push(rel); break; }
      }
      for (const ext2 of [".ts", ".tsx", ".js", ".jsx"]) {
        const rel = path.relative(rootDir, path.join(resolved, "index" + ext2));
        if (knownPaths.includes(rel)) { imports.push(rel); break; }
      }
    }
  } else if (ext === ".py") {
    const relRe = /from\s+(\.+[\w.]*)\s+import/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(content)) !== null) {
      const dots = m[1].match(/^\.+/)?.[0] || ".";
      const modPart = m[1].slice(dots.length).replace(/\./g, path.sep);
      let base = dir;
      for (let i = 1; i < dots.length; i++) { base = path.dirname(base); }
      const candidate = path.relative(rootDir, path.join(base, modPart + ".py"));
      if (knownPaths.includes(candidate)) { imports.push(candidate); }
    }
  }

  return [...new Set(imports)];
}

function computeEntryPoints(files: FileIndex[], moduleGraph: Record<string, string[]>): string[] {
  const imported = new Set<string>();
  for (const deps of Object.values(moduleGraph)) {
    for (const dep of deps) { imported.add(dep); }
  }
  return files
    .filter((f) => !imported.has(f.path) && f.symbols.some((s) => s.isExported || s.kind === "function"))
    .map((f) => f.path)
    .slice(0, 10);
}

function detectProjectType(rootDir: string): WorkspaceIndex["projectType"] {
  const hasNode   = fs.existsSync(path.join(rootDir, "package.json"));
  const hasPython = fs.existsSync(path.join(rootDir, "requirements.txt")) || fs.existsSync(path.join(rootDir, "setup.py")) || fs.existsSync(path.join(rootDir, "pyproject.toml"));
  const hasJava   = fs.existsSync(path.join(rootDir, "pom.xml")) || fs.existsSync(path.join(rootDir, "build.gradle"));

  const types = [hasNode, hasPython, hasJava].filter(Boolean).length;
  if (types > 1) { return "mixed"; }
  if (hasNode)   { return "node"; }
  if (hasPython) { return "python"; }
  if (hasJava)   { return "java"; }
  return "unknown";
}

function detectFrameworks(rootDir: string): string[] {
  const hints: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const checks: [string, string][] = [
      ["react", "react"], ["next", "next"], ["vue", "vue"], ["svelte", "svelte"],
      ["angular", "@angular/core"], ["express", "express"], ["fastify", "fastify"],
      ["nestjs", "@nestjs/core"], ["electron", "electron"], ["vscode", "@types/vscode"],
      ["tailwind", "tailwindcss"], ["prisma", "prisma"], ["typeorm", "typeorm"],
    ];
    for (const [hint, pkg2] of checks) {
      if (deps[pkg2]) { hints.push(hint); }
    }
  } catch { /* not a node project */ }

  if (fs.existsSync(path.join(rootDir, "requirements.txt"))) {
    try {
      const req = fs.readFileSync(path.join(rootDir, "requirements.txt"), "utf8");
      if (req.includes("django"))  { hints.push("django"); }
      if (req.includes("fastapi")) { hints.push("fastapi"); }
      if (req.includes("flask"))   { hints.push("flask"); }
    } catch { /* ignore */ }
  }

  return hints;
}
