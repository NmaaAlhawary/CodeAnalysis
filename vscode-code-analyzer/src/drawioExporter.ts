function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseNodeToken(token: string): { id: string; label: string } | null {
  const cleaned = token.trim();
  if (!cleaned) {
    return null;
  }

  const labeled = cleaned.match(/^([A-Za-z0-9_]+)\s*(\[[^\]]+\]|\([^\)]+\)|\{[^\}]+\})$/);
  if (labeled) {
    const [, id, rawLabel] = labeled;
    return { id, label: unquote(rawLabel.slice(1, -1)) || id };
  }

  const plain = cleaned.match(/^([A-Za-z0-9_]+)$/);
  if (plain) {
    return { id: plain[1], label: plain[1] };
  }

  return null;
}

function stripComment(line: string): string {
  return line.replace(/%%.*$/, "").trim();
}

export function extractFirstMermaid(markdown: string): string | null {
  const fenced = markdown.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]?.trim()) {
    return fenced[1].trim();
  }

  const asPlainMermaid = markdown.trim();
  if (/^(flowchart|graph|classDiagram|sequenceDiagram)\b/i.test(asPlainMermaid)) {
    return asPlainMermaid;
  }

  return null;
}

export function mermaidToDrawioXml(mermaidCode: string, pageName = "Architecture"): string {
  const lines = mermaidCode
    .split("\n")
    .map((line) => stripComment(line))
    .filter(Boolean);

  const nodeLabels = new Map<string, string>();
  const edges: Array<{ source: string; target: string }> = [];

  for (const rawLine of lines) {
    if (/^(flowchart|graph)\b/i.test(rawLine) || /^subgraph\b/i.test(rawLine) || /^end$/i.test(rawLine)) {
      continue;
    }

    const compact = rawLine.replace(/\s+/g, " ").trim();

    if (compact.includes("-->") || compact.includes("-.->") || compact.includes("==>")) {
      const normalized = compact
        .replace(/-.->/g, "-->")
        .replace(/==>/g, "-->")
        .replace(/\|[^|]*\|/g, "");

      const parts = normalized.split("-->");
      for (let i = 0; i < parts.length - 1; i++) {
        const leftToken = parseNodeToken(parts[i]);
        const rightToken = parseNodeToken(parts[i + 1]);
        if (!leftToken || !rightToken) {
          continue;
        }
        nodeLabels.set(leftToken.id, leftToken.label);
        nodeLabels.set(rightToken.id, rightToken.label);
        edges.push({ source: leftToken.id, target: rightToken.id });
      }
      continue;
    }

    const declaration = parseNodeToken(compact);
    if (declaration) {
      nodeLabels.set(declaration.id, declaration.label);
    }
  }

  const nodeIds = [...nodeLabels.keys()];
  if (!nodeIds.length) {
    throw new Error("No diagram nodes were found in Mermaid output.");
  }

  const mxIds = new Map<string, string>();
  let nextId = 2;
  for (const nodeId of nodeIds) {
    mxIds.set(nodeId, String(nextId++));
  }

  const columns = Math.max(2, Math.ceil(Math.sqrt(nodeIds.length)));
  const nodeWidth = 220;
  const nodeHeight = 72;
  const gapX = 70;
  const gapY = 54;

  const nodeCells = nodeIds
    .map((nodeId, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = 40 + col * (nodeWidth + gapX);
      const y = 40 + row * (nodeHeight + gapY);
      const label = escapeXml(nodeLabels.get(nodeId) || nodeId);
      const id = mxIds.get(nodeId);
      return `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;" parent="1" vertex="1"><mxGeometry x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" as="geometry"/></mxCell>`;
    })
    .join("");

  const edgeCells = edges
    .map((edge) => {
      const source = mxIds.get(edge.source);
      const target = mxIds.get(edge.target);
      if (!source || !target) {
        return "";
      }
      const id = String(nextId++);
      return `<mxCell id="${id}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#3d3d3d;" parent="1" source="${source}" target="${target}" edge="1"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" modified="${new Date().toISOString()}" agent="code-analyzer" version="24.7.17" type="device">
  <diagram id="architecture" name="${escapeXml(pageName)}">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1920" pageHeight="1080" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${nodeCells}
        ${edgeCells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}
