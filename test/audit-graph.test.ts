import test from "node:test";
import assert from "node:assert/strict";
import { auditDesignContext } from "../src/core/audit.js";
import { buildDesignGraph } from "../src/core/graph.js";
import { contextIRSchema } from "../src/core/ir.js";

function context() {
  return contextIRSchema.parse({
    schemaVersion: 1,
    scope: "screen",
    host: "figma",
    documentId: "doc-audit",
    documentName: "Audit fixture",
    selection: [],
    screenId: "screen-1",
    nodes: [
      {
        id: "screen-1",
        name: "Dashboard",
        kind: "screen",
        parentId: null,
        children: ["button-1", "image-1", "absolute-1", "free-1", "heading-1", "instance-1"],
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        visible: true,
        layout: { mode: "horizontal", gap: 24 },
      },
      {
        id: "button-1",
        name: "Continue",
        kind: "frame",
        parentId: "screen-1",
        children: [],
        bounds: { x: 24, y: 24, width: 160, height: 48 },
        visible: true,
        accessibility: { role: "button" },
        prototypeLinks: [{ trigger: "on_click", action: "node" }],
        styleRefs: { fill: "missing-token" },
      },
      {
        id: "image-1",
        name: "Hero image",
        kind: "rectangle",
        parentId: "screen-1",
        children: [],
        bounds: { x: 208, y: 24, width: 320, height: 180 },
        visible: true,
        fills: [{ type: "image" }],
      },
      {
        id: "absolute-1",
        name: "Badge overlay",
        kind: "frame",
        parentId: "screen-1",
        children: [],
        bounds: { x: 480, y: 24, width: 80, height: 24 },
        visible: true,
        layoutPositioning: "absolute",
      },
      {
        id: "free-1",
        name: "Free group",
        kind: "group",
        parentId: null,
        children: ["grow-1", "free-child-1"],
        bounds: { x: 0, y: 840, width: 400, height: 120 },
        visible: true,
      },
      {
        id: "grow-1",
        name: "Growing child",
        kind: "frame",
        parentId: "free-1",
        children: [],
        bounds: { x: 0, y: 840, width: 400, height: 120 },
        visible: true,
        layoutGrow: 1,
      },
      {
        id: "free-child-1",
        name: "Free sibling",
        kind: "rectangle",
        parentId: "free-1",
        children: [],
        bounds: { x: 0, y: 840, width: 80, height: 80 },
        visible: true,
      },
      {
        id: "heading-1",
        name: "Page title",
        kind: "text",
        parentId: "screen-1",
        children: [],
        bounds: { x: 24, y: 240, width: 400, height: 48 },
        visible: true,
        accessibility: { role: "heading" },
      },
      {
        id: "instance-1",
        name: "Unknown instance",
        kind: "instance",
        parentId: "screen-1",
        children: [],
        bounds: { x: 24, y: 320, width: 200, height: 80 },
        visible: true,
        component: { id: "component-1", isInstance: true },
      },
    ],
    tokens: [],
    pagination: { offset: 0, limit: 100, total: 9, returned: 9, hasMore: true },
    snapshot: {
      id: "snapshot-audit",
      scope: "screen",
      documentRevision: 1,
      selectionRevision: 1,
      screenId: "screen-1",
      generatedAt: new Date().toISOString(),
    },
    exportedAt: new Date().toISOString(),
  });
}

test("semantic audit reports actionable layout and accessibility diagnostics", () => {
  const audit = auditDesignContext(context());
  const codes = new Set(audit.diagnostics.map((diagnostic) => diagnostic.code));
  assert.equal(audit.partial, true);
  assert.equal(audit.snapshotId, "snapshot-audit");
  assert.equal(codes.has("absolute-child-in-flow"), true);
  assert.equal(codes.has("interactive-missing-label"), true);
  assert.equal(codes.has("interaction-without-destination"), true);
  assert.equal(codes.has("visual-missing-alt"), true);
  assert.equal(codes.has("heading-missing-level"), true);
  assert.equal(codes.has("grow-without-flow"), true);
  assert.equal(codes.has("missing-flow-metadata"), true);
  assert.equal(codes.has("instance-missing-component-reference"), true);
  assert.equal(codes.has("unresolved-token-reference"), true);
  assert.equal(audit.summary.nodeCount, 9);
});

test("design graph preserves reusable component and prototype relationships", () => {
  const graph = buildDesignGraph(context());
  assert.equal(graph.scope, "screen");
  assert.equal(graph.partial, true);
  assert.deepEqual(graph.screens, [{
    id: "screen-1",
    name: "Dashboard",
    viewport: {
      width: 1280,
      height: 800,
      orientation: "landscape",
      breakpoint: "expanded",
    },
  }]);
  assert.deepEqual(graph.components, [{
    nodeId: "instance-1",
    componentId: "component-1",
    name: "Unknown instance",
    isInstance: true,
  }]);
  assert.deepEqual(graph.interactions, [{
    sourceNodeId: "button-1",
    trigger: "on_click",
    action: "node",
  }]);
});
