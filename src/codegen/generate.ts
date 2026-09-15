import type { Color, ContextIR, DesignIR, DesignNode } from "../core/ir.js";

export type CodeTarget =
  | "html"
  | "web"
  | "react"
  | "vue"
  | "flutter"
  | "swiftui"
  | "compose";
export type DesignSnapshot = DesignIR | ContextIR;

export interface GeneratedCode {
  target: CodeTarget;
  files: Record<string, string>;
  nodeCount: number;
  screenCount: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TextAlignValue = NonNullable<DesignNode["typography"]>["align"];

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function formatFloat(value: number): string {
  return `${formatNumber(value)}f`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function quoteString(value: string): string {
  return JSON.stringify(value);
}

function quoteDart(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("$", "\\$")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}'`;
}

function cssClass(id: string): string {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `dp-${(hash >>> 0).toString(16)}`;
}

function allNodes(snapshot: DesignSnapshot): DesignNode[] {
  return "scope" in snapshot ? snapshot.nodes : Object.values(snapshot.nodes);
}

function nodeMap(snapshot: DesignSnapshot): Map<string, DesignNode> {
  return new Map(allNodes(snapshot).map((node) => [node.id, node]));
}

function childrenOf(node: DesignNode, map: Map<string, DesignNode>): DesignNode[] {
  return node.children
    .map((id) => map.get(id))
    .filter((child): child is DesignNode => Boolean(child));
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

function screenBounds(node: DesignNode): Box {
  return {
    x: node.bounds?.x ?? 0,
    y: node.bounds?.y ?? 0,
    width: Math.max(1, Math.round(node.bounds?.width ?? 1440)),
    height: Math.max(1, Math.round(node.bounds?.height ?? 900)),
  };
}

function relativeBox(node: DesignNode, parent: Box | null): Box {
  const bounds = node.bounds;
  const origin = parent ?? { x: 0, y: 0 };
  return {
    x: bounds ? bounds.x - origin.x : 0,
    y: bounds ? bounds.y - origin.y : 0,
    width: Math.max(0, Math.round(bounds?.width ?? parent?.width ?? 0)),
    height: Math.max(0, Math.round(bounds?.height ?? parent?.height ?? 0)),
  };
}

function nodeFill(node: DesignNode): Color | undefined {
  return node.fills?.find((fill) => fill.type === "solid" && fill.color)?.color;
}

function colorToCss(color: Color): string {
  const rgb = [color.r, color.g, color.b]
    .map((channel) => Math.round(clamp(channel, 0, 1) * 255))
    .join(", ");
  return color.a === undefined
    ? `rgb(${rgb})`
    : `rgba(${rgb}, ${formatNumber(clamp(color.a, 0, 1))})`;
}

type LayoutMode = "horizontal" | "vertical" | "grid";

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface LayoutPlan {
  mode: LayoutMode;
  gap: number;
  padding: Padding;
  columns?: number;
  inferred: boolean;
  fillChildId?: string;
}

type StyleMap = Record<string, string | number>;

const zeroPadding: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

function paddingFrom(node: DesignNode): Padding {
  const padding = node.layout?.padding;
  return padding ? { ...padding } : { ...zeroPadding };
}

function coordinateGroupCount(values: number[], tolerance: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  let count = 0;
  let last: number | undefined;
  for (const value of sorted) {
    if (last === undefined || Math.abs(value - last) > tolerance) count += 1;
    last = value;
  }
  return count;
}

function inferredGap(children: DesignNode[], mode: LayoutMode): number {
  const withBounds = children.filter((child) => child.bounds);
  const sorted = [...withBounds].sort((left, right) => mode === "horizontal"
    ? (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0)
    : (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0));
  const gaps = sorted.slice(1).map((child, index) => {
    const previous = sorted[index]?.bounds;
    const current = child.bounds;
    if (!previous || !current) return 0;
    return mode === "horizontal"
      ? current.x - (previous.x + previous.width)
      : current.y - (previous.y + previous.height);
  }).filter((gap) => gap > 0);
  if (!gaps.length) return 0;
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

function inferredPadding(node: DesignNode, children: DesignNode[]): Padding {
  const parent = node.bounds;
  const withBounds = children.filter((child) => child.bounds);
  if (!parent || !withBounds.length) return { ...zeroPadding };
  const left = Math.min(...withBounds.map((child) => (child.bounds?.x ?? parent.x) - parent.x));
  const top = Math.min(...withBounds.map((child) => (child.bounds?.y ?? parent.y) - parent.y));
  const right = Math.min(...withBounds.map((child) => parent.x + parent.width - ((child.bounds?.x ?? parent.x) + (child.bounds?.width ?? 0))));
  const bottom = Math.min(...withBounds.map((child) => parent.y + parent.height - ((child.bounds?.y ?? parent.y) + (child.bounds?.height ?? 0))));
  return {
    top: Math.max(0, Math.round(top)),
    right: Math.max(0, Math.round(right)),
    bottom: Math.max(0, Math.round(bottom)),
    left: Math.max(0, Math.round(left)),
  };
}

function flexibleChildId(children: DesignNode[], mode: LayoutMode): string | undefined {
  const axis = mode === "horizontal" ? "horizontal" : mode === "vertical" ? "vertical" : null;
  if (axis) {
    const explicit = children.filter((child) => sizingFor(child, axis) === "fill");
    if (explicit.length === 1) return explicit[0]?.id;
  }
  if (!axis || children.length !== 2) return undefined;
  const sorted = [...children].sort((left, right) => {
    const leftValue = mode === "horizontal" ? left.bounds?.width ?? 0 : left.bounds?.height ?? 0;
    const rightValue = mode === "horizontal" ? right.bounds?.width ?? 0 : right.bounds?.height ?? 0;
    return rightValue - leftValue;
  });
  const larger = sorted[0];
  const smaller = sorted[1];
  if (!larger || !smaller) return undefined;
  const largerSize = mode === "horizontal" ? larger.bounds?.width ?? 0 : larger.bounds?.height ?? 0;
  const smallerSize = Math.max(1, mode === "horizontal" ? smaller.bounds?.width ?? 0 : smaller.bounds?.height ?? 0);
  return largerSize / smallerSize >= 1.5 ? larger.id : undefined;
}

function inferLayoutPlan(node: DesignNode, map: Map<string, DesignNode>): LayoutPlan | null {
  const children = childrenOf(node, map).filter((child) => child.bounds);
  const parent = node.bounds;
  if (!parent || children.length < 2) return null;

  const alignmentTolerance = Math.max(8, parent.width * 0.04, parent.height * 0.04);
  const sortedHorizontal = [...children].sort((left, right) => (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0));
  const sortedVertical = [...children].sort((left, right) => (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0));
  const horizontalCenters = sortedHorizontal.map((child) => (child.bounds?.y ?? 0) + (child.bounds?.height ?? 0) / 2);
  const verticalCenters = sortedVertical.map((child) => (child.bounds?.x ?? 0) + (child.bounds?.width ?? 0) / 2);
  const sameRow = horizontalCenters.every((center) => Math.abs(center - (horizontalCenters[0] ?? center)) <= alignmentTolerance);
  const sameColumn = verticalCenters.every((center) => Math.abs(center - (verticalCenters[0] ?? center)) <= alignmentTolerance);
  const separatedHorizontally = sortedHorizontal.slice(1).every((child, index) => {
    const previous = sortedHorizontal[index]?.bounds;
    return previous && child.bounds ? child.bounds.x >= previous.x + previous.width - 2 : false;
  });
  const separatedVertically = sortedVertical.slice(1).every((child, index) => {
    const previous = sortedVertical[index]?.bounds;
    return previous && child.bounds ? child.bounds.y >= previous.y + previous.height - 2 : false;
  });

  let mode: LayoutMode | undefined;
  if (sameRow && separatedHorizontally) {
    mode = "horizontal";
  } else if (sameColumn && separatedVertically) {
    mode = "vertical";
  } else {
    const columns = coordinateGroupCount(children.map((child) => child.bounds?.x ?? 0), alignmentTolerance);
    const rows = coordinateGroupCount(children.map((child) => child.bounds?.y ?? 0), alignmentTolerance);
    if (columns > 1 && rows > 1) mode = "grid";
  }
  if (!mode) return null;

  const plan: LayoutPlan = {
    mode,
    gap: mode === "grid" ? inferredGap(children, "vertical") : inferredGap(children, mode),
    padding: inferredPadding(node, children),
    inferred: true,
  };
  if (mode === "grid") {
    plan.columns = Math.max(1, coordinateGroupCount(children.map((child) => child.bounds?.x ?? 0), alignmentTolerance));
  }
  const fillChildId = flexibleChildId(children, mode);
  if (fillChildId) plan.fillChildId = fillChildId;
  return plan;
}

function layoutPlanFor(node: DesignNode, map: Map<string, DesignNode>): LayoutPlan | null {
  const explicit = node.layout;
  if (explicit?.mode === "none") return null;
  if (explicit?.mode) {
    const plan: LayoutPlan = {
      mode: explicit.mode,
      gap: explicit.gap ?? 0,
      padding: paddingFrom(node),
      inferred: false,
    };
    if (explicit.mode === "grid") {
      const children = childrenOf(node, map).filter((child) => child.bounds);
      plan.columns = Math.max(1, coordinateGroupCount(
        children.map((child) => child.bounds?.x ?? 0),
        Math.max(8, (node.bounds?.width ?? 0) * 0.04),
      ));
    }
    const fillChildId = flexibleChildId(childrenOf(node, map).filter((child) => child.bounds), explicit.mode);
    if (fillChildId) plan.fillChildId = fillChildId;
    return plan;
  }
  return inferLayoutPlan(node, map);
}

function sizingFor(node: DesignNode, axis: "horizontal" | "vertical"): "fixed" | "hug" | "fill" {
  return axis === "horizontal"
    ? node.layout?.sizingHorizontal ?? "fixed"
    : node.layout?.sizingVertical ?? "fixed";
}

function effectiveSizing(
  node: DesignNode,
  parentLayout: LayoutPlan,
  axis: "horizontal" | "vertical",
): "fixed" | "hug" | "fill" {
  if (parentLayout.fillChildId === node.id && (
    (axis === "horizontal" && parentLayout.mode === "horizontal")
    || (axis === "vertical" && parentLayout.mode === "vertical")
  )) return "fill";
  return sizingFor(node, axis);
}

function visualStyleFor(node: DesignNode): StyleMap {
  const style: StyleMap = {};
  const fill = nodeFill(node);
  if (fill) style[node.kind === "text" ? "color" : "background"] = colorToCss(fill);
  if (node.visible === false) style.visibility = "hidden";
  if (node.opacity !== undefined) style.opacity = node.opacity;
  if (node.typography?.family) style["font-family"] = node.typography.family;
  if (node.typography?.style) style["font-style"] = node.typography.style;
  if (node.typography?.size) style["font-size"] = `${formatNumber(node.typography.size)}px`;
  if (node.typography?.weight) style["font-weight"] = node.typography.weight;
  if (node.typography?.lineHeight) style["line-height"] = `${formatNumber(node.typography.lineHeight)}px`;
  if (node.typography?.letterSpacing) style["letter-spacing"] = `${formatNumber(node.typography.letterSpacing)}px`;
  if (node.typography?.align) style["text-align"] = node.typography.align;
  return style;
}

function layoutStyleFor(plan: LayoutPlan | null): StyleMap {
  if (!plan) return {};
  const style: StyleMap = {
    display: plan.mode === "grid" ? "grid" : "flex",
    ...(plan.mode === "horizontal" ? { "flex-direction": "row" } : {}),
    ...(plan.mode === "vertical" ? { "flex-direction": "column" } : {}),
    ...(plan.mode === "grid" ? { "grid-template-columns": `repeat(${plan.columns ?? 1}, minmax(0, 1fr))` } : {}),
    ...(plan.gap > 0 ? { gap: `${formatNumber(plan.gap)}px` } : {}),
  };
  const { top, right, bottom, left } = plan.padding;
  if (top || right || bottom || left) {
    style.padding = `${formatNumber(top)}px ${formatNumber(right)}px ${formatNumber(bottom)}px ${formatNumber(left)}px`;
  }
  return style;
}

function placementStyleFor(
  node: DesignNode,
  parentBounds: Box | null,
  parentLayout: LayoutPlan | null,
): StyleMap {
  const frame = relativeBox(node, parentBounds);
  if (!parentLayout) {
    return {
      position: "absolute",
      left: `${formatNumber(frame.x)}px`,
      top: `${formatNumber(frame.y)}px`,
      width: `${formatNumber(frame.width)}px`,
      height: `${formatNumber(frame.height)}px`,
    };
  }

  if (parentLayout.mode === "horizontal" || parentLayout.mode === "vertical") {
    const primaryAxis = parentLayout.mode === "horizontal" ? "horizontal" : "vertical";
    const crossAxis = primaryAxis === "horizontal" ? "vertical" : "horizontal";
    const primarySize = primaryAxis === "horizontal" ? frame.width : frame.height;
    const primarySizing = effectiveSizing(node, parentLayout, primaryAxis);
    const crossSizing = sizingFor(node, crossAxis);
    const style: StyleMap = { position: "relative", "min-width": "0", "min-height": "0" };
    style.flex = primarySizing === "fill"
      ? "1 1 0"
      : primarySizing === "hug"
        ? "0 1 auto"
        : `0 0 ${formatNumber(primarySize)}px`;
    if (primarySizing === "hug") {
      style[primaryAxis === "horizontal" ? "max-width" : "max-height"] = "100%";
    }
    if (crossSizing === "fill") {
      style["align-self"] = "stretch";
    } else {
      style[crossAxis === "horizontal" ? "width" : "height"] = `${formatNumber(crossAxis === "horizontal" ? frame.width : frame.height)}px`;
    }
    return style;
  }

  return {
    position: "relative",
    width: sizingFor(node, "horizontal") === "fill" ? "100%" : `${formatNumber(frame.width)}px`,
    height: sizingFor(node, "vertical") === "fill" ? "100%" : `${formatNumber(frame.height)}px`,
    "min-width": "0",
    "min-height": "0",
  };
}

function cssString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function cssStyle(style: StyleMap): string {
  return Object.entries(style)
    .map(([property, value]) => `${property}: ${typeof value === "number" ? formatNumber(value) : (property === "font-family" || property === "font-style" ? cssString(value) : value)}`)
    .join("; ");
}

function reactStyleKey(property: string): string {
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function reactStyle(style: StyleMap): string {
  return `{{ ${Object.entries(style)
    .map(([property, value]) => `${reactStyleKey(property)}: ${typeof value === "number" ? formatNumber(value) : quoteString(value)}`)
    .join(", ")} }}`;
}

function sharedCss(_snapshot: DesignSnapshot): string {
  return `* { box-sizing: border-box; }
body { margin: 0; background: #f4f6f8; color: #17202a; }
.designport-document { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
.dp-screen { position: relative; margin: 0 auto; box-shadow: 0 8px 30px rgba(0,0,0,.08); overflow: hidden; }
.dp-node { box-sizing: border-box; }
.dp-text { white-space: pre-wrap; overflow: hidden; }
.dp-action { font: inherit; text-align: inherit; border: 0; cursor: pointer; }
`;
}

function renderWebNode(
  node: DesignNode,
  map: Map<string, DesignNode>,
  parentBounds: Box | null,
  parentLayout: LayoutPlan | null,
  parentAction = false,
): string {
  const ownLayout = layoutPlanFor(node, map);
  const style = {
    ...placementStyleFor(node, parentBounds, parentLayout),
    ...visualStyleFor(node),
    ...layoutStyleFor(ownLayout),
  };
  const action = !parentAction && isActionNode(node);
  const children = childrenOf(node, map)
    .map((child) => renderWebNode(child, map, node.bounds, ownLayout, parentAction || action))
    .join("\n");
  const label = node.kind === "text" && node.text ? escapeHtml(node.text) : "";
  const tag = action ? "button" : "div";
  const actionAttributes = tag === "button"
    ? ` type="button" aria-label="${escapeHtml(node.text || node.name)}"`
    : "";
  return `<${tag} class="${cssClass(node.id)} dp-node dp-${node.kind}${tag === "button" ? " dp-action" : ""}" data-designport-id="${escapeHtml(node.id)}"${actionAttributes} style="${cssStyle(style)}">${label}${children}</${tag}>`;
}

function renderWebSections(snapshot: DesignSnapshot, _vue: boolean): string {
  const map = nodeMap(snapshot);
  return rootNodes(snapshot)
    .map((root) => {
      const size = screenBounds(root);
      const ownLayout = layoutPlanFor(root, map);
      const rootStyle: StyleMap = {
        position: "relative",
        width: `${formatNumber(size.width)}px`,
        height: `${formatNumber(size.height)}px`,
        overflow: "hidden",
        ...visualStyleFor(root),
        ...layoutStyleFor(ownLayout),
      };
      const nodes = root.kind === "screen"
        ? childrenOf(root, map).map((child) => renderWebNode(child, map, root.bounds, ownLayout)).join("\n")
        : renderWebNode(root, map, null, null);
      return `<section class="dp-screen" data-designport-id="${escapeHtml(root.id)}" style="${cssStyle(rootStyle)}">${nodes}</section>`;
    })
    .join("\n");
}

function generateHtml(snapshot: DesignSnapshot): GeneratedCode {
  const body = renderWebSections(snapshot, false);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DesignPort export</title>
    <style>
${sharedCss(snapshot)}    </style>
  </head>
  <body>
    <div class="designport-document">
    ${body}
    </div>
  </body>
</html>
`;
  return {
    target: "html",
    files: { "designport-export.html": html },
    nodeCount: allNodes(snapshot).length,
    screenCount: rootNodes(snapshot).filter((node) => node.kind === "screen").length,
  };
}

function generateWeb(snapshot: DesignSnapshot): GeneratedCode {
  const body = renderWebSections(snapshot, false);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DesignPort web export</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div class="designport-document">
    ${body}
    </div>
  </body>
</html>
`;
  return {
    target: "web",
    files: {
      "index.html": html,
      "styles.css": sharedCss(snapshot),
    },
    nodeCount: allNodes(snapshot).length,
    screenCount: rootNodes(snapshot).filter((node) => node.kind === "screen").length,
  };
}

function renderReactNode(
  node: DesignNode,
  map: Map<string, DesignNode>,
  parentBounds: Box | null,
  parentLayout: LayoutPlan | null,
  parentAction = false,
): string {
  const ownLayout = layoutPlanFor(node, map);
  const style = {
    ...placementStyleFor(node, parentBounds, parentLayout),
    ...visualStyleFor(node),
    ...layoutStyleFor(ownLayout),
  };
  const action = !parentAction && isActionNode(node);
  const children = childrenOf(node, map)
    .map((child) => renderReactNode(child, map, node.bounds, ownLayout, parentAction || action))
    .join("\n");
  const label = node.kind === "text" && node.text ? escapeHtml(node.text) : "";
  const tag = action ? "button" : "div";
  const actionAttributes = action
    ? ` type="button" aria-label="${escapeHtml(node.text || node.name)}"`
    : "";
  return `<${tag} className="${cssClass(node.id)} dp-node dp-${node.kind}${action ? " dp-action" : ""}" data-designport-id="${escapeHtml(node.id)}"${actionAttributes} style=${reactStyle(style)}>${label}${children}</${tag}>`;
}

function generateReact(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const markup = rootNodes(snapshot)
    .map((root) => {
      const size = screenBounds(root);
      const ownLayout = layoutPlanFor(root, map);
      const rootStyle: StyleMap = {
        position: "relative",
        width: `${formatNumber(size.width)}px`,
        height: `${formatNumber(size.height)}px`,
        overflow: "hidden",
        ...visualStyleFor(root),
        ...layoutStyleFor(ownLayout),
      };
      const nodes = root.kind === "screen"
        ? childrenOf(root, map).map((child) => renderReactNode(child, map, root.bounds, ownLayout)).join("\n")
        : renderReactNode(root, map, null, null);
      return `<section className="dp-screen" data-designport-id="${escapeHtml(root.id)}" style=${reactStyle(rootStyle)}>${nodes}</section>`;
    })
    .join("\n");
  const component = `import "./DesignPortScreen.css";

export default function DesignPortScreen() {
  return (
    <div className="designport-document">
      ${markup}
    </div>
  );
}
`;
  return {
    target: "react",
    files: {
      "DesignPortScreen.tsx": component,
      "DesignPortScreen.css": sharedCss(snapshot),
    },
    nodeCount: allNodes(snapshot).length,
    screenCount: rootNodes(snapshot).filter((node) => node.kind === "screen").length,
  };
}

function generateVue(snapshot: DesignSnapshot): GeneratedCode {
  const body = renderWebSections(snapshot, true);
  const component = `<template>
  <div class="designport-document">
    ${body}
  </div>
</template>

<style scoped>
${sharedCss(snapshot)}</style>
`;
  return {
    target: "vue",
    files: { "DesignPortScreen.vue": component },
    nodeCount: allNodes(snapshot).length,
    screenCount: rootNodes(snapshot).filter((node) => node.kind === "screen").length,
  };
}

function mobileOpacity(node: DesignNode): number | undefined {
  if (node.visible === false) return 0;
  return node.opacity;
}

function isActionNode(node: DesignNode): boolean {
  return /\b(button|cta|action|link|submit|continue|next|save|cancel|confirm)\b/.test(node.name.toLowerCase());
}

function flutterColor(color: Color | undefined): string {
  if (!color) return "const Color(0x00000000)";
  return `Color.fromRGBO(${Math.round(clamp(color.r, 0, 1) * 255)}, ${Math.round(clamp(color.g, 0, 1) * 255)}, ${Math.round(clamp(color.b, 0, 1) * 255)}, ${formatNumber(clamp(color.a ?? 1, 0, 1))})`;
}

function flutterWeight(weight: number | undefined): string | undefined {
  if (weight === undefined) return undefined;
  const value = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  return `FontWeight.w${value}`;
}

function flutterTextAlign(value: TextAlignValue): string | undefined {
  switch (value) {
    case "left": return "TextAlign.left";
    case "center": return "TextAlign.center";
    case "right": return "TextAlign.right";
    case "justified": return "TextAlign.justify";
    default: return undefined;
  }
}

function flutterTextStyle(node: DesignNode): string {
  const values: string[] = [];
  const fill = nodeFill(node);
  if (fill) values.push(`color: ${flutterColor(fill)}`);
  if (node.typography?.family) values.push(`fontFamily: ${quoteDart(node.typography.family)}`);
  if (node.typography?.size) values.push(`fontSize: ${formatNumber(node.typography.size)}`);
  const weight = flutterWeight(node.typography?.weight);
  if (weight) values.push(`fontWeight: ${weight}`);
  return values.length ? `TextStyle(${values.join(", ")})` : "null";
}

function flutterDecoration(node: DesignNode): string {
  const fill = nodeFill(node);
  if (!fill && node.kind !== "ellipse") return "null";
  return `BoxDecoration(color: ${flutterColor(fill)}${node.kind === "ellipse" ? ", shape: BoxShape.circle" : ""})`;
}

function flutterPadding(plan: LayoutPlan): string {
  const { top, right, bottom, left } = plan.padding;
  if (!top && !right && !bottom && !left) return "EdgeInsets.zero";
  return `EdgeInsets.fromLTRB(${formatNumber(left)}, ${formatNumber(top)}, ${formatNumber(right)}, ${formatNumber(bottom)})`;
}

function renderFlutterFlowChildren(
  node: DesignNode,
  map: Map<string, DesignNode>,
  plan: LayoutPlan,
  parentAction = false,
): string {
  const directChildren = childrenOf(node, map);
  const children = directChildren.map((child) => {
    const item = renderFlutterNode(child, map, node.bounds, plan, parentAction);
    if (plan.mode === "horizontal") {
      const sizing = effectiveSizing(child, plan, "horizontal");
      if (sizing === "fill") return `Expanded(child: ${item})`;
      if (sizing === "hug") return `Flexible(fit: FlexFit.loose, child: ${item})`;
    }
    if (plan.mode === "vertical") {
      const sizing = effectiveSizing(child, plan, "vertical");
      if (sizing === "fill") return `Expanded(child: ${item})`;
      if (sizing === "hug") return `Flexible(fit: FlexFit.loose, child: ${item})`;
    }
    return item;
  });

  if (plan.mode === "horizontal") {
    const crossAxis = directChildren.some((child) => sizingFor(child, "vertical") === "fill")
      ? "CrossAxisAlignment.stretch"
      : "CrossAxisAlignment.start";
    return `Row(crossAxisAlignment: ${crossAxis}, children: [${children.join(", ")}])`;
  }
  if (plan.mode === "vertical") {
    const crossAxis = directChildren.some((child) => sizingFor(child, "horizontal") === "fill")
      ? "CrossAxisAlignment.stretch"
      : "CrossAxisAlignment.start";
    return `Column(crossAxisAlignment: ${crossAxis}, children: [${children.join(", ")}])`;
  }
  return `Wrap(spacing: ${formatNumber(plan.gap)}, runSpacing: ${formatNumber(plan.gap)}, children: [${children.join(", ")}])`;
}

function flutterFlowItemSize(
  node: DesignNode,
  frame: Box,
  parentLayout: LayoutPlan,
  content: string,
): string {
  if (parentLayout.mode === "horizontal") {
    const primary = effectiveSizing(node, parentLayout, "horizontal");
    const cross = sizingFor(node, "vertical");
    const width = primary === "fixed" ? `width: ${formatNumber(frame.width)}, ` : "";
    const height = cross === "fill" ? "" : `height: ${formatNumber(frame.height)}, `;
    return `SizedBox(${width}${height}child: ${content})`;
  }
  if (parentLayout.mode === "vertical") {
    const primary = effectiveSizing(node, parentLayout, "vertical");
    const cross = sizingFor(node, "horizontal");
    const width = cross === "fill" ? "" : `width: ${formatNumber(frame.width)}, `;
    const height = primary === "fixed" ? `height: ${formatNumber(frame.height)}, ` : "";
    return `SizedBox(${width}${height}child: ${content})`;
  }
  return `SizedBox(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, child: ${content})`;
}

function renderFlutterNode(
  node: DesignNode,
  map: Map<string, DesignNode>,
  parent: Box | null,
  parentLayout: LayoutPlan | null = null,
  parentAction = false,
): string {
  const frame = relativeBox(node, parent);
  const ownLayout = layoutPlanFor(node, map);
  const children = childrenOf(node, map);
  const action = !parentAction && isActionNode(node);
  let content: string;

  if (node.kind === "text") {
    const align = flutterTextAlign(node.typography?.align);
    const argumentsList = [quoteDart(node.text ?? ""), `style: ${flutterTextStyle(node)}`];
    if (align) argumentsList.push(`textAlign: ${align}`);
    content = `Text(${argumentsList.join(", ")})`;
  } else if (children.length || nodeFill(node) || node.kind === "ellipse") {
    const child = ownLayout
      ? renderFlutterFlowChildren(node, map, ownLayout, parentAction || action)
      : children.length
        ? `Stack(clipBehavior: Clip.hardEdge, children: [${children.map((child) => renderFlutterNode(child, map, node.bounds, null, parentAction || action)).join(", ")}])`
        : "null";
    const padding = ownLayout ? `, padding: ${flutterPadding(ownLayout)}` : "";
    content = `Container(decoration: ${flutterDecoration(node)}${padding}, child: ${child})`;
  } else {
    content = "const SizedBox.shrink()";
  }

  if (action) {
    if (!children.length && node.kind !== "text") content = `Text(${quoteDart(node.name)})`;
    content = `CupertinoButton.filled(padding: EdgeInsets.zero, minSize: 0, onPressed: () {}, child: ${content})`;
  }

  let wrapped = parentLayout
    ? flutterFlowItemSize(node, frame, parentLayout, content)
    : `SizedBox(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, child: ${content})`;
  const opacity = mobileOpacity(node);
  if (opacity !== undefined) {
    wrapped = `Opacity(opacity: ${formatNumber(opacity)}, child: ${wrapped})`;
  }
  return parentLayout
    ? wrapped
    : `Positioned(left: ${formatNumber(frame.x)}, top: ${formatNumber(frame.y)}, width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, child: ${wrapped})`;
}

function renderFlutterRoot(root: DesignNode, map: Map<string, DesignNode>): string {
  const size = screenBounds(root);
  const plan = layoutPlanFor(root, map);
  const children = root.kind === "screen"
    ? (plan
      ? renderFlutterFlowChildren(root, map, plan)
      : `Stack(clipBehavior: Clip.hardEdge, children: [${childrenOf(root, map).map((child) => renderFlutterNode(child, map, root.bounds)).join(", ")}])`)
    : `Stack(clipBehavior: Clip.hardEdge, children: [${renderFlutterNode(root, map, null)}])`;
  const fill = nodeFill(root);
  const padding = plan ? `, padding: ${flutterPadding(plan)}` : "";
  const container = `Container(decoration: ${fill ? `BoxDecoration(color: ${flutterColor(fill)})` : "null"}${padding}, child: ${children})`;
  return `SizedBox(width: ${formatNumber(size.width)}, height: ${formatNumber(size.height)}, child: ${container})`;
}

function generateFlutter(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const roots = rootNodes(snapshot);
  const widgets = roots.map((root) => renderFlutterRoot(root, map));
  const body = widgets.length === 1
    ? widgets[0]
    : `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${widgets.join(", ")}])`;
  const source = `// Generated by DesignPort for Flutter 3.47+ / cupertino_ui 1.0.2.
// Layout metadata becomes Row, Column, Wrap, Expanded, or Flexible where available.
// Refine behavior and accessibility before shipping.
import 'dart:ui';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/widgets.dart';

class DesignPortApp extends StatelessWidget {
  const DesignPortApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const CupertinoApp(
      debugShowCheckedModeBanner: false,
      home: DesignPortScreen(),
    );
  }
}

class DesignPortScreen extends StatelessWidget {
  const DesignPortScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      backgroundColor: CupertinoColors.systemBackground,
      child: SafeArea(child: ${body ?? "const SizedBox.shrink()"}),
    );
  }
}
`;
  return {
    target: "flutter",
    files: { "design_port_screen.dart": source },
    nodeCount: allNodes(snapshot).length,
    screenCount: roots.filter((node) => node.kind === "screen").length,
  };
}

function swiftColor(color: Color | undefined): string {
  if (!color) return "Color.clear";
  return `Color(red: ${formatNumber(clamp(color.r, 0, 1))}, green: ${formatNumber(clamp(color.g, 0, 1))}, blue: ${formatNumber(clamp(color.b, 0, 1))}, opacity: ${formatNumber(clamp(color.a ?? 1, 0, 1))})`;
}

function swiftWeight(weight: number | undefined): string {
  if (weight === undefined) return ".regular";
  if (weight >= 800) return ".heavy";
  if (weight >= 700) return ".bold";
  if (weight >= 600) return ".semibold";
  if (weight >= 500) return ".medium";
  if (weight <= 300) return ".light";
  return ".regular";
}

function swiftAlignment(value: TextAlignValue): string {
  switch (value) {
    case "center": return ".center";
    case "right": return ".trailing";
    case "justified": return ".leading";
    default: return ".leading";
  }
}

function swiftPadding(plan: LayoutPlan): string {
  const { top, right, bottom, left } = plan.padding;
  if (!top && !right && !bottom && !left) return "";
  return `.padding(EdgeInsets(top: ${formatNumber(top)}, leading: ${formatNumber(left)}, bottom: ${formatNumber(bottom)}, trailing: ${formatNumber(right)}))`;
}

function swiftFlowItem(
  node: DesignNode,
  frame: Box,
  parentLayout: LayoutPlan,
  content: string,
): string {
  if (parentLayout.mode === "horizontal") {
    const primary = effectiveSizing(node, parentLayout, "horizontal");
    const cross = sizingFor(node, "vertical");
    if (primary === "fill" && cross === "fill") return `${content}.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)`;
    if (primary === "fill") return `${content}.frame(maxWidth: .infinity, alignment: .topLeading).frame(height: ${formatNumber(frame.height)})`;
    if (primary === "hug" && cross === "fill") return `${content}.frame(maxHeight: .infinity, alignment: .topLeading)`;
    if (primary === "hug") return `${content}.frame(height: ${formatNumber(frame.height)}, alignment: .topLeading)`;
    if (cross === "fill") return `${content}.frame(width: ${formatNumber(frame.width)}, maxHeight: .infinity, alignment: .topLeading)`;
    return `${content}.frame(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, alignment: .topLeading)`;
  }
  if (parentLayout.mode === "vertical") {
    const primary = effectiveSizing(node, parentLayout, "vertical");
    const cross = sizingFor(node, "horizontal");
    if (primary === "fill" && cross === "fill") return `${content}.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)`;
    if (primary === "fill") return `${content}.frame(maxHeight: .infinity, alignment: .topLeading).frame(width: ${formatNumber(frame.width)})`;
    if (primary === "hug" && cross === "fill") return `${content}.frame(maxWidth: .infinity, alignment: .topLeading)`;
    if (primary === "hug") return `${content}.frame(width: ${formatNumber(frame.width)}, alignment: .topLeading)`;
    if (cross === "fill") return `${content}.frame(maxWidth: .infinity, height: ${formatNumber(frame.height)}, alignment: .topLeading)`;
    return `${content}.frame(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, alignment: .topLeading)`;
  }
  return `${content}.frame(maxWidth: .infinity, alignment: .topLeading)`;
}

function renderSwiftFlowChildren(
  node: DesignNode,
  map: Map<string, DesignNode>,
  plan: LayoutPlan,
  parentAction = false,
): string {
  const children = childrenOf(node, map).map((child) => renderSwiftNode(child, map, node.bounds, plan, parentAction));
  if (plan.mode === "horizontal") {
    return `HStack(alignment: .top, spacing: ${formatNumber(plan.gap)}) {\n            ${children.join("\n            ")}\n        }`;
  }
  if (plan.mode === "vertical") {
    return `VStack(alignment: .leading, spacing: ${formatNumber(plan.gap)}) {\n            ${children.join("\n            ")}\n        }`;
  }
  return `LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: ${formatNumber(plan.gap)}), count: ${plan.columns ?? 1}), spacing: ${formatNumber(plan.gap)}) {\n            ${children.join("\n            ")}\n        }`;
}

function renderSwiftNode(
  node: DesignNode,
  map: Map<string, DesignNode>,
  parent: Box | null,
  parentLayout: LayoutPlan | null = null,
  parentAction = false,
): string {
  const frame = relativeBox(node, parent);
  const ownLayout = layoutPlanFor(node, map);
  const children = childrenOf(node, map);
  const action = !parentAction && isActionNode(node);
  let content: string;

  if (node.kind === "text") {
    const size = formatNumber(node.typography?.size ?? 14);
    const font = node.typography?.family
      ? `.font(.custom(${quoteString(node.typography.family)}, size: ${size}))`
      : `.font(.system(size: ${size}, weight: ${swiftWeight(node.typography?.weight)}, design: .default))`;
    const foreground = nodeFill(node) ? `.foregroundStyle(${swiftColor(nodeFill(node))})` : "";
    content = `Text(${quoteString(node.text ?? "")})${font}${foreground}.multilineTextAlignment(${swiftAlignment(node.typography?.align)})`;
  } else if (node.kind === "rectangle") {
    content = `Rectangle().fill(${swiftColor(nodeFill(node))})`;
  } else if (node.kind === "ellipse") {
    content = `Ellipse().fill(${swiftColor(nodeFill(node))})`;
  } else {
    const childMarkup = ownLayout
      ? renderSwiftFlowChildren(node, map, ownLayout, parentAction || action)
      : children.length
        ? `ZStack(alignment: .topLeading) {\n            ${children.map((child) => renderSwiftNode(child, map, node.bounds, null, parentAction || action)).join("\n            ")}\n        }`
        : "Color.clear";
    content = childMarkup;
    if (ownLayout) content += swiftPadding(ownLayout);
    if (nodeFill(node)) content += `.background(${swiftColor(nodeFill(node))})`;
  }

  if (node.kind === "rectangle" || node.kind === "ellipse" || node.kind === "text") {
    content += `.frame(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, alignment: .topLeading)`;
  }
  if (action) {
    if (!children.length && node.kind !== "text") content = `Text(${quoteString(node.name)})`;
    content = `designPortButton { ${content} }`;
  } else if (node.kind === "component" || node.kind === "instance" || node.kind === "frame" || node.kind === "group") {
    content = `designPortGlass(cornerRadius: 20) { ${content} }`;
  }
  if (parentLayout) {
    content = swiftFlowItem(node, frame, parentLayout, content);
  } else {
    content += `.frame(width: ${formatNumber(frame.width)}, height: ${formatNumber(frame.height)}, alignment: .topLeading).offset(x: ${formatNumber(frame.x)}, y: ${formatNumber(frame.y)})`;
  }
  const opacity = mobileOpacity(node);
  if (opacity !== undefined) content += `.opacity(${formatNumber(opacity)})`;
  return content;
}

function renderSwiftRoot(root: DesignNode, map: Map<string, DesignNode>): string {
  const size = screenBounds(root);
  const plan = layoutPlanFor(root, map);
  const body = root.kind === "screen"
    ? (plan
      ? renderSwiftFlowChildren(root, map, plan)
      : `ZStack(alignment: .topLeading) {\n            ${childrenOf(root, map).map((child) => renderSwiftNode(child, map, root.bounds)).join("\n            ")}\n        }`)
    : `ZStack(alignment: .topLeading) { ${renderSwiftNode(root, map, null)} }`;
  const paddedBody = plan ? `${body}${swiftPadding(plan)}` : body;
  const background = nodeFill(root) ? `.background(${swiftColor(nodeFill(root))})` : "";
  return `${paddedBody}.frame(width: ${formatNumber(size.width)}, height: ${formatNumber(size.height)}, alignment: .topLeading)${background}.clipShape(RoundedRectangle(cornerRadius: 28))`;
}

function generateSwiftUI(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const roots = rootNodes(snapshot);
  const views = roots.map((root) => renderSwiftRoot(root, map));
  const body = views.length === 1
    ? views[0]
    : `VStack(alignment: .leading, spacing: 24) {\n        ${views.join("\n        ")}\n    }`;
  const source = `// Generated by DesignPort for SwiftUI on iOS 26+ / macOS 26+.
// Uses Liquid Glass when available and keeps a material fallback for older deployment targets.
// Refine behavior and accessibility before shipping.
import SwiftUI

@ViewBuilder
private func designPortGlass<Content: View>(
    interactive: Bool = false,
    cornerRadius: CGFloat = 20,
    @ViewBuilder content: () -> Content
) -> some View {
    if #available(iOS 26.0, macOS 26.0, *) {
        if interactive {
            content().glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: cornerRadius))
        } else {
            content().glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
        }
    } else {
        content().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
    }
}

@ViewBuilder
private func designPortButton<Label: View>(
    @ViewBuilder label: () -> Label
) -> some View {
    if #available(iOS 26.0, macOS 26.0, *) {
        Button(action: {}) { label() }
            .buttonStyle(.glassProminent)
    } else {
        Button(action: {}) { label() }
            .buttonStyle(.borderedProminent)
    }
}

@ViewBuilder
private func designPortGlassContainer<Content: View>(
    @ViewBuilder content: () -> Content
) -> some View {
    if #available(iOS 26.0, macOS 26.0, *) {
        GlassEffectContainer(spacing: 16) { content() }
    } else {
        content()
    }
}

struct DesignPortScreen: View {
    var body: some View {
        designPortGlassContainer {
            ${body ?? "Color.clear"}
        }
    }
}

#Preview {
    DesignPortScreen()
}
`;
  return {
    target: "swiftui",
    files: { "DesignPortScreen.swift": source },
    nodeCount: allNodes(snapshot).length,
    screenCount: roots.filter((node) => node.kind === "screen").length,
  };
}

function composeColor(color: Color | undefined): string {
  if (!color) return "Color.Transparent";
  return `Color(red = ${formatFloat(clamp(color.r, 0, 1))}, green = ${formatFloat(clamp(color.g, 0, 1))}, blue = ${formatFloat(clamp(color.b, 0, 1))}, alpha = ${formatFloat(clamp(color.a ?? 1, 0, 1))})`;
}

function composeWeight(weight: number | undefined): string | undefined {
  if (weight === undefined) return undefined;
  return `FontWeight(${Math.min(900, Math.max(100, Math.round(weight / 100) * 100))})`;
}

function composeTextAlign(value: TextAlignValue): string | undefined {
  switch (value) {
    case "left": return "TextAlign.Start";
    case "center": return "TextAlign.Center";
    case "right": return "TextAlign.End";
    case "justified": return "TextAlign.Justify";
    default: return undefined;
  }
}

function composePadding(plan: LayoutPlan | null): string {
  if (!plan) return "";
  const { top, right, bottom, left } = plan.padding;
  if (!top && !right && !bottom && !left) return "";
  return `.padding(start = ${formatNumber(left)}.dp, top = ${formatNumber(top)}.dp, end = ${formatNumber(right)}.dp, bottom = ${formatNumber(bottom)}.dp)`;
}

function composeModifier(
  node: DesignNode,
  frame: Box,
  parentLayout: LayoutPlan | null = null,
  includeFill = true,
): string {
  const values: string[] = [];
  if (!parentLayout) {
    values.push(`Modifier.offset(x = ${formatNumber(frame.x)}.dp, y = ${formatNumber(frame.y)}.dp)`);
    values.push(`.size(width = ${formatNumber(frame.width)}.dp, height = ${formatNumber(frame.height)}.dp)`);
  } else if (parentLayout.mode === "horizontal") {
    const primary = effectiveSizing(node, parentLayout, "horizontal");
    const cross = sizingFor(node, "vertical");
    values.push("Modifier");
    if (primary === "fill") values.push(".weight(1f)");
    else if (primary === "fixed") values.push(`.width(${formatNumber(frame.width)}.dp)`);
    if (cross === "fill") values.push(".fillMaxHeight()");
    else values.push(`.height(${formatNumber(frame.height)}.dp)`);
  } else if (parentLayout.mode === "vertical") {
    const primary = effectiveSizing(node, parentLayout, "vertical");
    const cross = sizingFor(node, "horizontal");
    values.push("Modifier");
    if (primary === "fill") values.push(".weight(1f)");
    else if (primary === "fixed") values.push(`.height(${formatNumber(frame.height)}.dp)`);
    if (cross === "fill") values.push(".fillMaxWidth()");
    else values.push(`.width(${formatNumber(frame.width)}.dp)`);
  } else {
    values.push("Modifier.weight(1f)");
    values.push(`.height(${formatNumber(frame.height)}.dp)`);
  }
  const fill = nodeFill(node);
  if (includeFill && fill) {
    values.push(node.kind === "ellipse"
      ? `.background(${composeColor(fill)}, shape = CircleShape)`
      : `.background(${composeColor(fill)})`);
  }
  const opacity = mobileOpacity(node);
  if (opacity !== undefined) values.push(`.alpha(${formatFloat(opacity)})`);
  return values.join("\n        ");
}

function composeText(node: DesignNode, modifier: string, style = "MaterialTheme.typography.bodyLarge"): string {
  const argumentsList = [
    `text = ${quoteString(node.text ?? "")}`,
    `modifier = ${modifier}`,
    `style = ${style}`,
  ];
  const fill = nodeFill(node);
  if (fill) argumentsList.push(`color = ${composeColor(fill)}`);
  if (node.typography?.size) argumentsList.push(`fontSize = ${formatNumber(node.typography.size)}.sp`);
  const weight = composeWeight(node.typography?.weight);
  if (weight) argumentsList.push(`fontWeight = ${weight}`);
  const align = composeTextAlign(node.typography?.align);
  if (align) argumentsList.push(`textAlign = ${align}`);
  return `Text(${argumentsList.join(", ")})`;
}

function renderComposeFlowChildren(
  node: DesignNode,
  map: Map<string, DesignNode>,
  plan: LayoutPlan,
  parentAction = false,
): string {
  const children = childrenOf(node, map).map((child) => renderComposeNode(child, map, node.bounds, plan, parentAction));
  if (plan.mode === "horizontal") {
    return `Row(modifier = Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(${formatNumber(plan.gap)}.dp), verticalAlignment = Alignment.Top) { ${children.join(" ")} }`;
  }
  if (plan.mode === "vertical") {
    return `Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(${formatNumber(plan.gap)}.dp), horizontalAlignment = Alignment.Start) { ${children.join(" ")} }`;
  }
  const columns = Math.max(1, plan.columns ?? 1);
  const rows: string[] = [];
  for (let index = 0; index < children.length; index += columns) {
    rows.push(`Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(${formatNumber(plan.gap)}.dp), verticalAlignment = Alignment.Top) { ${children.slice(index, index + columns).join(" ")} }`);
  }
  return `Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(${formatNumber(plan.gap)}.dp)) { ${rows.join(" ")} }`;
}

function renderComposeNode(
  node: DesignNode,
  map: Map<string, DesignNode>,
  parent: Box | null,
  parentLayout: LayoutPlan | null = null,
  parentAction = false,
): string {
  const frame = relativeBox(node, parent);
  const ownLayout = layoutPlanFor(node, map);
  const children = childrenOf(node, map);
  const action = !parentAction && isActionNode(node);
  if (node.kind === "text") {
    if (action) {
      return `Button(onClick = {}, modifier = ${composeModifier(node, frame, parentLayout, false)}, shape = RoundedCornerShape(12.dp)) { ${composeText(node, "Modifier", "MaterialTheme.typography.labelLarge")} }`;
    }
    const text = composeText(node, "Modifier.fillMaxSize()");
    return `Box(modifier = ${composeModifier(node, frame, parentLayout)}${composePadding(ownLayout)}) { ${text} }`;
  }
  const childMarkup = ownLayout
    ? renderComposeFlowChildren(node, map, ownLayout, parentAction || action)
    : children.length
      ? `Box(modifier = Modifier.fillMaxSize()) { ${children.map((child) => renderComposeNode(child, map, node.bounds, null, parentAction || action)).join(" ")} }`
      : "";
  const modifier = `${composeModifier(node, frame, parentLayout, !nodeFill(node))}${composePadding(ownLayout)}`;
  if (action) {
    const label = childMarkup || `Text(text = ${quoteString(node.name)}, style = MaterialTheme.typography.labelLarge)`;
    const colors = nodeFill(node) ? `, colors = ButtonDefaults.buttonColors(containerColor = ${composeColor(nodeFill(node))})` : "";
    return `Button(onClick = {}, modifier = ${composeModifier(node, frame, parentLayout, false)}${composePadding(ownLayout)}, shape = RoundedCornerShape(12.dp)${colors}) { ${label} }`;
  }
  if (nodeFill(node)) {
    const shape = node.kind === "ellipse" ? "CircleShape" : "RoundedCornerShape(12.dp)";
    return `Surface(modifier = ${modifier}, color = ${composeColor(nodeFill(node))}, shape = ${shape}, tonalElevation = 1.dp) { ${childMarkup} }`;
  }
  return `Box(modifier = ${modifier}) { ${childMarkup} }`;
}

function renderComposeRoot(root: DesignNode, map: Map<string, DesignNode>): string {
  const size = screenBounds(root);
  const plan = layoutPlanFor(root, map);
  const children = root.kind === "screen"
    ? (plan
      ? renderComposeFlowChildren(root, map, plan)
      : `Box(modifier = Modifier.fillMaxSize()) { ${childrenOf(root, map).map((child) => renderComposeNode(child, map, root.bounds)).join(" ")} }`)
    : renderComposeNode(root, map, null);
  const paddedChildren = plan
    ? `Box(modifier = Modifier.fillMaxSize()${composePadding(plan)}) { ${children} }`
    : children;
  const modifier = `Modifier.size(width = ${formatNumber(size.width)}.dp, height = ${formatNumber(size.height)}.dp)`;
  const color = nodeFill(root) ? composeColor(nodeFill(root)) : "MaterialTheme.colorScheme.surface";
  return `Surface(modifier = ${modifier}, color = ${color}, shape = RoundedCornerShape(28.dp), tonalElevation = 1.dp) { ${paddedChildren} }`;
}

function generateCompose(snapshot: DesignSnapshot): GeneratedCode {
  const map = nodeMap(snapshot);
  const roots = rootNodes(snapshot);
  const composables = roots.map((root) => renderComposeRoot(root, map));
  const body = composables.length === 1
    ? composables[0]
    : `Column(verticalArrangement = Arrangement.spacedBy(24.dp)) { ${composables.join(" ")} }`;
  const source = `// Generated by DesignPort for Jetpack Compose Material 3 1.4.0 (latest stable).
// Layout metadata becomes Row, Column, weight, or a responsive grid of rows.
// Refine behavior and accessibility before shipping.
import android.os.Build

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
private fun DesignPortTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val darkTheme = isSystemInDarkTheme()
    val colorScheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> dynamicLightColorScheme(context)
        darkTheme -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}

@Composable
fun DesignPortScreen() {
    DesignPortTheme {
        Scaffold(containerColor = MaterialTheme.colorScheme.background) { contentPadding ->
            Box(modifier = Modifier.padding(contentPadding)) {
                ${body ?? "Box(Modifier.size(1.dp, 1.dp))"}
            }
        }
    }
}
`;
  return {
    target: "compose",
    files: { "DesignPortScreen.kt": source },
    nodeCount: allNodes(snapshot).length,
    screenCount: roots.filter((node) => node.kind === "screen").length,
  };
}

export function generateCode(snapshot: DesignSnapshot, target: CodeTarget): GeneratedCode {
  switch (target) {
    case "html": return generateHtml(snapshot);
    case "web": return generateWeb(snapshot);
    case "react": return generateReact(snapshot);
    case "vue": return generateVue(snapshot);
    case "flutter": return generateFlutter(snapshot);
    case "swiftui": return generateSwiftUI(snapshot);
    case "compose": return generateCompose(snapshot);
  }
}
