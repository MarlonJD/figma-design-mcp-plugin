import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, Script } from "node:vm";
import { eventMessageSchema, helloMessageSchema } from "../src/core/protocol.js";

const rootDir = new URL("..", import.meta.url);

function run(source: string, globals: Record<string, unknown>) {
  const context = createContext({
    ...globals,
    Array,
    ArrayBuffer,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    console,
    clearTimeout,
    setTimeout,
  });
  new Script(source).runInContext(context);
  return context;
}

test("Figma entrypoint emits authenticated v2 hello and bounded invalidation events", async () => {
  const source = await readFile(new URL("plugins/figma/code.js", rootDir), "utf8");
  const uiMessages: unknown[] = [];
  const listeners = new Map<string, (event?: unknown) => void>();
  const nodes = new Map<string, { id: string; type: string; parent: unknown; name: string; visible: boolean }>();
  const page = {
    id: "page-1",
    type: "PAGE",
    name: "Page 1",
    parent: { id: "document-1", children: [] },
    children: [] as unknown[],
    selection: [] as unknown[],
  };
  const figma = {
    showUI() {},
    ui: {
      onmessage: null as ((message: unknown) => void) | null,
      postMessage(message: unknown) { uiMessages.push(message); },
    },
    root: { id: "document-1", name: "Fixture", children: [page] },
    currentPage: page,
    getNodeById(id: string) { return nodes.get(id) ?? null; },
    base64Encode() { return ""; },
    on(event: string, handler: (value?: unknown) => void) { listeners.set(event, handler); },
  };
  run(source, { __html__: "", figma });
  assert.ok(figma.ui.onmessage);

  figma.ui.onmessage!({ type: "ui_ready" });
  const helloEnvelope = uiMessages.find((item) => (item as { type?: string }).type === "host_hello") as { hello: unknown } | undefined;
  assert.ok(helloEnvelope);
  const hello = helloMessageSchema.parse(helloEnvelope.hello);
  assert.equal(hello.protocolVersion, 2);
  assert.equal(hello.host, "figma");
  assert.equal(hello.pairingToken, "designport-local-pairing");
  assert.equal(hello.capabilities?.supports.createNodeTree, true);
  assert.equal(hello.capabilities?.operations.includes("create_node_tree"), true);

  listeners.get("selectionchange")!();
  const selectionEnvelope = uiMessages.at(-1) as { value: unknown };
  const selectionEvent = eventMessageSchema.parse(selectionEnvelope.value);
  assert.equal(selectionEvent.event, "selection.changed");
  assert.deepEqual(selectionEvent.payload.affectedNodeIds, []);

  listeners.get("documentchange")!({ documentChanges: [{ id: "node-1", type: "PROPERTY_CHANGE" }] });
  const documentEnvelope = uiMessages.at(-1) as { value: unknown };
  const documentEvent = eventMessageSchema.parse(documentEnvelope.value);
  assert.equal(documentEvent.event, "document.changed");
  assert.deepEqual(documentEvent.payload.affectedNodeIds, ["node-1"]);
  assert.equal("nodes" in documentEvent.payload, false);

  figma.ui.onmessage!({
    type: "bridge_request",
    request: { type: "request", requestId: "request-1", operation: "ping", payload: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const responseEnvelope = uiMessages.at(-1) as { value: { result?: { ok?: boolean } } };
  assert.equal(responseEnvelope.value.result?.ok, true);
});

test("XD entrypoint sends the v2 pairing handshake through its real setup", async () => {
  const source = await readFile(new URL("plugins/xd/main.js", rootDir), "utf8");
  let setup: Record<string, any> | undefined;
  let socket: MockSocket | undefined;

  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: unknown[] = [];
    constructor() { socket = this; }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }

  const entrypoints = {
    setup(value: Record<string, any>) { setup = value; },
  };
  const root = { guid: "xd-document", name: "Fixture", children: [], globalBounds: { x: 0, y: 0, width: 100, height: 100 } };
  const scenegraph = {
    Artboard: class {},
    Rectangle: class {},
    Text: class {},
    Color: class {},
    root,
    selection: { items: [] },
    getNodeByGUID() { return null; },
  };
  const application = { activeDocument: { guid: "xd-document", name: "Fixture" } };
  run(source, {
    WebSocket: MockSocket,
    require(name: string) {
      if (name === "uxp") return { entrypoints, storage: { localFileSystem: {}, formats: {} } };
      if (name === "scenegraph") return scenegraph;
      if (name === "application") return application;
      throw new Error(`Unexpected module ${name}`);
    },
  });
  assert.ok(setup?.plugin?.create);
  setup!.plugin.create();
  assert.ok(socket);
  socket!.readyState = MockSocket.OPEN;
  socket!.onopen!();
  const hello = helloMessageSchema.parse(socket!.sent[0]);
  assert.equal(hello.protocolVersion, 2);
  assert.equal(hello.host, "xd");
  assert.equal(hello.pairingToken, "designport-local-pairing");
  assert.equal(hello.capabilities?.supports.createNodeTree, false);
  assert.equal(hello.capabilities?.operations.includes("create_node_tree"), false);
  assert.equal(hello.capabilities?.limitations?.includes("node-tree-authoring-unsupported"), true);
  socket!.onmessage!({
    data: JSON.stringify({
      type: "request",
      requestId: "xd-tree",
      operation: "create_node_tree",
      payload: {},
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const unsupported = socket!.sent.at(-1) as { ok?: boolean; error?: { code?: string } };
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error?.code, "XD_NODE_TREE_AUTHORING_UNSUPPORTED");
});

test("Figma entrypoint creates a bounded nested tree, orders auto layout, updates explicit IDs, and cleans up failed tasks", async () => {
  const source = await readFile(new URL("plugins/figma/code.js", rootDir), "utf8");
  const uiMessages: any[] = [];
  const listeners = new Map<string, (event?: unknown) => void>();
  const nodes = new Map<string, MockNode>();
  const log: string[] = [];
  let nextId = 1;

  class MockNode {
    [key: string]: any;
    id: string;
    type: string;
    name: string;
    parent: MockNode | null = null;
    children: MockNode[] = [];
    selection: MockNode[] = [];
    x = 0;
    y = 0;
    width = 100;
    height = 100;
    visible = true;
    opacity = 1;
    fills: any[] = [];
    strokes: any[] = [];
    effects: any[] = [];
    removed = false;
    absoluteBoundingBox: any;
    absoluteRenderBounds: any;
    relativeTransform = [[1, 0, 0], [0, 1, 0]];
    layoutAlign = "INHERIT";
    layoutGrow = 0;
    layoutPositioning = "AUTO";
    layoutMode = "NONE";
    hasMissingFont = false;
    autoRename = false;

    constructor(type: string, id: string, name: string) {
      this.type = type;
      this.id = id;
      this.name = name;
      this.absoluteBoundingBox = { x: 0, y: 0, width: this.width, height: this.height };
      this.absoluteRenderBounds = this.absoluteBoundingBox;
      if (type === "TEXT") {
        this.characters = "";
        this.fontName = { family: "Inter", style: "Regular" };
        this.fontSize = 12;
        this.textAutoResize = "NONE";
        this.textTruncation = "DISABLED";
        this.textAlignHorizontal = "LEFT";
        this.textAlignVertical = "TOP";
        this.textDecoration = "NONE";
        this.textCase = "ORIGINAL";
      }
      for (const property of [
        "layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "fontName", "characters",
        "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textAlignVertical",
        "textAutoResize", "textTruncation", "maxLines", "textDecoration", "textCase",
        "paragraphIndent", "paragraphSpacing", "itemSpacing", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems",
        "layoutWrap", "counterAxisSpacing",
      ]) {
        const storageKey = `__${property}`;
        if (this[storageKey] === undefined) this[storageKey] = this[property];
        Object.defineProperty(this, property, {
          configurable: true,
          enumerable: true,
          get: () => this[storageKey],
          set: (value: unknown) => {
            this[storageKey] = value;
            log.push(`${this.id}:${property}=${String(value)}`);
          },
        });
      }
    }

    getStyledTextSegments() { return []; }

    getRangeAllFontNames() {
      return [{ family: "Inter", style: "Regular" }];
    }

    resize(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.absoluteBoundingBox = { x: this.x, y: this.y, width, height };
      this.absoluteRenderBounds = this.absoluteBoundingBox;
      log.push(`${this.id}:resize=${width}x${height}`);
    }

    appendChild(child: MockNode) {
      log.push(`${this.id}:appendChild:${child.id}`);
      if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
      child.parent = this;
      this.children.push(child);
    }

    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this);
      this.parent = null;
      for (const child of [...this.children]) child.remove();
      this.children = [];
      nodes.delete(this.id);
      log.push(`${this.id}:remove`);
    }
  }

  const documentNode = new MockNode("DOCUMENT", "document-1", "Fixture");
  const page = new MockNode("PAGE", "page-1", "Page 1");
  page.parent = documentNode;
  documentNode.children = [page];
  nodes.set(documentNode.id, documentNode);
  nodes.set(page.id, page);

  const addNewNode = (type: string) => {
    const node = new MockNode(type, `node-${nextId++}`, type);
    node.parent = page;
    page.children.push(node);
    nodes.set(node.id, node);
    return node;
  };

  const figma = {
    showUI() {},
    ui: {
      onmessage: null as ((message: unknown) => void) | null,
      postMessage(message: unknown) { uiMessages.push(message); },
    },
    root: documentNode,
    currentPage: page,
    getNodeById(id: string) { return nodes.get(id) ?? null; },
    createFrame() { return addNewNode("FRAME"); },
    createRectangle() { return addNewNode("RECTANGLE"); },
    createComponent() { return addNewNode("COMPONENT"); },
    createText() { return addNewNode("TEXT"); },
    async loadFontAsync(font: { family: string; style: string }) {
      log.push(`load-font:${font.family}/${font.style}`);
      if (font.family === "Missing") throw new Error("Font unavailable");
    },
    base64Encode() { return ""; },
    on(event: string, handler: (value?: unknown) => void) { listeners.set(event, handler); },
  };

  run(source, { __html__: "", figma });
  assert.ok(figma.ui.onmessage);

  const sendRequest = async (requestId: string, operation: string, payload: unknown) => {
    figma.ui.onmessage!({ type: "bridge_request", request: { type: "request", requestId, operation, payload } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const envelope = [...uiMessages].reverse().find((item) => item.type === "bridge_response" && item.value?.requestId === requestId);
    assert.ok(envelope, `No response for ${requestId}`);
    return envelope.value;
  };

  const capture = await sendRequest("capture-1", "export_ir", {
    scope: "document",
    options: { includeAssets: false, includeTokens: false, detail: "structure" },
  });
  assert.equal(capture.ok, true);
  const expectedSnapshotId = capture.result.snapshot.id;
  const beforeIds = page.children.map((node) => node.id);
  const initialSelection = page.selection;
  const created = await sendRequest("create-1", "create_node_tree", {
    expectedSnapshotId,
    nodes: [
      {
        ref: "screen",
        kind: "frame",
        name: "Screen",
        width: 1440,
        height: 900,
        layout: {
          mode: "vertical",
          gap: 16,
          padding: { top: 24, right: 24, bottom: 24, left: 24 },
          sizingHorizontal: "fixed",
          sizingVertical: "fixed",
        },
      },
      {
        ref: "fill-panel",
        parentRef: "screen",
        kind: "frame",
        name: "Fill panel",
        width: 600,
        height: 200,
        layout: { mode: "horizontal", sizingHorizontal: "fill", sizingVertical: "fixed" },
      },
      {
        ref: "title",
        parentRef: "fill-panel",
        kind: "text",
        name: "Title",
        text: "Initial title",
        width: 300,
        height: 32,
        typography: { family: "Inter", style: "Regular", size: 16 },
        layout: { sizingHorizontal: "fill", sizingVertical: "fixed" },
      },
      {
        ref: "hug-copy",
        parentRef: "screen",
        kind: "text",
        name: "Hug copy",
        text: "Hug text",
        typography: { family: "Inter", style: "Regular", size: 14 },
        layout: { sizingHorizontal: "hug", sizingVertical: "hug" },
      },
      {
        ref: "accent",
        parentRef: "fill-panel",
        kind: "rectangle",
        name: "Accent",
        width: 24,
        height: 24,
        fill: { r: 0.18, g: 0.44, b: 0.84, a: 1 },
        layout: { sizingHorizontal: "fixed", sizingVertical: "fixed" },
      },
    ],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.result.createdNodeIds.length, 5);
  assert.equal(Object.keys(created.result.referenceMap).length, 5);
  assert.deepEqual(page.children.map((node) => node.id), [...beforeIds, created.result.referenceMap.screen]);
  assert.strictEqual(page.selection, initialSelection);
  const appendIndex = log.findIndex((entry) => entry.endsWith(`:appendChild:${created.result.referenceMap["fill-panel"]}`));
  const fillSizingIndex = log.findIndex((entry) => entry.startsWith(`${created.result.referenceMap["fill-panel"]}:layoutSizingHorizontal=FILL`));
  assert.ok(appendIndex >= 0 && fillSizingIndex > appendIndex);
  const rootLayoutIndex = log.findIndex((entry) => entry.startsWith(`${created.result.referenceMap.screen}:layoutMode=VERTICAL`));
  const rootSizingIndex = log.findIndex((entry) => entry.startsWith(`${created.result.referenceMap.screen}:layoutSizingHorizontal=FIXED`));
  assert.ok(rootLayoutIndex >= 0 && rootSizingIndex > rootLayoutIndex);

  listeners.get("documentchange")!({ documentChanges: [{ id: created.result.referenceMap.title, type: "PROPERTY_CHANGE" }] });
  const stale = await sendRequest("stale-update", "update_selection", {
    expectedSnapshotId,
    targetIds: [created.result.referenceMap.title],
    patch: { text: "Rejected stale update" },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "WRITE_STALE_CAPTURE");

  const fresh = await sendRequest("capture-2", "export_ir", {
    scope: "document",
    options: { includeAssets: false, includeTokens: false, detail: "full" },
  });
  const sessionMismatch = await sendRequest("session-mismatch", "update_selection", {
    expectedSnapshotId: fresh.result.snapshot.id,
    sessionId: "bridge-connection-session",
    targetIds: [created.result.referenceMap.title],
    patch: { text: "Rejected bridge selector" },
  });
  assert.equal(sessionMismatch.ok, false);
  assert.equal(sessionMismatch.error.code, "WRITE_SESSION_MISMATCH");
  const documentMismatch = await sendRequest("document-mismatch", "update_selection", {
    expectedSnapshotId: fresh.result.snapshot.id,
    documentId: "other-document",
    targetIds: [created.result.referenceMap.title],
    patch: { text: "Rejected other document" },
  });
  assert.equal(documentMismatch.ok, false);
  assert.equal(documentMismatch.error.code, "WRITE_DOCUMENT_MISMATCH");
  const outOfScope = await sendRequest("out-of-scope-update", "update_selection", {
    expectedSnapshotId: fresh.result.snapshot.id,
    targetIds: ["not-in-captured-scope"],
    patch: { name: "Rejected target" },
  });
  assert.equal(outOfScope.ok, false);
  assert.equal(outOfScope.error.code, "WRITE_TARGET_MISMATCH");
  page.selection = [nodes.get(created.result.referenceMap.screen)!];
  const updated = await sendRequest("update-1", "update_selection", {
    expectedSnapshotId: fresh.result.snapshot.id,
    targetIds: [created.result.referenceMap.title],
    patch: {
      text: "Updated title",
      typography: { family: "Inter", style: "Medium", size: 18 },
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(nodes.get(created.result.referenceMap.title)!.characters, "Updated title");

  const afterText = await sendRequest("capture-3", "export_ir", {
    scope: "document",
    options: { includeAssets: false, includeTokens: false, detail: "structure" },
  });
  const layoutUpdate = await sendRequest("update-layout", "update_selection", {
    expectedSnapshotId: afterText.result.snapshot.id,
    targetIds: [created.result.referenceMap["fill-panel"]],
    patch: { layout: { mode: "vertical", gap: 24, sizingHorizontal: "fill" } },
  });
  assert.equal(layoutUpdate.ok, true);

  const afterFailure = await sendRequest("capture-4", "export_ir", {
    scope: "document",
    options: { includeAssets: false, includeTokens: false, detail: "structure" },
  });
  const beforeFailureIds = page.children.map((node) => node.id);
  const failed = await sendRequest("create-failed", "create_node_tree", {
    expectedSnapshotId: afterFailure.result.snapshot.id,
    nodes: [
      { ref: "failed-screen", kind: "frame", name: "Failed screen", width: 500, height: 300 },
      {
        ref: "missing-font",
        parentRef: "failed-screen",
        kind: "text",
        name: "Missing font",
        text: "This must be cleaned up",
        typography: { family: "Missing", style: "Regular", size: 16 },
      },
    ],
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(page.children.map((node) => node.id), beforeFailureIds);
  assert.equal([...nodes.values()].some((node) => node.name === "Failed screen"), false);
});
