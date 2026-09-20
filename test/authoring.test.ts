import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BridgeHostAdapter } from "../src/core/adapter.js";
import {
  nodeTreeSpecSchema,
  setPrototypeSpecSchema,
  type NodeTreeSpec,
} from "../src/core/ir.js";

function validTree(): NodeTreeSpec {
  return nodeTreeSpecSchema.parse({
    nodes: [
      {
        ref: "body-copy",
        parentRef: "screen",
        kind: "text",
        name: "Body copy",
        text: "A bounded native text node",
        width: 320,
        typography: { family: "Inter", style: "Regular", size: 16, autoResize: "height" },
        layout: { sizingHorizontal: "fill", sizingVertical: "hug" },
      },
      {
        ref: "screen",
        kind: "frame",
        name: "Screen",
        width: 1440,
        height: 900,
        fill: { r: 0.96, g: 0.97, b: 0.98, a: 1 },
        layout: {
          mode: "vertical",
          gap: 16,
          padding: { top: 24, right: 24, bottom: 24, left: 24 },
          sizingHorizontal: "fixed",
          sizingVertical: "fixed",
          primaryAxisAlign: "min",
          counterAxisAlign: "min",
        },
      },
    ],
  });
}

test("node-tree schema bounds nesting, rejects unknown fields, and accepts explicit parents out of order", () => {
  const tree = validTree();
  assert.equal(tree.nodes[0]?.parentRef, "screen");
  assert.equal(tree.nodes[1]?.layout?.mode, "vertical");
  assert.equal(tree.nodes[0]?.positioning, "auto");
  assert.doesNotThrow(() => nodeTreeSpecSchema.parse({
    nodes: [{
      ref: "standalone-text",
      kind: "text",
      name: "Standalone text",
      text: "Fixed text",
      layout: { sizingHorizontal: "fixed", sizingVertical: "hug" },
    }],
  }));

  assert.throws(() => nodeTreeSpecSchema.parse({
    nodes: [{ ref: "screen", kind: "frame", name: "Screen", unsupported: true }],
  }));
  assert.throws(() => nodeTreeSpecSchema.parse({
    nodes: [{
      ref: "text",
      kind: "text",
      name: "Text",
      text: "Text",
      layout: { sizingHorizontal: "fill" },
    }],
  }));
  assert.throws(() => nodeTreeSpecSchema.parse({
    nodes: [{ ref: "screen", kind: "frame", name: "Screen", text: "not allowed" }],
  }));
  assert.doesNotThrow(() => nodeTreeSpecSchema.parse({
    nodes: [{
      ref: "button-instance",
      kind: "instance",
      name: "Button instance",
      componentId: "local-component-id",
      textOverrides: { "Label#0:0": "Open" },
      width: 220,
      height: 52,
    }],
  }));
  assert.throws(() => nodeTreeSpecSchema.parse({
    nodes: [{ ref: "missing-component", kind: "instance", name: "Missing component" }],
  }));
  assert.throws(() => nodeTreeSpecSchema.parse({
    nodes: [{ ref: "wrong-fields", kind: "frame", name: "Frame", componentId: "not-allowed" }],
  }));
  assert.doesNotThrow(() => setPrototypeSpecSchema.parse({
    links: [
      { sourceNodeId: "source", destinationNodeId: "destination", mode: "set", trigger: "on_click", transition: "instant" },
      { sourceNodeId: "source", destinationNodeId: "destination", mode: "clear", clearScope: "matching" },
      { sourceNodeId: "source", mode: "clear", clearScope: "all" },
    ],
    flowStartingPoints: [{ nodeId: "destination", name: "Launch", mode: "set" }],
  }));
  assert.throws(() => setPrototypeSpecSchema.parse({
    links: [{ sourceNodeId: "source", mode: "clear" }],
    flowStartingPoints: [],
  }));
});

test("adapter validates and routes node-tree creation and explicit-ID updates", async () => {
  const calls: Array<{ operation: string; payload: unknown }> = [];
  const bridge = {
    request: async (_host: unknown, operation: string, payload: unknown) => {
      calls.push({ operation, payload });
      if (operation === "create_node_tree") {
        return {
          status: "applied",
          createdNodeIds: ["1:1", "1:2"],
          rootNodeIds: ["1:1"],
          referenceMap: { screen: "1:1", "body-copy": "1:2" },
        };
      }
      if (operation === "set_prototype") {
        return {
          status: "applied",
          affectedNodeIds: ["source", "destination"],
          linksSet: 1,
          linksCleared: 0,
          flowsSet: 1,
          flowsCleared: 0,
        };
      }
      return { status: "applied", nodes: [{ host: "figma", id: "1:2" }] };
    },
  } as never;
  const adapter = new BridgeHostAdapter(bridge, { host: "figma", sessionId: "session-1", documentId: "doc-1" });
  await adapter.createNodeTree({ ...validTree(), expectedSnapshotId: "snapshot-1" });
  await adapter.updateSelection({
    expectedSnapshotId: "snapshot-2",
    targetIds: ["1:2"],
    patch: {
      coordinateSpace: "parent",
      text: "Updated body",
      typography: { family: "Inter", style: "Medium", size: 17 },
      layout: { sizingHorizontal: "fill" },
    },
    documentId: "doc-1",
    sessionId: "session-1",
  });
  await adapter.setPrototype({
    expectedSnapshotId: "snapshot-4",
    sessionId: "native-capture-session",
    links: [{
      sourceNodeId: "source",
      destinationNodeId: "destination",
      mode: "set",
      trigger: "on_click",
      transition: "instant",
    }],
    flowStartingPoints: [{ nodeId: "destination", name: "Destination", mode: "set" }],
  });

  assert.equal(calls[0]?.operation, "create_node_tree");
  assert.equal(calls[1]?.operation, "update_selection");
  assert.equal(calls[2]?.operation, "set_prototype");
  assert.deepEqual((calls[1]?.payload as { targetIds: string[] }).targetIds, ["1:2"]);
  await assert.rejects(() => adapter.updateSelection({
    expectedSnapshotId: "snapshot-3",
    targetIds: [],
    patch: { coordinateSpace: "parent" },
  }));
});

test("Avia fixture declares positioned screens, visible card sizing, and scoped Finance navigation", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../examples/avia-wireframe/spec.json", import.meta.url),
    "utf8",
  )) as {
    documentName: string;
    viewport: { width: number; height: number };
    screens: Array<{ ref: string; x: number; y: number; nodes: Array<Record<string, any>> }>;
  };
  const nodes = fixture.screens.flatMap((screen) => screen.nodes);
  assert.equal(fixture.documentName, "Avia · DesignPort wireframe experiment");
  assert.deepEqual(fixture.viewport, { width: 1440, height: 900 });
  assert.equal(fixture.screens.length, 3);
  assert.equal(nodes.length, 109);
  assert.equal(nodes.filter((node) => node.kind === "text").length, 65);
  assert.deepEqual(fixture.screens.map(({ ref, x, y }) => ({ ref, x, y })), [
    { ref: "risk-profile", x: 0, y: 0 },
    { ref: "planning-draft", x: 1480, y: 0 },
    { ref: "finance-review", x: 2960, y: 0 },
  ]);

  for (const screen of fixture.screens) {
    assert.equal(screen.nodes.filter((node) => !node.parentRef).length, 1);
    const byRef = new Map(screen.nodes.map((node) => [node.ref, node]));
    for (const ref of ["status-card", "owner-card", "action-card"]) {
      assert.equal(byRef.get(ref)?.height, 148);
      assert.equal(byRef.get(ref)?.layout?.sizingVertical, "fixed");
    }
    const detailRef = screen.ref === "risk-profile"
      ? "recommendation"
      : screen.ref === "planning-draft" ? "scope-card" : "budget-card";
    assert.equal(byRef.get(detailRef)?.height, 360);
    assert.equal(byRef.get(detailRef)?.layout?.sizingVertical, "fixed");
    assert.equal(byRef.get("boundary")?.height, 360);
    assert.equal(byRef.get("boundary")?.layout?.sizingVertical, "fixed");
  }

  const finance = fixture.screens.find((screen) => screen.ref === "finance-review")!;
  assert.deepEqual(
    finance.nodes.filter((node) => node.parentRef === "nav").map((node) => node.text),
    ["AVIA / SURVEIL", "FINANCE", "Finance Review"],
  );
  const risk = fixture.screens.find((screen) => screen.ref === "risk-profile")!;
  assert.equal(risk.nodes.find((node) => node.ref === "status-value")?.text, "Elevated · assessed");
  const planning = fixture.screens.find((screen) => screen.ref === "planning-draft")!;
  assert.equal(planning.nodes.find((node) => node.ref === "topbar-status")?.text, "Planning draft · Awaiting submission");
});
