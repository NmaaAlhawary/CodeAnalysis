import * as vscode from "vscode";
import { getAIProvider, getStoredApiKey } from "./geminiClient";
import { getCachedIndex } from "./indexer";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeAnalyzerSidebar";
  private _view?: vscode.WebviewView;
  private _hasKey = false;
  private _maskedKey = "";
  private _providerLabel = "Claude";
  private _isIndexed = false;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._html();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command) {
        await vscode.commands.executeCommand(msg.command);
        if (msg.command === "codeAnalyzer.configureGemini" || msg.command === "codeAnalyzer.reindex") {
          setTimeout(() => void this.refresh(), 400);
        }
      }
    }, undefined, this._context.subscriptions);

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const provider = getAIProvider();
    const apiKey = await getStoredApiKey(this._context, provider);
    this._hasKey = apiKey.length > 0;
    this._maskedKey = this._hasKey ? `${apiKey.slice(0, 8)}···${apiKey.slice(-4)}` : "";
    this._providerLabel = provider === "deepseek" ? "DeepSeek" : provider === "gemini" ? "Gemini" : "Claude";

    const index = getCachedIndex(this._context);
    this._isIndexed = !!(index && vscode.workspace.workspaceFolders?.[0]?.uri.fsPath && index.rootDir === vscode.workspace.workspaceFolders[0].uri.fsPath);

    if (this._view) {
      this._view.webview.html = this._html();
    }
  }

  private _html(): string {
    const { _hasKey: hasKey, _maskedKey: maskedKey, _providerLabel: providerLabel, _isIndexed: isIndexed } = this;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family,system-ui,-apple-system,sans-serif);
  font-size:13px;
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background);
  padding:0 0 16px 0;
  overflow-x:hidden;
}

/* ── Header ── */
.header{
  padding:14px 14px 12px;
  background:linear-gradient(135deg,rgba(124,58,237,.15) 0%,rgba(6,182,212,.08) 100%);
  border-bottom:1px solid rgba(124,58,237,.2);
  margin-bottom:10px;
}
.logo-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.logo-icon{
  width:28px;height:28px;border-radius:7px;
  background:linear-gradient(135deg,#7c3aed,#06b6d4);
  display:flex;align-items:center;justify-content:center;
  font-size:14px;flex-shrink:0;color:#fff;font-weight:700;
}
.logo-text{font-size:13px;font-weight:700;color:var(--vscode-foreground);letter-spacing:-.01em}
.logo-sub{font-size:10px;color:#64748b;margin-top:1px}

/* ── Status chips ── */
.status-row{display:flex;gap:6px}
.chip{
  display:flex;align-items:center;gap:5px;
  padding:4px 8px;border-radius:20px;font-size:10px;font-weight:600;
  border:1px solid transparent;cursor:pointer;transition:all .15s;flex:1;
  white-space:nowrap;overflow:hidden;
}
.chip:hover{filter:brightness(1.15)}
.chip-ai{
  background:rgba(124,58,237,.12);
  border-color:${hasKey ? "rgba(16,185,129,.3)" : "rgba(100,116,139,.2)"};
  color:${hasKey ? "#10b981" : "#64748b"};
}
.chip-idx{
  background:rgba(6,182,212,.08);
  border-color:${isIndexed ? "rgba(6,182,212,.3)" : "rgba(100,116,139,.2)"};
  color:${isIndexed ? "#06b6d4" : "#64748b"};
}
.chip-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;
  background:${hasKey ? "#10b981" : "#475569"}}
.chip-dot-idx{width:5px;height:5px;border-radius:50%;flex-shrink:0;
  background:${isIndexed ? "#06b6d4" : "#475569"}}
.chip-label{overflow:hidden;text-overflow:ellipsis}

/* ── Primary chat button ── */
.btn-primary{
  display:flex;align-items:center;gap:10px;width:100%;
  padding:10px 14px;border:none;border-radius:8px;
  background:linear-gradient(135deg,#7c3aed,#6d28d9);
  color:#fff;font-family:inherit;font-size:12px;font-weight:600;
  cursor:pointer;text-align:left;margin:0 0 10px;
  transition:all .15s;box-shadow:0 2px 8px rgba(124,58,237,.3);
}
.btn-primary:hover{background:linear-gradient(135deg,#8b5cf6,#7c3aed);box-shadow:0 4px 12px rgba(124,58,237,.4);transform:translateY(-1px)}
.btn-primary:active{transform:none;box-shadow:none}
.btn-primary .kbd{
  margin-left:auto;font-size:9px;
  background:rgba(255,255,255,.15);border-radius:4px;
  padding:2px 5px;font-weight:500;flex-shrink:0;
}

/* ── Section header ── */
.sec{
  font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:#475569;padding:0 14px 5px;margin-top:6px;
}
.divider{height:1px;background:rgba(255,255,255,.05);margin:8px 14px}

/* ── Action buttons ── */
.action{
  display:flex;align-items:center;gap:10px;width:100%;
  padding:7px 14px;border:none;border-radius:0;
  background:transparent;color:var(--vscode-foreground);
  font-family:inherit;font-size:12px;cursor:pointer;text-align:left;
  transition:background .1s;
}
.action:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.06))}
.action:active{background:var(--vscode-list-activeSelectionBackground)}
.action-icon{
  width:22px;height:22px;border-radius:5px;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;flex-shrink:0;
}
.ic-purple{background:rgba(124,58,237,.15);color:#a78bfa}
.ic-cyan{background:rgba(6,182,212,.12);color:#06b6d4}
.ic-green{background:rgba(16,185,129,.12);color:#34d399}
.ic-orange{background:rgba(249,115,22,.12);color:#fb923c}
.ic-pink{background:rgba(236,72,153,.12);color:#f472b6}
.ic-blue{background:rgba(59,130,246,.12);color:#60a5fa}
.ic-gray{background:rgba(100,116,139,.1);color:#94a3b8}
.action-text{flex:1;min-width:0}
.action-label{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.action-desc{font-size:10px;color:#64748b;margin-top:1px}
.action-kbd{
  font-size:9px;flex-shrink:0;
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.1);
  border-radius:3px;padding:1px 4px;color:#64748b;
}

/* ── Dashboard card ── */
.dash-card{
  margin:0 10px 10px;border-radius:8px;
  border:1px solid rgba(6,182,212,.2);
  background:rgba(6,182,212,.05);
  overflow:hidden;cursor:pointer;transition:all .15s;
}
.dash-card:hover{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.1)}
.dash-inner{padding:10px 12px;display:flex;align-items:center;gap:10px}
.dash-icon{font-size:18px}
.dash-text{flex:1}
.dash-title{font-size:12px;font-weight:600;color:#06b6d4}
.dash-sub{font-size:10px;color:#64748b;margin-top:1px}
.dash-arrow{color:#06b6d4;font-size:14px}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="logo-row">
    <div class="logo-icon">CA</div>
    <div>
      <div class="logo-text">Code Analyzer</div>
      <div class="logo-sub">AI-powered codebase intelligence</div>
    </div>
  </div>
  <div class="status-row">
    <div class="chip chip-ai" onclick="run('codeAnalyzer.configureGemini')" title="Configure AI provider">
      <div class="chip-dot"></div>
      <div class="chip-label">${hasKey ? `${providerLabel} ready` : `Set ${providerLabel} key`}</div>
    </div>
    <div class="chip chip-idx" onclick="run('codeAnalyzer.reindex')" title="${isIndexed ? "Re-index workspace" : "Index workspace now"}">
      <div class="chip-dot-idx"></div>
      <div class="chip-label">${isIndexed ? "Indexed" : "Not indexed"}</div>
    </div>
  </div>
</div>

<div style="padding:0 10px 2px">
  <button class="btn-primary" onclick="run('codeAnalyzer.openChat')">
    <span>💬</span>
    <div>
      <div>Chat with AI</div>
      <div style="font-size:10px;font-weight:400;opacity:.75;margin-top:1px">Ask anything about your codebase</div>
    </div>
    <span class="kbd">⌘⇧C</span>
  </button>
</div>

<!-- Dashboard -->
<div class="dash-card" onclick="run('codeAnalyzer.openDashboard')">
  <div class="dash-inner">
    <div class="dash-icon">📊</div>
    <div class="dash-text">
      <div class="dash-title">Dashboard</div>
      <div class="dash-sub">Deps · call graph · git · coupling · symbols</div>
    </div>
    <div class="dash-arrow">›</div>
  </div>
</div>

<!-- AI Tools -->
<div class="sec">Analyze</div>

<button class="action" onclick="run('codeAnalyzer.explainSelection')">
  <div class="action-icon ic-purple">✦</div>
  <div class="action-text">
    <div class="action-label">Explain Selection</div>
    <div class="action-desc">AI explanation of selected code</div>
  </div>
  <span class="action-kbd">⌘⇧E</span>
</button>

<button class="action" onclick="run('codeAnalyzer.explainFile')">
  <div class="action-icon ic-purple">📄</div>
  <div class="action-text">
    <div class="action-label">Explain File</div>
    <div class="action-desc">Deep dive with full project context</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.businessLogic')">
  <div class="action-icon ic-cyan">🧠</div>
  <div class="action-text">
    <div class="action-label">Business Logic</div>
    <div class="action-desc">What does this project actually do?</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.codeReview')">
  <div class="action-icon ic-orange">👁</div>
  <div class="action-text">
    <div class="action-label">AI Code Review</div>
    <div class="action-desc">Review current file's git diff</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.findRelatedFiles')">
  <div class="action-icon ic-blue">🔗</div>
  <div class="action-text">
    <div class="action-label">Find Related Files</div>
    <div class="action-desc">Explore module dependencies</div>
  </div>
</button>

<div class="divider"></div>
<div class="sec">Diagrams</div>

<button class="action" onclick="run('codeAnalyzer.generateWorkspaceDiagram')">
  <div class="action-icon ic-cyan">🗺</div>
  <div class="action-text">
    <div class="action-label">Workspace Diagram</div>
    <div class="action-desc">Full architecture as Mermaid</div>
  </div>
  <span class="action-kbd">⌘⇧G</span>
</button>

<button class="action" onclick="run('codeAnalyzer.generateDiagram')">
  <div class="action-icon ic-purple">◈</div>
  <div class="action-text">
    <div class="action-label">Diagram from Selection</div>
    <div class="action-desc">Visual diagram of selected code</div>
  </div>
</button>

<div class="divider"></div>
<div class="sec">Documentation</div>

<button class="action" onclick="run('codeAnalyzer.generateReadme')">
  <div class="action-icon ic-green">📝</div>
  <div class="action-text">
    <div class="action-label">Generate README</div>
    <div class="action-desc">Auto-write project README.md</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.generateInlineDocs')">
  <div class="action-icon ic-green">✍</div>
  <div class="action-text">
    <div class="action-label">Inline Docs</div>
    <div class="action-desc">Add JSDoc/TSDoc to this file</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.generateArchitectureDoc')">
  <div class="action-icon ic-green">🏗</div>
  <div class="action-text">
    <div class="action-label">Architecture Doc</div>
    <div class="action-desc">Generate ARCHITECTURE.md</div>
  </div>
</button>

<button class="action" onclick="run('codeAnalyzer.analyzeGithubRepo')">
  <div class="action-icon ic-pink">⬡</div>
  <div class="action-text">
    <div class="action-label">Analyze GitHub Repo</div>
    <div class="action-desc">Paste any public GitHub URL</div>
  </div>
</button>

<div class="divider"></div>

<button class="action" onclick="run('codeAnalyzer.configureGemini')">
  <div class="action-icon ic-gray">⚙</div>
  <div class="action-text">
    <div class="action-label">Configure AI Provider</div>
    <div class="action-desc">${hasKey ? maskedKey : "Set API key · Claude / DeepSeek / Gemini"}</div>
  </div>
</button>

<script>
const vscode = acquireVsCodeApi();
function run(command) { vscode.postMessage({ command }); }
</script>
</body>
</html>`;
  }
}
