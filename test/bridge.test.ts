import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { DesignPortBridge } from "../src/bridge/bridge-server.js";

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

function hello(host: "figma" | "xd") {
  return {
    type: "hello",
    protocolVersion: 1,
    host,
    pluginVersion: "test",
    documentId: `${host}-document`,
    documentName: `${host} document`,
    capabilities: {
      host,
      pluginVersion: "test",
      operations: ["ping"],
      supports: {
        documentRead: true,
        selectionRead: true,
        createScreen: host === "figma",
        createComponent: host === "figma",
        updateSelection: true,
        userActionRequiredForWrite: host === "xd",
      },
    },
  };
}

test("bridge registers a host and routes correlated requests", async () => {
  const bridge = new DesignPortBridge({
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 1000,
    serverVersion: "test",
  });
  const address = await bridge.start();
  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  socket.send(JSON.stringify(hello("xd")));
  const ack = await nextMessage(socket);

  assert.equal(ack.type, "hello_ack");
  assert.equal(bridge.listHosts()[0]?.host, "xd");

  const request = bridge.request<{ ok: boolean }>("xd", "ping", {});
  const outbound = await nextMessage(socket);
  assert.equal(outbound.type, "request");
  socket.send(JSON.stringify({
    type: "response",
    requestId: outbound.requestId,
    ok: true,
    result: { ok: true },
  }));

  assert.deepEqual(await request, { ok: true });
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bridge.listHosts().length, 0);
  await bridge.stop();
});

test("bridge requires an explicit host when Figma and XD are both connected", async () => {
  const bridge = new DesignPortBridge({
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 1000,
    serverVersion: "test",
  });
  const address = await bridge.start();
  const xd = await connect(`ws://127.0.0.1:${address.port}`);
  const figma = await connect(`ws://127.0.0.1:${address.port}`);
  xd.send(JSON.stringify(hello("xd")));
  figma.send(JSON.stringify(hello("figma")));
  await Promise.all([nextMessage(xd), nextMessage(figma)]);

  await assert.rejects(
    bridge.request(undefined, "ping", {}),
    (error: unknown) => error instanceof Error && error.message.includes("More than one design host"),
  );

  xd.close();
  figma.close();
  await bridge.stop();
});
