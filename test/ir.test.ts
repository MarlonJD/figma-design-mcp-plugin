import test from "node:test";
import assert from "node:assert/strict";
import {
  contextIRSchema,
  designIRSchema,
  screenSpecSchema,
  visualContextSchema,
} from "../src/core/ir.js";

test("screen specs receive safe defaults", () => {
  const spec = screenSpecSchema.parse({ name: "Audit overview" });
  assert.equal(spec.width, 1440);
  assert.equal(spec.height, 900);
});

test("DesignIR and context IR reject host-specific shape drift", () => {
  const exportedAt = new Date().toISOString();
  const node = {
    id: "root",
    name: "Document",
    kind: "root" as const,
    parentId: null,
    children: [],
    bounds: null,
    visible: true,
  };
  const ir = designIRSchema.parse({
    schemaVersion: 1,
    host: "xd",
    documentId: "doc-1",
    documentName: "Example",
    rootId: "root",
    nodes: { root: node },
    screens: [],
    selection: [],
    exportedAt,
  });
  assert.equal(ir.nodes.root?.kind, "root");

  const context = contextIRSchema.parse({
    schemaVersion: 1,
    scope: "selection",
    host: "xd",
    documentId: "doc-1",
    documentName: "Example",
    selection: [],
    nodes: [node],
    exportedAt,
  });
  assert.equal(context.scope, "selection");

  assert.throws(() =>
    designIRSchema.parse({
      ...ir,
      host: "photoshop",
    }),
  );
});

test("DesignIR accepts normalized stroke paint records", () => {
  const exportedAt = new Date().toISOString();
  const ir = designIRSchema.parse({
    schemaVersion: 1,
    host: "figma",
    documentId: "doc-2",
    documentName: "Strokes",
    rootId: "root",
    nodes: {
      root: {
        id: "root",
        name: "Document",
        kind: "root",
        parentId: null,
        children: [],
        bounds: null,
        visible: true,
        strokes: [{
          fills: [{
            type: "solid",
            color: { r: 0.1, g: 0.2, b: 0.3 },
          }],
          weight: 1,
          position: "inside",
        }],
      },
    },
    screens: [],
    selection: [],
    exportedAt,
  });
  assert.equal(ir.nodes.root?.strokes?.[0]?.weight, 1);
});

test("DesignIR preserves the evidence needed for semantic reconstruction", () => {
  const node = {
    id: "card-1",
    name: "Profile card",
    kind: "frame" as const,
    parentId: "root",
    children: ["icon-1"],
    bounds: { x: 24, y: 32, width: 320, height: 180 },
    renderBounds: { x: 22, y: 30, width: 324, height: 184 },
    visible: true,
    opacity: 0.96,
    blendMode: "normal",
    fills: [{
      type: "gradient" as const,
      gradientType: "linear" as const,
      gradientStops: [
        { position: 0, color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } },
        { position: 1, color: { r: 0.8, g: 0.9, b: 1, a: 0.8 } },
      ],
      gradientTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      visible: true,
      blendMode: "normal",
      opacity: 1,
    }],
    strokes: [{
      fills: [{ type: "solid", color: { r: 0, g: 0, b: 0, a: 0.2 }, opacity: 0.2 }],
      sideWeights: { top: 1, right: 2, bottom: 1, left: 2 },
      dashPattern: [4, 2],
      cap: "round",
      join: "round",
    }],
    effects: [{
      type: "drop-shadow" as const,
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 8 },
      radius: 16,
      spread: 0,
      visible: true,
      blendMode: "normal",
    }],
    cornerRadius: 16,
    cornerRadii: { topLeft: 16, topRight: 16, bottomRight: 12, bottomLeft: 12 },
    asset: { mimeType: "image/svg+xml", data: "<svg />", kind: "vector" as const },
    rotation: 0,
    clipsContent: true,
    minWidth: 240,
    maxWidth: 640,
    minHeight: 120,
    maxHeight: 360,
    constraints: { horizontal: "left-right" as const, vertical: "top" as const },
    layoutAlign: "stretch" as const,
    layoutGrow: 1,
    layoutPositioning: "auto" as const,
    gridPosition: { row: 0, column: 1, rowSpan: 1, columnSpan: 2 },
    typography: {
      family: "Inter",
      style: "Semi Bold",
      size: 18,
      weight: 600,
      lineHeight: 24,
      letterSpacing: 0.2,
      align: "left" as const,
      alignVertical: "center" as const,
      decoration: "none" as const,
      textCase: "original" as const,
      autoResize: "height" as const,
      textTruncation: "ending" as const,
      maxLines: 2,
      paragraphIndent: 0,
      paragraphSpacing: 8,
    },
    layout: {
      mode: "horizontal" as const,
      gap: 16,
      padding: { top: 16, right: 20, bottom: 16, left: 20 },
      sizingHorizontal: "fill" as const,
      sizingVertical: "hug" as const,
      primaryAxisAlign: "space-between" as const,
      counterAxisAlign: "center" as const,
      counterAxisAlignContent: "auto" as const,
      wrap: "no-wrap" as const,
      counterAxisSpacing: 12,
      itemReverseZIndex: false,
      strokesIncludedInLayout: true,
      grid: { rows: 1, columns: 2, rowGap: 12, columnGap: 16 },
    },
    prototypeLinks: [{
      trigger: "on_click",
      action: "node",
      destinationId: "screen-2",
      navigation: "navigate",
      transition: "smart_animate",
      duration: 0.2,
      preserveScrollPosition: false,
    }],
  };

  const context = contextIRSchema.parse({
    schemaVersion: 1,
    scope: "screen",
    host: "figma",
    documentId: "doc-rich",
    documentName: "Rich evidence",
    selection: [],
    nodes: [node],
    screenId: "screen-1",
    exportedAt: new Date().toISOString(),
  });

  const parsed = context.nodes[0]!;
  assert.equal(parsed.renderBounds?.width, 324);
  assert.equal(parsed.fills?.[0]?.gradientTransform?.tx, 0);
  assert.equal(parsed.strokes?.[0]?.sideWeights?.right, 2);
  assert.equal(parsed.effects?.[0]?.offset?.y, 8);
  assert.equal(parsed.layout?.primaryAxisAlign, "space-between");
  assert.equal(parsed.layout?.grid?.columns, 2);
  assert.equal(parsed.typography?.maxLines, 2);
  assert.equal(parsed.prototypeLinks?.[0]?.navigation, "navigate");
});

test("visual context keeps image data separate from node properties", () => {
  const visual = visualContextSchema.parse({
    schemaVersion: 1,
    scope: "screen",
    host: "figma",
    documentId: "doc-3",
    documentName: "Visual example",
    items: [{
      nodeId: "screen-1",
      nodeName: "Overview",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      scale: 1,
    }],
    exportedAt: new Date().toISOString(),
  });
  assert.equal(visual.items[0]?.mimeType, "image/png");
  assert.equal(visual.items[0]?.bounds?.width, 390);
});
