import * as vscode from "vscode";
import * as path from "path";
import { WorkspaceIndex, FileIndex, extractSymbols } from "./indexer";
import { DashboardPanel } from "./dashboardPanel";

interface GithubTreeItem {
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha: string;
}

const CODE_EXTS = new Set([".ts",".tsx",".js",".jsx",".py",".java",".go",".rs",".rb",".cs",".swift",".kt",".vue",".svelte",".cpp",".c",".h"]);
const CACHE_TTL = 24 * 60 * 60 * 1000;

export function parseGithubUrl(url: string): { owner: string; repo: string; branch: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?(?:\/.*)?$/);
  if (!m) { return null; }
  return { owner: m[1], repo: m[2], branch: m[3] || "HEAD" };
}

async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get("codeAnalyzer.githubToken");
}

async function githubFetch(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { "Accept": "application/vnd.github.v3+json" };
  if (token) { headers["Authorization"] = `Bearer ${token}`; }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  branch: string,
  token?: string
): Promise<GithubTreeItem[]> {
  const repoData = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
  const defaultBranch = branch === "HEAD" ? repoData.default_branch : branch;
  const treeData = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token
  );
  return (treeData.tree || []) as GithubTreeItem[];
}

async function fetchFileContent(
  owner: string,
  repo: string,
  filePath: string,
  token?: string
): Promise<string> {
  const data = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
    token
  );
  if (data.encoding === "base64" && data.content) {
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return "";
}

function computeEntryPoints(moduleGraph: Record<string, string[]>, files: FileIndex[]): string[] {
  const imported = new Set<string>();
  for (const deps of Object.values(moduleGraph)) {
    for (const dep of deps) { imported.add(dep); }
  }
  return files
    .filter((f) => !imported.has(f.path) && f.symbols.some((s) => s.isExported || s.kind === "function"))
    .map((f) => f.path)
    .slice(0, 10);
}

export async function analyzeGithubRepo(
  url: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const parsed = parseGithubUrl(url);
  if (!parsed) {
    vscode.window.showErrorMessage("Invalid GitHub URL. Format: https://github.com/owner/repo");
    return;
  }

  const { owner, repo, branch } = parsed;
  const cacheKey = `codeAnalyzer.remote.${owner}.${repo}`;

  // Check cache
  const cached = context.globalState.get<{ index: WorkspaceIndex; cachedAt: number }>(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    vscode.window.showInformationMessage(`Loaded cached analysis of ${owner}/${repo}`);
    DashboardPanel.createOrShow(context, cached.index);
    return;
  }

  const token = await getToken(context);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Analyzing GitHub: ${owner}/${repo}`,
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      progress.report({ message: "Fetching file tree…", increment: 10 });

      let tree: GithubTreeItem[];
      try {
        tree = await fetchRepoTree(owner, repo, branch, token);
      } catch (err: any) {
        vscode.window.showErrorMessage(`GitHub fetch failed: ${err.message}`);
        return;
      }

      if (cancellationToken.isCancellationRequested) { return; }

      const codeFiles = tree.filter(
        (item) => item.type === "blob" && CODE_EXTS.has(path.extname(item.path).toLowerCase())
      ).slice(0, 300);

      progress.report({ message: `Fetching ${codeFiles.length} source files…`, increment: 20 });

      const files: FileIndex[] = [];
      const moduleGraph: Record<string, string[]> = {};
      const allPaths = codeFiles.map((f) => f.path);

      // Prioritize entry-point-like files first
      const prioritized = [
        ...codeFiles.filter((f) => /index\.|main\.|app\.|server\.|extension\./.test(path.basename(f.path))),
        ...codeFiles.filter((f) => !/index\.|main\.|app\.|server\.|extension\./.test(path.basename(f.path))),
      ].filter((v, i, a) => a.indexOf(v) === i);

      let fetched = 0;
      const batchSize = 5;

      for (let i = 0; i < Math.min(prioritized.length, 150); i += batchSize) {
        if (cancellationToken.isCancellationRequested) { return; }

        const batch = prioritized.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map((item) => fetchFileContent(owner, repo, item.path, token))
        );

        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          const ext = path.extname(item.path).toLowerCase();
          const result = results[j];
          const content = result.status === "fulfilled" ? result.value : "";
          const lines = content ? content.split("\n").length : 0;
          const symbols = content ? extractSymbols(content, ext) : [];

          const imports = extractSimpleImports(content, ext, item.path, allPaths);
          moduleGraph[item.path] = imports;

          files.push({
            path: item.path,
            ext,
            lines,
            symbols,
            imports,
            lastModified: 0,
            contentHash: "",
          });
        }

        fetched += batch.length;
        progress.report({
          message: `Processing files (${fetched}/${Math.min(prioritized.length, 150)})…`,
          increment: Math.floor((fetched / 150) * 60),
        });
      }

      // Add remaining files (symbols from path name only, no content fetch)
      for (const item of prioritized.slice(150)) {
        const ext = path.extname(item.path).toLowerCase();
        files.push({ path: item.path, ext, lines: 0, symbols: [], imports: [], lastModified: 0, contentHash: "" });
        moduleGraph[item.path] = [];
      }

      const entryPoints = computeEntryPoints(moduleGraph, files);

      const index: WorkspaceIndex = {
        rootDir: `github:${owner}/${repo}`,
        indexedAt: Date.now(),
        totalFiles: files.length,
        files,
        moduleGraph,
        entryPoints,
        projectType: detectProjectTypeFromTree(tree),
        frameworkHints: detectFrameworksFromTree(tree),
      };

      await context.globalState.update(cacheKey, { index, cachedAt: Date.now() });

      progress.report({ message: "Opening dashboard…", increment: 10 });
      DashboardPanel.createOrShow(context, index);
      vscode.window.showInformationMessage(`Analysis complete: ${owner}/${repo} (${files.length} files)`);
    }
  );
}

function extractSimpleImports(content: string, ext: string, filePath: string, allPaths: string[]): string[] {
  if (!content || (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx")) { return []; }
  const dir = path.dirname(filePath);
  const imports: string[] = [];
  const esRe  = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const reqRe = /require\(['"]([^'"]+)['"]\)/g;
  let m: RegExpExecArray | null;
  const raw: string[] = [];
  while ((m = esRe.exec(content))  !== null) { raw.push(m[1]); }
  while ((m = reqRe.exec(content)) !== null) { raw.push(m[1]); }

  for (const imp of raw) {
    if (!imp.startsWith(".")) { continue; }
    const resolved = path.posix.resolve("/" + dir, imp).slice(1);
    for (const ext2 of [".ts", ".tsx", ".js", ".jsx", ""]) {
      if (allPaths.includes(resolved + ext2)) { imports.push(resolved + ext2); break; }
    }
  }
  return [...new Set(imports)];
}

function detectProjectTypeFromTree(tree: GithubTreeItem[]): WorkspaceIndex["projectType"] {
  const names = new Set(tree.map((t) => path.basename(t.path)));
  const hasNode   = names.has("package.json");
  const hasPython = names.has("requirements.txt") || names.has("pyproject.toml");
  const hasJava   = names.has("pom.xml") || names.has("build.gradle");
  const count = [hasNode, hasPython, hasJava].filter(Boolean).length;
  if (count > 1) { return "mixed"; }
  if (hasNode)   { return "node"; }
  if (hasPython) { return "python"; }
  if (hasJava)   { return "java"; }
  return "unknown";
}

function detectFrameworksFromTree(tree: GithubTreeItem[]): string[] {
  const paths = tree.map((t) => t.path.toLowerCase());
  const hints: string[] = [];
  if (paths.some((p) => p.includes("next.config")))   { hints.push("next"); }
  if (paths.some((p) => p.includes("nuxt.config")))   { hints.push("nuxt"); }
  if (paths.some((p) => p.includes("svelte.config"))) { hints.push("svelte"); }
  if (paths.some((p) => p.includes("vite.config")))   { hints.push("vite"); }
  if (paths.some((p) => p.includes("angular.json")))  { hints.push("angular"); }
  return hints;
}
