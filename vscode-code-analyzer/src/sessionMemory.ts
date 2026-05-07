import * as vscode from "vscode";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface UserPreferences {
  diagramStyle: "flowchart TD" | "graph LR" | "auto";
  docStyle: "jsdoc" | "tsdoc" | "docstring";
  contextBudget: number;
}

export interface SessionMemory {
  chatHistory: ChatMessage[];
  lastAnalysisTimestamp: number;
  fileSummaryCache: Record<string, { summary: string; hash: string }>;
  userPreferences: UserPreferences;
}

const HISTORY_KEY  = "codeAnalyzer.chatHistory";
const PREFS_KEY    = "codeAnalyzer.userPrefs";
const SUMMARY_KEY  = "codeAnalyzer.fileSummaries";
const MAX_MESSAGES = 50;
const MAX_SUMMARIES = 200;

const DEFAULT_PREFS: UserPreferences = {
  diagramStyle: "auto",
  docStyle: "tsdoc",
  contextBudget: 24000,
};

export function getChatHistory(
  context: vscode.ExtensionContext,
  maxMessages = 8
): ChatMessage[] {
  const history = context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
  return history.slice(-maxMessages);
}

export function appendChatMessage(
  context: vscode.ExtensionContext,
  msg: ChatMessage
): void {
  const history = context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
  history.push(msg);
  if (history.length > MAX_MESSAGES) { history.splice(0, history.length - MAX_MESSAGES); }
  void context.workspaceState.update(HISTORY_KEY, history);
}

export function clearChatHistory(context: vscode.ExtensionContext): void {
  void context.workspaceState.update(HISTORY_KEY, []);
}

export function getUserPreferences(context: vscode.ExtensionContext): UserPreferences {
  return context.globalState.get<UserPreferences>(PREFS_KEY, DEFAULT_PREFS);
}

export function saveUserPreferences(
  context: vscode.ExtensionContext,
  prefs: Partial<UserPreferences>
): void {
  const current = getUserPreferences(context);
  void context.globalState.update(PREFS_KEY, { ...current, ...prefs });
}

export function getFileSummaryCache(
  context: vscode.ExtensionContext
): Record<string, { summary: string; hash: string }> {
  return context.workspaceState.get<Record<string, { summary: string; hash: string }>>(SUMMARY_KEY, {});
}

export function setFileSummary(
  context: vscode.ExtensionContext,
  filePath: string,
  summary: string,
  hash: string
): void {
  const cache = getFileSummaryCache(context);
  cache[filePath] = { summary, hash };

  const entries = Object.entries(cache);
  if (entries.length > MAX_SUMMARIES) {
    const pruned = Object.fromEntries(entries.slice(entries.length - MAX_SUMMARIES));
    void context.workspaceState.update(SUMMARY_KEY, pruned);
  } else {
    void context.workspaceState.update(SUMMARY_KEY, cache);
  }
}
