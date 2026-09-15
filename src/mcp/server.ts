import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  componentSpecSchema,
  designPatchSchema,
  exportOptionsSchema,
  screenSpecSchema,
  hostKindSchema,
  type HostKind,
  visualContextSchema,
} from "../core/ir.js";
import { asDesignPortError, DesignPortError } from "../core/errors.js";
import { DesignPortBridge } from "../bridge/bridge-server.js";
import { BridgeHostAdapter } from "../core/adapter.js";
import { auditDesignContext, designAuditSchema } from "../core/audit.js";
import { buildDesignGraph, designGraphSchema } from "../core/graph.js";

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
  ...exportOptionsSchema.shape,
});

const selectionContextInput = hostInput.extend({
  ...exportOptionsSchema.shape,
});

const exportInput = hostInput.extend({
  scope: z.enum(["document", "selection", "screen"]).default("document"),
  screenId: z.string().min(1).optional(),
  ...exportOptionsSchema.shape,
});

const visualInput = hostInput.extend({
  scope: z.enum(["selection", "screen"]).default("screen"),
  screenId: z.string().min(1).optional(),
});

const designContextInput = visualInput.extend({
  ...exportOptionsSchema.shape,
  includeAudit: z.boolean().default(true),
});

const exportContextInput = hostInput.extend({
  scope: z.enum(["document", "selection", "screen"]).default("screen"),
  screenId: z.string().min(1).optional(),
  ...exportOptionsSchema.shape,
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
    version: "0.3.0",
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
      description: "Return the current selection as DesignIR with summary, structure, or full detail and optional pagination, delta, token, and asset controls.",
      inputSchema: selectionContextInput.shape,
    },
    async ({ host, ...options }) =>
      callBridge(bridge, host, "get_selection_context", {
        options: exportOptionsSchema.parse(options),
      }),
  );

  server.registerTool(
    "design.get_screen_context",
    {
      title: "Read screen context",
      description: "Return one screen/artboard as DesignIR with summary, structure, or full detail and optional pagination, delta, token, and asset controls.",
      inputSchema: screenContextInput.shape,
    },
    async ({ host, screenId, ...options }) =>
      callBridge(bridge, host, "get_screen_context", {
        screenId,
        options: exportOptionsSchema.parse(options),
      }),
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
      description: "Export the document, current selection, or one screen as DesignIR with detail modes, pagination, snapshot reuse, changed-only deltas, token, and asset controls.",
      inputSchema: exportInput.shape,
    },
    async ({ host, scope, screenId, ...options }) =>
      callBridge(bridge, host, "export_ir", {
        scope,
        screenId,
        options: exportOptionsSchema.parse(options),
      }),
  );

  server.registerTool(
    "design.audit_context",
    {
      title: "Audit design context",
      description: "Report deterministic semantic, responsive, interaction, accessibility, and token issues in an exported design context.",
      inputSchema: exportContextInput.shape,
    },
    async ({ host, scope, screenId, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        const snapshot = await adapter.exportIR(
          scope,
          screenId,
          exportOptionsSchema.parse({
            ...options,
            includeAssets: false,
            knownSnapshotId: undefined,
            changedOnly: false,
          }),
        );
        return jsonResult(designAuditSchema.parse(auditDesignContext(snapshot)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "design.get_graph",
    {
      title: "Read design component and interaction graph",
      description: "Return component/instance relationships, variant state values, screen viewports, and prototype interaction edges from a design context.",
      inputSchema: exportContextInput.shape,
    },
    async ({ host, scope, screenId, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        const snapshot = await adapter.exportIR(
          scope,
          screenId,
          exportOptionsSchema.parse({
            ...options,
            detail: options.detail === "full" ? "structure" : options.detail,
            includeAssets: false,
            knownSnapshotId: undefined,
            changedOnly: false,
          }),
        );
        return jsonResult(designGraphSchema.parse(buildDesignGraph(snapshot)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "design.get_design_context",
    {
      title: "Read complete design context",
      description: "Return host-neutral DesignIR properties, deterministic audit evidence, local image/vector assets, and a PNG visual reference together so an agent can reconstruct the interface in its own stack. Large snapshots can be paginated and assets/tokens can be limited.",
      inputSchema: designContextInput.shape,
    },
    async ({ host, scope, screenId, includeAudit, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, host));
        const normalizedOptions = exportOptionsSchema.parse(options);
        const snapshot = await adapter.exportIR(scope, screenId, normalizedOptions);
        const visual = await adapter.getVisualContext(scope, screenId);
        const audit = includeAudit && snapshot.unchanged !== true
          ? designAuditSchema.parse(auditDesignContext(snapshot))
          : undefined;
        const content = [
          {
            type: "text" as const,
            text: JSON.stringify({
              properties: snapshot,
              ...(audit ? { audit } : {}),
              visual: {
                scope: visual.scope,
                host: visual.host,
                items: visual.items.map(({ data: _data, ...item }) => item),
              },
            }, null, 2),
          },
          ...visual.items.map((item) => ({
            type: "image" as const,
            data: item.data,
            mimeType: item.mimeType,
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
