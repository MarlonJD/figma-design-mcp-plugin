import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  componentSpecSchema,
  designPatchSchema,
  screenSpecSchema,
  hostKindSchema,
  type HostKind,
  visualContextSchema,
} from "../core/ir.js";
import { asDesignPortError, DesignPortError } from "../core/errors.js";
import { DesignPortBridge } from "../bridge/bridge-server.js";
import { BridgeHostAdapter } from "../core/adapter.js";
import { generateCode } from "../codegen/generate.js";

const hostInput = z.object({
  host: hostKindSchema.optional(),
});

const screenInput = screenSpecSchema.extend({
  host: hostKindSchema.optional(),
});

const componentInput = componentSpecSchema.extend({
  host: hostKindSchema.optional(),
});

const updateSelectionInput = z.object({
  host: hostKindSchema.optional(),
  patch: designPatchSchema,
});

const screenContextInput = hostInput.extend({
  screenId: z.string().min(1).optional(),
});

const exportInput = hostInput.extend({
  scope: z.enum(["document", "selection", "screen"]).default("document"),
  screenId: z.string().min(1).optional(),
});

const generateCodeInput = exportInput.extend({
  target: z.enum(["html", "web", "react", "vue", "flutter", "swiftui", "compose"]).default("web"),
});

const visualInput = hostInput.extend({
  scope: z.enum(["selection", "screen"]).default("screen"),
  screenId: z.string().min(1).optional(),
});

const designContextInput = visualInput.extend({
  target: z.enum(["html", "web", "react", "vue", "flutter", "swiftui", "compose"]).default("web"),
  includeVisual: z.boolean().default(true),
});

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const normalized = asDesignPortError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function visualResult(value: unknown) {
  const visual = visualContextSchema.parse(value);
  const metadata = {
    ...visual,
    items: visual.items.map(({ data: _data, ...item }) => item),
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(metadata, null, 2),
      },
      ...visual.items.map((item) => ({
        type: "image" as const,
        data: item.data,
        mimeType: item.mimeType,
      })),
    ],
  };
}

function resolveHost(bridge: DesignPortBridge, host: HostKind | undefined): HostKind {
  if (host) return host;
  const hosts = bridge.listHosts();
  if (hosts.length === 1) return hosts[0]!.host;
  if (hosts.length === 0) {
    throw new DesignPortError("HOST_NOT_CONNECTED", "No design host plugin is connected");
  }
  throw new DesignPortError(
    "HOST_SELECTION_REQUIRED",
    "More than one design host is connected; pass host explicitly",
    { hosts: hosts.map((item) => item.host) },
  );
}

async function callBridge<T>(
  bridge: DesignPortBridge,
  host: HostKind | undefined,
  operation: string,
  payload: unknown,
) {
  try {
    return jsonResult(await bridge.request<T>(host, operation, payload));
  } catch (error) {
    return errorResult(error);
  }
}

export function createMcpServer(bridge: DesignPortBridge): McpServer {
  const server = new McpServer({
    name: "designport",
    version: "0.1.0",
  });

  server.registerTool(
    "design.list_hosts",
    {
      title: "List connected design hosts",
      description: "List connected Figma and Adobe XD DesignPort plugins.",
      inputSchema: {},
    },
    async () => jsonResult({ hosts: bridge.listHosts() }),
  );

  server.registerTool(
    "design.list_events",
    {
      title: "List design host events",
      description: "Read recent selection, document, and write status events from plugins.",
      inputSchema: hostInput.shape,
    },
    async ({ host }) => jsonResult({ events: bridge.listEvents(host) }),
  );

  server.registerTool(
    "design.get_capabilities",
    {
      title: "Get design host capabilities",
      description: "Return the active plugin capabilities for a design host.",
      inputSchema: hostInput.shape,
    },
    async ({ host }) =>
      callBridge(bridge, host, "get_capabilities", {}),
  );

  server.registerTool(
    "design.get_selection_context",
    {
      title: "Read selection context",
      description: "Return the current host selection normalized as DesignIR nodes.",
      inputSchema: hostInput.shape,
    },
    async ({ host }) =>
      callBridge(bridge, host, "get_selection_context", {}),
  );

  server.registerTool(
    "design.get_screen_context",
    {
      title: "Read screen context",
      description: "Return one screen/artboard and its normalized descendants.",
      inputSchema: screenContextInput.shape,
    },
    async ({ host, screenId }) =>
      callBridge(bridge, host, "get_screen_context", { screenId }),
  );

  server.registerTool(
    "design.get_visual_context",
    {
      title: "Read design visual context",
      description: "Render the selected node or screen as PNG image content and return its visual metadata.",
      inputSchema: visualInput.shape,
    },
    async ({ host, scope, screenId }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        return visualResult(await adapter.getVisualContext(scope, screenId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "design.export_ir",
    {
      title: "Export DesignIR",
      description: "Export the document, current selection, or one screen as DesignIR.",
      inputSchema: exportInput.shape,
    },
    async ({ host, scope, screenId }) =>
      callBridge(bridge, host, "export_ir", { scope, screenId }),
  );

  server.registerTool(
    "design.generate_code",
    {
      title: "Generate application code",
      description: "Export DesignIR from a host and generate a semantic starter implementation for web, React, Vue, Flutter Cupertino, SwiftUI, or Jetpack Compose. Layout metadata maps to flex, Row/Column, stacks, and fill-sized children where possible.",
      inputSchema: generateCodeInput.shape,
    },
    async ({ host, scope, screenId, target }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        const snapshot = await adapter.exportIR(scope, screenId);
        return jsonResult(generateCode(snapshot, target));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "design.get_design_context",
    {
      title: "Read complete design context",
      description: "Return design properties, a visual PNG, and generated target code together so an agent can reason from structure, appearance, and implementation.",
      inputSchema: designContextInput.shape,
    },
    async ({ host, scope, screenId, target, includeVisual }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        const snapshot = await adapter.exportIR(scope, screenId);
        const generated = generateCode(snapshot, target);
        const visual = includeVisual
          ? await adapter.getVisualContext(scope, screenId)
          : undefined;
        const content = [
          {
            type: "text" as const,
            text: JSON.stringify({
              properties: snapshot,
              visual: visual
                ? {
                    scope: visual.scope,
                    host: visual.host,
                    items: visual.items.map(({ data: _data, ...item }) => item),
                  }
                : null,
              code: {
                target: generated.target,
                files: Object.keys(generated.files),
                nodeCount: generated.nodeCount,
                screenCount: generated.screenCount,
              },
            }, null, 2),
          },
          ...(visual
            ? visual.items.map((item) => ({
                type: "image" as const,
                data: item.data,
                mimeType: item.mimeType,
              }))
            : []),
          ...Object.entries(generated.files).map(([name, source]) => ({
            type: "text" as const,
            text: `// ${name}\n${source}`,
          })),
        ];
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "design.create_screen",
    {
      title: "Create a design screen",
      description: "Create an artboard/screen through the active design host adapter.",
      inputSchema: screenInput.shape,
    },
    async ({ host, ...spec }) =>
      callBridge(bridge, host, "create_screen", spec),
  );

  server.registerTool(
    "design.create_component",
    {
      title: "Create a design component",
      description: "Create a component or symbol through the active host adapter.",
      inputSchema: componentInput.shape,
    },
    async ({ host, ...spec }) =>
      callBridge(bridge, host, "create_component", spec),
  );

  server.registerTool(
    "design.update_selection",
    {
      title: "Update the design selection",
      description: "Apply a normalized patch to the current host selection.",
      inputSchema: updateSelectionInput.shape,
    },
    async ({ host, patch }) =>
      callBridge(bridge, host, "update_selection", { patch }),
  );

  server.registerTool(
    "design.ping",
    {
      title: "Ping a design host",
      description: "Check that the selected plugin can receive bridge requests.",
      inputSchema: hostInput.shape,
    },
    async ({ host }) => callBridge(bridge, host, "ping", {}),
  );

  return server;
}

export function requireHost(value: unknown): HostKind {
  const parsed = hostKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new DesignPortError("INVALID_HOST", "Expected host to be figma or xd");
  }
  return parsed.data;
}
