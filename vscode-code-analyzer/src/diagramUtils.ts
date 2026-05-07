/**
 * Mermaid diagram sanitization and validation utilities.
 * Prevents the most common AI-generated syntax errors.
 */

const FORBIDDEN_IN_LABELS = /[()[\]<>|`{}]/g;
const NODE_DECL_RE = /(\w+)\[([^\]]*)\]/g;
const NODE_EDGE_RE = /(\w+)\s*(?:-->|---|-.->|===>|~~~|--\|>|--x)\s*(\w+)/g;

export function sanitizeMermaid(raw: string): string {
  // Extract just the mermaid block if wrapped in backticks
  const blockMatch = raw.match(/```mermaid\n([\s\S]*?)```/);
  const code = blockMatch ? blockMatch[1] : raw;

  const lines = code.split("\n");

  // Collect all declared node IDs
  const declaredNodes = new Set<string>();
  const fullContent = code;
  let m: RegExpExecArray | null;
  const declRe = new RegExp(NODE_DECL_RE.source, "g");
  while ((m = declRe.exec(fullContent)) !== null) {
    declaredNodes.add(m[1]);
  }

  // Find all edge references
  const edgeNodes = new Set<string>();
  const edgeRe = new RegExp(NODE_EDGE_RE.source, "g");
  while ((m = edgeRe.exec(fullContent)) !== null) {
    edgeNodes.add(m[1]);
    edgeNodes.add(m[2]);
  }

  // Auto-declare undeclared nodes referenced in edges
  const missingDecls: string[] = [];
  for (const nodeId of edgeNodes) {
    if (!declaredNodes.has(nodeId) && /^\w+$/.test(nodeId)) {
      const label = nodeId.replace(/_/g, " ");
      missingDecls.push(`  ${nodeId}[${label}]`);
      declaredNodes.add(nodeId);
    }
  }

  // Sanitize labels: remove forbidden characters from bracket labels
  const sanitizedLines = lines.map((line) => {
    return line.replace(/\[([^\]]*)\]/g, (match, label) => {
      const clean = label.replace(FORBIDDEN_IN_LABELS, "").trim();
      return `[${clean || "Node"}]`;
    });
  });

  // Insert missing declarations after the diagram type line
  if (missingDecls.length > 0) {
    const firstLineIdx = sanitizedLines.findIndex((l) => l.trim().match(/^(?:flowchart|graph|sequenceDiagram|classDiagram)/));
    const insertAt = firstLineIdx >= 0 ? firstLineIdx + 1 : 0;
    sanitizedLines.splice(insertAt, 0, ...missingDecls);
  }

  return sanitizedLines.join("\n");
}

export function extractMermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

export function buildDiagramRetryPrompt(originalCode: string, error: string): string {
  return `The Mermaid diagram has a syntax error: "${error}"

Original diagram:
\`\`\`
${originalCode}
\`\`\`

Fix the syntax error and return ONLY the corrected mermaid code block. Follow these strict rules:
1. Every node ID used in an edge (A --> B) must first be declared with a label: A[Label]
2. Node labels must NOT contain: ( ) [ ] < > | \` { }
3. Use only ASCII letters, numbers, and underscores in node IDs — no spaces
4. Maximum 12 nodes — group into subgraphs if needed
5. Return ONLY the \`\`\`mermaid ... \`\`\` block, nothing else`;
}
