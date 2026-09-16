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
});
