import { z } from "zod";
import {
  captureScopeSchema,
  componentSpecSchema,
  contextIRSchema,
  designAssetSchema,
  designIRSchema,
  designPatchSchema,
  exportOptionsSchema,
  hostCapabilitiesSchema,
  hostKindSchema,
  nodeTreeSpecSchema,
  screenSpecSchema,
  visualContextSchema,
} from "./ir.js";

const emptyInputSchema = z.object({}).strict();

const exportPayloadSchema = z.object({
  scope: captureScopeSchema,
  screenId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),
  options: exportOptionsSchema,
}).strict();

const selectionContextInputSchema = z.object({
  options: exportOptionsSchema,
}).strict();

const screenContextInputSchema = z.object({
  screenId: z.string().min(1).optional(),
  options: exportOptionsSchema,
}).strict();

const visualContextInputSchema = z.object({
  scope: z.enum(["selection", "screen", "page"]),
  screenId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),
  maxImagePixels: z.number().int().positive().max(100000000).default(8000000),
  maxImageBytes: z.number().int().positive().max(50000000).default(12000000),
}).strict();

const writeStateSchema = z.object({
  expectedSnapshotId: z.string().min(1),
  documentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const createScreenInputSchema = screenSpecSchema.extend(writeStateSchema.shape).strict();
const createComponentInputSchema = componentSpecSchema.extend(writeStateSchema.shape).strict();
const createNodeTreeInputSchema = nodeTreeSpecSchema.extend(writeStateSchema.shape).strict();
const updateSelectionInputSchema = z.object({
  patch: designPatchSchema,
  targetIds: z.array(z.string().min(1)).min(1).max(2000),
  ...writeStateSchema.shape,
}).strict();

const assetInputSchema = z.object({
  artifactId: z.string().min(1),
  captureId: z.string().min(1),
  maxBytes: z.number().int().positive().max(50000000).default(4000000),
  kind: z.enum(["original", "rendered"]).default("original"),
}).strict();

const operationStatusSchema = z.object({
  pendingId: z.string().min(1),
}).strict();

const pingOutputSchema = z.object({
  ok: z.literal(true),
  host: hostKindSchema,
  at: z.string().datetime({ offset: true }),
}).strict();

const writeOutputSchema = z.object({
  status: z.enum(["applied", "queued", "cancelled"]),
  pendingId: z.string().min(1).optional(),
  requiresUserAction: z.boolean().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  node: z.unknown().optional(),
  nodes: z.array(z.unknown()).optional(),
  createdNodeIds: z.array(z.string().min(1)).optional(),
  rootNodeIds: z.array(z.string().min(1)).optional(),
  referenceMap: z.record(z.string(), z.string()).optional(),
  kind: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).strict();

const nodeTreeOutputSchema = writeOutputSchema.extend({
  status: z.literal("applied"),
  createdNodeIds: z.array(z.string().min(1)).min(1),
  rootNodeIds: z.array(z.string().min(1)).min(1),
  referenceMap: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0),
}).strict();

const assetOutputSchema = designAssetSchema.extend({
  artifactId: z.string().min(1),
  captureId: z.string().min(1),
  data: z.string().min(1),
}).strict();

const operationStatusOutputSchema = z.object({
  pendingId: z.string().min(1),
  status: z.enum(["queued", "applied", "failed", "cancelled", "expired"]),
  operation: z.string().min(1),
  message: z.string().min(1).optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
}).strict();

export type OperationAccess = "read" | "write";

export interface OperationDefinition {
  access: OperationAccess;
  capability: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
}

export const operationRegistry = {
  ping: { access: "read", capability: "ping", input: emptyInputSchema, output: pingOutputSchema },
  get_capabilities: {
    access: "read",
    capability: "get_capabilities",
    input: emptyInputSchema,
    output: hostCapabilitiesSchema,
  },
  get_selection_context: {
    access: "read",
    capability: "get_selection_context",
    input: selectionContextInputSchema,
    output: contextIRSchema,
  },
  get_screen_context: {
    access: "read",
    capability: "get_screen_context",
    input: screenContextInputSchema,
    output: contextIRSchema,
  },
  get_visual_context: {
    access: "read",
    capability: "get_visual_context",
    input: visualContextInputSchema,
    output: visualContextSchema,
  },
  export_ir: {
    access: "read",
    capability: "export_ir",
    input: exportPayloadSchema,
    output: z.union([designIRSchema, contextIRSchema]),
  },
  get_asset: {
    access: "read",
    capability: "get_asset",
    input: assetInputSchema,
    output: assetOutputSchema,
  },
  get_operation_status: {
    access: "read",
    capability: "get_operation_status",
    input: operationStatusSchema,
    output: operationStatusOutputSchema,
  },
  create_screen: {
    access: "write",
    capability: "create_screen",
    input: createScreenInputSchema,
    output: writeOutputSchema,
  },
  create_component: {
    access: "write",
    capability: "create_component",
    input: createComponentInputSchema,
    output: writeOutputSchema,
  },
  create_node_tree: {
    access: "write",
    capability: "create_node_tree",
    input: createNodeTreeInputSchema,
    output: nodeTreeOutputSchema,
  },
  update_selection: {
    access: "write",
    capability: "update_selection",
    input: updateSelectionInputSchema,
    output: writeOutputSchema,
  },
} satisfies Record<string, OperationDefinition>;

export type OperationName = keyof typeof operationRegistry;

export function operationDefinition(operation: string): OperationDefinition {
  const definition = operationRegistry[operation as OperationName];
  if (!definition) {
    throw new Error(`Unsupported DesignPort operation: ${operation}`);
  }
  return definition;
}

export function parseOperationInput(operation: string, payload: unknown): unknown {
  return operationDefinition(operation).input.parse(payload);
}

export function parseOperationOutput(operation: string, result: unknown): unknown {
  return operationDefinition(operation).output.parse(result);
}
