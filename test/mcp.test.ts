import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { DesignPortBridge } from "../src/bridge/bridge-server.js";
import { createMcpServer } from "../src/mcp/server.js";

const PAIRING_TOKEN = "mcp-contract-pairing-token";

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer) => resolve(JSON.parse(data.toString()) as Record<string, any>);
    const onError = (error: Error) => reject(error);
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => socket.once("close", () => setImmediate(resolve)));
}

function hello() {
  return {
    type: "hello",
    protocolVersion: 2,
    host: "figma",
    pluginVersion: "test",
    pairingToken: PAIRING_TOKEN,
    documentId: "figma-document",
    documentName: "Avia · DesignPort wireframe experiment",
    capabilities: {
      host: "figma",
      pluginVersion: "test",
      operations: ["update_selection"],
      supports: {
        documentRead: true,
        selectionRead: true,
        createScreen: true,
        createComponent: true,
        createNodeTree: true,
        updateSelection: true,
        userActionRequiredForWrite: false,
      },
    },
  };
}

test("public MCP update maps bridge session selection to native capture identity", async () => {
  const bridge = new DesignPortBridge({
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 1000,
    serverVersion: "test",
    pairingToken: PAIRING_TOKEN,
  });
  const address = await bridge.start();
  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  const server = createMcpServer(bridge);
  const client = new Client({ name: "mcp-contract-test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    socket.send(JSON.stringify(hello()));
    const ack = await nextMessage(socket);
    assert.equal(ack.type, "hello_ack");
    const bridgeSessionId = bridge.listHosts()[0]?.sessionId;
    assert.ok(bridgeSessionId);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const responsePromise = client.callTool({
      name: "design.update_selection",
      arguments: {
        host: "figma",
        sessionId: bridgeSessionId,
        captureSessionId: "native-capture-session",
        documentId: "figma-document",
        expectedSnapshotId: "snapshot-native",
        targetIds: ["node-1"],
        patch: { text: "Updated copy" },
      },
    });
    const outbound = await nextMessage(socket);
    assert.equal(outbound.type, "request");
    assert.notEqual(outbound.payload.sessionId, bridgeSessionId);
    assert.equal(outbound.payload.sessionId, "native-capture-session");
    assert.equal(outbound.payload.documentId, "figma-document");
    assert.equal(outbound.payload.expectedSnapshotId, "snapshot-native");
    assert.deepEqual(outbound.payload.targetIds, ["node-1"]);

    socket.send(JSON.stringify({
      type: "response",
      requestId: outbound.requestId,
      ok: true,
      result: { status: "applied", nodes: [{ host: "figma", id: "node-1" }] },
    }));
    const result = await responsePromise;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      status: "applied",
      nodes: [{ host: "figma", id: "node-1" }],
    });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    socket.close();
    await closed(socket);
    await bridge.stop();
  }
});
