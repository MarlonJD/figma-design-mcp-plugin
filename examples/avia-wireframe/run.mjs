import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DesignPortBridge } from "../../dist/src/bridge/bridge-server.js";
import { createMcpServer } from "../../dist/src/mcp/server.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REVISION_TIMEOUT_MS = 30_000;
const PAIRING_TOKEN = process.env.DESIGNPORT_PAIRING_TOKEN || "designport-local-pairing";

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseHexColor(value) {
  if (typeof value !== "string") return value;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return value;
  const channel = (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    ...(hex.length === 8 ? { a: channel(6) } : {}),
  };
}

function colorValue(value, palette) {
  if (typeof value === "string" && palette[value]) return parseHexColor(palette[value]);
  return parseHexColor(value);
}

function authoredNodes(spec) {
  return spec.screens.flatMap((screen) => {
    const root = screen.nodes.find((node) => !node.parentRef);
    if (!root) throw new Error(`Screen ${screen.ref} must declare a root node.`);
    return screen.nodes.map((node) => ({
      ...node,
      ...(node.ref === root.ref ? {
        ...(screen.x !== undefined ? { x: screen.x } : {}),
        ...(screen.y !== undefined ? { y: screen.y } : {}),
      } : {}),
      ref: `${screen.ref}--${node.ref}`,
      ...(node.parentRef ? { parentRef: `${screen.ref}--${node.parentRef}` } : {}),
      ...(node.fill !== undefined ? { fill: colorValue(node.fill, spec.palette) } : {}),
      ...(node.stroke ? {
        stroke: {
          ...node.stroke,
          color: colorValue(node.stroke.color, spec.palette),
        },
      } : {}),
    }));
  });
}

function resultData(result, operation) {
  if (result?.isError) {
    const text = result.content?.find((item) => item.type === "text")?.text || `${operation} failed`;
    throw new Error(text);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${operation} returned no structured content`);
  return JSON.parse(text);
}

async function main() {
  const spec = JSON.parse(await readFile(new URL("./spec.json", import.meta.url), "utf8"));
  const requestedPort = Number(argumentValue("--port", "0"));
  const hostTimeoutMs = Number(argumentValue("--host-timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  if (!Number.isInteger(hostTimeoutMs) || hostTimeoutMs < 1000) {
    throw new Error("--host-timeout-ms must be at least 1000ms");
  }

  const bridge = new DesignPortBridge({
    host: "127.0.0.1",
    port: requestedPort,
    requestTimeoutMs: 30_000,
    serverVersion: "0.5.0",
    pairingToken: PAIRING_TOKEN,
  });
  const address = await bridge.start();
  const client = new Client({ name: "designport-avia-fixture", version: "0.5.0" });
  const server = createMcpServer(bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = async (name, args) => resultData(await client.callTool({ name, arguments: args }), name);
  const selector = (host) => ({ host: "figma", sessionId: host.sessionId, documentId: host.documentId });
  const startedAt = Date.now();
  let host;
  try {
    console.error(`[avia-fixture] bridge listening on ws://${address.host}:${address.port}`);
    console.error("[avia-fixture] waiting for a Figma host on this bridge; no 5514 fallback is used");
    while (!host && Date.now() - startedAt < hostTimeoutMs) {
      const hosts = await call("design.list_hosts", {});
      const figmaHosts = hosts.hosts.filter((item) => item.host === "figma");
      const matchingHosts = figmaHosts.filter((item) => item.documentName === spec.documentName);
      if (matchingHosts.length > 1) {
        throw new Error(`More than one Figma host is connected to the intended document "${spec.documentName}".`);
      }
      if (matchingHosts.length === 1) {
        host = matchingHosts[0];
      } else if (figmaHosts.length > 0) {
        const names = figmaHosts.map((item) => item.documentName || "<unnamed>").join(", ");
        throw new Error(`Connected Figma document does not match the intended scratch document "${spec.documentName}" (connected: ${names}).`);
      } else {
        await sleep(250);
      }
    }
    if (!host) {
      throw new Error(`No Figma host connected within ${hostTimeoutMs}ms. Point the development plugin at ws://${address.host}:${address.port} and run the fixture again.`);
    }
    if (host.documentName !== spec.documentName) {
      throw new Error(`Refusing to write to Figma document "${host.documentName || "<unnamed>"}"; expected "${spec.documentName}".`);
    }

    const hostArgs = selector(host);
    const initial = await call("design.export_ir", {
      ...hostArgs,
      scope: "document",
      detail: "full",
      includeAssets: false,
      includeTokens: false,
    });
    if (!initial.snapshot?.complete) throw new Error("The initial document capture is incomplete and cannot authorize authoring.");
    if (initial.documentName !== spec.documentName || initial.documentId !== host.documentId) {
      throw new Error(`Initial capture is not the intended scratch document "${spec.documentName}".`);
    }

    const nodes = authoredNodes(spec);
    const created = await call("design.create_node_tree", {
      ...hostArgs,
      expectedSnapshotId: initial.snapshot.id,
      nodes,
    });
    if (created.createdNodeIds.length !== nodes.length) throw new Error("The host did not return every created node ID.");
    if (Object.keys(created.referenceMap).length !== nodes.length) throw new Error("The host did not return a complete caller-reference map.");

    const waitForDocumentRevision = async (previousRevision) => {
      const deadline = Date.now() + DEFAULT_REVISION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const events = bridge.listEvents("figma");
        if (events.some((event) => event.sessionId === host.sessionId
          && event.documentId === host.documentId
          && event.event === "document.changed"
          && event.payload.documentRevision > previousRevision)) return;
        await sleep(200);
      }
      throw new Error(`Figma did not report a document revision after the write (previous revision ${previousRevision}).`);
    };

    await waitForDocumentRevision(initial.snapshot.documentRevision);
    const createdCapture = await call("design.export_ir", {
      ...hostArgs,
      scope: "document",
      detail: "full",
      includeAssets: false,
      includeTokens: false,
    });
    const exportedNodes = createdCapture.nodes;
    const checkIds = new Set(created.createdNodeIds);
    for (const id of created.createdNodeIds) {
      if (!exportedNodes[id]) throw new Error(`Created node ${id} was not present in the exported structure.`);
    }
    for (const node of nodes) {
      const id = created.referenceMap[node.ref];
      const exported = exportedNodes[id];
      if (!exported) throw new Error(`Missing exported node for ${node.ref}.`);
      if (node.parentRef && exported.parentId !== created.referenceMap[node.parentRef]) {
        throw new Error(`Parent mismatch for ${node.ref}.`);
      }
      if (node.parentRef && !exportedNodes[created.referenceMap[node.parentRef]].children.includes(id)) {
        throw new Error(`Child linkage missing for ${node.ref}.`);
      }
      if (node.kind === "text" && exported.text !== node.text) throw new Error(`Text mismatch for ${node.ref}.`);
      if (node.layout?.mode && node.layout.mode !== "none" && exported.layout?.mode !== node.layout.mode) {
        throw new Error(`Auto-layout mismatch for ${node.ref}.`);
      }
      if (node.layout?.sizingVertical === "fixed" && node.height !== undefined
        && Math.abs((exported.bounds?.height ?? Number.NaN) - node.height) > 0.5) {
        throw new Error(`Fixed-height mismatch for ${node.ref}: expected ${node.height}, got ${exported.bounds?.height}.`);
      }
    }
    for (const screen of spec.screens) {
      const root = exportedNodes[created.referenceMap[`${screen.ref}--screen`]];
      if (root?.bounds?.x !== screen.x || root?.bounds?.y !== screen.y
        || root?.bounds?.width !== spec.viewport.width || root?.bounds?.height !== spec.viewport.height) {
        throw new Error(`Viewport mismatch for ${screen.ref}.`);
      }
    }
    if (created.rootNodeIds.length !== spec.screens.length) throw new Error("The fixture did not create exactly three screen roots.");

    const textRef = "risk-profile--scenario-copy";
    const updatedText = "Scenario note · Fictional record for the DesignPort experiment. The Department Manager has reviewed the elevated exposure and is deciding whether to adopt the recommendation into Planning.";
    await call("design.update_selection", {
      ...hostArgs,
      captureSessionId: createdCapture.snapshot.identity.sessionId,
      expectedSnapshotId: createdCapture.snapshot.id,
      targetIds: [created.referenceMap[textRef]],
      patch: { text: updatedText, typography: { family: "Inter", style: "Regular", size: 14 } },
    });
    await waitForDocumentRevision(createdCapture.snapshot.documentRevision);
    const afterText = await call("design.export_ir", {
      ...hostArgs,
      scope: "document",
      detail: "full",
      includeAssets: false,
      includeTokens: false,
    });
    if (afterText.nodes[created.referenceMap[textRef]]?.text !== updatedText) throw new Error("Explicit text update was not visible in the next capture.");

    const layoutRef = "risk-profile--content";
    await call("design.update_selection", {
      ...hostArgs,
      captureSessionId: afterText.snapshot.identity.sessionId,
      expectedSnapshotId: afterText.snapshot.id,
      targetIds: [created.referenceMap[layoutRef]],
      patch: { layout: { gap: 24 } },
    });
    await waitForDocumentRevision(afterText.snapshot.documentRevision);
    const afterLayout = await call("design.export_ir", {
      ...hostArgs,
      scope: "document",
      detail: "structure",
      includeAssets: false,
      includeTokens: false,
    });
    if (afterLayout.nodes[created.referenceMap[layoutRef]]?.layout?.gap !== 24) throw new Error("Explicit layout update was not visible in the next capture.");

    const result = {
      fixture: spec.fixture,
      documentName: spec.documentName,
      bridge: { host: address.host, port: address.port },
      host: { host: host.host, sessionId: host.sessionId, documentId: host.documentId },
      checks: {
        screenCount: created.rootNodeIds.length,
        nodeCount: created.createdNodeIds.length,
        createdIdsComplete: checkIds.size === nodes.length,
        parentRelationships: true,
        nestedNativeNodes: true,
        autoLayout: true,
        rootCoordinates: true,
        fixedCardSizing: true,
        intendedDocument: host.documentName === spec.documentName,
        captureIdentityMapped: true,
        editableText: true,
        explicitTextUpdate: true,
        explicitLayoutUpdate: true,
      },
      snapshots: {
        initial: initial.snapshot.id,
        created: createdCapture.snapshot.id,
        afterText: afterText.snapshot.id,
        afterLayout: afterLayout.snapshot.id,
      },
      limitations: {
        prototypeAuthoring: "deferred",
        componentInstancesAndVariants: "deferred",
        evidence: "This runner checks exported native structure and IDs; it does not substitute screenshots or HTML.",
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await bridge.stop();
  }
}

main().catch((error) => {
  console.error(`[avia-fixture] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
