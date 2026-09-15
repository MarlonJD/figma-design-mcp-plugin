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
  documentId: z.string().optional(),
  documentName: z.string().optional(),
  capabilities: hostCapabilitiesSchema.optional(),
});

export const requestMessageSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.unknown(),
});

export const responseMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: protocolErrorSchema.optional(),
});

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
  payload: z.unknown(),
});

export const helloAckMessageSchema = z.object({
  type: z.literal("hello_ack"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  serverVersion: z.string().min(1),
});

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
