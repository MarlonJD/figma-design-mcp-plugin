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
