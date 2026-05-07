import * as vscode from "vscode";
import { ReportPanel } from "./reportPanel";
import { migrateApiKeysToSecrets, storeApiKey, getStoredApiKey } from "./geminiClient";

export function activate(context: vscode.ExtensionContext): void {
  void migrateApiKeysToSecrets(context);

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("codebaseIntelligence.generateReport", () => {
      void ReportPanel.generate(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codebaseIntelligence.configureProvider", async () => {
      const pick = await vscode.window.showQuickPick([
        { label: "$(sparkle) Claude",  description: "Anthropic — highest quality",    value: "claude"   },
        { label: "$(rocket) DeepSeek", description: "Fast & affordable",               value: "deepseek" },
        { label: "$(globe) Gemini",    description: "Google — free tier available",    value: "gemini"   },
      ], { title: "Codebase Intelligence — Choose AI Provider", ignoreFocusOut: true });
      if (!pick) { return; }

      const provider = pick.value as "claude" | "deepseek" | "gemini";
      await vscode.workspace.getConfiguration("codeAnalyzer").update("aiProvider", provider, vscode.ConfigurationTarget.Global);

      const label  = { claude: "Claude", deepseek: "DeepSeek", gemini: "Gemini" }[provider];
      const prompt = { claude: "Anthropic API key (console.anthropic.com)", deepseek: "DeepSeek API key (platform.deepseek.com)", gemini: "Gemini API key (aistudio.google.com)" }[provider];
      const current = await getStoredApiKey(context, provider);

      const key = await vscode.window.showInputBox({ title: `${label} API Key`, prompt, password: true, value: current, ignoreFocusOut: true });
      if (key === undefined) { return; }

      await storeApiKey(context, provider, key);
      vscode.window.showInformationMessage(`${label} API key saved. Click ⬡ Analyze to generate your report.`);
    })
  );

  // ── Status bar ────────────────────────────────────────────────────────────
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.name    = "Codebase Intelligence";
  bar.command = "codebaseIntelligence.generateReport";
  bar.text    = "$(graph) Analyze";
  bar.tooltip = "Generate codebase report";

  const update = () => vscode.workspace.workspaceFolders?.length ? bar.show() : bar.hide();
  update();
  context.subscriptions.push(bar);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(update));
}

export function deactivate(): void {}
