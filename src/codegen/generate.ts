import type { ContextIR, DesignIR, DesignNode } from "../core/ir.js";

export type CodeTarget = "html" | "react";
export type DesignSnapshot = DesignIR | ContextIR;

export interface GeneratedCode {
  target: CodeTarget;
  files: Record<string, string>;
  nodeCount: number;
  screenCount: number;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsx(value: string): string {
  return escapeHtml(value).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

function cssClass(id: string): string {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `dp-${(hash >>> 0).toString(16)}`;
}

function colorToCss(color: { r: number; g: number; b: number; a?: number | undefined }): string {
  const rgb = [color.r, color.g, color.b]
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255))
    .join(", ");
  return color.a === undefined ? `rgb(${rgb})` : `rgba(${rgb}, ${color.a})`;
}

function nodeFill(node: DesignNode): string | null {
  const fill = node.fills?.find((item) => item.type === "solid" && item.color);
  return fill?.color ? colorToCss(fill.color) : null;
}

function nodeStyle(node: DesignNode, origin: { x: number; y: number }): string {
  const bounds = node.bounds;
  const declarations: string[] = ["position: absolute"];
  if (bounds) {
    declarations.push(`left: ${Math.round(bounds.x - origin.x)}px`);
    declarations.push(`top: ${Math.round(bounds.y - origin.y)}px`);
    declarations.push(`width: ${Math.round(bounds.width)}px`);
    declarations.push(`height: ${Math.round(bounds.height)}px`);
  }
  const fill = nodeFill(node);
  if (fill) declarations.push(`${node.kind === "text" ? "color" : "background"}: ${fill}`);
  if (node.opacity !== undefined) declarations.push(`opacity: ${node.opacity}`);
  if (node.typography?.family) declarations.push(`font-family: ${JSON.stringify(node.typography.family)}`);
  if (node.typography?.size) declarations.push(`font-size: ${node.typography.size}px`);
  if (node.typography?.weight) declarations.push(`font-weight: ${node.typography.weight}`);
  if (node.typography?.align) declarations.push(`text-align: ${node.typography.align}`);
  return declarations.join("; ");
}

function allNodes(snapshot: DesignSnapshot): DesignNode[] {
  return "scope" in snapshot ? snapshot.nodes : Object.values(snapshot.nodes);
}

function nodeMap(snapshot: DesignSnapshot): Map<string, DesignNode> {
  return new Map(allNodes(snapshot).map((node) => [node.id, node]));
}

function styleOriginFor(
  node: DesignNode,
  map: Map<string, DesignNode>,
  fallback: { x: number; y: number },
): { x: number; y: number } {
  const visited = new Set<string>();
  let current: DesignNode | undefined = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === "screen" && current.bounds) {
      return { x: current.bounds.x, y: current.bounds.y };
    }
    current = current.parentId ? map.get(current.parentId) : undefined;
  }
  return fallback;
}

function boundsOrigin(snapshot: DesignSnapshot): { x: number; y: number } {
  const nodes = allNodes(snapshot).filter((node) => node.bounds);
  const x = Math.min(...nodes.map((node) => node.bounds?.x ?? 0), 0);
  const y = Math.min(...nodes.map((node) => node.bounds?.y ?? 0), 0);
  return { x, y };
}

function rootNodes(snapshot: DesignSnapshot): DesignNode[] {
  const map = nodeMap(snapshot);
  const children = new Set(allNodes(snapshot).flatMap((node) => node.children));
  const explicitRoots = allNodes(snapshot).filter((node) => !children.has(node.id));
  if ("scope" in snapshot && snapshot.scope === "screen" && snapshot.screenId) {
    const screen = map.get(snapshot.screenId);
    if (screen) return [screen];
  }
  if ("scope" in snapshot && snapshot.scope === "selection" && snapshot.selection.length) {
    return snapshot.selection
      .map((item) => map.get(item.id))
      .filter((node): node is DesignNode => Boolean(node));
  }
  if (!("scope" in snapshot) && snapshot.screens.length) {
    return snapshot.screens
      .map((item) => map.get(item.id))
      .filter((node): node is DesignNode => Boolean(node));
  }
  return explicitRoots;
}

function childrenOf(node: DesignNode, map: Map<string, DesignNode>): DesignNode[] {
  return node.children
    .map((id) => map.get(id))
    .filter((child): child is DesignNode => Boolean(child));
}

function renderHtmlNode(node: DesignNode, map: Map<string, DesignNode>, origin: { x: number; y: number }): string {
  const className = cssClass(node.id);
  const label = node.kind === "text" && node.text ? escapeHtml(node.text) : "";
  const children = childrenOf(node, map)
    .map((child) => renderHtmlNode(child, map, origin))
    .join("");
  return `<div class="${className} dp-node dp-${node.kind}" data-designport-id="${escapeHtml(node.id)}" style="${nodeStyle(node, origin)}">${label}${children}</div>`;
}

function screenBounds(node: DesignNode): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(node.bounds?.width ?? 1440)),
    height: Math.max(1, Math.round(node.bounds?.height ?? 900)),
  };
}

function generateHtml(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const origin = boundsOrigin(snapshot);
  const roots = rootNodes(snapshot);
  const body = roots.map((node) => {
    const size = node.kind === "screen" ? screenBounds(node) : undefined;
    const style = size
      ? `position: relative; width: ${size.width}px; height: ${size.height}px; overflow: hidden;`
      : "position: relative; min-height: 320px;";
    return `<section class="dp-screen" data-designport-id="${escapeHtml(node.id)}" style="${style}">${childrenOf(node, map).map((child) => renderHtmlNode(child, map, node.bounds ? { x: node.bounds.x, y: node.bounds.y } : origin)).join("")}</section>`;
  }).join("\n");
  const classes = allNodes(snapshot)
    .map((node) => `.${cssClass(node.id)} { ${nodeStyle(node, styleOriginFor(node, map, origin))} }`)
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DesignPort export</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #f4f6f8; color: #17202a; }
      .dp-screen { margin: 24px auto; background: #fff; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
      .dp-node { box-sizing: border-box; }
      .dp-text { white-space: pre-wrap; overflow: hidden; }
      ${classes}
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>
`;
  return {
    target: "html",
    files: { "designport-export.html": html },
    nodeCount: allNodes(snapshot).length,
    screenCount: roots.filter((node) => node.kind === "screen").length,
  };
}

function renderReactNode(node: DesignNode, map: Map<string, DesignNode>): string {
  const children = childrenOf(node, map).map((child) => renderReactNode(child, map)).join("");
  const content = node.kind === "text" && node.text ? escapeJsx(node.text) : children;
  return `<div className="${cssClass(node.id)} dp-node dp-${node.kind}" data-designport-id="${escapeHtml(node.id)}">${content}</div>`;
}

function generateReact(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const roots = rootNodes(snapshot);
  const origin = boundsOrigin(snapshot);
  const markup = roots.map((node) => {
    const size = screenBounds(node);
    const children = childrenOf(node, map).map((child) => renderReactNode(child, map)).join("");
    return `<section className="dp-screen" data-designport-id="${escapeHtml(node.id)}" style={{ width: ${size.width}, height: ${size.height} }}>${children}</section>`;
  }).join("\n");
  const css = `* { box-sizing: border-box; }
body { margin: 0; background: #f4f6f8; color: #17202a; }
.dp-screen { position: relative; margin: 24px auto; background: #fff; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
.dp-node { position: absolute; box-sizing: border-box; }
.dp-text { white-space: pre-wrap; overflow: hidden; }
${allNodes(snapshot).map((node) => `.${cssClass(node.id)} { ${nodeStyle(node, styleOriginFor(node, map, origin))} }`).join("\n")}
`;
  const component = `import "./DesignPortScreen.css";

export default function DesignPortScreen() {
  return (
    <>
${markup.split("\n").map((line) => `      ${line}`).join("\n")}
    </>
  );
}
`;
  return {
    target: "react",
    files: {
      "DesignPortScreen.tsx": component,
      "DesignPortScreen.css": css,
    },
    nodeCount: allNodes(snapshot).length,
    screenCount: roots.filter((node) => node.kind === "screen").length,
  };
}

export function generateCode(snapshot: DesignSnapshot, target: CodeTarget): GeneratedCode {
  return target === "html" ? generateHtml(snapshot) : generateReact(snapshot);
}
