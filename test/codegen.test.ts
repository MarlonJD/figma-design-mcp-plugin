import test from "node:test";
import assert from "node:assert/strict";
import { generateCode, type CodeTarget } from "../src/codegen/generate.js";
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

const flowSnapshot: DesignIR = {
  ...snapshot,
  documentName: "Responsive split layout",
  nodes: {
    "page-1": {
      ...snapshot.nodes["page-1"]!,
      children: ["screen-1"],
    },
    "screen-1": {
      ...snapshot.nodes["screen-1"]!,
      children: ["sidebar-1", "content-1"],
      layout: {
        mode: "horizontal",
        gap: 24,
        padding: { top: 24, right: 24, bottom: 24, left: 24 },
      },
    },
    "sidebar-1": {
      id: "sidebar-1",
      name: "Sidebar",
      kind: "frame",
      parentId: "screen-1",
      children: ["sidebar-label-1"],
      bounds: { x: 124, y: 224, width: 240, height: 552 },
      visible: true,
      layout: {
        mode: "vertical",
        gap: 16,
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
        sizingHorizontal: "fixed",
        sizingVertical: "fill",
      },
    },
    "sidebar-label-1": {
      id: "sidebar-label-1",
      name: "Navigation",
      kind: "text",
      parentId: "sidebar-1",
      children: [],
      bounds: { x: 140, y: 240, width: 160, height: 24 },
      visible: true,
      text: "Navigation",
    },
    "content-1": {
      id: "content-1",
      name: "Main content",
      kind: "frame",
      parentId: "screen-1",
      children: ["content-label-1", "continue-1"],
      bounds: { x: 388, y: 224, width: 488, height: 552 },
      visible: true,
      layout: {
        mode: "vertical",
        gap: 20,
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
        sizingHorizontal: "fill",
        sizingVertical: "fill",
      },
    },
    "content-label-1": {
      id: "content-label-1",
      name: "Heading",
      kind: "text",
      parentId: "content-1",
      children: [],
      bounds: { x: 404, y: 240, width: 300, height: 48 },
      visible: true,
      text: "Risk overview",
    },
    "continue-1": {
      id: "continue-1",
      name: "Continue Button",
      kind: "component",
      parentId: "content-1",
      children: [],
      bounds: { x: 404, y: 308, width: 200, height: 48 },
      visible: true,
    },
  },
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
  assert.match(generated.files["DesignPortScreen.tsx"] ?? "", /left: "40px"/);
});

const targetFiles: Array<[CodeTarget, string, RegExp]> = [
  ["web", "index.html", /styles\.css/],
  ["vue", "DesignPortScreen.vue", /<template>/],
  ["flutter", "design_port_screen.dart", /class DesignPortScreen/],
  ["swiftui", "DesignPortScreen.swift", /struct DesignPortScreen: View/],
  ["compose", "DesignPortScreen.kt", /@Composable/],
];

for (const [target, file, marker] of targetFiles) {
  test(`${target} generation returns a target-specific file`, () => {
    const generated = generateCode(snapshot, target);
    assert.equal(generated.target, target);
    assert.equal(generated.nodeCount, 3);
    assert.ok(generated.files[file]);
    assert.match(generated.files[file] ?? "", marker);
    assert.match(generated.files[file] ?? "", /Risk overview|DesignPort/);
  });
}

test("layout metadata becomes responsive flow primitives across targets", () => {
  const web = generateCode(flowSnapshot, "web");
  assert.match(web.files["index.html"] ?? "", /display: flex; flex-direction: row/);
  assert.match(web.files["index.html"] ?? "", /flex: 1 1 0/);

  const react = generateCode(flowSnapshot, "react");
  assert.match(react.files["DesignPortScreen.tsx"] ?? "", /flexDirection: "row"/);
  assert.match(react.files["DesignPortScreen.tsx"] ?? "", /flex: "1 1 0"/);

  const vue = generateCode(flowSnapshot, "vue");
  assert.match(vue.files["DesignPortScreen.vue"] ?? "", /display: flex; flex-direction: row/);

  const flutter = generateCode(flowSnapshot, "flutter");
  assert.match(flutter.files["design_port_screen.dart"] ?? "", /Row\(/);
  assert.match(flutter.files["design_port_screen.dart"] ?? "", /Expanded\(/);
  assert.match(flutter.files["design_port_screen.dart"] ?? "", /CupertinoButton\.filled/);

  const swiftui = generateCode(flowSnapshot, "swiftui");
  assert.match(swiftui.files["DesignPortScreen.swift"] ?? "", /HStack\(/);
  assert.match(swiftui.files["DesignPortScreen.swift"] ?? "", /maxWidth: \.infinity/);
  assert.match(swiftui.files["DesignPortScreen.swift"] ?? "", /designPortButton/);

  const compose = generateCode(flowSnapshot, "compose");
  assert.match(compose.files["DesignPortScreen.kt"] ?? "", /Row\(/);
  assert.match(compose.files["DesignPortScreen.kt"] ?? "", /\.weight\(1f\)/);
  assert.match(compose.files["DesignPortScreen.kt"] ?? "", /MaterialTheme/);
});
