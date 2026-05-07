import * as vscode from "vscode";
import { AnalysisResult } from "./analyzer";

const SYSTEM_PROMPT = `You are a senior software architect. Analyze the provided codebase data and write exactly 2-3 sentences describing: (1) what the project does, (2) its key modules, (3) one architectural concern. Be specific — cite actual file names. Return plain text only, no markdown, no headers, no bullet points.`;

// ── Provider helpers ──────────────────────────────────────────────────────────
export function getAIProvider(): "gemini" | "deepseek" | "claude" {
  return vscode.workspace.getConfiguration("codeAnalyzer").get<string>("aiProvider", "deepseek") as "gemini" | "deepseek" | "claude";
}

export async function getClaudeConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = context ? ((await context.secrets.get("codeAnalyzer.claudeApiKey")) || "") : "";
  if (!apiKey) { apiKey = (c.get<string>("claudeApiKey") || "").trim(); }
  return { apiKey, model: (c.get<string>("claudeModel") || "claude-sonnet-4-6").trim() };
}

export async function getGeminiConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = context ? ((await context.secrets.get("codeAnalyzer.geminiApiKey")) || "") : "";
  if (!apiKey) { apiKey = (c.get<string>("geminiApiKey") || "").trim(); }
  return { apiKey, model: (c.get<string>("geminiModel") || "gemini-2.5-flash").trim() };
}

export async function getDeepSeekConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = context ? ((await context.secrets.get("codeAnalyzer.deepseekApiKey")) || "") : "";
  if (!apiKey) { apiKey = (c.get<string>("deepseekApiKey") || "").trim(); }
  return { apiKey, model: (c.get<string>("deepseekModel") || "deepseek-chat").trim() };
}

export async function storeApiKey(context: vscode.ExtensionContext, provider: "deepseek" | "gemini" | "claude", key: string): Promise<void> {
  await context.secrets.store(`codeAnalyzer.${provider}ApiKey`, key.trim());
}

export async function getStoredApiKey(context: vscode.ExtensionContext, provider: "deepseek" | "gemini" | "claude"): Promise<string> {
  return (await context.secrets.get(`codeAnalyzer.${provider}ApiKey`)) || "";
}

export async function migrateApiKeysToSecrets(context: vscode.ExtensionContext): Promise<void> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  for (const provider of ["deepseek", "gemini", "claude"] as const) {
    const plain = c.get<string>(`${provider}ApiKey`, "").trim();
    if (plain) {
      await context.secrets.store(`codeAnalyzer.${provider}ApiKey`, plain);
      try { await c.update(`${provider}ApiKey`, "", vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    }
  }
}

// ── Build summary prompt ──────────────────────────────────────────────────────
function buildPrompt(result: AnalysisResult): string {
  const topFiles = result.depGraph.nodes
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 15)
    .map(n => `${n.name} (${n.lines} lines)`)
    .join(", ");

  const topLangs = result.fileStats
    .slice(0, 4)
    .map(s => `${s.ext}: ${s.count} files`)
    .join(", ");

  const hotspots = result.hotspots
    .slice(0, 5)
    .map(h => h.file)
    .join(", ");

  return `${SYSTEM_PROMPT}\n\nProject stats:\n- ${result.totalFiles} files, ${result.totalLines} lines\n- Languages: ${topLangs}\n- Largest files: ${topFiles}\n- Most edited: ${hotspots || "n/a"}\n\nWrite the 2-3 sentence summary now:`;
}

// ── AI summary (non-streaming) ────────────────────────────────────────────────
export async function generateAISummary(result: AnalysisResult, context?: vscode.ExtensionContext): Promise<string> {
  const provider = getAIProvider();
  const prompt = buildPrompt(result);
  if (provider === "claude")   { return callClaude(prompt, context); }
  if (provider === "deepseek") { return callDeepSeek(prompt, context); }
  return callGemini(prompt, context);
}

async function callDeepSeek(prompt: string, context?: vscode.ExtensionContext): Promise<string> {
  const { apiKey, model } = await getDeepSeekConfig(context);
  if (!apiKey) { throw new Error("DeepSeek API key not configured."); }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 256 }),
      signal: ctrl.signal,
    });
    const json = await res.json() as any;
    if (!res.ok) { throw new Error(json.error?.message || `DeepSeek ${res.status}`); }
    return (json.choices?.[0]?.message?.content || "").trim();
  } finally { clearTimeout(t); }
}

async function callGemini(prompt: string, context?: vscode.ExtensionContext): Promise<string> {
  const { apiKey, model } = await getGeminiConfig(context);
  if (!apiKey) { throw new Error("Gemini API key not configured."); }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 256 } }),
      signal: ctrl.signal,
    });
    const json = await res.json() as any;
    if (!res.ok) { throw new Error(json.error?.message || `Gemini ${res.status}`); }
    return (json.candidates?.flatMap((c: any) => c.content?.parts || []).map((p: any) => p.text || "").join("") || "").trim();
  } finally { clearTimeout(t); }
}

async function callClaude(prompt: string, context?: vscode.ExtensionContext): Promise<string> {
  const { apiKey, model } = await getClaudeConfig(context);
  if (!apiKey) { throw new Error("Anthropic API key not configured."); }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 256, temperature: 0.3, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal,
    });
    const json = await res.json() as any;
    if (!res.ok) { throw new Error(json.error?.message || `Anthropic ${res.status}`); }
    return ((json.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") || "").trim();
  } finally { clearTimeout(t); }
}
