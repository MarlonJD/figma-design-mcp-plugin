import { DesignPortBridge } from "./bridge/bridge-server.js";
import { createMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const portValue = Number.parseInt(process.env.DESIGNPORT_PORT ?? "5514", 10);
const timeoutValue = Number.parseInt(
  process.env.DESIGNPORT_REQUEST_TIMEOUT_MS ?? "15000",
  10,
);

if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) {
  throw new Error("DESIGNPORT_PORT must be an integer between 0 and 65535");
}

if (!Number.isInteger(timeoutValue) || timeoutValue < 1) {
  throw new Error("DESIGNPORT_REQUEST_TIMEOUT_MS must be a positive integer");
}

const bridge = new DesignPortBridge({
  host: process.env.DESIGNPORT_HOST ?? "127.0.0.1",
  port: portValue,
  requestTimeoutMs: timeoutValue,
  serverVersion: "0.3.0",
});

const address = await bridge.start();
console.error(`DesignPort bridge listening on ws://${address.host}:${address.port}`);

const mcpServer = createMcpServer(bridge);
const transport = new StdioServerTransport();
await mcpServer.connect(transport);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`DesignPort received ${signal}; shutting down`);
  await bridge.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
