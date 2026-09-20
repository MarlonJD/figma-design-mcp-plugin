import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { DesignPortBridge } from "../src/bridge/bridge-server.js";

const PAIRING_TOKEN = "test-pairing-token-1234";

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer) => resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    const onError = (error: Error) => reject(error);
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => socket.once("close", () => setImmediate(resolve)));
}

function hello(
  host: "figma" | "xd",
  operations = ["ping"],
  pairingToken = PAIRING_TOKEN,
) {
  return {
    type: "hello",
    protocolVersion: 2,
    host,
    pluginVersion: "test",
    pairingToken,
    documentId: `${host}-document`,
    documentName: `${host} document`,
    capabilities: {
      host,
      pluginVersion: "test",
      operations,
      supports: {
        documentRead: true,
        selectionRead: true,
        createScreen: host === "figma",
        createComponent: host === "figma",
        createNodeTree: host === "figma",
        updateSelection: true,
        setPrototype: host === "figma",
        userActionRequiredForWrite: host === "xd",
      },
    },
  };
}

async function startBridge() {
  const bridge = new DesignPortBridge({
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 1000,
    serverVersion: "test",
    pairingToken: PAIRING_TOKEN,
  });
  const address = await bridge.start();
  return { bridge, url: `ws://127.0.0.1:${address.port}` };
}

test("bridge authenticates a host and routes validated correlated requests", async () => {
  const { bridge, url } = await startBridge();
  const socket = await connect(url);
  try {
    socket.send(JSON.stringify(hello("xd")));
    const ack = await nextMessage(socket);
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.protocolVersion, 2);
    assert.equal(typeof ack.sessionId, "string");
    assert.equal(bridge.listHosts()[0]?.host, "xd");

    const sessionId = bridge.listHosts()[0]!.sessionId;
    const request = bridge.request<{ ok: boolean }>({ host: "xd", sessionId }, "ping", {});
    const outbound = await nextMessage(socket);
    assert.equal(outbound.type, "request");
    socket.send(JSON.stringify({
      type: "response",
      requestId: outbound.requestId,
      ok: true,
      result: { ok: true, host: "xd", at: new Date().toISOString() },
    }));
    const result = await request;
    assert.equal(result.ok, true);
  } finally {
    socket.close();
    await closed(socket);
    await bridge.stop();
  }
});

test("bridge retains duplicate host sessions and rejects ambiguous selection", async () => {
  const { bridge, url } = await startBridge();
  const first = await connect(url);
  const second = await connect(url);
  const figma = await connect(url);
  try {
    first.send(JSON.stringify(hello("xd")));
    second.send(JSON.stringify(hello("xd")));
    figma.send(JSON.stringify(hello("figma")));
    await Promise.all([nextMessage(first), nextMessage(second), nextMessage(figma)]);
    assert.equal(bridge.listHosts().length, 3);
    await assert.rejects(
      bridge.request("xd", "ping", {}),
      (error: unknown) => error instanceof Error && error.message.includes("More than one design host session"),
    );
    await assert.rejects(
      bridge.request(undefined, "ping", {}),
      (error: unknown) => error instanceof Error && error.message.includes("More than one design host session"),
    );
  } finally {
    first.close();
    second.close();
    figma.close();
    await Promise.all([closed(first), closed(second), closed(figma)]);
    await bridge.stop();
  }
});

test("bridge rejects unauthenticated, duplicate, and malformed handshakes", async () => {
  const { bridge, url } = await startBridge();
  const bad = await connect(url);
  const duplicate = await connect(url);
  try {
    bad.send(JSON.stringify(hello("xd", ["ping"], "wrong-pairing-token")));
    await closed(bad);
    assert.equal(bridge.listHosts().length, 0);

    duplicate.send(JSON.stringify(hello("xd")));
    await nextMessage(duplicate);
    duplicate.send(JSON.stringify(hello("xd")));
    await closed(duplicate);
    assert.equal(bridge.listHosts().length, 0);
  } finally {
    duplicate.close();
    await closed(duplicate);
    await bridge.stop();
  }
});

test("bridge rejects invalid host responses and preserves compact event evidence", async () => {
  const { bridge, url } = await startBridge();
  const socket = await connect(url);
  try {
    socket.send(JSON.stringify(hello("xd")));
    await nextMessage(socket);
    const request = bridge.request("xd", "ping", {});
    const outbound = await nextMessage(socket);
    socket.send(JSON.stringify({
      type: "response",
      requestId: outbound.requestId,
      ok: true,
      result: { nope: true },
    }));
    await assert.rejects(
      request,
      (error: unknown) => error instanceof Error && error.message.includes("invalid response"),
    );

    socket.send(JSON.stringify({
      type: "event",
      event: "document.changed",
      payload: {
        sequence: 1,
        documentId: "xd-document",
        documentRevision: 4,
        selectionRevision: 2,
        affectedNodeIds: ["node-1"],
        removedNodeIds: [],
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const event = bridge.listEvents("xd")[0];
    assert.equal(event?.payload.affectedNodeIds[0], "node-1");
    assert.equal("nodes" in event!.payload, false);
  } finally {
    socket.close();
    await closed(socket);
    await bridge.stop();
  }
});

test("bridge times out pending requests and rejects writes after disconnect", async () => {
  const { bridge, url } = await startBridge();
  const socket = await connect(url);
  socket.send(JSON.stringify(hello("xd")));
  await nextMessage(socket);
  const request = bridge.request("xd", "ping", {});
  await nextMessage(socket);
  const pendingRejection = assert.rejects(
    request,
    (error: unknown) => error instanceof Error && error.message.includes("disconnected"),
  );
  socket.close();
  await closed(socket);
  await pendingRejection;
  await bridge.stop();
});
