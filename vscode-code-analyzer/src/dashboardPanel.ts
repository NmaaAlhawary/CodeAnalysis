import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { analyzeWorkspace, AnalysisResult } from "./analyzer";
import { WorkspaceIndex, getCachedIndex, buildIndex } from "./indexer";
import { buildAIContext } from "./contextBuilder";
import { generateWithAI } from "./geminiClient";

function getNonce(): string {
  let text = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { text += c.charAt(Math.floor(Math.random() * c.length)); }
  return text;
}

interface CouplingData { modules: string[]; matrix: number[][] }

function computeModuleCoupling(index: WorkspaceIndex): CouplingData {
  const getModule = (p: string) => { const parts = p.split("/"); return parts.length > 1 ? parts[0] : "(root)"; };
  const modSet = new Set<string>();
  for (const f of index.files) { modSet.add(getModule(f.path)); }
  const modules = [...modSet].sort();
  const matrix: number[][] = modules.map(() => modules.map(() => 0));
  for (const [from, imports] of Object.entries(index.moduleGraph)) {
    const fi = modules.indexOf(getModule(from));
    for (const imp of imports) {
      const ti = modules.indexOf(getModule(imp));
      if (fi >= 0 && ti >= 0 && fi !== ti) { matrix[fi][ti]++; }
    }
  }
  return { modules, matrix };
}

function computeHealthScore(data: AnalysisResult, index: WorkspaceIndex | undefined): number {
  let score = 0;
  if (data.flat.some(f => /readme\.md/i.test(f.name))) { score += 20; }
  if (data.flat.some(f => f.name.includes(".test.") || f.name.includes(".spec."))) { score += 20; }
  if (index) {
    const exported = index.files.flatMap(f => f.symbols.filter(s => s.isExported));
    const docPct = exported.length > 0 ? exported.filter(s => s.jsdocExists).length / exported.length : 0;
    score += Math.round(docPct * 30);
  }
  if (data.hotspots.length > 0) {
    const total = data.hotspots.reduce((s, h) => s + h.edits, 0);
    const topPct = data.hotspots[0].edits / total;
    score += topPct < 0.3 ? 15 : topPct < 0.5 ? 8 : 0;
  } else { score += 15; }
  const avgDeg = data.depGraph.links.length / Math.max(data.depGraph.nodes.length, 1);
  score += avgDeg < 3 ? 15 : avgDeg < 5 ? 8 : 0;
  return Math.min(100, score);
}

function buildCallGraph(filePath: string, index: WorkspaceIndex | undefined): { nodes: string[]; edges: Array<[string, string]> } | null {
  if (!index) { return null; }
  const relPath = path.relative(index.rootDir.startsWith("github:") ? "" : index.rootDir, filePath);
  const fileEntry = index.files.find(f => f.path === relPath || filePath.endsWith(f.path));
  if (!fileEntry) { return null; }
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  const lines = content.split("\n");
  const fns = fileEntry.symbols.filter(s => s.kind === "function" || s.kind === "method" || s.kind === "const");
  if (fns.length < 2) { return null; }
  const fnNames = new Set(fns.map(s => s.name));
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < fns.length; i++) {
    const start = fns[i].line - 1;
    const end   = i + 1 < fns.length ? fns[i + 1].line - 2 : lines.length;
    const body  = lines.slice(start, Math.min(end, start + 80)).join("\n");
    for (const other of fnNames) {
      if (other !== fns[i].name && new RegExp(`\\b${other}\\s*\\(`).test(body)) {
        edges.push([fns[i].name, other]);
      }
    }
  }
  return { nodes: [...fnNames], edges };
}

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext, remoteIndex?: WorkspaceIndex): void {
    const col = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(col);
      if (remoteIndex) { DashboardPanel.currentPanel._refreshWithRemoteIndex(remoteIndex); }
      else              { DashboardPanel.currentPanel._refresh(); }
      return;
    }
    const panel = vscode.window.createWebviewPanel("codeAnalyzerDashboard", "Code Analyzer", col,
      { enableScripts: true, retainContextWhenHidden: true });
    DashboardPanel.currentPanel = new DashboardPanel(panel, context, remoteIndex);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _context: vscode.ExtensionContext,
    remoteIndex?: WorkspaceIndex
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== "object") { return; }

      if (msg.type === "openFile") {
        const rawPath = (msg.path as string || "").trim();
        if (!rawPath) { return; }
        const [ws] = vscode.workspace.workspaceFolders ?? [];
        if (!ws) { return; }
        const found = await vscode.workspace.findFiles(`**/${rawPath}`, "**/node_modules/**", 1);
        const uri = found[0] ?? vscode.Uri.joinPath(ws.uri, rawPath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch { /* ignore */ }
        return;
      }

      if (msg.type === "getCallGraph") {
        const filePath = msg.filePath as string;
        const index = getCachedIndex(this._context);
        const data = buildCallGraph(filePath, index);
        this._panel.webview.postMessage({ type: "callGraphData", data });
        return;
      }

      if (msg.type === "generateInsights") {
        const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootDir) { return; }
        let index = getCachedIndex(this._context);
        if (!index) { index = await buildIndex(rootDir, this._context).catch(() => undefined); }
        if (!index) { return; }
        const context2 = buildAIContext(index, { mode: "architecture", tokenBudget: 16000 }, rootDir);
        const prompt = `Analyse this codebase and provide:
1. **Project Summary** (2-3 sentences)
2. **Top 3 Architectural Concerns** (potential issues, coupling, missing patterns)
3. **Top 5 Refactoring Candidates** — specific files/functions with brief reasoning
4. **Strengths** — 2-3 things the codebase does well
Be specific, cite file paths. Use Markdown.

${context2}`;
        try {
          const result = await generateWithAI([{ role: "user", content: prompt }], {}, this._context);
          await this._context.workspaceState.update("codeAnalyzer.insights", { text: result.text, model: result.model, at: Date.now() });
          this._panel.webview.postMessage({ type: "insightsReady", text: result.text, model: result.model });
        } catch (err: any) {
          this._panel.webview.postMessage({ type: "insightsError", message: err?.message || String(err) });
        }
        return;
      }
    }, null, this._disposables);

    if (remoteIndex) { this._refreshWithRemoteIndex(remoteIndex); }
    else             { this._refresh(); }
  }

  private _refreshWithRemoteIndex(index: WorkspaceIndex): void {
    this._panel.title = `Code Analyzer — ${index.rootDir}`;
    setImmediate(() => {
      try {
        const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || index.rootDir;
        const data = analyzeWorkspace(rootDir);
        this._panel.webview.html = this._buildHtml(data, index.rootDir);
      } catch {
        this._panel.webview.html = this._errorHtml(`Remote analysis: ${index.rootDir} (${index.totalFiles} files)`);
      }
    });
  }

  private _refresh(): void {
    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootDir) { this._panel.webview.html = this._errorHtml("No workspace folder open."); return; }
    this._panel.webview.html = this._loadingHtml();
    setImmediate(() => {
      try {
        const data = analyzeWorkspace(rootDir);
        this._panel.webview.html = this._buildHtml(data);
      } catch (err) {
        this._panel.webview.html = this._errorHtml(String(err));
      }
    });
  }

  private _errorHtml(msg: string): string {
    return `<html><body style="background:#0f1117;color:#ef4444;padding:40px;font-family:system-ui"><h2>Error</h2><p>${msg}</p></body></html>`;
  }

  private _loadingHtml(): string {
    return `<html><body style="background:#0f1117;color:#e2e8f0;padding:40px;font-family:system-ui;display:flex;align-items:center;gap:16px">
      <div style="width:32px;height:32px;border:3px solid #7c3aed;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite"></div>
      <span>Analysing workspace…</span>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </body></html>`;
  }

  private _buildHtml(data: AnalysisResult, sourceLabel?: string): string {
    const nonce   = getNonce();
    const index   = getCachedIndex(this._context);
    const health  = computeHealthScore(data, index);
    const coupling = index ? computeModuleCoupling(index) : null;
    const cachedInsights = this._context.workspaceState.get<{ text: string; model: string; at: number }>("codeAnalyzer.insights");

    // Symbol data for search tab
    const symbolsJson = index ? JSON.stringify(
      index.files.flatMap(f => f.symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        file: f.path,
        line: s.line,
        exported: s.isExported,
        docs: s.jsdocExists,
      }))).slice(0, 2000)
    ) : "[]";

    // Files list for call graph dropdown
    const indexedFilesJson = index ? JSON.stringify(
      index.files
        .filter(f => f.symbols.length >= 2)
        .map(f => ({ path: f.path, name: f.path.split("/").pop() }))
        .slice(0, 100)
    ) : "[]";

    // Module coupling
    const couplingJson = coupling ? JSON.stringify(coupling) : "null";

    // Doc coverage for health breakdown
    let docCoverage = 0;
    if (index) {
      const exp = index.files.flatMap(f => f.symbols.filter(s => s.isExported));
      docCoverage = exp.length > 0 ? Math.round((exp.filter(s => s.jsdocExists).length / exp.length) * 100) : 0;
    }

    const hasTests   = data.flat.some(f => f.name.includes(".test.") || f.name.includes(".spec."));
    const hasReadme  = data.flat.some(f => /readme\.md/i.test(f.name));
    const healthColor = health >= 70 ? "#10b981" : health >= 40 ? "#f59e0b" : "#ef4444";

    // File tree HTML (server-side rendered)
    function treeToHtml(nodes: typeof data.tree): string {
      if (!nodes?.length) { return ""; }
      let html = "<ul>";
      for (const n of nodes) {
        if (n.type === "dir") {
          html += `<li class="dir"><span class="tog">▶</span> 📁 <b>${n.name}</b>`;
          if (n.children?.length) { html += `<div class="ch collapsed">${treeToHtml(n.children)}</div>`; }
          html += `</li>`;
        } else {
          const isCode = [".ts",".tsx",".js",".jsx",".py",".cpp",".c",".h",".java",".go",".rs",".cs"].includes(n.ext || "");
          const hots = data.hotspots.find(h => h.file.endsWith(n.path));
          const heatStyle = hots ? `style="background:rgba(239,68,68,${Math.min(0.6, hots.edits / (data.hotspots[0]?.edits || 1) * 0.6)})"` : "";
          html += `<li class="fl" data-path="${n.path}" ${heatStyle}>${isCode ? "📄" : "📝"} <span class="fn">${n.name}</span> <span class="lc">${n.lines ? n.lines + " lines" : ""}</span></li>`;
        }
      }
      return html + "</ul>";
    }

    const treeHtml     = treeToHtml(data.tree);
    const statsJson    = JSON.stringify(data.fileStats.slice(0, 12));
    const hotspotsJson = JSON.stringify(data.hotspots.slice(0, 20));
    const gitLogJson   = JSON.stringify(data.gitLog.slice(0, 30));
    const depJson      = JSON.stringify(data.depGraph);

    // Commit frequency data (dates)
    const commitDates = data.gitLog.map(c => c.date).filter(Boolean);
    const commitFreqMap: Record<string, number> = {};
    for (const d of commitDates) { commitFreqMap[d] = (commitFreqMap[d] || 0) + 1; }
    const commitFreqJson = JSON.stringify(Object.entries(commitFreqMap).sort((a, b) => a[0].localeCompare(b[0])).slice(-30));

    // Author stats
    const authorMap: Record<string, number> = {};
    for (const c of data.gitLog) { if (c.author) { authorMap[c.author] = (authorMap[c.author] || 0) + 1; } }
    const authorJson = JSON.stringify(Object.entries(authorMap).sort((a, b) => b[1] - a[1]).slice(0, 8));

    // Churn vs size scatter data
    const scatterJson = JSON.stringify(
      data.hotspots.slice(0, 30).map(h => {
        const node = data.depGraph.nodes.find(n => n.path === h.file || h.file.endsWith(n.path));
        return { file: h.file.split("/").pop(), edits: h.edits, lines: node?.lines || 50 };
      })
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           style-src 'nonce-${nonce}';
           img-src data: https:;
           connect-src https:;">
<title>Code Analyzer</title>
<style nonce="${nonce}">
:root{--bg:#0f1117;--surf:#1a1d27;--bdr:#2a2d3a;--acc:#7c3aed;--acc2:#06b6d4;--acc3:#10b981;--tx:#e2e8f0;--mt:#64748b;--warn:#f59e0b;--err:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:13px/1.6 var(--vscode-font-family,system-ui)}
header{background:linear-gradient(135deg,#1e1b4b,#0f1117);border-bottom:1px solid var(--bdr);padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:1.1rem;font-weight:700}header h1 span{color:var(--acc2)}
header .meta{color:var(--mt);font-size:11px;margin-top:2px}
nav{background:var(--surf);border-bottom:1px solid var(--bdr);padding:0 20px;display:flex;gap:0;overflow-x:auto}
nav button{background:none;border:none;color:var(--mt);padding:9px 12px;cursor:pointer;font-size:11px;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;flex-shrink:0}
nav button.active,nav button:hover{color:var(--tx);border-color:var(--acc)}
.pane{display:none;padding:16px 20px;min-height:400px}.pane.active{display:block}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:16px}
.sc{background:var(--surf);border:1px solid var(--bdr);border-radius:8px;padding:12px;text-align:center}
.sc .v{font-size:1.6rem;font-weight:700;color:var(--acc2)}.sc .l{color:var(--mt);font-size:10px;margin-top:2px}
.card{background:var(--surf);border:1px solid var(--bdr);border-radius:8px;padding:14px;margin-bottom:14px}
.card h3{font-size:.85rem;margin-bottom:10px;color:var(--acc2);display:flex;align-items:center;gap:8px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.g2{grid-template-columns:1fr}}
.ch-wrap{position:relative;height:260px}.ch-tall{position:relative;height:340px}
.tree ul{list-style:none;padding-left:14px}
.dir{margin:2px 0}.fl{margin:1px 0;color:var(--mt);cursor:pointer;border-radius:3px;padding:1px 3px}
.fl:hover{background:rgba(6,182,212,.1);color:var(--tx)}
.fn{transition:color .1s}
.tog{cursor:pointer;user-select:none;font-size:9px;margin-right:4px;transition:transform .15s;display:inline-block}
.tog.open{transform:rotate(90deg)}.ch.collapsed{display:none}
.lc{font-size:10px;color:var(--bdr)}
#depg{width:100%;height:460px;background:#0c0e18;border-radius:6px;overflow:hidden;position:relative}
#callg{width:100%;height:400px;background:#0c0e18;border-radius:6px;overflow:hidden}
.dep-toolbar{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center}
.tb{background:#0c0e18;border:1px solid var(--bdr);color:var(--tx);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer}
.tb:hover{border-color:var(--acc2);color:var(--acc2)}
.tb.active{border-color:var(--acc);color:var(--acc)}
.node circle{stroke-width:1.5px}.node text{fill:var(--tx);font-size:9px;pointer-events:none}
.link{stroke:#334155;stroke-opacity:.5;stroke-width:1px}
.link.cycle{stroke:#ef4444;stroke-opacity:.9;stroke-width:2px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:6px 10px;border-bottom:2px solid var(--bdr);color:var(--mt);font-weight:600}
td{padding:5px 10px;border-bottom:1px solid var(--bdr)}
tr:hover td{background:rgba(124,58,237,.07)}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#1e293b}
.badge-fn{background:#1e1b4b;color:#a78bfa}
.badge-cls{background:#0c2031;color:#67e8f9}
.badge-if{background:#0a2010;color:#6ee7b7}
.hbar{display:flex;align-items:center;gap:6px}
.hfill{height:6px;border-radius:3px;background:var(--acc);min-width:2px}
.hash{font-family:monospace;color:var(--acc2);font-size:11px}
.muted{color:var(--mt);font-size:11px}
.sb{width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--bdr);background:#0c0e18;color:var(--tx);font-size:12px;margin-bottom:10px;outline:none}
.sb:focus{border-color:var(--acc2)}
.empty{color:var(--mt);padding:10px 0;font-size:12px}
select.sb{cursor:pointer}
.health-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.health-bar-bg{flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden}
.health-bar{height:100%;border-radius:4px;transition:width .4s}
.health-label{font-size:11px;color:var(--mt);min-width:140px}
.health-val{font-size:11px;font-weight:700;min-width:32px;text-align:right}
#coupling-grid{overflow:auto;margin-top:8px}
.coupling-table{border-collapse:collapse;font-size:11px}
.coupling-table td,.coupling-table th{padding:4px 8px;border:1px solid var(--bdr);text-align:center;min-width:70px}
.coupling-table th{background:#1e293b;color:var(--mt)}
.coupling-table td{font-family:monospace}
.insights-block pre,.insights-block p,.insights-block h1,.insights-block h2,.insights-block h3{margin:6px 0}
.insights-block h2{font-size:.9rem;color:var(--acc2)}
.insights-block h3{font-size:.85rem;color:var(--acc2)}
.insights-block ul{padding-left:16px}
.insights-block li{margin:2px 0}
.insights-block code{background:#0c0e18;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:11px}
.spinner{width:18px;height:18px;border:2px solid var(--acc);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.cycle-legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mt);margin-top:6px}
.cycle-swatch{width:14px;height:3px;background:#ef4444;border-radius:2px}
</style>
</head>
<body>
<header>
  <div>
    <h1>Code Analyzer — <span>${data.rootDir.split("/").pop()}</span></h1>
    <div class="meta">${sourceLabel ? `<span style="color:#06b6d4;margin-right:6px">⬡ ${sourceLabel}</span>` : data.rootDir}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:1.4rem;font-weight:700;color:${healthColor}">${health}</div>
    <div style="color:var(--mt);font-size:10px">health score</div>
  </div>
</header>

<nav>
  <button class="active" data-tab="overview">Overview</button>
  <button data-tab="tree">File Tree</button>
  <button data-tab="deps">Dep Graph</button>
  <button data-tab="callgraph">Call Graph</button>
  <button data-tab="hotspots">Git Hotspots</button>
  <button data-tab="gitlog">Git History</button>
  <button data-tab="coupling">Module Coupling</button>
  <button data-tab="symbols">Symbol Search</button>
  <button data-tab="insights">AI Insights</button>
</nav>

<!-- ① OVERVIEW ─────────────────────────────────────────────────────────── -->
<div class="pane active" id="tab-overview">
  <div class="stats">
    <div class="sc"><div class="v">${data.totalFiles.toLocaleString()}</div><div class="l">Total Files</div></div>
    <div class="sc"><div class="v">${data.totalDirs.toLocaleString()}</div><div class="l">Directories</div></div>
    <div class="sc"><div class="v">${data.totalLines.toLocaleString()}</div><div class="l">Total Lines</div></div>
    <div class="sc"><div class="v">${data.codeFileCount.toLocaleString()}</div><div class="l">Code Files</div></div>
    <div class="sc"><div class="v">${data.depGraph.links.length.toLocaleString()}</div><div class="l">Local Imports</div></div>
    <div class="sc"><div class="v">${data.hotspots.length}</div><div class="l">Hot Files</div></div>
  </div>
  <div class="g2">
    <div class="card"><h3>Files by Type</h3><div class="ch-wrap"><canvas id="extC"></canvas></div></div>
    <div class="card"><h3>Lines of Code by Type</h3><div class="ch-wrap"><canvas id="locC"></canvas></div></div>
  </div>
  <div class="card">
    <h3>Project Health — <span style="color:${healthColor}">${health}/100</span></h3>
    <div style="margin-bottom:12px">
      <div class="health-row"><span class="health-label">README present</span><div class="health-bar-bg"><div class="health-bar" style="width:${hasReadme?100:0}%;background:${hasReadme?"#10b981":"#ef4444"}"></div></div><span class="health-val" style="color:${hasReadme?"#10b981":"#ef4444"}">${hasReadme?"✓":"✗"}</span></div>
      <div class="health-row"><span class="health-label">Test files present</span><div class="health-bar-bg"><div class="health-bar" style="width:${hasTests?100:0}%;background:${hasTests?"#10b981":"#ef4444"}"></div></div><span class="health-val" style="color:${hasTests?"#10b981":"#ef4444"}">${hasTests?"✓":"✗"}</span></div>
      <div class="health-row"><span class="health-label">Doc coverage</span><div class="health-bar-bg"><div class="health-bar" style="width:${docCoverage}%;background:#06b6d4"></div></div><span class="health-val" style="color:#06b6d4">${docCoverage}%</span></div>
    </div>
    <table>
      <thead><tr><th>Extension</th><th>Files</th><th>Lines</th><th>Avg/File</th></tr></thead>
      <tbody id="statsBody"></tbody>
    </table>
  </div>
</div>

<!-- ② FILE TREE ──────────────────────────────────────────────────────────── -->
<div class="pane" id="tab-tree">
  <div class="card">
    <h3>Directory Structure <span style="font-size:10px;color:var(--mt);font-weight:400">(click files to open · heat = edit frequency)</span></h3>
    <input class="sb" id="ts" placeholder="Filter files…">
    <div class="tree">${treeHtml}</div>
  </div>
</div>

<!-- ③ DEPENDENCY GRAPH ───────────────────────────────────────────────────── -->
<div class="pane" id="tab-deps">
  <div class="card">
    <h3>Import Dependency Graph — ${data.depGraph.nodes.length} nodes · ${data.depGraph.links.length} edges</h3>
    <div class="dep-toolbar">
      <button class="tb" id="detect-cycles">Detect Cycles</button>
      <button class="tb" id="zoom-fit-dep">Fit</button>
      <span id="cycle-count" style="font-size:11px;color:var(--mt)"></span>
    </div>
    <div class="cycle-legend" id="cycle-legend" style="display:none"><div class="cycle-swatch"></div>Red edges = circular dependencies</div>
    <p class="muted" style="margin-bottom:8px">Node size = lines of code · Drag nodes · Scroll to zoom</p>
    <div id="depg"></div>
  </div>
</div>

<!-- ④ CALL GRAPH ─────────────────────────────────────────────────────────── -->
<div class="pane" id="tab-callgraph">
  <div class="card">
    <h3>Call Graph — function-level relationships within a file</h3>
    <select class="sb" id="cg-file-picker" style="margin-bottom:10px">
      <option value="">Select a file…</option>
    </select>
    <div id="callg"></div>
    <p class="muted" id="cg-hint" style="margin-top:6px">Select a file to visualise which functions call which other functions.</p>
  </div>
</div>

<!-- ⑤ GIT HOTSPOTS ──────────────────────────────────────────────────────── -->
<div class="pane" id="tab-hotspots">
  <div class="g2">
    <div class="card">
      <h3>Most Frequently Modified Files</h3>
      ${data.hotspots.length === 0
        ? '<p class="empty">No git modification history found.</p>'
        : `<div class="ch-tall"><canvas id="hotC"></canvas></div>`}
    </div>
    <div class="card">
      <h3>Churn vs Size <span style="font-size:10px;color:var(--mt);font-weight:400">(top-right = highest refactoring risk)</span></h3>
      <div class="ch-tall"><canvas id="scatterC"></canvas></div>
    </div>
  </div>
  ${data.hotspots.length > 0 ? `
  <div class="card">
    <h3>Hotspot Details</h3>
    <table>
      <thead><tr><th>File</th><th>Edits</th><th>Heat</th></tr></thead>
      <tbody id="hotBody"></tbody>
    </table>
  </div>` : ""}
</div>

<!-- ⑥ GIT HISTORY ───────────────────────────────────────────────────────── -->
<div class="pane" id="tab-gitlog">
  <div class="g2">
    <div class="card"><h3>Author Contributions</h3><div class="ch-wrap"><canvas id="authorC"></canvas></div></div>
    <div class="card"><h3>Commit Frequency</h3><div class="ch-wrap"><canvas id="freqC"></canvas></div></div>
  </div>
  <div class="card">
    <h3>Recent Commits</h3>
    ${data.gitLog.length === 0
      ? '<p class="empty">No git history found.</p>'
      : `<table><thead><tr><th>Hash</th><th>Date</th><th>Author</th><th>Message</th></tr></thead><tbody id="gitBody"></tbody></table>`}
  </div>
</div>

<!-- ⑦ MODULE COUPLING ───────────────────────────────────────────────────── -->
<div class="pane" id="tab-coupling">
  <div class="card">
    <h3>Cross-Module Import Coupling <span style="font-size:10px;color:var(--mt);font-weight:400">(darker = more imports between modules)</span></h3>
    <p class="muted" style="margin-bottom:10px">High coupling between unrelated modules signals architecture debt. Rows = source module, Columns = imported module.</p>
    <div id="coupling-grid">
      ${coupling && coupling.modules.length > 1
        ? `<table class="coupling-table" id="couplingTable"></table>`
        : '<p class="empty">No cross-module imports found, or workspace not indexed yet. Run "Re-index Workspace" first.</p>'}
    </div>
  </div>
</div>

<!-- ⑧ SYMBOL SEARCH ─────────────────────────────────────────────────────── -->
<div class="pane" id="tab-symbols">
  <div class="card">
    <h3>Symbol Search <span style="font-size:10px;color:var(--mt);font-weight:400">(all functions, classes, and exports across ${index?.totalFiles ?? 0} files)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <input class="sb" id="sym-search" placeholder="Search symbol name…" style="flex:1;min-width:160px;margin-bottom:0">
      <select class="sb" id="sym-kind" style="width:120px;margin-bottom:0">
        <option value="">All kinds</option>
        <option value="function">function</option>
        <option value="class">class</option>
        <option value="interface">interface</option>
        <option value="method">method</option>
        <option value="const">const</option>
        <option value="type">type</option>
      </select>
      <select class="sb" id="sym-filter" style="width:130px;margin-bottom:0">
        <option value="">All symbols</option>
        <option value="exported">Exported only</option>
        <option value="nodocs">Missing docs</option>
      </select>
    </div>
    <div style="overflow:auto;max-height:480px">
      <table>
        <thead><tr><th>Symbol</th><th>Kind</th><th>File</th><th>Line</th><th>Docs</th></tr></thead>
        <tbody id="symBody"></tbody>
      </table>
    </div>
    <div id="sym-count" style="font-size:11px;color:var(--mt);margin-top:8px"></div>
  </div>
</div>

<!-- ⑨ AI INSIGHTS ───────────────────────────────────────────────────────── -->
<div class="pane" id="tab-insights">
  <div class="card">
    <h3>AI Codebase Insights ${cachedInsights ? `<span style="font-size:10px;color:var(--mt);font-weight:400">— generated ${new Date(cachedInsights.at).toLocaleDateString()} · ${cachedInsights.model}</span>` : ""}</h3>
    <div id="insights-content">
      ${cachedInsights
        ? `<div class="insights-block" id="insights-md"></div>`
        : `<p class="muted" style="margin-bottom:12px">Generate an AI analysis of your codebase: architectural concerns, refactoring candidates, strengths, and a summary.</p>
           <button class="tb" id="gen-insights-btn" style="padding:8px 18px;font-size:12px">✨ Generate AI Insights</button>`}
    </div>
  </div>
</div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script nonce="${nonce}">
const vscode   = acquireVsCodeApi();
const STATS    = ${statsJson};
const HOTS     = ${hotspotsJson};
const GITLOG   = ${gitLogJson};
const DEP      = ${depJson};
const COUPLING = ${couplingJson};
const SYMBOLS  = ${symbolsJson};
const CG_FILES = ${indexedFilesJson};
const SCATTER  = ${JSON.stringify(scatterJson)};
const AUTHOR   = ${authorJson};
const FREQ     = ${commitFreqJson};
const CACHED_INSIGHTS = ${cachedInsights ? JSON.stringify(cachedInsights.text) : "null"};
const PAL = ['#7c3aed','#06b6d4','#10b981','#f59e0b','#ef4444','#8b5cf6','#22d3ee','#34d399','#fbbf24','#f87171','#a78bfa','#67e8f9'];

// ── Tab switching ─────────────────────────────────────────────────────────
let depDone = false, cgDone = false;
document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'deps'     && !depDone)   { depDone = true; initDep(); }
  if (btn.dataset.tab === 'coupling' && COUPLING)    { initCoupling(); }
  if (btn.dataset.tab === 'gitlog')                  { initGitCharts(); }
  if (btn.dataset.tab === 'hotspots')                { initHotCharts(); }
  if (btn.dataset.tab === 'symbols')                 { renderSymbols(); }
}));

// ── Overview charts ───────────────────────────────────────────────────────
new Chart(document.getElementById('extC'), {
  type: 'doughnut',
  data: { labels: STATS.map(d=>d.ext), datasets:[{data:STATS.map(d=>d.count),backgroundColor:PAL,borderWidth:0}] },
  options: { plugins:{ legend:{ labels:{ color:'#e2e8f0', font:{size:10} } } }, cutout:'55%' }
});
new Chart(document.getElementById('locC'), {
  type: 'bar',
  data: { labels: STATS.map(d=>d.ext), datasets:[{label:'Lines',data:STATS.map(d=>d.lines),backgroundColor:PAL,borderRadius:3}] },
  options: { indexAxis:'y', plugins:{legend:{display:false}},
    scales:{ x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}}, y:{ticks:{color:'#e2e8f0',font:{size:10}},grid:{display:false}} } }
});
const sb = document.getElementById('statsBody');
if(sb) STATS.slice(0,15).forEach(s=>{
  const tr=document.createElement('tr');
  tr.innerHTML=\`<td><span class="badge">\${s.ext||'—'}</span></td><td>\${s.count}</td><td>\${s.lines.toLocaleString()}</td><td>\${s.count?Math.round(s.lines/s.count):0}</td>\`;
  sb.appendChild(tr);
});

// ── File tree ─────────────────────────────────────────────────────────────
document.querySelector('.tree')?.addEventListener('click', e => {
  const tog = e.target.closest('.tog');
  if (tog) { tog.classList.toggle('open'); tog.closest('li').querySelector('.ch')?.classList.toggle('collapsed'); return; }
  const fl = e.target.closest('.fl');
  if (fl) { const p = fl.dataset.path; if (p) vscode.postMessage({ type: 'openFile', path: p }); }
});
document.getElementById('ts')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.fl').forEach(el => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
});

// ── Hotspot charts ────────────────────────────────────────────────────────
function initHotCharts() {
  if (HOTS.length && document.getElementById('hotC') && !document.getElementById('hotC')._chartjs) {
    new Chart(document.getElementById('hotC'),{
      type:'bar',
      data:{labels:HOTS.map(h=>h.file.split('/').slice(-2).join('/')),datasets:[{label:'Edits',data:HOTS.map(h=>h.edits),backgroundColor:'#7c3aed',borderRadius:3}]},
      options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}},y:{ticks:{color:'#e2e8f0',font:{size:10}},grid:{display:false}}}}
    });
    const hb=document.getElementById('hotBody');
    if(hb) HOTS.forEach(h=>{
      const pct=Math.round((h.edits/HOTS[0].edits)*100);
      const tr=document.createElement('tr');
      tr.innerHTML=\`<td style="font-family:monospace;font-size:11px">\${h.file}</td><td>\${h.edits}</td><td><div class="hbar"><div class="hfill" style="width:\${pct}px"></div>\${pct}%</div></td>\`;
      hb.appendChild(tr);
    });
  }
  // Churn vs Size scatter
  const sc = document.getElementById('scatterC');
  if (sc && !sc._chartjs) {
    const raw = JSON.parse(${JSON.stringify(JSON.stringify(data.hotspots.slice(0, 30).map(h => {
      const node = data.depGraph.nodes.find(n => n.path === h.file || h.file.endsWith(n.path));
      return { x: h.edits, y: node?.lines || 50, label: h.file.split("/").pop() || h.file };
    })))});
    new Chart(sc, {
      type: 'scatter',
      data: { datasets:[{ label:'Files', data: raw.map(d => ({x:d.x,y:d.y})), backgroundColor:'rgba(124,58,237,.7)', pointRadius:6, pointHoverRadius:8 }] },
      options: {
        plugins: {
          legend:{display:false},
          tooltip:{ callbacks:{ label:(ctx) => raw[ctx.dataIndex]?.label + ' ('+ctx.parsed.x+' edits, '+ctx.parsed.y+' lines)' } }
        },
        scales: {
          x:{title:{display:true,text:'Edit count',color:'#64748b'},ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
          y:{title:{display:true,text:'Lines of code',color:'#64748b'},ticks:{color:'#64748b'},grid:{color:'#1e293b'}}
        }
      }
    });
  }
}

// ── Git charts ────────────────────────────────────────────────────────────
let gitChartsInit = false;
function initGitCharts() {
  if (gitChartsInit) { return; } gitChartsInit = true;
  const gb=document.getElementById('gitBody');
  if(gb) GITLOG.forEach(c=>{
    const tr=document.createElement('tr');
    tr.innerHTML=\`<td class="hash">\${c.hash}</td><td class="muted">\${c.date}</td><td>\${c.author}</td><td style="font-size:11px">\${c.message}</td>\`;
    gb.appendChild(tr);
  });
  if (AUTHOR.length) {
    new Chart(document.getElementById('authorC'), {
      type:'doughnut',
      data:{labels:AUTHOR.map(a=>a[0]),datasets:[{data:AUTHOR.map(a=>a[1]),backgroundColor:PAL,borderWidth:0}]},
      options:{plugins:{legend:{labels:{color:'#e2e8f0',font:{size:10}}}},cutout:'50%'}
    });
  }
  if (FREQ.length) {
    new Chart(document.getElementById('freqC'), {
      type:'line',
      data:{labels:FREQ.map(f=>f[0]),datasets:[{label:'Commits',data:FREQ.map(f=>f[1]),borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,.15)',fill:true,tension:.3,pointRadius:3}]},
      options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#64748b',maxTicksLimit:8},grid:{color:'#1e293b'}},y:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}}}}
    });
  }
}

// ── Dependency graph ──────────────────────────────────────────────────────
function initDep(){
  if(!DEP.nodes.length){ document.getElementById('depg').innerHTML='<p class="empty" style="padding:20px">No local imports found.</p>'; return; }
  const el=document.getElementById('depg');
  const W=el.clientWidth||800, H=el.clientHeight||460;
  const maxL=Math.max(...DEP.nodes.map(n=>n.lines||1));
  const extCol={'.ts':'#3b82f6','.tsx':'#60a5fa','.js':'#f59e0b','.jsx':'#fbbf24','.py':'#22c55e','.cpp':'#a855f7','.c':'#9333ea','.h':'#c084fc','.java':'#ef4444','.go':'#0891b2','.rs':'#f97316','default':'#475569'};

  const svg=d3.select('#depg').append('svg').attr('width',W).attr('height',H);
  svg.append('defs').append('marker').attr('id','arr').attr('viewBox','0 -4 8 8').attr('refX',14).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto').append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#334155');
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([.05,8]).on('zoom',ev=>g.attr('transform',ev.transform)));

  const nodes=DEP.nodes.map(d=>({...d}));
  const links=DEP.links.map(d=>({...d}));
  let cycleEdges=new Set();

  const LARGE_DEP = nodes.length > 200;
  const sim=d3.forceSimulation(nodes)
    .force('link',d3.forceLink(links).id(d=>d.id).distance(100))
    .force('charge',d3.forceManyBody().strength(-220))
    .force('center',d3.forceCenter(W/2,H/2))
    .force('col',d3.forceCollide(d=>7+Math.sqrt((d.lines/maxL)*160)));
  if(LARGE_DEP) sim.alphaDecay(0.05).velocityDecay(0.4);

  const link=g.append('g').selectAll('line').data(links).join('line').attr('class','link').attr('marker-end','url(#arr)');
  const node=g.append('g').selectAll('g').data(nodes).join('g').attr('class','node')
    .call(d3.drag().on('start',(ev,d)=>{if(!ev.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;}).on('drag',(ev,d)=>{d.fx=ev.x;d.fy=ev.y;}).on('end',(ev,d)=>{if(!ev.active)sim.alphaTarget(0);d.fx=null;d.fy=null;}));
  node.append('circle').attr('r',d=>5+Math.sqrt((d.lines/maxL)*160)).attr('fill',d=>extCol[d.ext]||extCol.default).attr('stroke','rgba(255,255,255,.2)').attr('stroke-width',1.5);
  node.append('title').text(d=>\`\${d.path}\\n\${d.lines} lines\`);
  node.append('text').attr('dy',d=>-(8+Math.sqrt((d.lines/maxL)*160))).attr('text-anchor','middle').style('font-size','9px').style('fill','#cbd5e1').text(d=>d.name.length>14?d.name.slice(0,12)+'…':d.name);
  node.on('click', (_,d) => vscode.postMessage({ type:'openFile', path: d.path }));

  let _rafDep=null;
  function tickedDep(){
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('transform',d=>\`translate(\${d.x},\${d.y})\`);
  }
  sim.on('tick',()=>{
    if(LARGE_DEP){ if(_rafDep)return; _rafDep=requestAnimationFrame(()=>{_rafDep=null;tickedDep();}); }
    else{ tickedDep(); }
  });

  document.getElementById('zoom-fit-dep').addEventListener('click',()=>{
    svg.transition().duration(400).call(d3.zoom().transform, d3.zoomIdentity.translate(W/2,H/2).scale(0.8).translate(-W/2,-H/2));
  });

  // Tarjan's SCC for cycle detection
  document.getElementById('detect-cycles').addEventListener('click',()=>{
    const n=nodes.length;
    const adj=Array.from({length:n},()=>[]);
    links.forEach(l=>{ const s=typeof l.source==='object'?l.source.id:l.source; const t=typeof l.target==='object'?l.target.id:l.target; adj[s].push(t); });
    const idx=new Array(n).fill(-1), low=new Array(n).fill(0), onStack=new Array(n).fill(false);
    const stack=[], sccs=[];
    let counter=0;
    function scc(v){
      idx[v]=low[v]=counter++;
      stack.push(v); onStack[v]=true;
      for(const w of adj[v]){
        if(idx[w]===-1){scc(w);low[v]=Math.min(low[v],low[w]);}
        else if(onStack[w]){low[v]=Math.min(low[v],idx[w]);}
      }
      if(low[v]===idx[v]){
        const scc=[];let w;
        do{w=stack.pop();onStack[w]=false;scc.push(w);}while(w!==v);
        if(scc.length>1) sccs.push(scc);
      }
    }
    for(let i=0;i<n;i++){if(idx[i]===-1)scc(i);}
    const cycleNodes=new Set(sccs.flat());
    cycleEdges=new Set();
    links.forEach((l,i)=>{
      const s=typeof l.source==='object'?l.source.id:l.source;
      const t=typeof l.target==='object'?l.target.id:l.target;
      if(cycleNodes.has(s)&&cycleNodes.has(t))cycleEdges.add(i);
    });
    link.attr('class',(_,i)=>cycleEdges.has(i)?'link cycle':'link');
    node.select('circle').attr('stroke',d=>cycleNodes.has(d.id)?'#ef4444':'rgba(255,255,255,.2)').attr('stroke-width',d=>cycleNodes.has(d.id)?2.5:1.5);
    const cnt=sccs.length;
    document.getElementById('cycle-count').textContent=cnt===0?'✓ No cycles found':\`⚠ \${cnt} circular group\${cnt===1?'':'s'} found\`;
    document.getElementById('cycle-count').style.color=cnt===0?'#10b981':'#ef4444';
    document.getElementById('cycle-legend').style.display=cnt>0?'flex':'none';
  });
}

// ── Call Graph ────────────────────────────────────────────────────────────
const cgPicker = document.getElementById('cg-file-picker');
CG_FILES.forEach(f=>{
  const opt=document.createElement('option');
  opt.value=f.path; opt.textContent=f.path;
  cgPicker.appendChild(opt);
});
cgPicker.addEventListener('change', function() {
  if(!this.value) return;
  vscode.postMessage({ type:'getCallGraph', filePath: this.value });
  document.getElementById('cg-hint').textContent='Loading call graph…';
});

// ── Module Coupling ───────────────────────────────────────────────────────
function initCoupling(){
  if(!COUPLING||!COUPLING.modules.length) return;
  const table=document.getElementById('couplingTable');
  if(!table||table.innerHTML) return;
  const maxVal=Math.max(...COUPLING.matrix.flat(),1);
  let html='<tr><th></th>'+COUPLING.modules.map(m=>\`<th title="\${m}">\${m.length>8?m.slice(0,7)+'…':m}</th>\`).join('')+'</tr>';
  COUPLING.matrix.forEach((row,i)=>{
    html+=\`<tr><th style="text-align:left">\${COUPLING.modules[i].length>10?COUPLING.modules[i].slice(0,9)+'…':COUPLING.modules[i]}</th>\`;
    row.forEach((val,j)=>{
      const alpha=val>0?0.15+0.7*(val/maxVal):0;
      const bg=val>0?\`rgba(124,58,237,\${alpha.toFixed(2)})\`:'transparent';
      html+=\`<td style="background:\${bg};color:\${val>0?'#e2e8f0':'#2a2d3a'}">\${val||'·'}</td>\`;
    });
    html+='</tr>';
  });
  table.innerHTML=html;
}

// ── Symbol Search ─────────────────────────────────────────────────────────
let symRendered=false;
function renderSymbols(){
  if(symRendered) return; symRendered=true;
  filterSymbols();
  document.getElementById('sym-search').addEventListener('input', filterSymbols);
  document.getElementById('sym-kind').addEventListener('change', filterSymbols);
  document.getElementById('sym-filter').addEventListener('change', filterSymbols);
}
function filterSymbols(){
  const q    = (document.getElementById('sym-search').value||'').toLowerCase();
  const kind = document.getElementById('sym-kind').value;
  const filt = document.getElementById('sym-filter').value;
  const body = document.getElementById('symBody');
  const count= document.getElementById('sym-count');
  body.innerHTML='';
  let shown=0;
  const MAX=200;
  for(const s of SYMBOLS){
    if(q && !s.name.toLowerCase().includes(q) && !s.file.toLowerCase().includes(q)) continue;
    if(kind && s.kind!==kind) continue;
    if(filt==='exported' && !s.exported) continue;
    if(filt==='nodocs' && s.docs) continue;
    if(shown>=MAX) break;
    const kindClass=s.kind==='function'?'badge-fn':s.kind==='class'||s.kind==='interface'?'badge-cls':'';
    const tr=document.createElement('tr');
    tr.innerHTML=\`
      <td style="font-family:monospace;font-weight:600">\${s.name}</td>
      <td><span class="badge \${kindClass}">\${s.kind}</span></td>
      <td style="font-family:monospace;font-size:11px;color:var(--acc2);cursor:pointer" onclick="vscode.postMessage({type:'openFile',path:'\${s.file}'})">\${s.file}</td>
      <td class="muted">\${s.line}</td>
      <td>\${s.docs?'<span style="color:#10b981">✓</span>':'<span style="color:#ef4444">✗</span>'}</td>
    \`;
    body.appendChild(tr);
    shown++;
  }
  count.textContent=\`Showing \${shown} of \${SYMBOLS.length} symbols\`;
}

// ── AI Insights ───────────────────────────────────────────────────────────
if(CACHED_INSIGHTS){
  const md=document.getElementById('insights-md');
  if(md){ md.innerHTML=marked.parse(CACHED_INSIGHTS); }
}
document.getElementById('gen-insights-btn')?.addEventListener('click',function(){
  this.disabled=true;
  this.innerHTML='<span class="spinner"></span>Generating…';
  vscode.postMessage({ type:'generateInsights' });
});

// ── Message handler ───────────────────────────────────────────────────────
window.addEventListener('message', e=>{
  const msg=e.data;

  if(msg.type==='callGraphData'){
    const data=msg.data;
    document.getElementById('cg-hint').style.display='none';
    const el=document.getElementById('callg');
    el.innerHTML='';
    if(!data||!data.edges.length){
      el.innerHTML='<p class="empty" style="padding:16px">No function calls detected in this file (or not enough symbols).</p>';
      return;
    }
    const W=el.clientWidth||800, H=400;
    const svg=d3.select('#callg').append('svg').attr('width',W).attr('height',H);
    const g2=svg.append('g');
    svg.call(d3.zoom().scaleExtent([.1,6]).on('zoom',ev=>g2.attr('transform',ev.transform)));

    // Compute in-degree for sizing
    const inDeg={};
    data.nodes.forEach(n=>{inDeg[n]=0;});
    data.edges.forEach(([,t])=>{inDeg[t]=(inDeg[t]||0)+1;});

    const nodeData=data.nodes.map(name=>({name,id:name}));
    const linkData=data.edges.map(([s,t])=>({source:s,target:t}));

    svg.append('defs').append('marker').attr('id','arr2').attr('viewBox','0 -4 8 8').attr('refX',12).attr('refY',0).attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto').append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#475569');

    const LARGE_CG = nodeData.length > 200;
    const sim2=d3.forceSimulation(nodeData)
      .force('link',d3.forceLink(linkData).id(d=>d.id).distance(80))
      .force('charge',d3.forceManyBody().strength(-180))
      .force('center',d3.forceCenter(W/2,H/2))
      .force('col',d3.forceCollide(20));
    if(LARGE_CG) sim2.alphaDecay(0.05).velocityDecay(0.4);

    const link2=g2.append('g').selectAll('line').data(linkData).join('line').attr('stroke','#334155').attr('stroke-opacity',.7).attr('stroke-width',1.2).attr('marker-end','url(#arr2)');
    const node2=g2.append('g').selectAll('g').data(nodeData).join('g')
      .call(d3.drag().on('start',(ev,d)=>{if(!ev.active)sim2.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;}).on('drag',(ev,d)=>{d.fx=ev.x;d.fy=ev.y;}).on('end',(ev,d)=>{if(!ev.active)sim2.alphaTarget(0);d.fx=null;d.fy=null;}));
    node2.append('circle').attr('r',d=>8+(inDeg[d.name]||0)*3).attr('fill','#7c3aed').attr('stroke','rgba(255,255,255,.3)').attr('stroke-width',1.5);
    node2.append('text').attr('dy',d=>-(11+(inDeg[d.name]||0)*3)).attr('text-anchor','middle').style('font-size','10px').style('fill','#e2e8f0').text(d=>d.name.length>16?d.name.slice(0,14)+'…':d.name);
    let _rafCg=null;
    function tickedCg(){
      link2.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
      node2.attr('transform',d=>\`translate(\${d.x},\${d.y})\`);
    }
    sim2.on('tick',()=>{
      if(LARGE_CG){ if(_rafCg)return; _rafCg=requestAnimationFrame(()=>{_rafCg=null;tickedCg();}); }
      else{ tickedCg(); }
    });
    return;
  }

  if(msg.type==='insightsReady'){
    const content=document.getElementById('insights-content');
    content.innerHTML='<div class="insights-block" id="insights-md"></div>';
    document.getElementById('insights-md').innerHTML=marked.parse(msg.text);
    return;
  }

  if(msg.type==='insightsError'){
    const btn=document.getElementById('gen-insights-btn');
    if(btn){btn.disabled=false;btn.innerHTML='✨ Generate AI Insights';}
    const p=document.createElement('p');
    p.style.cssText='color:#ef4444;font-size:12px;margin-top:8px';
    p.textContent='Error: '+msg.message;
    document.getElementById('insights-content').appendChild(p);
    return;
  }
});
</script>
</body>
</html>`;
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }
}
