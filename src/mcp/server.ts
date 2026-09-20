import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  componentSpecSchema,
  designPatchSchema,
  exportOptionsSchema,
  screenSpecSchema,
  hostKindSchema,
  captureScopeSchema,
  nodeTreeSpecSchema,
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
  sessionId: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
});

const screenInput = screenSpecSchema.extend({
  host: hostKindSchema.optional(),
  sessionId: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  expectedSnapshotId: z.string().min(1),
}).strict();

const componentInput = componentSpecSchema.extend({
  host: hostKindSchema.optional(),
  sessionId: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  expectedSnapshotId: z.string().min(1),
}).strict();

const nodeTreeInput = nodeTreeSpecSchema.extend({
  host: hostKindSchema.optional(),
  sessionId: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  expectedSnapshotId: z.string().min(1),
}).strict();

const updateSelectionInput = z.object({
  host: hostKindSchema.optional(),
  sessionId: z.string().min(1).optional(),
  captureSessionId: z.string().min(1),
  documentId: z.string().min(1).optional(),
  patch: designPatchSchema,
  targetIds: z.array(z.string().min(1)).min(1).max(2000),
  expectedSnapshotId: z.string().min(1),
}).strict();

const screenContextInput = hostInput.extend({
  screenId: z.string().min(1).optional(),
  ...exportOptionsSchema.shape,
});

const selectionContextInput = hostInput.extend({
  ...exportOptionsSchema.shape,
});

const exportInput = hostInput.extend({
  scope: captureScopeSchema.default("document"),
  screenId: z.string().min(1).optional(),
  ...exportOptionsSchema.shape,
});

const visualInput = hostInput.extend({
  scope: z.enum(["selection", "screen", "page"]).default("screen"),
  screenId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),
  maxImagePixels: z.number().int().positive().max(100000000).default(8000000),
  maxImageBytes: z.number().int().positive().max(50000000).default(12000000),
});

const designContextInput = visualInput.extend({
  ...exportOptionsSchema.shape,
  includeAudit: z.boolean().default(true),
});

const exportContextInput = hostInput.extend({
  scope: captureScopeSchema.default("screen"),
  screenId: z.string().min(1).optional(),
  ...exportOptionsSchema.shape,
});

const assetInput = hostInput.extend({
  artifactId: z.string().min(1),
  captureId: z.string().min(1),
  maxBytes: z.number().int().positive().max(50000000).default(4000000),
  kind: z.enum(["original", "rendered"]).default("original"),
});

const operationStatusInput = hostInput.extend({
  pendingId: z.string().min(1),
});

function jsonResult(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
        annotations: { audience: ["assistant" as const] },
      },
    ],
  };
}

function errorResult(error: unknown) {
  const normalized = asDesignPortError(error);
  const structuredContent = {
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    },
  };
  return {
    isError: true,
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
        annotations: { audience: ["assistant" as const] },
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
    structuredContent: metadata,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(metadata, null, 2),
        annotations: { audience: ["assistant" as const] },
      },
      ...visual.items.map((item) => ({
        type: "image" as const,
        data: item.data,
        mimeType: item.mimeType,
      })),
    ],
  };
}

function resolveHost(
  bridge: DesignPortBridge,
  value: HostKind | { host?: HostKind; sessionId?: string; documentId?: string } | undefined,
): { host?: HostKind; sessionId?: string; documentId?: string } {
  const selector = typeof value === "string" ? { host: value } : value ?? {};
  if (selector.sessionId || selector.documentId) return selector;
  if (selector.host) {
    const hosts = bridge.listHosts().filter((item) => item.host === selector.host);
    if (hosts.length === 1) {
      return {
        host: selector.host,
        sessionId: hosts[0]!.sessionId,
        ...(hosts[0]!.documentId ? { documentId: hosts[0]!.documentId } : {}),
      };
    }
    if (hosts.length === 0) throw new DesignPortError("HOST_NOT_CONNECTED", `No ${selector.host} plugin is connected`);
    throw new DesignPortError("HOST_SELECTION_REQUIRED", `More than one ${selector.host} session is connected; pass sessionId and documentId`);
  }
  const hosts = bridge.listHosts();
  if (hosts.length === 1) {
    return {
      host: hosts[0]!.host,
      sessionId: hosts[0]!.sessionId,
      ...(hosts[0]!.documentId ? { documentId: hosts[0]!.documentId } : {}),
    };
  }
  if (hosts.length === 0) {
    throw new DesignPortError("HOST_NOT_CONNECTED", "No design host plugin is connected");
  }
  throw new DesignPortError(
    "HOST_SELECTION_REQUIRED",
    "More than one design host is connected; pass host explicitly",
  { hosts: hosts.map((item) => ({ host: item.host, sessionId: item.sessionId, documentId: item.documentId })) },
  );
}

function selectorFor(host: HostKind | undefined, sessionId?: string, documentId?: string) {
  return {
    ...(host ? { host } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(documentId ? { documentId } : {}),
  };
}

async function callBridge<T>(
  bridge: DesignPortBridge,
  host: { host?: HostKind; sessionId?: string; documentId?: string } | HostKind | undefined,
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
    version: "0.5.0",
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
    async ({ host, sessionId, documentId }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "get_capabilities", {}),
  );

  server.registerTool(
    "design.get_selection_context",
    {
      title: "Read selection context",
      description: "Return the current selection as DesignIR with summary, structure, or full detail and optional pagination, delta, token, and asset controls.",
      inputSchema: selectionContextInput.shape,
    },
    async ({ host, sessionId, documentId, ...options }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "get_selection_context", {
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
    async ({ host, sessionId, documentId, screenId, ...options }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "get_screen_context", {
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
    async ({ host, sessionId, documentId, scope, screenId, pageId, maxImagePixels, maxImageBytes }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, selectorFor(host, sessionId, documentId)));
        return visualResult(await adapter.getVisualContext(scope, screenId, {
          ...(pageId ? { pageId } : {}),
          maxImagePixels,
          maxImageBytes,
        }));
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
    async ({ host, sessionId, documentId, scope, screenId, ...options }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "export_ir", {
        scope,
        screenId,
        options: exportOptionsSchema.parse(options),
      }),
  );

  server.registerTool(
    "design.get_asset",
    {
      title: "Retrieve a captured design asset",
      description: "Retrieve one bounded original or rendered asset by artifact and capture identity.",
      inputSchema: assetInput.shape,
    },
    async ({ host, sessionId, documentId, artifactId, captureId, maxBytes, kind }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "get_asset", {
        artifactId,
        captureId,
        maxBytes,
        kind,
      }),
  );

  server.registerTool(
    "design.get_operation_status",
    {
      title: "Read a design write status",
      description: "Read the status of a queued or completed host write operation.",
      inputSchema: operationStatusInput.shape,
    },
    async ({ host, sessionId, documentId, pendingId }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "get_operation_status", { pendingId }),
  );

  server.registerTool(
    "design.audit_context",
    {
      title: "Audit design context",
      description: "Report deterministic semantic, responsive, interaction, accessibility, and token issues in an exported design context.",
      inputSchema: exportContextInput.shape,
    },
    async ({ host, sessionId, documentId, scope, screenId, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, selectorFor(host, sessionId, documentId)));
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
    async ({ host, sessionId, documentId, scope, screenId, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, selectorFor(host, sessionId, documentId)));
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
    async ({ host, sessionId, documentId, scope, screenId, pageId, maxImagePixels, maxImageBytes, includeAudit, ...options }) => {
      try {
        const adapter = new BridgeHostAdapter(bridge, resolveHost(bridge, selectorFor(host, sessionId, documentId)));
        const normalizedOptions = exportOptionsSchema.parse(options);
        if (pageId) normalizedOptions.pageId = pageId;
        let snapshot;
        let visual;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          snapshot = await adapter.exportIR(scope, screenId, normalizedOptions);
          visual = await adapter.getVisualContext(scope, screenId, {
            ...(pageId ? { pageId } : {}),
            maxImagePixels,
            maxImageBytes,
          });
          if (visual.captureId === snapshot.captureId) break;
          if (attempt === 1) {
            throw new DesignPortError(
              "CAPTURE_INCONSISTENT",
              "Properties and visual evidence were captured from different host states",
              { propertyCaptureId: snapshot.captureId, visualCaptureId: visual.captureId, attempts: 2 },
            );
          }
        }
        if (!snapshot || !visual) throw new DesignPortError("CAPTURE_INCONSISTENT", "Host did not return a complete combined capture");
        const audit = includeAudit && snapshot.responseType !== "not-modified"
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
    async ({ host, sessionId, documentId, ...spec }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "create_screen", spec),
  );

  server.registerTool(
    "design.create_component",
    {
      title: "Create a design component",
      description: "Create a component or symbol through the active host adapter.",
      inputSchema: componentInput.shape,
    },
    async ({ host, sessionId, documentId, ...spec }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "create_component", spec),
  );

  server.registerTool(
    "design.create_node_tree",
    {
      title: "Create a bounded native node tree",
      description: "Create frames, text, rectangles, and components with explicit local references, nested parents, solid styling, and horizontal or vertical auto layout. Requires a complete expected snapshot and never uses the current selection.",
      inputSchema: nodeTreeInput.shape,
    },
    async ({ host, sessionId, documentId, ...spec }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "create_node_tree", spec),
  );

  server.registerTool(
    "design.update_selection",
    {
      title: "Update explicit design nodes",
      description: "Apply a normalized patch to explicit node IDs captured by the expected snapshot. sessionId selects the bridge connection; captureSessionId is the native session from snapshot.identity. Targets do not have to remain selected; the document, session, scope, and snapshot must still match.",
      inputSchema: updateSelectionInput.shape,
    },
    async ({ host, sessionId, captureSessionId, documentId, patch, targetIds, expectedSnapshotId }) =>
      callBridge(bridge, selectorFor(host, sessionId, documentId), "update_selection", {
        patch,
        targetIds,
        expectedSnapshotId,
        ...(documentId ? { documentId } : {}),
        sessionId: captureSessionId,
      }),
  );

  server.registerTool(
    "design.ping",
    {
      title: "Ping a design host",
      description: "Check that the selected plugin can receive bridge requests.",
      inputSchema: hostInput.shape,
    },
    async ({ host, sessionId, documentId }) => callBridge(bridge, selectorFor(host, sessionId, documentId), "ping", {}),
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
