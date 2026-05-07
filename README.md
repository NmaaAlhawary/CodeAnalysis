# Code Analyzer

AI-powered codebase intelligence for VS Code. Understand any project instantly — explanations, architecture diagrams, dependency graphs, and smart documentation, all inside your editor.

## Features

- **AI Chat** — Multi-turn conversation with full cross-file codebase context. Type `@filename` to inject any file directly.
- **Architecture Overview** — Generates a complete project brief: purpose, business logic, key components, module table, tech stack, and a Mermaid architecture diagram.
- **9-Tab Dashboard** — Dependency graph with cycle detection, call graph, git hotspots, module coupling heatmap, symbol search, AI insights, and more.
- **Explain Code** — Explain any selection or entire file with context from the full project structure.
- **Auto Documentation** — Generate README, inline JSDoc/TSDoc, and ARCHITECTURE.md. All show a diff before writing.
- **GitHub Remote Analysis** — Paste any public GitHub URL to analyze it without cloning.
- **3 AI Providers** — Claude (Anthropic), DeepSeek, or Gemini. Keys stored in VS Code's secure secrets vault.

## Installation

**From VS Code Marketplace:**

Search `Code Analyzer` in the Extensions panel (`⌘⇧X`) or install from the command line:

```bash
code --install-extension nmaaalhawary.code-analyzer
```

**From source:**

```bash
git clone https://github.com/NmaaAlhawary/CodeAnalysis.git
cd CodeAnalysis/vscode-code-analyzer
npm install
npm run package
code --install-extension code-analyzer-2.0.0.vsix
```

## Setup

1. Open VS Code and press `⌘⇧P` → **Code Analyzer: Configure AI Provider**
2. Choose your AI provider:
   - **Claude** — [console.anthropic.com](https://console.anthropic.com) *(best quality)*
   - **DeepSeek** — [platform.deepseek.com](https://platform.deepseek.com) *(fast & affordable)*
   - **Gemini** — [aistudio.google.com](https://aistudio.google.com) *(free tier)*
3. Paste your API key — stored securely in VS Code's secrets vault, never in plain settings
4. Open any project folder and the extension auto-indexes in the background

## Usage

| Action | How |
|---|---|
| Chat with AI about your codebase | `⌘⇧C` |
| Architecture overview + diagram | `⌘⇧G` |
| Open dashboard | `⌘⇧D` |
| Explain selected code | Select code → `⌘⇧E` |
| Explain entire file | Right-click → *Explain This File* |
| Generate README | `⌘⇧P` → *Generate README* |
| Generate inline docs | Right-click → *Generate Inline Documentation* |
| Analyze a GitHub repo | `⌘⇧P` → *Analyze GitHub Repository* |
| AI code review | `⌘⇧P` → *AI Code Review* |

## Dashboard Tabs

| Tab | What it shows |
|---|---|
| Overview | Project health score, file stats, language breakdown |
| File Tree | Clickable file tree with edit-frequency heat overlay |
| Dependency Graph | Module dependency graph with cycle detection (Tarjan SCC) |
| Call Graph | Function-to-function call graph for any file |
| Git Hotspots | Most-edited files, churn vs size scatter plot |
| Git History | Commit frequency, author contributions |
| Module Coupling | Cross-module import heatmap |
| Symbol Search | Search every symbol across the codebase by name, kind, or file |
| AI Insights | Cached AI narrative: project summary, architectural concerns, refactoring targets |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `codeAnalyzer.aiProvider` | `deepseek` | AI provider: `claude`, `deepseek`, or `gemini` |
| `codeAnalyzer.claudeModel` | `claude-sonnet-4-6` | Claude model name |
| `codeAnalyzer.geminiModel` | `gemini-2.5-flash` | Gemini model name |
| `codeAnalyzer.deepseekModel` | `deepseek-chat` | DeepSeek model name |
| `codeAnalyzer.maxContextTokens` | `24000` | Max tokens sent to AI per request |
| `codeAnalyzer.enableAutoIndex` | `true` | Auto-index workspace on startup |
| `codeAnalyzer.enableStreaming` | `true` | Stream AI responses token by token |
| `codeAnalyzer.docStyle` | `tsdoc` | Doc comment style: `tsdoc`, `jsdoc`, or `docstring` |
| `codeAnalyzer.enableCodeLens` | `true` | Show ✨ Explain lenses above functions |

## Requirements

- VS Code 1.90+
- An API key for at least one AI provider (Claude, DeepSeek, or Gemini)

## License

MIT © 2025 NmaaAlhawary
