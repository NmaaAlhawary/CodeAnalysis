import * as fs from "fs";
import * as path from "path";
import { WorkspaceIndex, FileIndex } from "./indexer";

export interface ContextBuildOptions {
  mode: "architecture" | "file-explain" | "chat" | "diagram" | "docgen";
  focusFile?: string;
  question?: string;
  tokenBudget?: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export function buildAIContext(
  index: WorkspaceIndex,
  options: ContextBuildOptions,
  rootDir: string
): string {
  const budget = options.tokenBudget ?? 24000;
  const parts: string[] = [];
  let used = 0;

  const add = (text: string): boolean => {
    const t = estimateTokens(text);
    if (used + t > budget) { return false; }
    parts.push(text);
    used += t;
    return true;
  };

  // Tier 1 — Project metadata
  const meta = buildProjectMeta(index, rootDir);
  add(meta);

  // Tier 2 — Architecture skeleton
  const skeleton = buildArchitectureSkeleton(index);
  add(skeleton);

  // Tier 3 — Scored file contents
  const scored = scoreFiles(index, options);
  for (const { file, score } of scored) {
    if (score <= 0) { continue; }
    const absPath = path.join(rootDir, file.path);
    let content = "";
    try { content = fs.readFileSync(absPath, "utf8"); } catch { continue; }
    if (!content.trim()) { continue; }

    const block = `\n=== FILE: ${file.path} (${file.lines} lines, score=${score}) ===\n${content.slice(0, 8000)}\n`;
    if (!add(block)) { break; }
  }

  // Tier 4 — Module graph summary
  const graphSummary = buildGraphSummary(index, options);
  add(graphSummary);

  return parts.join("\n");
}

function buildProjectMeta(index: WorkspaceIndex, rootDir: string): string {
  const lines: string[] = [
    `PROJECT CONTEXT`,
    `Root: ${rootDir}`,
    `Type: ${index.projectType}`,
    `Frameworks: ${index.frameworkHints.join(", ") || "none detected"}`,
    `Files: ${index.totalFiles} code files`,
    `Entry points: ${index.entryPoints.slice(0, 5).join(", ") || "none"}`,
    "",
  ];

  try {
    const pkg = fs.readFileSync(path.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(pkg);
    const brief = JSON.stringify({
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      scripts: parsed.scripts,
      dependencies: parsed.dependencies,
    }, null, 2).slice(0, 1500);
    lines.push(`package.json:\n${brief}\n`);
  } catch { /* not a node project */ }

  try {
    const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf8").slice(0, 1500);
    if (readme.trim()) { lines.push(`README.md (excerpt):\n${readme}\n`); }
  } catch { /* no readme */ }

  return lines.join("\n");
}

function buildArchitectureSkeleton(index: WorkspaceIndex): string {
  const lines = ["CODEBASE ARCHITECTURE SKELETON:"];
  for (const file of index.files) {
    if (file.symbols.length === 0) { continue; }
    const symbolList = file.symbols
      .filter((s) => s.isExported || s.kind === "class" || s.kind === "function")
      .slice(0, 15)
      .map((s) => `${s.kind === "function" ? "fn" : s.kind === "class" ? "cls" : s.kind} ${s.name}${s.isExported ? "*" : ""}`)
      .join(", ");
    if (symbolList) { lines.push(`  ${file.path}: [${symbolList}]`); }
  }
  return lines.join("\n");
}

function buildGraphSummary(index: WorkspaceIndex, options: ContextBuildOptions): string {
  const lines = ["\nMODULE GRAPH (imports):"];
  const focusFiles = options.focusFile ? getNeighborFiles(index, options.focusFile) : null;

  for (const [file, imports] of Object.entries(index.moduleGraph)) {
    if (imports.length === 0) { continue; }
    if (focusFiles && !focusFiles.has(file)) { continue; }
    lines.push(`  ${file} → [${imports.join(", ")}]`);
  }
  return lines.join("\n");
}

function getNeighborFiles(index: WorkspaceIndex, focusFile: string): Set<string> {
  const result = new Set<string>([focusFile]);
  const outgoing = index.moduleGraph[focusFile] || [];
  for (const dep of outgoing) { result.add(dep); }
  for (const [file, imports] of Object.entries(index.moduleGraph)) {
    if (imports.includes(focusFile)) { result.add(file); }
  }
  return result;
}

interface ScoredFile {
  file: FileIndex;
  score: number;
}

function scoreFiles(index: WorkspaceIndex, options: ContextBuildOptions): ScoredFile[] {
  const scores = new Map<string, number>();

  for (const file of index.files) {
    scores.set(file.path, 10); // base score
  }

  if (options.mode === "file-explain" && options.focusFile) {
    const rel = normalizeRelPath(options.focusFile, index.rootDir);
    scores.set(rel, 100);

    const outgoing = index.moduleGraph[rel] || [];
    for (const dep of outgoing) {
      scores.set(dep, Math.max(scores.get(dep) ?? 0, 80));
    }

    for (const [file, imports] of Object.entries(index.moduleGraph)) {
      if (imports.includes(rel)) {
        scores.set(file, Math.max(scores.get(file) ?? 0, 60));
      }
    }

  } else if (options.mode === "diagram" || options.mode === "architecture") {
    for (const file of index.files) {
      const outDegree = (index.moduleGraph[file.path] || []).length;
      let inDegree = 0;
      for (const imports of Object.values(index.moduleGraph)) {
        if (imports.includes(file.path)) { inDegree++; }
      }
      const connectivity = outDegree + inDegree;
      scores.set(file.path, Math.max(scores.get(file.path) ?? 0, 10 + connectivity * 5));
    }

  } else if (options.mode === "chat" && options.question) {
    const keywords = options.question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    for (const file of index.files) {
      const haystack = (file.path + " " + file.symbols.map((s) => s.name).join(" ")).toLowerCase();
      let matchScore = 0;
      for (const kw of keywords) {
        if (haystack.includes(kw)) { matchScore += 15; }
      }
      if (matchScore > 0) {
        scores.set(file.path, Math.max(scores.get(file.path) ?? 0, matchScore));
      }
    }
  }

  return index.files
    .map((file) => ({ file, score: scores.get(file.path) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

function normalizeRelPath(filePath: string, rootDir: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(rootDir, filePath);
  }
  return filePath;
}
