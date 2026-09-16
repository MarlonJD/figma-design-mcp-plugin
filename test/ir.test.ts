import test from "node:test";
import assert from "node:assert/strict";
import {
  contextIRSchema,
  designAssetSchema,
  designIRSchema,
  exportOptionsSchema,
  screenSpecSchema,
  snapshotSchema,
  visualContextSchema,
} from "../src/core/ir.js";

const exportedAt = new Date().toISOString();

function identity(scope: "document" | "page" | "selection" | "screen" = "screen") {
  return {
    sessionId: "session-1",
    documentId: "doc-1",
    scope,
    ...(scope === "screen" || scope === "page" ? { pageId: "page-1" } : {}),
    scopeRootIds: [scope === "selection" ? "node-1" : "root-1"],
    selectedIds: ["node-1"],
    normalizationVersion: "designport-ir-v2" as const,
    evidenceShape: {
      detail: "full" as const,
      includeAssets: true,
      includeTokens: true,
      maxAssetBytes: 4000000,
      maxTextBytes: 200000,
      maxTokenRecords: 5000,
    },
  };
}

function coverage(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { status: "complete" as const },
    layout: { status: "complete" as const },
    typography: { status: "complete" as const },
    tokens: { status: "complete" as const },
    components: { status: "complete" as const },
    interactions: { status: "complete" as const },
    assets: { status: "complete" as const },
    accessibility: { status: "complete" as const },
    ...overrides,
  };
}

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    name: "Node",
    kind: "frame" as const,
    parentId: null,
    children: [],
    bounds: { x: 0, y: 0, width: 100, height: 80 },
    visible: true,
    ...overrides,
  };
}

function snapshot(scope: "document" | "page" | "selection" | "screen" = "screen") {
  return snapshotSchema.parse({
    id: "snapshot-1",
    captureId: "capture-1",
    identity: identity(scope),
    scope,
    documentRevision: 2,
    selectionRevision: 1,
    generation: 1,
    complete: true,
    generatedAt: exportedAt,
  });
}

test("screen specs receive safe defaults", () => {
  const spec = screenSpecSchema.parse({ name: "Audit overview" });
  assert.equal(spec.width, 1440);
  assert.equal(spec.height, 900);
});

test("v2 export options, assets, and snapshots are explicit and bounded", () => {
  const options = exportOptionsSchema.parse({ includeAssets: false, maxNodes: 25 });
  assert.deepEqual(options, {
    maxNodes: 25,
    includeAssets: false,
    maxAssetBytes: 4000000,
    includeTokens: true,
    detail: "full",
    changedOnly: false,
    includePages: false,
    maxTextBytes: 200000,
    maxTokenRecords: 5000,
    maxImagePixels: 8000000,
    maxResponseBytes: 12000000,
  });

  const incremental = exportOptionsSchema.parse({
    detail: "structure",
    knownSnapshotId: "snapshot-1",
    changedOnly: true,
    cursor: "snapshot-1:25",
  });
  assert.equal(incremental.detail, "structure");
  assert.equal(incremental.knownSnapshotId, "snapshot-1");
  assert.equal(incremental.changedOnly, true);
  assert.equal(incremental.cursor, "snapshot-1:25");
  assert.throws(() => exportOptionsSchema.parse({ maxNodes: 10001 }));

  const asset = designAssetSchema.parse({
    mimeType: "image/svg+xml",
    data: "<svg />",
    kind: "vector",
    artifactId: "asset-1",
    digest: "digest-1",
    size: 7,
    sourceNodeIds: ["node-1"],
    captureId: "capture-1",
  });
  assert.equal(asset.size, 7);
  assert.equal(asset.artifactId, "asset-1");

  assert.equal(snapshot().captureId, "capture-1");
  assert.throws(() => snapshotSchema.parse({
    id: "snapshot-old",
    scope: "screen",
    documentRevision: 2,
    selectionRevision: 1,
    generatedAt: exportedAt,
  }));
});

test("DesignIR and context IR reject v1 and host-specific shape drift", () => {
  const root = node({ id: "root", name: "Document", kind: "root" });
  const ir = designIRSchema.parse({
    schemaVersion: 2,
    host: "xd",
    documentId: "doc-1",
    documentName: "Example",
    rootId: "root",
    nodes: { root },
    screens: [],
    selection: [],
    scope: "document",
    captureId: "capture-1",
    captureIdentity: identity("document"),
    responseType: "full",
    coverage: coverage(),
    exportedAt,
  });
  assert.equal(ir.nodes.root?.kind, "root");

  const context = contextIRSchema.parse({
    schemaVersion: 2,
    scope: "selection",
    host: "xd",
    documentId: "doc-1",
    documentName: "Example",
    selection: [],
    nodes: [root],
    captureId: "capture-1",
    captureIdentity: identity("selection"),
    responseType: "full",
    coverage: coverage(),
    exportedAt,
  });
  assert.equal(context.scope, "selection");

  assert.throws(() => designIRSchema.parse({
    ...ir,
    schemaVersion: 1,
  }));
  assert.throws(() => designIRSchema.parse({
    ...ir,
    host: "photoshop",
  }));
});

test("DesignIR preserves normalized evidence and interaction metadata", () => {
  const ir = designIRSchema.parse({
    schemaVersion: 2,
    host: "figma",
    documentId: "doc-evidence",
    documentName: "Evidence",
    rootId: "root",
    nodes: {
      root: node({
        id: "root",
        name: "Root",
        kind: "root",
        component: {
          id: "component-1",
          variantProperties: { State: "Hover", Size: "Large" },
          states: { State: "Hover" },
          properties: [{ key: "label#text", name: "label", type: "text", value: "Continue" }],
          isVariant: true,
        },
        accessibility: {
          role: "button",
          label: "Continue",
          source: "plugin-data",
          confidence: 1,
          provenance: {
            role: { source: "plugin-data", sourceField: "designport.accessibility.role" },
            label: { source: "plugin-data", sourceField: "designport.accessibility.label" },
          },
        },
        prototypeLinks: [{
          trigger: "on_click",
          action: "overlay",
          destinationId: "screen-2",
          duration: 0.2,
          easing: "ease-out",
          overlayPosition: { x: 10, y: 12 },
        }],
        provenance: {
          bounds: { source: "host", sourceField: "absoluteBoundingBox" },
        },
      }),
    },
    screens: [],
    selection: [],
    scope: "document",
    captureId: "capture-evidence",
    captureIdentity: { ...identity("document"), documentId: "doc-evidence" },
    responseType: "full",
    coverage: coverage(),
    tokens: [{
      id: "token-1",
      name: "color/action/primary",
      type: "color",
      value: { r: 0.1, g: 0.2, b: 0.3 },
      source: "variable",
      resolutionStatus: "resolved",
    }],
    pagination: {
      limit: 1,
      total: 1,
      returned: 1,
      hasMore: false,
    },
    exportStats: {
      totalNodes: 1,
      returnedNodes: 1,
      assetCount: 0,
      assetBytes: 0,
      assetsOmitted: 0,
      tokenCount: 1,
      textBytes: 0,
      tokenRecords: 1,
      imagePixels: 0,
      responseBytes: 1024,
    },
    exportedAt,
  });
  assert.equal(ir.tokens?.[0]?.name, "color/action/primary");
  assert.equal(ir.nodes.root?.component?.states?.State, "Hover");
  assert.equal(ir.nodes.root?.accessibility?.provenance?.role?.source, "plugin-data");
  assert.equal(ir.nodes.root?.prototypeLinks?.[0]?.overlayPosition?.x, 10);
  assert.equal(ir.exportStats?.tokenCount, 1);
});

test("visual context carries capture identity and pixel mapping", () => {
  const visual = visualContextSchema.parse({
    schemaVersion: 2,
    scope: "screen",
    host: "figma",
    documentId: "doc-3",
    documentName: "Visual example",
    captureId: "capture-visual",
    captureIdentity: { ...identity("screen"), documentId: "doc-3" },
    items: [{
      nodeId: "screen-1",
      nodeName: "Overview",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      scale: 1,
      pixelWidth: 390,
      pixelHeight: 844,
      cropOrigin: { x: 0, y: 0 },
      worldToPixel: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      captureId: "capture-visual",
    }],
    exportedAt,
  });
  assert.equal(visual.items[0]?.mimeType, "image/png");
  assert.equal(visual.items[0]?.pixelHeight, 844);
  assert.equal(visual.items[0]?.captureId, "capture-visual");
});
