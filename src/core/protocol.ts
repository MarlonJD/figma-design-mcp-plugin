import { z } from "zod";
import {
  PROTOCOL_VERSION,
  designIRSchema,
  hostCapabilitiesSchema,
  hostKindSchema,
} from "./ir.js";

export const protocolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  host: hostKindSchema,
  pluginVersion: z.string().min(1),
  pairingToken: z.string().min(1),
  documentId: z.string().optional(),
  documentName: z.string().optional(),
  capabilities: hostCapabilitiesSchema.optional(),
}).strict();

export const requestMessageSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.unknown(),
}).strict();

const responseSuccessMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
}).strict();

const responseErrorMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.literal(false),
  error: protocolErrorSchema,
}).strict();

export const responseMessageSchema = z.discriminatedUnion("ok", [
  responseSuccessMessageSchema,
  responseErrorMessageSchema,
]);

export const hostEventPayloadSchema = z.object({
  sequence: z.number().int().positive(),
  documentId: z.string().min(1),
  documentRevision: z.number().int().nonnegative(),
  selectionRevision: z.number().int().nonnegative(),
  affectedNodeIds: z.array(z.string().min(1)).max(200).default([]),
  removedNodeIds: z.array(z.string().min(1)).max(200).default([]),
  status: z.string().min(1).max(160).optional(),
  operation: z.string().min(1).max(80).optional(),
  pendingId: z.string().min(1).max(160).optional(),
  requestId: z.string().min(1).max(160).optional(),
  errorCode: z.string().min(1).max(80).optional(),
}).strict();

export const eventMessageSchema = z.object({
  type: z.literal("event"),
  event: z.enum([
    "selection.changed",
    "document.changed",
    "write.queued",
    "write.applied",
    "write.failed",
    "status",
  ]),
  payload: hostEventPayloadSchema,
}).strict();

export const helloAckMessageSchema = z.object({
  type: z.literal("hello_ack"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  serverVersion: z.string().min(1),
}).strict();

export const protocolMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  requestMessageSchema,
  responseMessageSchema,
  eventMessageSchema,
  helloAckMessageSchema,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type RequestMessage = z.infer<typeof requestMessageSchema>;
export type ResponseMessage = z.infer<typeof responseMessageSchema>;
export type EventMessage = z.infer<typeof eventMessageSchema>;
export type HelloAckMessage = z.infer<typeof helloAckMessageSchema>;
export type ProtocolMessage = z.infer<typeof protocolMessageSchema>;

export function encodeMessage(message: ProtocolMessage | RequestMessage): string {
  return JSON.stringify(message);
}

export function decodeMessage(data: unknown): ProtocolMessage {
  const text = typeof data === "string" ? data : String(data);
  const json: unknown = JSON.parse(text);
  return protocolMessageSchema.parse(json);
}

export function okResponse(
  requestId: string,
  result: unknown,
): ResponseMessage {
  return { type: "response", requestId, ok: true, result };
}

export function errorResponse(
  requestId: string,
  error: ProtocolError,
): ResponseMessage {
  return { type: "response", requestId, ok: false, error };
}

export function isDesignIR(value: unknown): boolean {
  return designIRSchema.safeParse(value).success;
}
