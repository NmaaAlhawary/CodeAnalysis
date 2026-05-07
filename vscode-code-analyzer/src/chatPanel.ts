import * as vscode from "vscode";
import { generateWithAIStreaming, AIMessage } from "./geminiClient";
import { getCachedIndex, buildIndex } from "./indexer";
import { buildAIContext } from "./contextBuilder";
import { appendChatMessage, getChatHistory, clearChatHistory, ChatMessage } from "./sessionMemory";

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext, initialQuestion?: string): void {
    const col = vscode.ViewColumn.Beside;
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(col);
      if (initialQuestion) {
        ChatPanel.currentPanel._panel.webview.postMessage({ type: "preFill", text: initialQuestion });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "codeAnalyzerChat",
      "Code Analyzer Chat",
      col,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatPanel.currentPanel = new ChatPanel(panel, context, initialQuestion);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _context: vscode.ExtensionContext,
    initialQuestion?: string
  ) {
    this._panel = panel;
    const nonce = getNonce();
    this._panel.webview.html = this._buildHtml(nonce);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg !== "object") { return; }

        if (msg.type === "ready") {
          const history = getChatHistory(this._context, 50);
          this._panel.webview.postMessage({ type: "historyLoaded", messages: history });
          const index = getCachedIndex(this._context);
          const status = index ? "ready" : "stale";
          const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          this._panel.webview.postMessage({ type: "indexStatus", status, rootDir: rootDir || "" });
          if (initialQuestion) {
            this._panel.webview.postMessage({ type: "preFill", text: initialQuestion });
          }
          return;
        }

        if (msg.type === "sendMessage") {
          await this._handleUserMessage(msg.text as string);
          return;
        }

        if (msg.type === "clearHistory") {
          clearChatHistory(this._context);
          this._panel.webview.postMessage({ type: "historyCleared" });
          return;
        }

        if (msg.type === "quickAction") {
          await this._handleQuickAction(msg.action as string);
          return;
        }

        if (msg.type === "getFileMatches") {
          const index = getCachedIndex(this._context);
          if (!index) { this._panel.webview.postMessage({ type: "fileMatches", matches: [] }); return; }
          const query = (msg.query as string || "").toLowerCase();
          const matches = index.files
            .filter((f) => f.path.toLowerCase().includes(query))
            .map((f) => f.path)
            .slice(0, 8);
          this._panel.webview.postMessage({ type: "fileMatches", matches });
          return;
        }

        if (msg.type === "reindex") {
          await vscode.commands.executeCommand("codeAnalyzer.reindex");
          const index = getCachedIndex(this._context);
          this._panel.webview.postMessage({ type: "indexStatus", status: index ? "ready" : "stale" });
          return;
        }
      },
      null,
      this._disposables
    );
  }

  private async _handleUserMessage(text: string): Promise<void> {
    if (!text.trim()) { return; }

    const userMsg: ChatMessage = { role: "user", content: text, timestamp: Date.now() };
    appendChatMessage(this._context, userMsg);
    this._panel.webview.postMessage({ type: "userMessage", message: userMsg });

    const messageId = Date.now().toString();
    this._panel.webview.postMessage({ type: "assistantStart", messageId });

    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const messages = await this._buildConversationMessages(text, rootDir);

    let fullText = "";
    try {
      const result = await generateWithAIStreaming(
        messages,
        (chunk) => {
          fullText += chunk;
          this._panel.webview.postMessage({ type: "streamChunk", text: chunk, messageId });
        },
        {},
        this._context
      );

      const assistantMsg: ChatMessage = { role: "assistant", content: result.text, timestamp: Date.now() };
      appendChatMessage(this._context, assistantMsg);
      this._panel.webview.postMessage({ type: "streamDone", messageId, model: result.model });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this._panel.webview.postMessage({ type: "error", message: errMsg, messageId });
    }
  }

  private async _handleQuickAction(action: string): Promise<void> {
    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const actionMap: Record<string, string> = {
      "architecture": "Generate a high-level architecture diagram of this codebase. Show the main modules and how they interact.",
      "explain-file": "Explain the currently active file in the context of the whole project.",
      "git-summary":  "Summarize the recent git history and identify which files have been changing most frequently.",
      "generate-docs": "What functions and classes in this codebase are missing documentation? List the top 10 most important ones.",
    };
    const question = actionMap[action];
    if (!question) { return; }

    if (action === "explain-file") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { this._panel.webview.postMessage({ type: "error", message: "Open a file first." }); return; }
      const fileName = editor.document.fileName.split("/").pop();
      await this._handleUserMessage(`Explain the file ${fileName} in the context of this project.`);
      return;
    }

    await this._handleUserMessage(question);
  }

  private async _buildConversationMessages(
    latestQuestion: string,
    rootDir: string | undefined
  ): Promise<AIMessage[]> {
    const messages: AIMessage[] = [];

    // Build context from workspace index
    if (rootDir) {
      let index = getCachedIndex(this._context);
      if (!index) {
        try { index = await buildIndex(rootDir, this._context); } catch { /* fallback */ }
      }
      if (index) {
        const context = buildAIContext(index, { mode: "chat", question: latestQuestion, tokenBudget: 18000 }, rootDir);
        messages.push({
          role: "user",
          content: `CODEBASE CONTEXT (use this to answer questions accurately):\n${context}\n\n---\nNow answer my question using this context. Always cite specific file paths.`,
        });
        messages.push({
          role: "assistant",
          content: "I have the codebase context loaded. I'll answer your questions with specific file references.",
        });
      }
    }

    // Include recent conversation history
    const history = getChatHistory(this._context, 6);
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Add the latest question (may be a duplicate of last history entry if just appended)
    const lastHistoryMsg = history[history.length - 1];
    if (!lastHistoryMsg || lastHistoryMsg.content !== latestQuestion || lastHistoryMsg.role !== "user") {
      messages.push({ role: "user", content: latestQuestion });
    }

    return messages;
  }

  private _buildHtml(nonce: string): string {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || "No workspace";

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           style-src 'nonce-${nonce}';
           img-src data: https: blob:;">
<title>Code Analyzer Chat</title>
<style nonce="${nonce}">
:root{--bg:#0f1117;--surf:#1a1d27;--bdr:#2a2d3a;--acc:#7c3aed;--acc2:#06b6d4;--tx:#e2e8f0;--mt:#64748b;--user-bg:#1e1b4b;--ai-bg:#1a1d27}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--tx);font:13px/1.6 var(--vscode-font-family,system-ui);display:flex;flex-direction:column}
header{background:linear-gradient(135deg,#1e1b4b,#0f1117);padding:10px 16px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:10px;flex-shrink:0}
header h1{font-size:.85rem;font-weight:700;color:var(--acc2);flex:1}
.index-dot{width:7px;height:7px;border-radius:50%;background:#64748b;flex-shrink:0;transition:background .3s}
.index-dot.ready{background:#10b981}
.index-dot.indexing{background:#f59e0b;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.4}}
.hdr-btn{background:transparent;border:1px solid var(--bdr);color:var(--mt);border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer}
.hdr-btn:hover{border-color:var(--acc2);color:var(--acc2)}
.quick-bar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--bdr);flex-shrink:0;overflow-x:auto}
.qa{background:#0c0e18;border:1px solid var(--bdr);border-radius:5px;padding:4px 10px;font-size:11px;color:var(--tx);cursor:pointer;white-space:nowrap;flex-shrink:0}
.qa:hover{border-color:var(--acc2);color:var(--acc2)}
#messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.msg{border-radius:8px;padding:10px 14px;max-width:100%;word-wrap:break-word}
.msg-user{background:var(--user-bg);border:1px solid #312e81;align-self:flex-end;max-width:80%}
.msg-assistant{background:var(--ai-bg);border:1px solid var(--bdr);align-self:flex-start}
.msg-meta{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.msg-role{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--acc2)}
.msg-role.user{color:#818cf8}
.msg-time{font-size:10px;color:var(--mt)}
.model-chip{font-size:9px;border:1px solid var(--bdr);border-radius:999px;padding:1px 6px;color:var(--mt);background:#0c0e18}
.copy-msg{background:transparent;border:none;color:var(--mt);cursor:pointer;font-size:10px;padding:2px 5px;border-radius:3px;margin-left:auto}
.copy-msg:hover{color:var(--acc2)}
.msg-content h1,.msg-content h2,.msg-content h3{margin:10px 0 4px;color:var(--acc2)}
.msg-content h1{font-size:1rem}.msg-content h2{font-size:.9rem}.msg-content h3{font-size:.85rem}
.msg-content p{margin:4px 0}
.msg-content code{background:#0c0e18;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:11px}
.msg-content pre{background:#0c0e18;border:1px solid var(--bdr);border-radius:6px;padding:10px;margin:6px 0;overflow:auto}
.msg-content pre code{background:none;padding:0}
.msg-content ul,.msg-content ol{padding-left:18px;margin:4px 0}
.msg-content li{margin:1px 0}
.msg-content strong{color:#f1f5f9}
.msg-content table{width:100%;border-collapse:collapse;margin:6px 0;font-size:12px}
.msg-content th{background:#1e293b;padding:5px 8px;border:1px solid var(--bdr)}
.msg-content td{padding:4px 8px;border:1px solid var(--bdr)}
.mermaid-wrap{overflow:auto;margin:6px 0}
.mermaid svg{max-width:100%;height:auto;background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px}
.streaming-cursor::after{content:'▋';animation:blink .8s step-start infinite;color:var(--acc2)}
@keyframes blink{50%{opacity:0}}
.input-area{border-top:1px solid var(--bdr);padding:10px 12px;flex-shrink:0;position:relative}
.input-row{display:flex;gap:8px;align-items:flex-end}
#input{flex:1;background:#0c0e18;border:1px solid var(--bdr);border-radius:8px;padding:8px 12px;color:var(--tx);font:13px/1.5 var(--vscode-font-family,system-ui);resize:none;min-height:38px;max-height:120px;outline:none;overflow-y:auto}
#input:focus{border-color:var(--acc2)}
#input::placeholder{color:var(--mt)}
#send{background:var(--acc);border:none;color:#fff;border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600;flex-shrink:0;align-self:flex-end}
#send:hover{background:#6d28d9}
#send:disabled{opacity:.4;cursor:not-allowed}
.hint{font-size:10px;color:var(--mt);margin-top:4px}
#autocomplete{position:absolute;bottom:100%;left:12px;right:60px;background:#1a1d27;border:1px solid var(--bdr);border-radius:6px;max-height:160px;overflow-y:auto;z-index:10;display:none}
.ac-item{padding:5px 10px;font-size:11px;font-family:monospace;cursor:pointer;color:var(--tx)}
.ac-item:hover,.ac-item.selected{background:var(--acc);color:#fff}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;color:var(--mt);text-align:center;padding:20px}
.empty-state h2{font-size:.9rem;color:var(--tx)}
.empty-state p{font-size:11px;max-width:260px;line-height:1.5}
</style>
</head>
<body>
<header>
  <div class="index-dot" id="index-dot"></div>
  <h1>Chat — ${workspaceName}</h1>
  <button class="hdr-btn" id="reindex-btn" title="Re-index workspace">↻ Index</button>
  <button class="hdr-btn" id="clear-btn">Clear</button>
</header>

<div class="quick-bar">
  <button class="qa" data-action="architecture">Architecture Diagram</button>
  <button class="qa" data-action="explain-file">Explain Active File</button>
  <button class="qa" data-action="git-summary">Git Summary</button>
  <button class="qa" data-action="generate-docs">Missing Docs</button>
</div>

<div id="messages">
  <div class="empty-state" id="empty-state">
    <h2>Ask anything about your codebase</h2>
    <p>Type a question below or use the quick actions above. Type @ to reference a specific file.</p>
  </div>
</div>

<div class="input-area">
  <div id="autocomplete"></div>
  <div class="input-row">
    <textarea id="input" placeholder="Ask about your code… (@ to reference a file)" rows="1"></textarea>
    <button id="send">Send</button>
  </div>
  <div class="hint">Enter to send · Shift+Enter for newline · @ to mention a file</div>
</div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script nonce="${nonce}">
mermaid.initialize({
  startOnLoad: false, theme: 'base', securityLevel: 'loose',
  themeVariables: { primaryColor: '#e2e8f0', primaryTextColor: '#0f172a', primaryBorderColor: '#334155', lineColor: '#475569', fontSize: '12px' }
});

const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl    = document.getElementById('input');
const sendBtn    = document.getElementById('send');
const acEl       = document.getElementById('autocomplete');
const emptyState = document.getElementById('empty-state');
const indexDot   = document.getElementById('index-dot');

let streamingContent = {};
let acItems = [];
let acIndex = -1;
let atStart = -1;

marked.setOptions({ breaks: true, gfm: true });

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function renderMarkdown(content, container) {
  container.innerHTML = marked.parse(content);
  const blocks = container.querySelectorAll('code.language-mermaid');
  for (const block of blocks) {
    const code = block.textContent.trim();
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = code;
    wrap.appendChild(div);
    block.closest('pre').replaceWith(wrap);
    try { await mermaid.run({ nodes: [div] }); } catch(e) {
      div.innerHTML = '<span style="color:#f87171;font-size:11px">Diagram error: ' + (e.message||'syntax error') + '</span>';
    }
  }
}

function addMessage(msg) {
  if (emptyState) { emptyState.style.display = 'none'; }
  const isUser = msg.role === 'user';
  const div = document.createElement('div');
  div.className = 'msg msg-' + (isUser ? 'user' : 'assistant');
  div.id = 'msg-' + (msg.id || msg.timestamp);
  div.innerHTML = \`
    <div class="msg-meta">
      <span class="msg-role \${isUser ? 'user' : ''}">\${isUser ? 'You' : 'AI'}</span>
      <span class="msg-time">\${formatTime(msg.timestamp)}</span>
      \${msg.model ? '<span class="model-chip">'+msg.model+'</span>' : ''}
      \${!isUser ? '<button class="copy-msg" onclick="copyMsg(this)">Copy</button>' : ''}
    </div>
    <div class="msg-content"></div>
  \`;
  const contentEl = div.querySelector('.msg-content');
  if (isUser) {
    contentEl.textContent = msg.content;
  } else {
    renderMarkdown(msg.content, contentEl);
  }
  messagesEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function copyMsg(btn) {
  const content = btn.closest('.msg').querySelector('.msg-content');
  navigator.clipboard.writeText(content.textContent || '');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function setStreaming(messageId, isStreaming) {
  sendBtn.disabled = isStreaming;
  inputEl.disabled = isStreaming;
  const msgEl = document.getElementById('msg-' + messageId);
  if (!msgEl) { return; }
  const content = msgEl.querySelector('.msg-content');
  if (isStreaming) {
    content.classList.add('streaming-cursor');
  } else {
    content.classList.remove('streaming-cursor');
  }
}

// Autocomplete
inputEl.addEventListener('input', function() {
  const val = this.value;
  const cursor = this.selectionStart;
  const lastAt = val.lastIndexOf('@', cursor);
  if (lastAt === -1 || (lastAt > 0 && !/\s/.test(val[lastAt - 1]))) {
    hideAc(); return;
  }
  const query = val.slice(lastAt + 1, cursor);
  atStart = lastAt;
  if (query.length > 0) {
    vscode.postMessage({ type: 'getFileMatches', query });
  } else {
    hideAc();
  }
  autoResize(this);
});

inputEl.addEventListener('keydown', function(e) {
  if (acEl.style.display !== 'none') {
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); highlightAc(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); highlightAc(); return; }
    if (e.key === 'Enter' && acIndex >= 0) { e.preventDefault(); selectAc(acItems[acIndex]); return; }
    if (e.key === 'Escape') { hideAc(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

function highlightAc() {
  acEl.querySelectorAll('.ac-item').forEach((el, i) => {
    el.classList.toggle('selected', i === acIndex);
  });
}

function selectAc(match) {
  const val = inputEl.value;
  const cursor = inputEl.selectionStart;
  inputEl.value = val.slice(0, atStart) + '@' + match + ' ' + val.slice(cursor);
  hideAc();
  inputEl.focus();
}

function hideAc() {
  acEl.style.display = 'none';
  acIndex = -1;
  acItems = [];
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function doSend() {
  const text = inputEl.value.trim();
  if (!text) { return; }
  inputEl.value = '';
  inputEl.style.height = 'auto';
  hideAc();
  vscode.postMessage({ type: 'sendMessage', text });
}

sendBtn.addEventListener('click', doSend);

document.getElementById('clear-btn').addEventListener('click', function() {
  if (confirm('Clear chat history?')) {
    vscode.postMessage({ type: 'clearHistory' });
  }
});

document.getElementById('reindex-btn').addEventListener('click', function() {
  indexDot.className = 'index-dot indexing';
  vscode.postMessage({ type: 'reindex' });
});

document.querySelectorAll('.qa').forEach(function(btn) {
  btn.addEventListener('click', function() {
    vscode.postMessage({ type: 'quickAction', action: this.dataset.action });
  });
});

window.addEventListener('message', async function(e) {
  const msg = e.data;

  if (msg.type === 'historyLoaded') {
    for (const m of msg.messages) { addMessage(m); }
    return;
  }

  if (msg.type === 'historyCleared') {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyState);
    emptyState.style.display = '';
    return;
  }

  if (msg.type === 'indexStatus') {
    indexDot.className = 'index-dot ' + (msg.status === 'ready' ? 'ready' : '');
    return;
  }

  if (msg.type === 'fileMatches') {
    acItems = msg.matches;
    acIndex = -1;
    acEl.innerHTML = acItems.map(m => '<div class="ac-item" data-path="' + m + '">' + m + '</div>').join('');
    acEl.querySelectorAll('.ac-item').forEach(function(el) {
      el.addEventListener('mousedown', function(ev) { ev.preventDefault(); selectAc(el.dataset.path); });
    });
    acEl.style.display = acItems.length ? 'block' : 'none';
    return;
  }

  if (msg.type === 'userMessage') {
    addMessage(msg.message);
    return;
  }

  if (msg.type === 'assistantStart') {
    if (emptyState) { emptyState.style.display = 'none'; }
    const div = document.createElement('div');
    div.className = 'msg msg-assistant';
    div.id = 'msg-' + msg.messageId;
    div.innerHTML = \`
      <div class="msg-meta">
        <span class="msg-role">AI</span>
        <span class="msg-time">\${formatTime(Date.now())}</span>
        <span class="model-chip" id="chip-\${msg.messageId}">thinking…</span>
        <button class="copy-msg" onclick="copyMsg(this)">Copy</button>
      </div>
      <div class="msg-content streaming-cursor"></div>
    \`;
    messagesEl.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'end' });
    streamingContent[msg.messageId] = '';
    sendBtn.disabled = true;
    inputEl.disabled = true;
    return;
  }

  if (msg.type === 'streamChunk') {
    streamingContent[msg.messageId] = (streamingContent[msg.messageId] || '') + msg.text;
    const msgEl = document.getElementById('msg-' + msg.messageId);
    if (msgEl) {
      const contentEl = msgEl.querySelector('.msg-content');
      contentEl.innerHTML = marked.parse(streamingContent[msg.messageId]) + '<span class="streaming-cursor"></span>';
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    return;
  }

  if (msg.type === 'streamDone') {
    const msgEl = document.getElementById('msg-' + msg.messageId);
    if (msgEl) {
      const contentEl = msgEl.querySelector('.msg-content');
      contentEl.classList.remove('streaming-cursor');
      await renderMarkdown(streamingContent[msg.messageId] || '', contentEl);
      const chip = document.getElementById('chip-' + msg.messageId);
      if (chip && msg.model) { chip.textContent = msg.model; }
    }
    delete streamingContent[msg.messageId];
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
    return;
  }

  if (msg.type === 'error') {
    const msgEl = document.getElementById('msg-' + msg.messageId);
    if (msgEl) {
      msgEl.querySelector('.msg-content').innerHTML = '<span style="color:#f87171">Error: ' + msg.message + '</span>';
    }
    sendBtn.disabled = false;
    inputEl.disabled = false;
    return;
  }

  if (msg.type === 'preFill') {
    inputEl.value = msg.text;
    autoResize(inputEl);
    inputEl.focus();
    return;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  public dispose(): void {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }
}
