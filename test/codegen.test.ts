import test from "node:test";
import assert from "node:assert/strict";
import { generateCode } from "../src/codegen/generate.js";
import type { DesignIR } from "../src/core/ir.js";

const snapshot: DesignIR = {
  schemaVersion: 1,
  host: "figma",
  documentId: "document-1",
  documentName: "Example",
  rootId: "page-1",
  nodes: {
    "page-1": {
      id: "page-1",
      name: "Page 1",
      kind: "root",
      parentId: null,
      children: ["screen-1"],
      bounds: null,
      visible: true,
    },
    "screen-1": {
      id: "screen-1",
      name: "Overview",
      kind: "screen",
      parentId: "page-1",
      children: ["title-1"],
      bounds: { x: 100, y: 200, width: 800, height: 600 },
      visible: true,
    },
    "title-1": {
      id: "title-1",
      name: "Title",
      kind: "text",
      parentId: "screen-1",
      children: [],
      bounds: { x: 140, y: 240, width: 300, height: 48 },
      visible: true,
      text: "Risk overview",
    },
  },
  screens: [{ host: "figma", id: "screen-1" }],
  selection: [],
  exportedAt: new Date().toISOString(),
};

test("HTML generation returns a self-contained export", () => {
  const generated = generateCode(snapshot, "html");
  assert.equal(generated.target, "html");
  assert.equal(generated.nodeCount, 3);
  assert.match(generated.files["designport-export.html"] ?? "", /Risk overview/);
  assert.match(generated.files["designport-export.html"] ?? "", /data-designport-id/);
});

test("React generation returns component and stylesheet", () => {
  const generated = generateCode(snapshot, "react");
  assert.ok(generated.files["DesignPortScreen.tsx"]);
  assert.ok(generated.files["DesignPortScreen.css"]);
  assert.match(generated.files["DesignPortScreen.tsx"] ?? "", /export default function/);
  assert.match(generated.files["DesignPortScreen.css"] ?? "", /\.dp-screen/);
  assert.match(generated.files["DesignPortScreen.css"] ?? "", /left: 40px/);
});
