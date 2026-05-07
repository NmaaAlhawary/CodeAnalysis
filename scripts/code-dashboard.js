#!/usr/bin/env node
/**
 * Code Analysis Dashboard Generator
 * Combines: file hotspots, structure tree, file-type stats,
 *           import/dependency graph, and code quality indicators.
 * Usage: node scripts/code-dashboard.js [root-dir] [output-html]
 *   root-dir    defaults to cwd
 *   output-html defaults to code-analysis-report.html
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Config ────────────────────────────────────────────────────────────────────
const rootDir = path.resolve(process.argv[2] || process.cwd());
const outputFile = process.argv[3] || path.join(rootDir, "code-analysis-report.html");

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".idea", "dist", "build", "out",
  "__pycache__", ".cache", ".next", "coverage",
]);
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".cpp", ".c", ".h",
  ".java", ".go", ".rs", ".rb", ".cs", ".swift", ".kt",
]);
const TEXT_EXTS = new Set([
  ...CODE_EXTS,
  ".json", ".yaml", ".yml", ".md", ".txt", ".html", ".css",
  ".scss", ".xml", ".sh", ".bash", ".zsh",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function walkDir(dir, depth = 0) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    if (entry.isDirectory()) {
      results.push({ type: "dir", name: entry.name, path: relPath, depth, children: walkDir(fullPath, depth + 1) });
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      let lines = 0;
      if (TEXT_EXTS.has(ext)) {
        try { lines = fs.readFileSync(fullPath, "utf8").split("\n").length; } catch {}
      }
      results.push({ type: "file", name: entry.name, path: relPath, depth, ext, lines });
    }
  }
  return results;
}

function flattenTree(nodes, acc = []) {
  for (const n of nodes) {
    acc.push(n);
    if (n.children) flattenTree(n.children, acc);
  }
  return acc;
}

function getFileStats(flat) {
  const byExt = {};
  for (const f of flat.filter(n => n.type === "file")) {
    const ext = f.ext || "(no ext)";
    if (!byExt[ext]) byExt[ext] = { count: 0, lines: 0 };
    byExt[ext].count++;
    byExt[ext].lines += f.lines || 0;
  }
  return Object.entries(byExt)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ext, data]) => ({ ext, ...data }));
}

function getGitHotspots(limit = 20) {
  try {
    const out = execSync(
      `git -C "${rootDir}" log --name-only --pretty=format: --diff-filter=M`,
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    const counts = {};
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) counts[f] = (counts[f] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([file, edits]) => ({ file, edits }));
  } catch {
    return [];
  }
}

function getGitLog(limit = 20) {
  try {
    const out = execSync(
      `git -C "${rootDir}" log --pretty=format:"%h|%an|%ad|%s" --date=short -n ${limit}`,
      { encoding: "utf8" }
    );
    return out.trim().split("\n").map(line => {
      const [hash, author, date, ...msgParts] = line.split("|");
      return { hash, author, date, message: msgParts.join("|") };
    });
  } catch {
    return [];
  }
}

function extractImports(filePath) {
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const imports = [];
    // ES import/export
    const esRe = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = esRe.exec(src)) !== null) imports.push(m[1]);
    // require()
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    while ((m = reqRe.exec(src)) !== null) imports.push(m[1]);
    return imports.filter(i => i.startsWith(".") || i.startsWith("/")); // local only
  } catch {
    return [];
  }
}

function buildDependencyGraph(flat) {
  const nodes = new Map(); // relPath → id
  const links = [];

  const codeFiles = flat.filter(
    n => n.type === "file" && CODE_EXTS.has(n.ext)
  );

  codeFiles.forEach((f, i) => nodes.set(f.path, i));

  for (const f of codeFiles) {
    const absPath = path.join(rootDir, f.path);
    const dir = path.dirname(absPath);
    for (const imp of extractImports(absPath)) {
      let resolved = path.resolve(dir, imp);
      // Try common extensions
      let target = null;
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
        const candidate = resolved + ext;
        const rel = path.relative(rootDir, candidate);
        if (nodes.has(rel)) { target = rel; break; }
      }
      // Also try index files
      if (!target) {
        for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
          const candidate = path.join(resolved, "index" + ext);
          const rel = path.relative(rootDir, candidate);
          if (nodes.has(rel)) { target = rel; break; }
        }
      }
      if (target && target !== f.path) {
        links.push({ source: nodes.get(f.path), target: nodes.get(target) });
      }
    }
  }

  const nodeList = codeFiles.map((f, i) => ({
    id: i,
    name: f.name,
    path: f.path,
    lines: f.lines || 0,
    ext: f.ext,
  }));

  return { nodes: nodeList, links };
}

function treeToHtml(nodes, maxDepth = 4) {
  if (!nodes || nodes.length === 0) return "";
  let html = "<ul>";
  for (const n of nodes) {
    if (n.depth > maxDepth) continue;
    if (n.type === "dir") {
      html += `<li class="tree-dir"><span class="tree-toggle">▶</span> 📁 <strong>${n.name}</strong>`;
      if (n.children && n.children.length) {
        html += `<div class="tree-children collapsed">${treeToHtml(n.children, maxDepth)}</div>`;
      }
      html += "</li>";
    } else {
      const icon = CODE_EXTS.has(n.ext) ? "📄" : "📝";
      html += `<li class="tree-file">${icon} ${n.name} <span class="lines">${n.lines ? n.lines + " lines" : ""}</span></li>`;
    }
  }
  html += "</ul>";
  return html;
}

// ── Collect all data ──────────────────────────────────────────────────────────
console.log("🔍 Scanning directory:", rootDir);
const tree = walkDir(rootDir);
const flat = flattenTree(tree);
const fileStats = getFileStats(flat);
const hotspots = getGitHotspots(20);
const gitLog = getGitLog(20);
const depGraph = buildDependencyGraph(flat);

const totalFiles = flat.filter(n => n.type === "file").length;
const totalDirs = flat.filter(n => n.type === "dir").length;
const totalLines = flat.reduce((s, n) => s + (n.lines || 0), 0);
const codeFiles = flat.filter(n => n.type === "file" && CODE_EXTS.has(n.ext));

console.log(`  Files: ${totalFiles}, Dirs: ${totalDirs}, Lines: ${totalLines.toLocaleString()}`);
console.log(`  Code files: ${codeFiles.length}, Dependencies: ${depGraph.links.length}`);
console.log(`  Git hotspots: ${hotspots.length}, Git commits: ${gitLog.length}`);

// ── Generate HTML ─────────────────────────────────────────────────────────────
const treeHtml = treeToHtml(tree);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Analysis Report – ${path.basename(rootDir)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --accent: #7c3aed; --accent2: #06b6d4; --accent3: #10b981;
    --text: #e2e8f0; --muted: #64748b; --warn: #f59e0b; --danger: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.6 'Segoe UI', system-ui, sans-serif; }
  a { color: var(--accent2); }
  header {
    background: linear-gradient(135deg, #1e1b4b, #0f1117);
    border-bottom: 1px solid var(--border);
    padding: 20px 32px;
    display: flex; align-items: center; justify-content: space-between;
  }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header h1 span { color: var(--accent2); }
  header .meta { color: var(--muted); font-size: 12px; }
  nav {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 0 32px; display: flex; gap: 4px;
  }
  nav button {
    background: none; border: none; color: var(--muted);
    padding: 12px 18px; cursor: pointer; font-size: 13px;
    border-bottom: 2px solid transparent; transition: all .15s;
  }
  nav button.active, nav button:hover { color: var(--text); border-color: var(--accent); }
  .tab-pane { display: none; padding: 28px 32px; }
  .tab-pane.active { display: block; }
  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px; margin-bottom: 28px;
  }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px; text-align: center;
  }
  .stat-card .value { font-size: 2rem; font-weight: 700; color: var(--accent2); }
  .stat-card .label { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 20px; margin-bottom: 20px;
  }
  .card h3 { font-size: 1rem; margin-bottom: 14px; color: var(--accent2); }
  .chart-wrap { position: relative; height: 320px; }
  .chart-wrap-tall { position: relative; height: 420px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  /* Tree */
  .tree-root { font-size: 13px; }
  .tree-root ul { list-style: none; padding-left: 18px; }
  .tree-dir { margin: 2px 0; }
  .tree-file { margin: 1px 0; color: var(--muted); }
  .tree-toggle { cursor: pointer; user-select: none; font-size: 10px; margin-right: 4px; transition: transform .15s; }
  .tree-toggle.open { display: inline-block; transform: rotate(90deg); }
  .tree-children { overflow: hidden; }
  .tree-children.collapsed { display: none; }
  .lines { font-size: 11px; color: var(--border); }
  /* Dep graph */
  #dep-graph { width: 100%; height: 520px; background: #0c0e18; border-radius: 8px; overflow: hidden; }
  .node circle { stroke-width: 1.5px; }
  .node text { fill: var(--text); font-size: 10px; pointer-events: none; }
  .link { stroke: #334155; stroke-opacity: 0.5; stroke-width: 1px; }
  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border); color: var(--muted); font-weight: 600; }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: rgba(124,58,237,.08); }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600;
  }
  .badge-ts  { background: #1d4ed8; }
  .badge-js  { background: #b45309; }
  .badge-py  { background: #166534; }
  .badge-cpp { background: #7e22ce; }
  .badge-md  { background: #374151; }
  .badge-other { background: #1e293b; }
  .hotbar { display: flex; align-items: center; gap: 8px; }
  .hotbar-fill { height: 8px; border-radius: 4px; background: var(--accent); min-width: 4px; }
  /* Git log */
  .commit-hash { font-family: monospace; color: var(--accent2); font-size: 12px; }
  .commit-date { color: var(--muted); font-size: 12px; }
  /* Search */
  .search-box {
    width: 100%; padding: 8px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: #0c0e18;
    color: var(--text); font-size: 13px; margin-bottom: 14px;
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>Code Analysis — <span>${path.basename(rootDir)}</span></h1>
    <div class="meta">Generated ${new Date().toLocaleString()} · Root: ${rootDir}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:2rem;font-weight:700;color:var(--accent3)">${totalFiles.toLocaleString()}</div>
    <div style="color:var(--muted);font-size:12px">total files</div>
  </div>
</header>

<nav id="nav">
  <button class="active" data-tab="overview">Overview</button>
  <button data-tab="tree">File Tree</button>
  <button data-tab="hotspots">Git Hotspots</button>
  <button data-tab="deps">Dependency Graph</button>
  <button data-tab="gitlog">Git History</button>
</nav>

<!-- ═══════════ OVERVIEW ═══════════ -->
<div class="tab-pane active" id="tab-overview">
  <div class="stats-grid">
    <div class="stat-card"><div class="value">${totalFiles.toLocaleString()}</div><div class="label">Total Files</div></div>
    <div class="stat-card"><div class="value">${totalDirs.toLocaleString()}</div><div class="label">Directories</div></div>
    <div class="stat-card"><div class="value">${totalLines.toLocaleString()}</div><div class="label">Total Lines</div></div>
    <div class="stat-card"><div class="value">${codeFiles.length.toLocaleString()}</div><div class="label">Code Files</div></div>
    <div class="stat-card"><div class="value">${depGraph.links.length.toLocaleString()}</div><div class="label">Local Imports</div></div>
    <div class="stat-card"><div class="value">${gitLog.length}</div><div class="label">Recent Commits</div></div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h3>Files by Extension</h3>
      <div class="chart-wrap"><canvas id="extChart"></canvas></div>
    </div>
    <div class="card">
      <h3>Lines of Code by Extension</h3>
      <div class="chart-wrap"><canvas id="locChart"></canvas></div>
    </div>
  </div>

  <div class="card">
    <h3>Top File Types (detail)</h3>
    <table>
      <thead><tr><th>Extension</th><th>Files</th><th>Lines</th><th>Avg Lines/File</th></tr></thead>
      <tbody>
        ${fileStats.slice(0, 15).map(s => `
          <tr>
            <td><span class="badge badge-${s.ext.replace('.','')}">${s.ext || '—'}</span></td>
            <td>${s.count}</td>
            <td>${s.lines.toLocaleString()}</td>
            <td>${s.count ? Math.round(s.lines / s.count) : 0}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  </div>
</div>

<!-- ═══════════ FILE TREE ═══════════ -->
<div class="tab-pane" id="tab-tree">
  <div class="card">
    <h3>Directory Structure</h3>
    <input class="search-box" id="tree-search" placeholder="Filter files…">
    <div class="tree-root" id="tree-root">${treeHtml}</div>
  </div>
</div>

<!-- ═══════════ GIT HOTSPOTS ═══════════ -->
<div class="tab-pane" id="tab-hotspots">
  <div class="card">
    <h3>Most Frequently Modified Files (git history)</h3>
    ${hotspots.length === 0
      ? '<p style="color:var(--muted)">No git history found or no modifications detected.</p>'
      : `<div class="chart-wrap-tall"><canvas id="hotspotChart"></canvas></div>`}
  </div>
  ${hotspots.length > 0 ? `
  <div class="card">
    <h3>Hotspot Table</h3>
    <table>
      <thead><tr><th>File</th><th>Edit Count</th><th>Heat</th></tr></thead>
      <tbody>
        ${hotspots.map(h => {
          const pct = Math.round((h.edits / hotspots[0].edits) * 100);
          return `<tr>
            <td style="font-family:monospace">${h.file}</td>
            <td>${h.edits}</td>
            <td><div class="hotbar"><div class="hotbar-fill" style="width:${pct}px"></div>${pct}%</div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>` : ""}
</div>

<!-- ═══════════ DEPENDENCY GRAPH ═══════════ -->
<div class="tab-pane" id="tab-deps">
  <div class="card">
    <h3>Local Import Graph — ${depGraph.nodes.length} nodes · ${depGraph.links.length} edges</h3>
    <p style="color:var(--muted);font-size:12px;margin-bottom:12px">
      Nodes = source files · Edges = local imports/requires · Size = lines of code · Drag to explore
    </p>
    <div id="dep-graph"></div>
  </div>
</div>

<!-- ═══════════ GIT HISTORY ═══════════ -->
<div class="tab-pane" id="tab-gitlog">
  <div class="card">
    <h3>Recent Commits</h3>
    ${gitLog.length === 0
      ? '<p style="color:var(--muted)">No git history found.</p>'
      : `<table>
          <thead><tr><th>Hash</th><th>Author</th><th>Date</th><th>Message</th></tr></thead>
          <tbody>
            ${gitLog.map(c => `<tr>
              <td class="commit-hash">${c.hash}</td>
              <td>${c.author || "—"}</td>
              <td class="commit-date">${c.date}</td>
              <td>${c.message}</td>
            </tr>`).join("")}
          </tbody>
        </table>`}
  </div>
</div>

<script>
// ── Tab switching ──────────────────────────────────────────────────────────
const tabs = document.querySelectorAll('[data-tab]');
tabs.forEach(btn => btn.addEventListener('click', () => {
  tabs.forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'deps') initDepGraph();
}));

// ── Charts ─────────────────────────────────────────────────────────────────
const PALETTE = [
  '#7c3aed','#06b6d4','#10b981','#f59e0b','#ef4444',
  '#8b5cf6','#22d3ee','#34d399','#fbbf24','#f87171',
  '#a78bfa','#67e8f9','#6ee7b7','#fcd34d','#fca5a5',
];

const extData = ${JSON.stringify(fileStats.slice(0, 12))};
const extLabels = extData.map(d => d.ext);
const extCounts = extData.map(d => d.count);
const extLines  = extData.map(d => d.lines);

new Chart(document.getElementById('extChart'), {
  type: 'doughnut',
  data: { labels: extLabels, datasets: [{ data: extCounts, backgroundColor: PALETTE, borderWidth: 0 }] },
  options: { plugins: { legend: { labels: { color: '#e2e8f0' } } }, cutout: '55%' },
});

new Chart(document.getElementById('locChart'), {
  type: 'bar',
  data: { labels: extLabels, datasets: [{ label: 'Lines', data: extLines, backgroundColor: PALETTE, borderRadius: 6 }] },
  options: {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#e2e8f0' }, grid: { display: false } },
    },
  },
});

${hotspots.length > 0 ? `
const hotData = ${JSON.stringify(hotspots)};
new Chart(document.getElementById('hotspotChart'), {
  type: 'bar',
  data: {
    labels: hotData.map(h => h.file.split('/').slice(-2).join('/')),
    datasets: [{ label: 'Edits', data: hotData.map(h => h.edits), backgroundColor: '#7c3aed', borderRadius: 6 }],
  },
  options: {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#e2e8f0', font: { size: 11 } }, grid: { display: false } },
    },
  },
});` : ""}

// ── Tree toggle ────────────────────────────────────────────────────────────
document.getElementById('tree-root').addEventListener('click', e => {
  const toggle = e.target.closest('.tree-toggle');
  if (!toggle) return;
  toggle.classList.toggle('open');
  const children = toggle.closest('li').querySelector('.tree-children');
  if (children) children.classList.toggle('collapsed');
});

// ── Tree search ────────────────────────────────────────────────────────────
document.getElementById('tree-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.tree-file').forEach(el => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
});

// ── Dependency Graph (D3 force) ────────────────────────────────────────────
let depInited = false;
function initDepGraph() {
  if (depInited) return;
  depInited = true;

  const graphData = ${JSON.stringify(depGraph)};
  if (!graphData.nodes.length) {
    document.getElementById('dep-graph').innerHTML =
      '<p style="padding:20px;color:#64748b">No local imports found in code files.</p>';
    return;
  }

  const container = document.getElementById('dep-graph');
  const W = container.clientWidth, H = container.clientHeight;
  const maxLines = Math.max(...graphData.nodes.map(n => n.lines || 1));

  const extColor = {
    '.ts': '#1d4ed8', '.tsx': '#2563eb', '.js': '#d97706', '.jsx': '#f59e0b',
    '.py': '#16a34a', '.cpp': '#7e22ce', '.c': '#6b21a8', '.h': '#9333ea',
    '.java': '#b91c1c', '.go': '#0891b2', '.rs': '#c2410c', default: '#475569',
  };

  const svg = d3.select('#dep-graph').append('svg')
    .attr('width', W).attr('height', H);

  svg.append('defs').append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 14).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#334155');

  const g = svg.append('g');

  svg.call(d3.zoom().scaleExtent([0.1, 4])
    .on('zoom', ev => g.attr('transform', ev.transform)));

  const nodes = graphData.nodes.map(d => ({ ...d }));
  const links = graphData.links.map(d => ({ ...d }));

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide(20));

  const link = g.append('g').selectAll('line').data(links).join('line')
    .attr('class', 'link')
    .attr('marker-end', 'url(#arrow)');

  const node = g.append('g').selectAll('g').data(nodes).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append('circle')
    .attr('r', d => 5 + Math.sqrt((d.lines / maxLines) * 200))
    .attr('fill', d => extColor[d.ext] || extColor.default)
    .attr('stroke', '#7c3aed');

  node.append('title').text(d => \`\${d.path}\\n\${d.lines} lines\`);

  node.append('text')
    .attr('dy', d => -(6 + Math.sqrt((d.lines / maxLines) * 200)))
    .attr('text-anchor', 'middle')
    .text(d => d.name.length > 18 ? d.name.slice(0, 16) + '…' : d.name);

  sim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });
}
</script>
</body>
</html>`;

fs.writeFileSync(outputFile, html, "utf8");
console.log(`\n✅ Report written to: ${outputFile}`);
console.log(`   Open in browser: open "${outputFile}"`);
