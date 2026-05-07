import * as vscode from "vscode";

export interface GeminiResult {
  text: string;
  model: string;
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICallOptions {
  temperature?: number;
  maxTokens?: number;
  taskType?: "explain" | "diagram" | "chat" | "docgen" | "architecture";
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are Code Analyzer, an expert software architect and developer assistant embedded in VS Code.
You have access to a structured index of the user's codebase including file paths, symbols, and module relationships.
When answering questions, always cite specific file paths (e.g., src/module.ts) and function names from the provided context.
When generating Mermaid diagrams, follow these strict rules:
- Every node ID used in an edge (A --> B) must be declared with a label: A[Label]
- Node labels must NOT contain: parentheses (), angle brackets <>, pipes |, backticks \`
- Use only ASCII characters and underscores in node IDs (no spaces)
- Maximum 12 nodes; group into subgraphs if the codebase is larger
- Return ONLY the mermaid code block for diagram tasks, no explanation
Responses should be precise, developer-focused, and reference specific code rather than giving generic advice.`;

// ── Provider helpers ──────────────────────────────────────────────────────────
export function getAIProvider(): "gemini" | "deepseek" | "claude" {
  return vscode.workspace.getConfiguration("codeAnalyzer").get<string>("aiProvider", "deepseek") as "gemini" | "deepseek" | "claude";
}

export async function getClaudeConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = "";
  if (context) {
    apiKey = (await context.secrets.get("codeAnalyzer.claudeApiKey")) || "";
  }
  if (!apiKey) {
    apiKey = (c.get<string>("claudeApiKey") || "").trim();
  }
  return {
    apiKey,
    model: (c.get<string>("claudeModel") || "claude-sonnet-4-6").trim(),
  };
}

export async function getGeminiConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = "";
  if (context) {
    apiKey = (await context.secrets.get("codeAnalyzer.geminiApiKey")) || "";
  }
  if (!apiKey) {
    apiKey = (c.get<string>("geminiApiKey") || "").trim();
  }
  return {
    apiKey,
    model: (c.get<string>("geminiModel") || "gemini-2.5-flash").trim(),
  };
}

export async function getDeepSeekConfig(context?: vscode.ExtensionContext): Promise<{ apiKey: string; model: string }> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");
  let apiKey = "";
  if (context) {
    apiKey = (await context.secrets.get("codeAnalyzer.deepseekApiKey")) || "";
  }
  if (!apiKey) {
    apiKey = (c.get<string>("deepseekApiKey") || "").trim();
  }
  return {
    apiKey,
    model: (c.get<string>("deepseekModel") || "deepseek-chat").trim(),
  };
}

// ── Primary entry point (multi-turn) ─────────────────────────────────────────
export async function generateWithAI(
  messages: AIMessage[],
  options: AICallOptions = {},
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const provider = getAIProvider();
  if (provider === "claude") { return callClaude(messages, options, context); }
  if (provider === "deepseek") { return callDeepSeek(messages, options, context); }
  return callGemini(messages, options, context);
}

// ── Backward-compatible single-prompt wrapper ─────────────────────────────────
export async function generateWithGemini(
  prompt: string,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  return generateWithAI([{ role: "user", content: prompt }], {}, context);
}

function forwardAbort(internal: AbortController, external?: AbortSignal): void {
  if (external) { external.addEventListener("abort", () => internal.abort(), { once: true }); }
}

// ── Streaming entry point ─────────────────────────────────────────────────────
export async function generateWithAIStreaming(
  messages: AIMessage[],
  onChunk: (text: string) => void,
  options: AICallOptions = {},
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const provider = getAIProvider();
  if (provider === "claude") { return callClaudeStreaming(messages, onChunk, options, context); }
  if (provider === "deepseek") { return callDeepSeekStreaming(messages, onChunk, options, context); }
  return callGeminiStreaming(messages, onChunk, options, context);
}

// ── DeepSeek (non-streaming) ──────────────────────────────────────────────────
async function callDeepSeek(
  messages: AIMessage[],
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getDeepSeekConfig(context);
  if (!apiKey) {
    throw new Error("DeepSeek API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: buildDeepSeekMessages(messages),
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 8192,
      }),
      signal: controller.signal,
    });

    const json = await response.json() as any;
    if (!response.ok) { throw new Error(json.error?.message || `DeepSeek error: HTTP ${response.status}`); }

    const text = (json.choices?.[0]?.message?.content || "").trim();
    if (!text) { throw new Error("DeepSeek returned an empty response."); }
    return { text, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── DeepSeek (streaming) ──────────────────────────────────────────────────────
async function callDeepSeekStreaming(
  messages: AIMessage[],
  onChunk: (text: string) => void,
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getDeepSeekConfig(context);
  if (!apiKey) {
    throw new Error("DeepSeek API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const controller = new AbortController();
  forwardAbort(controller, options.signal);
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: buildDeepSeekMessages(messages),
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 8192,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const json = await response.json() as any;
      throw new Error(json.error?.message || `DeepSeek error: HTTP ${response.status}`);
    }

    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!data || data === "[DONE]") { continue; }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) { fullText += delta; onChunk(delta); }
        } catch { /* skip malformed lines */ }
      }
    }

    return { text: fullText, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Gemini (non-streaming) ────────────────────────────────────────────────────
async function callGemini(
  messages: AIMessage[],
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getGeminiConfig(context);
  if (!apiKey) {
    throw new Error("Gemini API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  forwardAbort(controller, options.signal);
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const { systemInstruction, contents } = buildGeminiMessages(messages);
    const body: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        topP: 0.9,
        maxOutputTokens: options.maxTokens ?? 8192,
      },
    };
    if (systemInstruction) { body.systemInstruction = systemInstruction; }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = await response.json() as any;
    if (!response.ok) { throw new Error(json.error?.message || `Gemini error: HTTP ${response.status}`); }

    const text = (json.candidates
      ?.flatMap((c: any) => c.content?.parts || [])
      .map((p: any) => p.text || "")
      .join("") || "").trim();

    if (!text) { throw new Error("Gemini returned an empty response."); }
    return { text, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Gemini (streaming) ────────────────────────────────────────────────────────
async function callGeminiStreaming(
  messages: AIMessage[],
  onChunk: (text: string) => void,
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getGeminiConfig(context);
  if (!apiKey) {
    throw new Error("Gemini API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const { systemInstruction, contents } = buildGeminiMessages(messages);
    const body: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        topP: 0.9,
        maxOutputTokens: options.maxTokens ?? 8192,
      },
    };
    if (systemInstruction) { body.systemInstruction = systemInstruction; }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const json = await response.json() as any;
      throw new Error(json.error?.message || `Gemini error: HTTP ${response.status}`);
    }

    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!data) { continue; }
        try {
          const json = JSON.parse(data);
          const delta = (json.candidates?.[0]?.content?.parts || [])
            .map((p: any) => p.text || "")
            .join("");
          if (delta) { fullText += delta; onChunk(delta); }
        } catch { /* skip malformed lines */ }
      }
    }

    return { text: fullText, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Claude / Anthropic (non-streaming) ───────────────────────────────────────
async function callClaude(
  messages: AIMessage[],
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getClaudeConfig(context);
  if (!apiKey) {
    throw new Error("Anthropic API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const { system, claudeMessages } = buildClaudeMessages(messages);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 8192,
        temperature: options.temperature ?? 0.2,
        system,
        messages: claudeMessages,
      }),
      signal: controller.signal,
    });

    const json = await response.json() as any;
    if (!response.ok) { throw new Error(json.error?.message || `Anthropic error: HTTP ${response.status}`); }

    const text = (json.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!text) { throw new Error("Claude returned an empty response."); }
    return { text, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Claude / Anthropic (streaming) ───────────────────────────────────────────
async function callClaudeStreaming(
  messages: AIMessage[],
  onChunk: (text: string) => void,
  options: AICallOptions,
  context?: vscode.ExtensionContext
): Promise<GeminiResult> {
  const { apiKey, model } = await getClaudeConfig(context);
  if (!apiKey) {
    throw new Error("Anthropic API key not configured. Run 'Code Analyzer: Configure AI Provider'.");
  }

  const { system, claudeMessages } = buildClaudeMessages(messages);
  const controller = new AbortController();
  forwardAbort(controller, options.signal);
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "accept": "text/event-stream",
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 8192,
        temperature: options.temperature ?? 0.2,
        system,
        messages: claudeMessages,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const json = await response.json() as any;
      throw new Error(json.error?.message || `Anthropic error: HTTP ${response.status}`);
    }

    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!data || data === "[DONE]") { continue; }
        try {
          const json = JSON.parse(data);
          const delta = json.delta?.type === "text_delta" ? (json.delta.text || "") : "";
          if (delta) { fullText += delta; onChunk(delta); }
        } catch { /* skip malformed lines */ }
      }
    }

    return { text: fullText, model };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Message format helpers ────────────────────────────────────────────────────
function buildDeepSeekMessages(messages: AIMessage[]): any[] {
  const result: any[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const msg of messages) {
    if (msg.role === "system") { continue; }
    result.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
  }
  return result;
}

function buildClaudeMessages(messages: AIMessage[]): {
  system: string;
  claudeMessages: any[];
} {
  const userSystem = messages.find((m) => m.role === "system");
  const system = SYSTEM_PROMPT + (userSystem ? "\n\n" + userSystem.content : "");
  const claudeMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  return { system, claudeMessages };
}

function buildGeminiMessages(messages: AIMessage[]): {
  systemInstruction: any;
  contents: any[];
} {
  const userSystem = messages.find((m) => m.role === "system");
  const systemText = SYSTEM_PROMPT + (userSystem ? "\n\n" + userSystem.content : "");

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  return {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
  };
}

// ── API key migration (plain config → secrets) ────────────────────────────────
export async function migrateApiKeysToSecrets(context: vscode.ExtensionContext): Promise<void> {
  const c = vscode.workspace.getConfiguration("codeAnalyzer");

  for (const provider of ["deepseek", "gemini", "claude"] as const) {
    const configKey = `${provider}ApiKey`;
    const secretKey = `codeAnalyzer.${provider}ApiKey`;
    const plainKey = c.get<string>(configKey, "").trim();
    if (plainKey) {
      await context.secrets.store(secretKey, plainKey);
      try { await c.update(configKey, "", vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    }
  }
}

export async function storeApiKey(
  context: vscode.ExtensionContext,
  provider: "deepseek" | "gemini" | "claude",
  key: string
): Promise<void> {
  const secretKey = `codeAnalyzer.${provider}ApiKey`;
  await context.secrets.store(secretKey, key.trim());
}

export async function getStoredApiKey(
  context: vscode.ExtensionContext,
  provider: "deepseek" | "gemini" | "claude"
): Promise<string> {
  const secretKey = `codeAnalyzer.${provider}ApiKey`;
  return (await context.secrets.get(secretKey)) || "";
}
