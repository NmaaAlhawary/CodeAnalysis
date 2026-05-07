import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildIndex, getCachedIndex, extractSymbols } from "./indexer";
import { buildAIContext } from "./contextBuilder";
import { generateWithAI } from "./geminiClient";

export async function generateReadme(
  rootDir: string,
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating README…", cancellable: false },
    async () => {
      let index = getCachedIndex(context);
      if (!index || index.rootDir !== rootDir) {
        index = await buildIndex(rootDir, context);
      }

      const aiContext = buildAIContext(index, { mode: "architecture", tokenBudget: 20000 }, rootDir);
      const prompt = `You are a technical writer. Generate a complete README.md for this project.

Include these sections in order:
# [Project Name]
Brief description (1-2 sentences).
## Features
Bullet list of key capabilities.
## Installation
Step-by-step setup instructions.
## Usage
Code examples showing main use cases.
## Architecture
A Mermaid diagram followed by a brief description of the main modules.
Diagram rules: every node in an edge must be declared (A[Label]), no special chars in labels, max 10 nodes.
## Contributing
Brief contributing guidelines.

Use the actual project name, file paths, and function names from the context below.
Return only the README content, no preamble.

${aiContext}`;

      const result = await generateWithAI([{ role: "user", content: prompt }], {}, context);

      const existingReadmePath = path.join(rootDir, "README.md");
      const hasExisting = fs.existsSync(existingReadmePath);

      const tmpPath = path.join(rootDir, ".readme-generated.md");
      fs.writeFileSync(tmpPath, result.text, "utf8");

      if (hasExisting) {
        const existing = vscode.Uri.file(existingReadmePath);
        const generated = vscode.Uri.file(tmpPath);
        await vscode.commands.executeCommand("vscode.diff", existing, generated, "README.md — Current vs Generated");
        vscode.window.showInformationMessage(
          "Review the generated README. Save manually to accept the changes.",
          "Accept & Replace"
        ).then(async (choice) => {
          if (choice === "Accept & Replace") {
            fs.copyFileSync(tmpPath, existingReadmePath);
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            const doc = await vscode.workspace.openTextDocument(existingReadmePath);
            await vscode.window.showTextDocument(doc);
          }
        });
      } else {
        const uri = vscode.Uri.file(tmpPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(
          "Generated README preview. Save to README.md to keep it.",
          "Save as README.md"
        ).then(async (choice) => {
          if (choice === "Save as README.md") {
            fs.copyFileSync(tmpPath, existingReadmePath);
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            const saved = await vscode.workspace.openTextDocument(existingReadmePath);
            await vscode.window.showTextDocument(saved);
          }
        });
      }
    }
  );
}

export async function generateInlineDocs(
  filePath: string,
  rootDir: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const supportedExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
  if (!supportedExts.has(ext)) {
    vscode.window.showWarningMessage("Inline doc generation supports TypeScript, JavaScript, and Python files.");
    return;
  }

  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch {
    vscode.window.showErrorMessage("Could not read file.");
    return;
  }

  const symbols = extractSymbols(content, ext);
  const undocumented = symbols.filter(
    (s) => !s.jsdocExists && s.isExported && (s.kind === "function" || s.kind === "class" || s.kind === "method")
  );

  if (undocumented.length === 0) {
    vscode.window.showInformationMessage("All exported symbols already have documentation.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating docs for ${undocumented.length} symbols…`,
      cancellable: false,
    },
    async () => {
      const lines = content.split("\n");
      const patches: Array<{ line: number; content: string; symbolName: string }> = [];
      const docStyle = ext === ".py" ? "docstring" : "tsdoc";

      for (const symbol of undocumented.slice(0, 20)) {
        const lineIndex = symbol.line - 1;
        const surroundingStart = Math.max(0, lineIndex - 5);
        const surroundingEnd   = Math.min(lines.length, lineIndex + 25);
        const surrounding = lines.slice(surroundingStart, surroundingEnd).join("\n");

        const prompt = docStyle === "docstring"
          ? `Generate a Python docstring for this function/class. Use Google style.
Return ONLY the docstring (including the triple quotes), nothing else.

Context:
\`\`\`python
${surrounding}
\`\`\`
Full file (for context):
\`\`\`python
${content.slice(0, 4000)}
\`\`\``
          : `Generate a TSDoc comment for this TypeScript/JavaScript function or class.
Include @param, @returns, @throws if applicable.
Return ONLY the TSDoc block (/** ... */), nothing else.

Context:
\`\`\`typescript
${surrounding}
\`\`\`
Full file (for context):
\`\`\`typescript
${content.slice(0, 4000)}
\`\`\``;

        try {
          const result = await generateWithAI([{ role: "user", content: prompt }], { temperature: 0.1 }, context);
          const docBlock = extractDocBlock(result.text, docStyle);
          if (docBlock) {
            patches.push({ line: lineIndex, content: docBlock, symbolName: symbol.name });
          }
        } catch { /* skip on error */ }
      }

      if (patches.length === 0) {
        vscode.window.showInformationMessage("Could not generate documentation.");
        return;
      }

      await applyDocPatches(filePath, lines, patches);
      vscode.window.showInformationMessage(
        `Added documentation to ${patches.length} symbol(s) in ${path.basename(filePath)}.`
      );
    }
  );
}

async function applyDocPatches(
  filePath: string,
  _lines: string[],
  patches: Array<{ line: number; content: string; symbolName: string }>
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);

  const edit = new vscode.WorkspaceEdit();
  const sortedPatches = [...patches].sort((a, b) => b.line - a.line);

  for (const patch of sortedPatches) {
    const lineText = doc.lineAt(patch.line).text;
    const indent = lineText.match(/^(\s*)/)?.[1] || "";
    const docLines = patch.content.split("\n").map((l, i) => (i === 0 ? indent + l.trimStart() : indent + l));
    const docText = docLines.join("\n") + "\n";
    edit.insert(uri, new vscode.Position(patch.line, 0), docText);
  }

  await vscode.workspace.applyEdit(edit);
  try { await vscode.commands.executeCommand("editor.action.formatDocument"); } catch { /* optional */ }
}

function extractDocBlock(text: string, style: "tsdoc" | "docstring"): string | null {
  const trimmed = text.trim();
  if (style === "tsdoc") {
    const start = trimmed.indexOf("/**");
    const end   = trimmed.lastIndexOf("*/");
    if (start !== -1 && end !== -1 && end > start) {
      return trimmed.slice(start, end + 2);
    }
  } else {
    const m = trimmed.match(/"""[\s\S]*?"""/);
    if (m) { return m[0]; }
    const m2 = trimmed.match(/'''[\s\S]*?'''/);
    if (m2) { return m2[0]; }
  }
  return null;
}

export async function generateArchitectureDoc(
  rootDir: string,
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating architecture doc…", cancellable: false },
    async () => {
      let index = getCachedIndex(context);
      if (!index || index.rootDir !== rootDir) {
        index = await buildIndex(rootDir, context);
      }

      const aiContext = buildAIContext(index, { mode: "architecture", tokenBudget: 20000 }, rootDir);
      const prompt = `Generate an ARCHITECTURE.md document for this project.

Include:
# Architecture

## Overview
2-3 sentence summary of what the system does.

## Module Structure
A Mermaid flowchart TD diagram showing the main modules and their relationships.
Rules: every node in edge must be declared (A[Label]), no special chars in labels, max 10 nodes.

## Key Modules
A table or bullet list describing each major module: name, file path, responsibility.

## Data Flow
How data moves through the system (step by step).

## Design Decisions
2-3 key architectural decisions and their rationale.

Use specific file paths from the context. Return only the document content.

${aiContext}`;

      const result = await generateWithAI([{ role: "user", content: prompt }], {}, context);

      const archPath = path.join(rootDir, "ARCHITECTURE.md");
      const tmpPath  = path.join(rootDir, ".architecture-generated.md");
      fs.writeFileSync(tmpPath, result.text, "utf8");

      if (fs.existsSync(archPath)) {
        await vscode.commands.executeCommand(
          "vscode.diff", vscode.Uri.file(archPath), vscode.Uri.file(tmpPath),
          "ARCHITECTURE.md — Current vs Generated"
        );
      } else {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage("Generated architecture doc. Save as ARCHITECTURE.md to keep it.", "Save").then(
          async (choice) => {
            if (choice === "Save") {
              fs.copyFileSync(tmpPath, archPath);
              try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            }
          }
        );
      }
    }
  );
}
