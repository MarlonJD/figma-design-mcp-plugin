import test from "node:test";
import assert from "node:assert/strict";
import {
  contextIRSchema,
  designIRSchema,
  screenSpecSchema,
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
