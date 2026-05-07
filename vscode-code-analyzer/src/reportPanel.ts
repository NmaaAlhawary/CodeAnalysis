import * as vscode from "vscode";
import * as path from "path";
import { analyzeWorkspace, AnalysisResult, DepGraph } from "./analyzer";
import { buildIndex } from "./indexer";
import { generateAISummary } from "./geminiClient";

// ── Cycle detection (Tarjan SCC) ──────────────────────────────────────────────
function detectCycleNodes(graph: DepGraph): Set<number> {
  const n = graph.nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const l of graph.links) { if (l.source < n && l.target < n) { adj[l.source].push(l.target); } }

  const idx: number[]  = new Array(n).fill(-1);
  const low: number[]  = new Array(n).fill(0);
  const onStk: boolean[] = new Array(n).fill(false);
  const stk: number[]  = [];
  let counter = 0;
  const cycleNodes = new Set<number>();

  function scc(v: number): void {
    idx[v] = low[v] = counter++;
    stk.push(v); onStk[v] = true;
    for (const w of adj[v]) {
      if (idx[w] === -1) { scc(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStk[w]) { low[v] = Math.min(low[v], idx[w]); }
    }
    if (low[v] === idx[v]) {
      const component: number[] = [];
      let w: number;
      do { w = stk.pop()!; onStk[w] = false; component.push(w); } while (w !== v);
      if (component.length > 1) { for (const x of component) { cycleNodes.add(x); } }
    }
  }

  for (let v = 0; v < n; v++) { if (idx[v] === -1) { scc(v); } }
  return cycleNodes;
}

// ── Report Panel ──────────────────────────────────────────────────────────────
export class ReportPanel {
  private static _panel: vscode.WebviewPanel | undefined;
  private static _msgSub: vscode.Disposable | undefined;

  static async generate(context: vscode.ExtensionContext): Promise<void> {
    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootDir) { vscode.window.showWarningMessage("Open a folder to analyze."); return; }

    if (ReportPanel._panel) {
      ReportPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      ReportPanel._panel = vscode.window.createWebviewPanel(
        "codebaseReport", "Codebase Report",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      ReportPanel._panel.onDidDispose(() => {
        ReportPanel._panel = undefined;
        ReportPanel._msgSub?.dispose();
      }, null, context.subscriptions);
    }

    const panel = ReportPanel._panel;
    const projectName = path.basename(rootDir);

    panel.webview.html = loadingHtml(projectName);

    const [result] = await Promise.all([
      Promise.resolve(analyzeWorkspace(rootDir)),
      buildIndex(rootDir, context).catch(() => null),
    ]);

    const cycleNodes = detectCycleNodes(result.depGraph);
    panel.webview.html = reportHtml(projectName, result, cycleNodes);

    // Message handler
    ReportPanel._msgSub?.dispose();
    let summaryReady = false;
    let pendingSummary: { text: string | null; noKey: boolean } | undefined;

    ReportPanel._msgSub = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        summaryReady = true;
        if (pendingSummary) {
          panel.webview.postMessage({ type: "summary", ...pendingSummary });
          pendingSummary = undefined;
        }
      }
      if (msg.type === "rerun") {
        await ReportPanel.generate(context);
      }
      if (msg.type === "configure") {
        await vscode.commands.executeCommand("codebaseIntelligence.configureProvider");
      }
    });

    // Generate AI summary in background
    try {
      const text = await generateAISummary(result, context);
      const payload = { text, noKey: false };
      if (summaryReady) { panel.webview.postMessage({ type: "summary", ...payload }); }
      else { pendingSummary = payload; }
    } catch (err: any) {
      const noKey = /not configured/i.test(err?.message || "");
      const payload = { text: noKey ? null : `Could not generate summary: ${err?.message}`, noKey };
      if (summaryReady) { panel.webview.postMessage({ type: "summary", ...payload }); }
      else { pendingSummary = payload; }
    }
  }
}

// ── Loading HTML ──────────────────────────────────────────────────────────────
function loadingHtml(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;background:#0a0a0f;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;color:#64748b}
  .wrap{text-align:center}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#7c3aed;margin:0 3px;animation:bounce .9s ease-in-out infinite}
  .dot:nth-child(2){animation-delay:.18s}.dot:nth-child(3){animation-delay:.36s}
  @keyframes bounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-8px);opacity:1}}
  p{margin:16px 0 0;font-size:13px;letter-spacing:.04em}
</style></head><body>
<div class="wrap">
  <div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <p>Analyzing <strong style="color:#e2e8f0">${escHtml(name)}</strong>…</p>
</div></body></html>`;
}

// ── Report HTML ───────────────────────────────────────────────────────────────
function reportHtml(name: string, r: AnalysisResult, cycleNodes: Set<number>): string {
  // Cap graph at 80 nodes (largest files)
  const MAX_NODES = 80;
  let graphNodes = [...r.depGraph.nodes].sort((a, b) => b.lines - a.lines).slice(0, MAX_NODES);
  const shownIds = new Set(graphNodes.map(n => n.id));
  const graphLinks = r.depGraph.links.filter(l => shownIds.has(l.source) && shownIds.has(l.target));
  // Re-index nodes 0..N-1 for the webview
  const idMap = new Map<number, number>();
  graphNodes.forEach((n, i) => idMap.set(n.id, i));
  const graphData = {
    nodes: graphNodes.map((n, i) => ({ id: i, name: n.name, path: n.path, lines: n.lines, cycle: cycleNodes.has(n.id) })),
    links: graphLinks.map(l => ({ source: idMap.get(l.source)!, target: idMap.get(l.target)! })).filter(l => l.source !== undefined && l.target !== undefined),
  };

  // Language bars
  const topLangs = r.fileStats.filter(s => s.lines > 0).slice(0, 8);
  const maxLines = topLangs[0]?.lines || 1;
  const langBars = topLangs.map(s => {
    const pct = Math.round((s.lines / maxLines) * 100);
    const label = s.ext.replace(".", "").toUpperCase() || "OTHER";
    const color = langColor(s.ext);
    return `<div class="lang-row">
      <span class="lang-name">${escHtml(label)}</span>
      <div class="lang-track"><div class="lang-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="lang-count">${s.count} files</span>
    </div>`;
  }).join("");

  const hasCycles = cycleNodes.size > 0;
  const cycleCount = new Set([...r.depGraph.links.filter(l => cycleNodes.has(l.source) && cycleNodes.has(l.target)).flatMap(l => [l.source, l.target])]).size;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;padding:0 0 60px}
/* Header */
.header{padding:24px 28px 20px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.header-left{min-width:0}
.project-name{font-size:18px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:8px}
.project-name span{color:#7c3aed;font-size:15px}
.header-meta{font-size:12px;color:#475569;margin-top:4px}
.rerun-btn{flex-shrink:0;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);color:#a78bfa;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.rerun-btn:hover{background:rgba(124,58,237,.22);border-color:rgba(124,58,237,.5)}
/* Stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:20px 28px}
.stat-card{background:#111827;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:16px}
.stat-val{font-size:22px;font-weight:800;color:#f1f5f9;font-variant-numeric:tabular-nums}
.stat-val span{font-size:13px;font-weight:500;color:#64748b;margin-left:3px}
.stat-label{font-size:11px;color:#475569;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
/* Section */
.section{padding:0 28px;margin-top:28px}
.section-title{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.badge{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.25);color:#fca5a5;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:700}
.badge-ok{background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.25);color:#6ee7b7}
/* Graph */
#graph-canvas{width:100%;height:320px;display:block;border-radius:8px;background:#080b12;cursor:crosshair}
.graph-wrap{position:relative}
.graph-legend{position:absolute;bottom:10px;right:12px;display:flex;gap:12px;font-size:10px;color:#475569}
.legend-item{display:flex;align-items:center;gap:4px}
.legend-dot{width:8px;height:8px;border-radius:50%}
/* Lang bars */
.lang-row{display:grid;grid-template-columns:52px 1fr 56px;align-items:center;gap:10px;margin-bottom:9px}
.lang-name{font-size:11px;font-weight:600;color:#64748b;text-align:right}
.lang-track{background:rgba(255,255,255,.05);border-radius:3px;height:6px;overflow:hidden}
.lang-bar{height:100%;border-radius:3px;transition:width .4s ease}
.lang-count{font-size:11px;color:#334155;text-align:right}
/* AI Summary */
.ai-box{background:#111827;border:1px solid rgba(124,58,237,.2);border-radius:10px;padding:20px 22px;min-height:72px;position:relative}
.ai-label{font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.ai-text{font-size:13px;color:#cbd5e1;line-height:1.7}
.ai-placeholder{color:#334155;font-size:13px;display:flex;align-items:center;gap:8px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(124,58,237,.3);border-top-color:#7c3aed;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.configure-prompt{font-size:12px;color:#475569}
.configure-prompt button{background:none;border:1px solid rgba(124,58,237,.3);color:#a78bfa;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;margin-top:8px;display:block}
.configure-prompt button:hover{border-color:rgba(124,58,237,.6)}
/* Tooltip */
#tooltip{position:fixed;background:#1e293b;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:6px 10px;font-size:11px;color:#e2e8f0;pointer-events:none;display:none;z-index:100;max-width:200px;word-break:break-all}
</style>
</head>
<body>
<div id="tooltip"></div>

<div class="header">
  <div class="header-left">
    <div class="project-name"><span>⬡</span>${escHtml(name)}</div>
    <div class="header-meta">${r.totalFiles} files · ${fmtNum(r.totalLines)} lines · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
  </div>
  <button class="rerun-btn" id="rerun-btn">↺ Re-run</button>
</div>

<div class="stats">
  <div class="stat-card">
    <div class="stat-val">${r.totalFiles}<span>files</span></div>
    <div class="stat-label">Total files</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">${fmtNum(r.totalLines)}<span>lines</span></div>
    <div class="stat-label">Lines of code</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">${r.depGraph.nodes.length}<span>modules</span></div>
    <div class="stat-label">${hasCycles ? `<span style="color:#fca5a5">${cycleCount} in cycles</span>` : `<span style="color:#6ee7b7">no cycles</span>`}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">
    Dependency Graph
    ${hasCycles ? `<span class="badge">⚠ ${cycleCount} cycle nodes</span>` : `<span class="badge-ok">✓ clean</span>`}
  </div>
  <div class="graph-wrap">
    <canvas id="graph-canvas"></canvas>
    <div class="graph-legend">
      <div class="legend-item"><div class="legend-dot" style="background:rgba(255,255,255,.55)"></div>file</div>
      ${hasCycles ? `<div class="legend-item"><div class="legend-dot" style="background:#f97316"></div>cycle</div>` : ""}
      <div class="legend-item"><div class="legend-dot" style="background:#06b6d4"></div>hover</div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Language Breakdown</div>
  ${langBars}
</div>

<div class="section">
  <div class="section-title">✦ AI Summary</div>
  <div class="ai-box" id="ai-box">
    <div class="ai-label">✦ Codebase Intelligence</div>
    <div class="ai-placeholder" id="ai-placeholder">
      <span class="spin"></span>Generating summary…
    </div>
    <div class="ai-text" id="ai-text" style="display:none"></div>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();

  // ── Re-run ──────────────────────────────────────────────────────────────────
  document.getElementById('rerun-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'rerun' });
  });

  // ── Graph data ──────────────────────────────────────────────────────────────
  const GRAPH = ${JSON.stringify(graphData)};

  // ── Force simulation ────────────────────────────────────────────────────────
  const canvas = document.getElementById('graph-canvas');
  const rect0 = canvas.getBoundingClientRect();
  canvas.width  = Math.floor(rect0.width  || 600);
  canvas.height = 320;
  const ctx = canvas.getContext('2d');

  const nodes = GRAPH.nodes.map(n => ({
    ...n,
    x: canvas.width  * 0.1 + Math.random() * canvas.width  * 0.8,
    y: canvas.height * 0.1 + Math.random() * canvas.height * 0.8,
    vx: 0, vy: 0,
  }));
  const links = GRAPH.links;

  // Pre-compute incoming count per node (for sizing)
  const incoming = new Array(nodes.length).fill(0);
  for (const l of links) { if (l.target < nodes.length) incoming[l.target]++; }

  let hovered = null;
  let ticks = 0;
  const MAX_TICKS = 300;

  function tick() {
    const K = 1800;
    const IDEAL = 70;
    const DAMP  = 0.82;

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy || 1;
        const f = K / d2;
        const fx = f * dx / Math.sqrt(d2), fy = f * dy / Math.sqrt(d2);
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Attraction along links
    for (const l of links) {
      const a = nodes[l.source], b = nodes[l.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx*dx + dy*dy) || 1;
      const f = (d - IDEAL) * 0.006;
      a.vx += f * dx/d; a.vy += f * dy/d;
      b.vx -= f * dx/d; b.vy -= f * dy/d;
    }
    // Centre gravity
    const cx = canvas.width / 2, cy = canvas.height / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.003;
      n.vy += (cy - n.y) * 0.003;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x = Math.max(8, Math.min(canvas.width  - 8, n.x + n.vx));
      n.y = Math.max(8, Math.min(canvas.height - 8, n.y + n.vy));
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Links
    for (const l of links) {
      const a = nodes[l.source], b = nodes[l.target];
      if (!a || !b) continue;
      const isCycleLink = a.cycle && b.cycle;
      const isConnected = hovered && (l.source === hovered.id || l.target === hovered.id);
      ctx.strokeStyle = isCycleLink ? 'rgba(249,115,22,.5)' : isConnected ? 'rgba(6,182,212,.5)' : 'rgba(255,255,255,.07)';
      ctx.lineWidth = isConnected ? 1.5 : 0.8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Nodes
    for (const n of nodes) {
      const r = 3 + Math.min(4, incoming[n.id] * 0.8);
      const isHov = n === hovered;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHov ? '#06b6d4' : n.cycle ? '#f97316' : 'rgba(255,255,255,.55)';
      ctx.fill();
      if (isHov) {
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '10px system-ui';
        const lx = n.x + r + 5, ly = n.y + 4;
        ctx.fillText(n.name, lx, ly);
      }
    }
  }

  const tooltip = document.getElementById('tooltip');
  canvas.addEventListener('mousemove', e => {
    const cr = canvas.getBoundingClientRect();
    const scaleX = canvas.width / cr.width;
    const mx = (e.clientX - cr.left) * scaleX;
    const my = (e.clientY - cr.top) * scaleX;
    let closest = null, minD = 18;
    for (const n of nodes) {
      const d = Math.hypot(n.x - mx, n.y - my);
      if (d < minD) { minD = d; closest = n; }
    }
    hovered = closest;
    if (closest) {
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top  = (e.clientY - 8)  + 'px';
      tooltip.textContent = closest.path + ' (' + closest.lines + ' lines)';
    } else {
      tooltip.style.display = 'none';
    }
  });
  canvas.addEventListener('mouseleave', () => { hovered = null; tooltip.style.display = 'none'; });

  function animate() {
    if (ticks < MAX_TICKS) { tick(); ticks++; }
    draw();
    requestAnimationFrame(animate);
  }
  animate();

  // ── AI Summary ──────────────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'summary') {
      const placeholder = document.getElementById('ai-placeholder');
      const aiText = document.getElementById('ai-text');
      placeholder.style.display = 'none';
      if (msg.noKey) {
        aiText.style.display = 'block';
        aiText.innerHTML = '<div class="configure-prompt">No AI key configured.<button id="cfg-btn">⚙ Configure AI Provider</button></div>';
        document.getElementById('cfg-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'configure' });
        });
      } else if (msg.text) {
        aiText.style.display = 'block';
        aiText.textContent = msg.text;
      }
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body></html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(n: number): string {
  if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
  return String(n);
}

function langColor(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "#3b82f6", ".tsx": "#06b6d4", ".js": "#f59e0b", ".jsx": "#f97316",
    ".py": "#10b981", ".java": "#8b5cf6", ".go": "#06b6d4", ".rs": "#f97316",
    ".css": "#ec4899", ".scss": "#ec4899", ".html": "#ef4444",
    ".md": "#64748b", ".json": "#94a3b8",
  };
  return map[ext] || "#475569";
}
