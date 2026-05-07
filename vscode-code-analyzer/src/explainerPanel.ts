import * as vscode from "vscode";
import { staticAnalyzeCode, StaticCodeInfo } from "./analyzer";
import { generateWithAIStreaming, AIMessage } from "./geminiClient";
import { extractFirstMermaid, mermaidToDrawioXml } from "./drawioExporter";
import { buildIndex, getCachedIndex } from "./indexer";
import { buildAIContext } from "./contextBuilder";

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}

export type ExplainMode = "selection" | "file" | "businessLogic" | "diagram" | "workspaceDiagram";

export class ExplainerPanel {
  public static currentPanel: ExplainerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _lastRun: {
    code: string; languageId: string; mode: ExplainMode;
    fileName?: string; rootDir?: string; focusFile?: string;
  } | undefined;
  private _lastMarkdown = "";
  private _lastTitle = "Code Explainer";
  private _mermaidRetries = 0;
  private _currentNonce = "";
  private _streamAbort: AbortController | null = null;

  public static async explain(
    context: vscode.ExtensionContext,
    code: string,
    languageId: string,
    mode: ExplainMode = "selection",
    fileName?: string,
    rootDir?: string,
    focusFile?: string
  ): Promise<void> {
    const col = vscode.ViewColumn.Beside;
    if (!ExplainerPanel.currentPanel) {
      const panel = vscode.window.createWebviewPanel(
        "codeAnalyzerExplainer", "Code Explainer", col,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      ExplainerPanel.currentPanel = new ExplainerPanel(panel, context);
    } else {
      ExplainerPanel.currentPanel._panel.reveal(col);
    }
    await ExplainerPanel.currentPanel._run(code, languageId, mode, fileName, rootDir, focusFile);
  }

  public static async explainBusinessLogic(context: vscode.ExtensionContext, rootDir: string): Promise<void> {
    await ExplainerPanel.explain(context, "", "markdown", "businessLogic", "Business Logic", rootDir);
  }

  public static async explainWorkspaceDiagram(context: vscode.ExtensionContext, rootDir: string): Promise<void> {
    const wsName = vscode.workspace.workspaceFolders?.[0]?.name || "Workspace";
    await ExplainerPanel.explain(context, "", "markdown", "workspaceDiagram", wsName, rootDir);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly _context: vscode.ExtensionContext) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (!message || typeof message !== "object") { return; }

        if (message.type === "copy") {
          await vscode.env.clipboard.writeText(this._lastMarkdown || "");
          void vscode.window.showInformationMessage("Copied to clipboard.");
          return;
        }

        if (message.type === "save") {
          const defaultUri = vscode.Uri.joinPath(this._context.globalStorageUri, `${this._sanitizeFileName(this._lastTitle)}.md`);
          const target = await vscode.window.showSaveDialog({ defaultUri, filters: { Markdown: ["md"] }, title: "Save as Markdown" });
          if (!target) { return; }
          await vscode.workspace.fs.writeFile(target, Buffer.from(this._lastMarkdown || "", "utf8"));
          void vscode.window.showInformationMessage(`Saved to ${target.fsPath}`);
          return;
        }

        if (message.type === "configureGemini") {
          await vscode.commands.executeCommand("codeAnalyzer.configureGemini");
          return;
        }

        if (message.type === "openDrawio") {
          const mermaid = extractFirstMermaid(this._lastMarkdown);
          if (!mermaid) { void vscode.window.showWarningMessage("No diagram found. Generate a diagram first."); return; }
          const xml = mermaidToDrawioXml(mermaid, this._lastTitle);
          await vscode.workspace.fs.createDirectory(this._context.globalStorageUri);
          const fileUri = vscode.Uri.joinPath(this._context.globalStorageUri, `${this._sanitizeFileName(this._lastTitle)}-${Date.now()}.drawio`);
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(xml, "utf8"));
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, { preview: false });
          return;
        }

        if (message.type === "openFile") {
          const rawPath = (message.path as string || "").trim();
          if (!rawPath) { return; }
          const [ws] = vscode.workspace.workspaceFolders ?? [];
          if (!ws) { return; }
          const found = await vscode.workspace.findFiles(`**/${rawPath.replace(/\/$/, "")}`, "**/node_modules/**", 1);
          if (found.length > 0) {
            try {
              const doc = await vscode.workspace.openTextDocument(found[0]);
              await vscode.window.showTextDocument(doc, { preview: true });
            } catch { await vscode.commands.executeCommand("revealInExplorer", found[0]); }
            return;
          }
          await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.joinPath(ws.uri, rawPath));
          return;
        }

        if (message.type === "mermaidError" && this._mermaidRetries < 2) {
          this._mermaidRetries++;
          const fixPrompt = `The Mermaid diagram has a syntax error: "${message.error}"\n\nOriginal:\n\`\`\`\n${message.code}\n\`\`\`\n\nFix it and return ONLY the corrected mermaid code block.\nRules:\n- Declare every node before using it in an edge: A[Label]\n- No parentheses (), angle brackets <>, pipes |, or backticks in labels\n- ASCII-only node IDs`;
          try {
            let fixed = "";
            await generateWithAIStreaming(
              [{ role: "user", content: fixPrompt }],
              (chunk) => { fixed += chunk; },
              {},
              this._context
            );
            this._lastMarkdown = fixed;
            this._panel.webview.postMessage({ type: "done", text: fixed, model: "retry" });
          } catch { /* ignore */ }
          return;
        }

        if (message.type === "stopStream") {
          this._streamAbort?.abort();
          this._streamAbort = null;
          return;
        }

        if (message.type === "regenerate" && this._lastRun) {
          this._mermaidRetries = 0;
          await this._run(
            this._lastRun.code, this._lastRun.languageId, this._lastRun.mode,
            this._lastRun.fileName, this._lastRun.rootDir, this._lastRun.focusFile
          );
        }
      },
      null,
      this._disposables
    );
  }

  private async _run(
    code: string,
    languageId: string,
    mode: ExplainMode,
    fileName?: string,
    rootDir?: string,
    focusFile?: string
  ): Promise<void> {
    const staticInfo = (mode !== "businessLogic" && mode !== "workspaceDiagram" && code.trim())
      ? staticAnalyzeCode(code, languageId)
      : null;

    const nonce = getNonce();
    this._currentNonce = nonce;

    const titleMap: Record<ExplainMode, string> = {
      selection: "Explain Code",
      file: fileName ? `Explain — ${fileName}` : "Explain File",
      businessLogic: "Business Logic",
      diagram: "Code Diagram",
      workspaceDiagram: fileName ? `Architecture — ${fileName}` : "Architecture Overview",
    };
    const title = titleMap[mode];

    this._lastRun   = { code, languageId, mode, fileName, rootDir, focusFile };
    this._lastTitle = title;
    this._lastMarkdown = "";
    this._mermaidRetries = 0;

    this._panel.webview.html = this._shellHtml(nonce, title, staticInfo);
    this._panel.title = title;

    await this._streamAI(code, languageId, mode, staticInfo, nonce, title, rootDir, focusFile);
  }

  private async _streamAI(
    code: string,
    languageId: string,
    mode: ExplainMode,
    staticInfo: StaticCodeInfo | null,
    nonce: string,
    title: string,
    rootDir?: string,
    focusFile?: string
  ): Promise<void> {
    // Wait for webview to signal it is ready before streaming chunks
    let webviewReady = false;
    const pendingChunks: string[] = [];

    const readySub = this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "webviewReady") {
        webviewReady = true;
        if (pendingChunks.length > 0) {
          this._panel.webview.postMessage({ type: "chunk", text: pendingChunks.join("") });
        }
        readySub.dispose();
      }
    });

    this._streamAbort?.abort();
    this._streamAbort = new AbortController();
    const abortSignal = this._streamAbort.signal;

    try {
      const messages = await this._buildMessages(code, languageId, mode, staticInfo, rootDir, focusFile);
      let accum = "";

      const result = await generateWithAIStreaming(
        messages,
        (chunk) => {
          accum += chunk;
          if (webviewReady) {
            this._panel.webview.postMessage({ type: "chunk", text: accum });
          } else {
            pendingChunks.push(chunk);
          }
        },
        { maxTokens: 8192, signal: abortSignal },
        this._context
      );

      this._lastMarkdown = result.text;
      this._panel.webview.postMessage({ type: "done", text: result.text, model: result.model });
    } catch (err: any) {
      readySub.dispose();
      const errMsg = err?.message || String(err);
      const isKeyErr = /API key not configured|not configured/i.test(errMsg);
      this._panel.webview.postMessage({
        type: "error",
        isKeyErr,
        message: isKeyErr
          ? "No AI key configured. Run \"Code Analyzer: Configure AI Provider\" to add one."
          : errMsg,
      });
    }
  }

  private async _buildMessages(
    code: string,
    languageId: string,
    mode: ExplainMode,
    staticInfo: StaticCodeInfo | null,
    rootDir?: string,
    focusFile?: string
  ): Promise<AIMessage[]> {
    if ((mode === "businessLogic" || mode === "workspaceDiagram") && rootDir) {
      let index = getCachedIndex(this._context);
      if (!index || index.rootDir !== rootDir) {
        try { index = await buildIndex(rootDir, this._context); } catch { /* fallback */ }
      }
      if (index) {
        const aiContext = buildAIContext(index, { mode: "architecture", tokenBudget: 22000 }, rootDir);
        const prompt = mode === "businessLogic"
          ? buildBusinessLogicPrompt(aiContext)
          : buildWorkspaceDiagramPrompt(aiContext);
        return [{ role: "user", content: prompt }];
      }
    }

    if (mode === "file" && rootDir && focusFile) {
      const index = getCachedIndex(this._context);
      if (index) {
        const aiContext = buildAIContext(index, { mode: "file-explain", focusFile, tokenBudget: 16000 }, rootDir);
        return [{ role: "user", content: buildFileExplainPrompt(code, languageId, staticInfo, aiContext) }];
      }
    }

    return [{ role: "user", content: buildPrompt(code, languageId, mode, staticInfo) }];
  }

  private _shellHtml(nonce: string, title: string, staticInfo: StaticCodeInfo | null): string {
    const staticHtml = staticInfo ? renderStaticInfo(staticInfo) : "";
    const isDiagram = title.toLowerCase().includes("diagram");

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           style-src 'nonce-${nonce}';
           img-src data: https: blob:;">
<title>${title}</title>
<style nonce="${nonce}">
:root{
  --bg:#0b0e16;--surf:#111827;--surf2:#1a1f2e;
  --bdr:rgba(255,255,255,.07);--bdr2:rgba(255,255,255,.12);
  --acc:#7c3aed;--acc2:#06b6d4;--green:#10b981;
  --tx:#e2e8f0;--tx2:#94a3b8;--tx3:#475569;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--tx);font:13px/1.7 var(--vscode-font-family,system-ui,-apple-system,sans-serif);display:flex;flex-direction:column}

/* ── Header ── */
header{
  background:linear-gradient(135deg,rgba(124,58,237,.2) 0%,rgba(11,14,22,1) 60%);
  border-bottom:1px solid var(--bdr);
  padding:10px 16px;
  display:flex;align-items:center;gap:10px;
  flex-shrink:0;
}
.hd-left{display:flex;align-items:center;gap:9px;flex:1;min-width:0}
.hd-icon{
  width:26px;height:26px;border-radius:6px;flex-shrink:0;
  background:linear-gradient(135deg,#7c3aed,#06b6d4);
  display:flex;align-items:center;justify-content:center;
  font-size:12px;color:#fff;
}
header h1{font-size:.88rem;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model-chip{
  font-size:9px;font-weight:600;flex-shrink:0;
  background:rgba(124,58,237,.15);border:1px solid rgba(124,58,237,.3);
  border-radius:20px;padding:2px 8px;color:var(--acc2);
  display:none;
}
.spinner{
  width:14px;height:14px;border-radius:50%;flex-shrink:0;
  border:2px solid rgba(124,58,237,.3);border-top-color:#7c3aed;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.toolbar{display:flex;gap:5px;flex-shrink:0}
.tb{
  background:rgba(255,255,255,.05);
  border:1px solid var(--bdr);color:var(--tx2);
  border-radius:6px;padding:4px 10px;font-size:11px;
  cursor:pointer;white-space:nowrap;font-family:inherit;
  transition:all .12s;
}
.tb:hover{background:rgba(255,255,255,.1);border-color:var(--bdr2);color:var(--tx)}

/* ── Diagram toolbar ── */
#diag-bar{
  display:none;align-items:center;gap:8px;
  padding:6px 16px;background:rgba(6,182,212,.04);
  border-bottom:1px solid rgba(6,182,212,.15);
  flex-shrink:0;
}
#diag-search{
  flex:1;max-width:240px;background:rgba(255,255,255,.05);
  border:1px solid var(--bdr);border-radius:6px;
  padding:4px 10px;color:var(--tx);font-size:11px;
  outline:none;font-family:inherit;
}
#diag-search:focus{border-color:var(--acc2)}
#diag-search::placeholder{color:var(--tx3)}
.zoom-row{display:flex;align-items:center;gap:4px;margin-left:auto}
#zoom-label{font-size:11px;color:var(--tx3);min-width:34px;text-align:center}

/* ── Scroll area ── */
#scroll{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px}
#scroll::-webkit-scrollbar{width:5px}
#scroll::-webkit-scrollbar-track{background:transparent}
#scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}

/* ── Static analysis ── */
.stat-row{display:flex;gap:8px;flex-wrap:wrap}
.stat-card{
  flex:1;min-width:70px;
  background:var(--surf);border:1px solid var(--bdr);
  border-radius:8px;padding:10px 12px;text-align:center;
}
.stat-val{font-size:1.4rem;font-weight:800;color:var(--acc2);line-height:1}
.stat-lbl{font-size:10px;color:var(--tx3);margin-top:3px;text-transform:uppercase;letter-spacing:.05em}
.tags-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
.tag{
  background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.2);
  border-radius:5px;padding:2px 8px;font-size:11px;
  font-family:monospace;color:var(--acc2);
}
.tag.import{background:rgba(6,182,212,.08);border-color:rgba(6,182,212,.2);color:var(--acc2)}
.todo{font-size:11px;color:#f59e0b;font-family:monospace;padding:2px 0}

/* ── AI output ── */
#ai-wrap{
  background:var(--surf);border:1px solid var(--bdr);
  border-radius:10px;overflow:hidden;flex:1;min-height:200px;
}
#ai-header{
  display:flex;align-items:center;gap:8px;
  padding:9px 14px;border-bottom:1px solid var(--bdr);
  background:rgba(124,58,237,.06);
}
#ai-header span{font-size:11px;font-weight:700;color:var(--acc2);text-transform:uppercase;letter-spacing:.06em;flex:1}
#md-output{padding:16px;font-size:13px;line-height:1.75}

/* ── Markdown styles ── */
#md-output h1,#md-output h2,#md-output h3{color:var(--tx);font-weight:700;margin:16px 0 6px}
#md-output h1{font-size:1.1rem;border-bottom:1px solid var(--bdr);padding-bottom:6px}
#md-output h2{font-size:.98rem}
#md-output h3{font-size:.88rem;color:var(--acc2)}
#md-output p{margin:6px 0;color:var(--tx)}
#md-output a{color:var(--acc2);text-decoration:none}
#md-output a:hover{text-decoration:underline}
#md-output strong{color:#f1f5f9;font-weight:700}
#md-output em{color:var(--tx2)}
#md-output code{
  background:rgba(255,255,255,.08);padding:1px 6px;
  border-radius:4px;font-family:'SF Mono','Cascadia Code','Fira Code',monospace;
  font-size:11.5px;color:#a5d6ff;
}
#md-output pre{
  background:#070a10;border:1px solid var(--bdr);
  border-radius:8px;padding:14px 16px;margin:10px 0;
  overflow-x:auto;
}
#md-output pre code{background:none;padding:0;color:#e2e8f0;font-size:12px}
#md-output ul,#md-output ol{padding-left:22px;margin:6px 0}
#md-output li{margin:3px 0;color:var(--tx)}
#md-output blockquote{
  border-left:3px solid var(--acc);padding:8px 14px;
  background:rgba(124,58,237,.06);border-radius:0 6px 6px 0;
  margin:8px 0;color:var(--tx2);
}
#md-output hr{border:none;border-top:1px solid var(--bdr);margin:16px 0}
#md-output table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px}
#md-output th{
  background:rgba(124,58,237,.1);padding:7px 10px;
  border:1px solid var(--bdr);color:var(--acc2);font-weight:600;text-align:left;
}
#md-output td{padding:6px 10px;border:1px solid var(--bdr);color:var(--tx)}
#md-output tr:hover td{background:rgba(255,255,255,.03)}

/* ── Mermaid ── */
.mermaid-wrap{
  margin:14px 0;border-radius:12px;overflow:auto;
  transform-origin:top left;transition:transform .2s;
  background:#0d1117;
  border:1px solid rgba(99,102,241,.25);
  box-shadow:0 0 40px rgba(99,102,241,.08),inset 0 1px 0 rgba(255,255,255,.04);
  padding:16px;
}
.mermaid-wrap.loading{
  background:rgba(6,182,212,.03);border:1px dashed rgba(6,182,212,.25);
  padding:28px;text-align:center;color:var(--tx3);font-size:12px;
}
/* SVG container */
.mermaid svg{
  max-width:100%!important;height:auto!important;
  display:block;margin:0 auto;
  background:transparent!important;min-height:120px;
}
/* Nodes — fill purple-dark, stroke indigo */
.mermaid .node rect,
.mermaid .node polygon,
.mermaid .node circle,
.mermaid .node ellipse,
.mermaid .node path{
  fill:#1e1b4b!important;stroke:#6366f1!important;stroke-width:1.5px!important;
}
/* Subgraph clusters — was rendering solid black */
.mermaid .cluster rect,
.mermaid .cluster polygon{
  fill:rgba(30,27,75,.45)!important;
  stroke:rgba(99,102,241,.5)!important;stroke-width:1px!important;
  stroke-dasharray:5!important;rx:8!important;
}
.mermaid .cluster text,.mermaid .cluster span{
  fill:#a5b4fc!important;color:#a5b4fc!important;font-weight:600!important;
}
/* All text inside nodes */
.mermaid .nodeLabel,.mermaid .node text,.mermaid text,
.mermaid .label,.mermaid tspan{
  fill:#e2e8f0!important;color:#e2e8f0!important;
  font-size:12.5px!important;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important;
}
/* Edge lines */
.mermaid .edgePath .path,
.mermaid .flowchart-link,
.mermaid path.path{
  stroke:#818cf8!important;stroke-width:1.6px!important;
}
/* Arrowheads */
.mermaid marker path,.mermaid marker polygon{
  fill:#818cf8!important;stroke:#818cf8!important;
}
/* Edge labels */
.mermaid .edgeLabel rect,.mermaid .edgeLabel{
  background:transparent!important;fill:transparent!important;
}
.mermaid .edgeLabel p,.mermaid .edgeLabel span{
  color:#94a3b8!important;font-size:11px!important;
  background:rgba(13,17,23,.85)!important;
  border-radius:4px!important;padding:1px 4px!important;
}
/* Sequence diagrams */
.mermaid .actor{fill:#1e1b4b!important;stroke:#6366f1!important}
.mermaid .actor-line{stroke:#475569!important}
.mermaid .messageLine0,.mermaid .messageLine1{stroke:#818cf8!important}
.mermaid .activation0,.mermaid .activation1{fill:#312e81!important;stroke:#6366f1!important}
/* Class diagrams */
.mermaid .classBox,.mermaid .class-title{
  fill:#1e1b4b!important;stroke:#6366f1!important;
}
/* Git graphs */
.mermaid .commit-label{fill:#e2e8f0!important}
.mermaid circle{fill:#7c3aed!important;stroke:#a78bfa!important}

/* ── States ── */
.thinking{
  display:flex;align-items:center;gap:10px;
  color:var(--tx3);font-size:13px;padding:6px 0;
}
.thinking-dots span{
  display:inline-block;width:5px;height:5px;border-radius:50%;
  background:var(--acc);margin:0 2px;
  animation:bounce 1.2s infinite;
}
.thinking-dots span:nth-child(2){animation-delay:.2s}
.thinking-dots span:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,80%,100%{transform:scale(.8);opacity:.4}40%{transform:scale(1);opacity:1}}
.cursor::after{content:'▋';animation:blink .9s step-start infinite;color:var(--acc2);font-weight:300}
@keyframes blink{50%{opacity:0}}
.error-box{
  background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);
  border-radius:8px;padding:14px 16px;
  color:#fca5a5;font-size:12px;line-height:1.6;
}
.error-box strong{color:#f87171;display:block;margin-bottom:4px}
</style>
</head>
<body>

<header>
  <div class="hd-left">
    <div class="hd-icon">${isDiagram ? "◈" : "✦"}</div>
    <h1 id="panel-title">${title}</h1>
    <span class="model-chip" id="model-chip"></span>
    <div class="spinner" id="spin"></div>
    <button class="tb stop-btn" id="stop-btn" title="Stop generation" style="display:none;color:#f87171;border-color:rgba(248,113,113,.3)">■ Stop</button>
  </div>
  <div class="toolbar">
    <button class="tb" id="copy-btn" title="Copy markdown">Copy</button>
    <button class="tb" id="save-btn" title="Save as .md">Save</button>
    ${isDiagram ? '<button class="tb" id="drawio-btn" title="Export to Draw.io">Draw.io</button>' : ""}
    <button class="tb" id="regen-btn" title="Regenerate">↺</button>
  </div>
</header>

${isDiagram ? `
<div id="diag-bar">
  <input id="diag-search" placeholder="Search nodes…" autocomplete="off"/>
  <div class="zoom-row">
    <button class="tb" id="zoom-out">−</button>
    <span id="zoom-label">100%</span>
    <button class="tb" id="zoom-in">+</button>
    <button class="tb" id="zoom-fit">Fit</button>
  </div>
</div>` : ""}

<div id="scroll">
  ${staticHtml}
  <div id="ai-wrap">
    <div id="ai-header">
      <span>✦ AI Analysis</span>
    </div>
    <div id="md-output">
      <div class="thinking">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        Analyzing…
      </div>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script nonce="${nonce}">
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  flowchart: {
    nodeSpacing: 50,
    rankSpacing: 70,
    curve: 'cardinal',
    padding: 20,
    useMaxWidth: true,
    htmlLabels: true,
  },
  sequence: { actorMargin: 60, boxMargin: 10, mirrorActors: false },
  themeVariables: {
    darkMode: true,
    background: '#0d1117',
    mainBkg: '#1e1b4b',
    nodeBorder: '#6366f1',
    clusterBkg: '#1a1740',
    clusterBorder: '#6366f1',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#0d1117',
    lineColor: '#818cf8',
    primaryColor: '#1e1b4b',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#6366f1',
    secondaryColor: '#1a1d35',
    tertiaryColor: '#161928',
    noteBkgColor: '#1e1b4b',
    noteTextColor: '#e2e8f0',
    noteBorderColor: '#6366f1',
    fontSize: '13px',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  }
});

const vscode = acquireVsCodeApi();
const out     = document.getElementById('md-output');
const spin    = document.getElementById('spin');
const stopBtn = document.getElementById('stop-btn');
const chip    = document.getElementById('model-chip');
let zoomLevel = 1;
let streamingDone = false;

marked.setOptions({ breaks: true, gfm: true });

// Signal webview is ready to receive chunks
vscode.postMessage({ type: 'webviewReady' });

// ── Zoom (diagram tabs) ─────────────────────────────────────────────────────
function applyZoom() {
  const lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(zoomLevel * 100) + '%';
  out.querySelectorAll('.mermaid-wrap').forEach(d => { d.style.transform = 'scale(' + zoomLevel + ')'; });
}

document.getElementById('zoom-in')?.addEventListener('click', () => { zoomLevel = Math.min(3, +(zoomLevel + .25).toFixed(2)); applyZoom(); });
document.getElementById('zoom-out')?.addEventListener('click', () => { zoomLevel = Math.max(.25, +(zoomLevel - .25).toFixed(2)); applyZoom(); });
document.getElementById('zoom-fit')?.addEventListener('click', () => { zoomLevel = 1; applyZoom(); });
document.getElementById('diag-search')?.addEventListener('input', e => doSearch(e.target.value));

function doSearch(q) {
  q = q.trim().toLowerCase();
  out.querySelectorAll('.mermaid .node, .mermaid .actor').forEach(node => {
    const txt = (node.textContent || '').toLowerCase();
    node.style.opacity = (!q || txt.includes(q)) ? '1' : '0.12';
    node.querySelectorAll('rect,polygon,circle,ellipse').forEach(s => {
      s.style.filter = (!q || !txt.includes(q)) ? '' : 'drop-shadow(0 0 8px #06b6d4)';
    });
  });
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
document.getElementById('copy-btn').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
document.getElementById('save-btn').addEventListener('click', () => vscode.postMessage({ type: 'save' }));
document.getElementById('drawio-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'openDrawio' }));
document.getElementById('regen-btn').addEventListener('click', () => {
  streamingDone = false;
  spin.style.display = 'block';
  stopBtn.style.display = 'inline-flex';
  chip.style.display = 'none';
  out.innerHTML = '<div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div>Regenerating…</div>';
  const diagBar = document.getElementById('diag-bar');
  if (diagBar) diagBar.style.display = 'none';
  zoomLevel = 1;
  vscode.postMessage({ type: 'regenerate' });
});

stopBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopStream' });
  stopBtn.style.display = 'none';
  spin.style.display = 'none';
});

// ── Node click → open file ──────────────────────────────────────────────────
function attachNodeClicks(container) {
  container.querySelectorAll('.node, .actor').forEach(node => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => {
      const labelEl = node.querySelector('text, .nodeLabel, span');
      const label = (labelEl ? labelEl.textContent : node.textContent || '').trim();
      if (label) vscode.postMessage({ type: 'openFile', path: label });
    });
  });
}

// ── Render mermaid blocks after AI finishes ──────────────────────────────────
async function renderMermaidBlocks() {
  const diagBar = document.getElementById('diag-bar');
  let hasDiagram = false;
  const blocks = out.querySelectorAll('code.language-mermaid');

  for (const block of blocks) {
    const code = (block.textContent || '').trim();
    const pre  = block.closest('pre');
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap loading';
    wrap.textContent = 'Rendering diagram…';
    pre?.replaceWith(wrap);

    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = code;

    try {
      wrap.className = 'mermaid-wrap';
      wrap.textContent = '';
      wrap.appendChild(div);
      await mermaid.run({ nodes: [div] });
      attachNodeClicks(div);
      hasDiagram = true;
    } catch(err) {
      const msg = (err && err.message) ? err.message : String(err);
      wrap.className = 'mermaid-wrap';
      wrap.innerHTML = '<div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:12px;font-size:11px;color:#fca5a5">⚠ Diagram syntax error — retrying…</div>';
      vscode.postMessage({ type: 'mermaidError', code, error: msg });
    }
  }

  if (hasDiagram && diagBar) { diagBar.style.display = 'flex'; }
}

// ── Message handler ──────────────────────────────────────────────────────────
window.addEventListener('message', async e => {
  const msg = e.data;

  if (msg.type === 'chunk') {
    const isFirst = out.innerHTML === '';
    out.innerHTML = marked.parse(msg.text) + '<span class="cursor"></span>';
    if (isFirst) {
      stopBtn.style.display = 'inline-flex';
      document.getElementById('ai-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    out.scrollTop = out.scrollHeight;
  }

  if (msg.type === 'done') {
    streamingDone = true;
    spin.style.display = 'none';
    stopBtn.style.display = 'none';

    out.innerHTML = marked.parse(msg.text);

    if (msg.model) {
      chip.textContent = msg.model.replace('claude-', '').replace('gemini-', '').replace('deepseek-', '');
      chip.style.display = 'inline-flex';
    }

    await renderMermaidBlocks();
  }

  if (msg.type === 'error') {
    spin.style.display = 'none';
    stopBtn.style.display = 'none';
    out.innerHTML = \`
      <div class="error-box">
        <strong>\${msg.isKeyErr ? '🔑 No API Key' : '⚠ Error'}</strong>
        \${msg.message}
        \${msg.isKeyErr ? '<br><br><button class="tb" onclick="vscode.postMessage({type:\\'configureGemini\\'})">⚙ Configure AI Provider</button>' : ''}
      </div>
    \`;
  }
});
</script>
</body>
</html>`;
  }

  public dispose(): void {
    ExplainerPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  private _sanitizeFileName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "analysis";
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────
function buildBusinessLogicPrompt(aiContext: string): string {
  return `You are a senior software architect. Analyse this project and provide a complete breakdown:

## Structure
1. **What this project does** — 2–3 sentence executive summary
2. **Core business logic** — main domains, workflows, and rules
3. **Architecture overview** — how the pieces fit together (cite specific file paths like \`src/module.ts\`)
4. **Data flow** — how data moves through the system
5. **Key dependencies and integrations**

## Diagram
Generate a Mermaid flowchart showing the high-level architecture.
Rules:
- Use \`flowchart TD\` or \`graph LR\`
- Declare every node before using it: \`A[Label]\`
- No parentheses, angle brackets, pipes, or backticks in labels
- Max 12 nodes, use subgraphs for grouping

${aiContext}

Use Markdown. Be specific — cite real file paths and function names.`;
}

function buildWorkspaceDiagramPrompt(aiContext: string): string {
  return `You are a senior software architect reviewing a codebase. Produce a complete project brief using the structure below. Be specific — cite real file paths, function names, and module names from the context provided.

---

## What this project does
Write 3–4 sentences describing the project's real-world purpose and who it's for.

## Main purpose
One clear sentence: what is the single core problem this software solves?

## Key features
Bullet list of the 5–8 most important capabilities. Each bullet: **Feature name** — one sentence description.

## How it works — core flow
Numbered steps walking through the main execution path from entry point to output. Cite specific files (e.g. \`src/extension.ts\`) and functions at each step.

## Architecture breakdown

| Module / File | Role | Key exports |
|---|---|---|
List the 6–10 most important files/modules, their role, and what they export or expose.

## Tech stack & dependencies
List the main technologies, frameworks, and external services used and why.

## Architecture diagram

Generate a Mermaid flowchart that shows the main modules and how they connect.

STRICT SYNTAX RULES — any violation breaks rendering:
1. First line must be: \`flowchart TD\`
2. Declare EVERY node BEFORE using it in an edge: \`NodeA[Label]\` then \`NodeA --> NodeB\`
3. Node labels must NOT contain: \`(\` \`)\` \`<\` \`>\` \`|\` \`{\` \`}\` or backticks
4. Node IDs: ASCII letters, numbers, underscores ONLY — no spaces
5. Maximum 12 nodes — group with \`subgraph\` blocks if needed
6. Wrap in a \`\`\`mermaid code fence

---

${aiContext}`;
}

function buildFileExplainPrompt(
  code: string,
  languageId: string,
  info: StaticCodeInfo | null,
  aiContext: string
): string {
  const meta = info
    ? `Lines: ${info.lines} | Functions: ${info.functions.length} | Classes: ${info.classes.length} | Complexity: ${info.complexity}`
    : "";

  return `You are a senior ${languageId} developer with full visibility into this project.

Explain this file in depth:

1. **Purpose** — what does this file do and why does it exist?
2. **Key functions / classes** — what does each main piece do? Be specific.
3. **How it connects** — how does this file interact with other parts of the codebase? Cite file paths.
4. **Business logic** — what real-world problem does this code solve?
5. **Potential improvements** — complexity hotspots, TODOs, things to watch

${meta ? `Quick stats: ${meta}\n` : ""}

File (\`${languageId}\`):
\`\`\`${languageId}
${code.slice(0, 9000)}
\`\`\`

Project context (use this for cross-file references):
${aiContext}

Use Markdown. Be specific — cite real function names and file paths.`;
}

function buildPrompt(code: string, languageId: string, mode: ExplainMode, info: StaticCodeInfo | null): string {
  const truncated = code.slice(0, 12000);
  const meta = info
    ? `Functions: ${info.functions.join(", ") || "none"} | Classes: ${info.classes.join(", ") || "none"} | Lines: ${info.lines}`
    : "";

  if (mode === "diagram") {
    return `Generate a Mermaid diagram for this ${languageId} code.

STRICT RULES:
1. Declare every node before using it in an edge: \`A[Label]\`
2. No parentheses \`()\`, angle brackets \`<>\`, pipes \`|\`, or backticks in labels
3. ASCII-only node IDs
4. Max 12 nodes; use subgraphs if needed
5. Choose: \`flowchart TD\` / \`classDiagram\` / \`sequenceDiagram\`
6. Return ONLY the \`\`\`mermaid code block

Code:
\`\`\`${languageId}
${truncated}
\`\`\``;
  }

  if (mode === "file") {
    return `You are a senior ${languageId} developer. Explain this file:

1. **Purpose** — what does this file do?
2. **Key functions / classes** — what does each main piece do?
3. **Business logic** — what problem does it solve?
4. **Notable patterns** — design patterns, algorithms, abstractions
5. **Potential issues** — complexity, TODOs, areas to improve

${meta ? `Stats: ${meta}\n` : ""}
\`\`\`${languageId}
${truncated}
\`\`\`

Use Markdown. Be direct and developer-focused.`;
  }

  // selection (default)
  return `You are a senior ${languageId} developer. Explain this code:

1. **What it does** — plain English summary
2. **How it works** — step-by-step breakdown
3. **Key concepts** — patterns, algorithms, or language features used
4. **Example** — a concrete usage example if helpful

${meta ? `Stats: ${meta}\n` : ""}
\`\`\`${languageId}
${truncated}
\`\`\`

Be concise, clear, and use Markdown.`;
}

function renderStaticInfo(info: StaticCodeInfo): string {
  const complexityColor = info.complexity < 10 ? "#10b981" : info.complexity < 20 ? "#f59e0b" : "#ef4444";
  return `
<div style="background:#111827;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px;flex-shrink:0">
  <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:10px">Static Analysis</div>
  <div class="stat-row">
    <div class="stat-card"><div class="stat-val">${info.lines}</div><div class="stat-lbl">Lines</div></div>
    <div class="stat-card"><div class="stat-val">${info.functions.length}</div><div class="stat-lbl">Functions</div></div>
    <div class="stat-card"><div class="stat-val">${info.classes.length}</div><div class="stat-lbl">Classes</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${complexityColor}">${info.complexity}</div><div class="stat-lbl">Complexity</div></div>
  </div>
  ${info.functions.length ? `<div class="tags-row">${info.functions.slice(0, 12).map(f => `<span class="tag">${f}</span>`).join("")}${info.functions.length > 12 ? `<span class="tag">+${info.functions.length - 12} more</span>` : ""}</div>` : ""}
  ${info.imports.length ? `<div class="tags-row">${info.imports.slice(0, 8).map(i => `<span class="tag import">${i}</span>`).join("")}</div>` : ""}
  ${info.todos.length ? `<div style="margin-top:8px">${info.todos.slice(0, 5).map(t => `<div class="todo">⚠ ${t}</div>`).join("")}</div>` : ""}
</div>`;
}
