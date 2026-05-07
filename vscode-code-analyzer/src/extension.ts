import * as vscode from "vscode";
import * as path from "path";
import { execSync } from "child_process";
import { DashboardPanel } from "./dashboardPanel";
import { ExplainerPanel } from "./explainerPanel";
import { SidebarProvider } from "./sidebarProvider";
import { ChatPanel } from "./chatPanel";
import { migrateApiKeysToSecrets, storeApiKey, getStoredApiKey } from "./geminiClient";
import { buildIndex, updateFileInIndex, getCachedIndex } from "./indexer";

export function activate(context: vscode.ExtensionContext): void {
  // Migrate API keys from plain config to secrets vault (silent, one-time)
  void migrateApiKeysToSecrets(context);

  // ── Sidebar panel ───────────────────────────────────────────────────────────
  const sidebar = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeAnalyzer")) { sidebar.refresh(); }
    })
  );

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const getRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const runWorkspaceCommand = async (action: "diagram" | "logic" | "dashboard"): Promise<void> => {
    const rootDir = getRoot();
    if (!rootDir) { vscode.window.showWarningMessage("Open a folder first."); return; }
    if (action === "diagram")   { await ExplainerPanel.explainWorkspaceDiagram(context, rootDir); return; }
    if (action === "logic")     { await ExplainerPanel.explainBusinessLogic(context, rootDir);    return; }
    DashboardPanel.createOrShow(context);
  };

  // ── Background workspace indexing ───────────────────────────────────────────
  setTimeout(async () => {
    const rootDir = getRoot();
    if (rootDir) {
      try {
        await buildIndex(rootDir, context);
        sidebar.refresh();
      } catch { /* non-critical */ }
    }
  }, 2000);

  // Incremental re-index on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const rootDir = getRoot();
      if (!rootDir) { return; }
      try { await updateFileInIndex(doc.fileName, rootDir, context); }
      catch { /* non-critical */ }
    })
  );

  // ── Commands ─────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.openWorkspaceTools", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(symbol-class) Architecture Diagram", description: "Whole codebase diagram",             action: "diagram"   as const },
          { label: "$(book) Business Logic",               description: "Explain what the project does",      action: "logic"     as const },
          { label: "$(graph) Dashboard",                   description: "Charts, file tree, dependency view", action: "dashboard" as const },
        ],
        { placeHolder: "Choose what you want to understand", title: "Code Analyzer" }
      );
      if (choice) { await runWorkspaceCommand(choice.action); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.openChat", () => {
      ChatPanel.createOrShow(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.reindex", async () => {
      const rootDir = getRoot();
      if (!rootDir) { vscode.window.showWarningMessage("Open a folder first."); return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Re-indexing workspace…", cancellable: false },
        async () => {
          await buildIndex(rootDir, context, true);
          sidebar.refresh();
        }
      );
      vscode.window.showInformationMessage("Workspace index updated.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.configureGemini", async () => {
      const providerChoice = await vscode.window.showQuickPick(
        [
          { label: "$(sparkle) Claude",   description: "Anthropic Claude — highest quality, great for complex analysis", value: "claude"   },
          { label: "$(rocket) DeepSeek",  description: "DeepSeek — fast, affordable, no daily quota",                    value: "deepseek" },
          { label: "$(globe) Gemini",     description: "Google Gemini — 20 req/day on free tier",                        value: "gemini"   },
        ],
        { title: "Code Analyzer — Choose AI Provider", placeHolder: "Which AI should power the extension?", ignoreFocusOut: true }
      );
      if (!providerChoice) { return; }

      const config = vscode.workspace.getConfiguration("codeAnalyzer");
      try {
        await config.update("aiProvider", providerChoice.value, vscode.ConfigurationTarget.Global);
      } catch {
        await vscode.workspace.getConfiguration().update("codeAnalyzer.aiProvider", providerChoice.value, vscode.ConfigurationTarget.Global);
      }

      const provider = providerChoice.value as "deepseek" | "gemini" | "claude";
      const currentKey = await getStoredApiKey(context, provider);
      const providerMeta: Record<string, { label: string; prompt: string }> = {
        claude:   { label: "Claude",   prompt: "Anthropic API key (console.anthropic.com)" },
        deepseek: { label: "DeepSeek", prompt: "DeepSeek API key (platform.deepseek.com)"  },
        gemini:   { label: "Gemini",   prompt: "Gemini API key (aistudio.google.com)"      },
      };
      const meta = providerMeta[provider];

      const apiKey = await vscode.window.showInputBox({
        title: `Code Analyzer — ${meta.label} API Key`,
        prompt: meta.prompt,
        password: true,
        value: currentKey,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) { return; }

      await storeApiKey(context, provider, apiKey.trim());
      vscode.window.showInformationMessage(`${meta.label} API key saved.`);
      sidebar.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.openDashboard", () => {
      DashboardPanel.createOrShow(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file and select some code first."); return; }
      const text = editor.document.getText(editor.selection);
      if (!text.trim()) { vscode.window.showInformationMessage("Select some code first."); return; }
      const rootDir = getRoot();
      await ExplainerPanel.explain(context, text, editor.document.languageId, "selection", editor.document.fileName.split("/").pop(), rootDir);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.explainFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file to explain."); return; }
      const rootDir = getRoot();
      await ExplainerPanel.explain(context, editor.document.getText(), editor.document.languageId, "file", editor.document.fileName.split("/").pop(), rootDir, editor.document.fileName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.businessLogic", () => runWorkspaceCommand("logic"))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.generateWorkspaceDiagram", () => runWorkspaceCommand("diagram"))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.generateDiagram", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file and select some code first."); return; }
      const text = editor.document.getText(editor.selection) || editor.document.getText();
      if (!text.trim()) { vscode.window.showInformationMessage("Select some code to diagram."); return; }
      await ExplainerPanel.explain(context, text, editor.document.languageId, "diagram", editor.document.fileName.split("/").pop());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.findRelatedFiles", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file first."); return; }
      const rootDir = getRoot();
      if (!rootDir) { vscode.window.showWarningMessage("Open a folder first."); return; }
      const index = getCachedIndex(context);
      if (!index) {
        vscode.window.showInformationMessage("Indexing workspace… try again in a moment.");
        return;
      }
      const filePath = editor.document.fileName;
      const rel = path.relative(rootDir, filePath);
      const outgoing = index.moduleGraph[rel] || [];
      const incoming = Object.entries(index.moduleGraph)
        .filter(([, deps]) => deps.includes(rel))
        .map(([f]) => f);
      const related = [...new Set([...outgoing, ...incoming])].slice(0, 20);
      const question = `Here are files related to ${rel}:\nImports: ${outgoing.join(", ") || "none"}\nImported by: ${incoming.join(", ") || "none"}\n\nWhat are the key interactions and responsibilities between these files?`;
      ChatPanel.createOrShow(context, question);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.codeReview", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file first."); return; }
      const rootDir = getRoot();
      if (!rootDir) { return; }
      let diff = "";
      try {
        diff = execSync(`git -C "${rootDir}" diff HEAD -- "${editor.document.fileName}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 });
      } catch { /* no diff */ }
      if (!diff.trim()) {
        vscode.window.showInformationMessage("No uncommitted changes found in this file.");
        return;
      }
      const question = `Please review these changes in ${editor.document.fileName.split("/").pop()} and identify any issues, bugs, or improvements:\n\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``;
      ChatPanel.createOrShow(context, question);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.analyzeGithubRepo", async () => {
      const url = await vscode.window.showInputBox({
        prompt: "Paste a GitHub repository URL",
        placeHolder: "https://github.com/owner/repo",
        validateInput: (v) => /github\.com\/[\w-]+\/[\w.-]+/.test(v) ? null : "Enter a valid GitHub URL",
        ignoreFocusOut: true,
      });
      if (!url) { return; }
      const { analyzeGithubRepo } = await import("./githubAnalyzer");
      await analyzeGithubRepo(url, context);
    })
  );

  // Documentation generation commands
  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.generateReadme", async () => {
      const rootDir = getRoot();
      if (!rootDir) { vscode.window.showWarningMessage("Open a folder first."); return; }
      const { generateReadme } = await import("./docGenerator");
      await generateReadme(rootDir, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.generateInlineDocs", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage("Open a file first."); return; }
      const rootDir = getRoot();
      if (!rootDir) { return; }
      const { generateInlineDocs } = await import("./docGenerator");
      await generateInlineDocs(editor.document.fileName, rootDir, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAnalyzer.generateArchitectureDoc", async () => {
      const rootDir = getRoot();
      if (!rootDir) { vscode.window.showWarningMessage("Open a folder first."); return; }
      const { generateArchitectureDoc } = await import("./docGenerator");
      await generateArchitectureDoc(rootDir, context);
    })
  );

  // ── Code Lens: inline "Explain" above functions & classes ───────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeAnalyzer.explainCodeLens",
      async (uri: vscode.Uri, range: vscode.Range) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const code = doc.getText(range).trim();
        if (!code) { return; }
        const rootDir = getRoot();
        await ExplainerPanel.explain(context, code, doc.languageId, "selection", doc.fileName.split("/").pop(), rootDir, doc.fileName);
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "typescript" }, { language: "typescriptreact" },
        { language: "javascript" }, { language: "javascriptreact" },
        { language: "python" },     { language: "java" },
      ],
      new CodeLensProvider()
    )
  );

  // ── Status bar ───────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name    = "Code Analyzer";
  statusBar.command = "codeAnalyzer.openWorkspaceTools";

  const updateStatusBar = (): void => {
    if (vscode.workspace.workspaceFolders?.length) {
      statusBar.text    = "$(organization) Code Analyzer";
      statusBar.tooltip = "Open workspace tools";
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  updateStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => updateStatusBar()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar()));
}

// ── Code Lens Provider ────────────────────────────────────────────────────────
class CodeLensProvider implements vscode.CodeLensProvider {
  private static readonly DECL = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+\w|class\s+\w|def\s+\w|(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?\w+\s*\()/;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("codeAnalyzer").get<boolean>("enableCodeLens", true)) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const lines = document.getText().split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (!CodeLensProvider.DECL.test(lines[i])) { continue; }

      let end = Math.min(i + 80, lines.length - 1);
      for (let j = i + 3; j < Math.min(i + 80, lines.length); j++) {
        if (CodeLensProvider.DECL.test(lines[j])) { end = j - 1; break; }
      }

      const lensRange = new vscode.Range(i, 0, i, lines[i].length);
      const codeRange = new vscode.Range(i, 0, end, lines[end].length);

      lenses.push(new vscode.CodeLens(lensRange, {
        title: "$(sparkle) Explain",
        command: "codeAnalyzer.explainCodeLens",
        arguments: [document.uri, codeRange],
        tooltip: "AI explanation of this function / class",
      }));
    }
    return lenses;
  }
}

export function deactivate(): void {}
