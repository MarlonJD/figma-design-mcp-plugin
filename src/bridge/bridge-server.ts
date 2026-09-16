import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import {
  type HostCapabilities,
  type HostKind,
  PROTOCOL_VERSION,
} from "../core/ir.js";
import { DesignPortError } from "../core/errors.js";
import {
  decodeMessage,
  encodeMessage,
  errorResponse,
  type EventMessage,
  type HelloMessage,
  type ProtocolMessage,
  type ResponseMessage,
} from "../core/protocol.js";
import {
  operationDefinition,
  parseOperationOutput,
  type OperationName,
} from "../core/operations.js";

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_MESSAGE_BYTES = 12_000_000;
const DEFAULT_MAX_EVENT_LOG = 100;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export interface BridgeOptions {
  host: string;
  port: number;
  requestTimeoutMs: number;
  serverVersion: string;
  pairingToken?: string;
  maxConnections?: number;
  maxPendingRequests?: number;
  maxMessageBytes?: number;
  handshakeTimeoutMs?: number;
  maxEventLog?: number;
}

export interface HostSelector {
  host?: HostKind;
  sessionId?: string;
  documentId?: string;
}

export interface HostSnapshot {
  sessionId: string;
  host: HostKind;
  pluginVersion: string;
  documentId: string | null;
  documentName: string | null;
  capabilities: HostCapabilities | null;
  connectedAt: string;
}

export interface HostEventRecord {
  id: string;
  receivedAt: string;
  sessionId: string;
  host: HostKind;
  documentId: string | null;
  sequence: number;
  event: EventMessage["event"];
  payload: EventMessage["payload"];
}

interface PendingRequest {
  operation: OperationName;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface HostSession {
  id: string;
  socket: WebSocket;
  host: HostKind | null;
  pluginVersion: string | null;
  documentId: string | null;
  documentName: string | null;
  capabilities: HostCapabilities | null;
  connectedAt: string;
  pending: Map<string, PendingRequest>;
  handshakeTimer: NodeJS.Timeout;
  lastEventSequence: number;
}

export interface BridgeEvents {
  hostConnected: (snapshot: HostSnapshot) => void;
  hostDisconnected: (snapshot: HostSnapshot | null) => void;
  hostEvent: (snapshot: HostSnapshot, message: EventMessage) => void;
}

function rawDataBytes(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function normalizeSelector(value: HostKind | HostSelector | undefined): HostSelector {
  return typeof value === "string" ? { host: value } : value ?? {};
}

export class DesignPortBridge extends EventEmitter {
  private readonly options: Required<Pick<
    BridgeOptions,
    | "host"
    | "port"
    | "requestTimeoutMs"
    | "serverVersion"
    | "maxConnections"
    | "maxPendingRequests"
    | "maxMessageBytes"
    | "handshakeTimeoutMs"
    | "maxEventLog"
  >> & { pairingToken: string };
  private readonly sessions = new Map<string, HostSession>();
  private readonly eventLog: HostEventRecord[] = [];
  private server: WebSocketServer | null = null;

  constructor(options: BridgeOptions) {
    super();
    if (!isLoopbackHost(options.host)) {
      throw new DesignPortError(
        "LOOPBACK_ONLY",
        "DesignPort only accepts loopback bridge hosts",
        { host: options.host },
      );
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new DesignPortError("INVALID_PORT", "Bridge port must be an integer between 0 and 65535");
    }
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new DesignPortError("INVALID_TIMEOUT", "Request timeout must be a positive integer");
    }
    const pairingToken = options.pairingToken ?? "designport-local-pairing";
    if (pairingToken.length < 16) {
      throw new DesignPortError("PAIRING_TOKEN_TOO_SHORT", "Pairing token must contain at least 16 characters");
    }
    this.options = {
      host: options.host,
      port: options.port,
      requestTimeoutMs: options.requestTimeoutMs,
      serverVersion: options.serverVersion,
      pairingToken,
      maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      maxPendingRequests: options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      maxEventLog: options.maxEventLog ?? DEFAULT_MAX_EVENT_LOG,
    };
    if (!Number.isInteger(this.options.maxConnections) || this.options.maxConnections < 1) {
      throw new DesignPortError("INVALID_CONNECTION_LIMIT", "maxConnections must be a positive integer");
    }
    if (!Number.isInteger(this.options.maxPendingRequests) || this.options.maxPendingRequests < 1) {
      throw new DesignPortError("INVALID_PENDING_LIMIT", "maxPendingRequests must be a positive integer");
    }
    if (!Number.isInteger(this.options.maxMessageBytes) || this.options.maxMessageBytes < 1024) {
      throw new DesignPortError("INVALID_MESSAGE_LIMIT", "maxMessageBytes must be at least 1024 bytes");
    }
    if (!Number.isInteger(this.options.handshakeTimeoutMs) || this.options.handshakeTimeoutMs < 1) {
      throw new DesignPortError("INVALID_HANDSHAKE_TIMEOUT", "handshakeTimeoutMs must be a positive integer");
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return this.address();

    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      maxPayload: this.options.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.server = server;
    server.on("connection", (socket) => {
      if (this.sessions.size >= this.options.maxConnections) {
        socket.close(1013, "DesignPort connection limit reached");
        return;
      }
      this.attachSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });

    return this.address();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;

    for (const session of [...this.sessions.values()]) {
      this.disconnect(session, "Bridge stopped");
      if (session.socket.readyState !== WebSocket.CLOSED) session.socket.terminate();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      return { host: this.options.host, port: this.options.port };
    }
    const info = address as AddressInfo;
    return { host: info.address, port: info.port };
  }

  listHosts(): HostSnapshot[] {
    return [...this.sessions.values()]
      .filter((session): session is HostSession & { host: HostKind } => session.host !== null)
      .map((session) => this.snapshot(session));
  }

  listEvents(host?: HostKind): HostEventRecord[] {
    return this.eventLog.filter((event) => !host || event.host === host);
  }

  async request<T>(
    selector: HostKind | HostSelector | undefined,
    operation: string,
    payload: unknown,
  ): Promise<T> {
    let definition;
    try {
      definition = operationDefinition(operation);
    } catch (error) {
      throw new DesignPortError("UNSUPPORTED_OPERATION", String(error));
    }
    let parsedPayload: unknown;
    try {
      parsedPayload = definition.input.parse(payload);
    } catch (error) {
      throw new DesignPortError("HOST_REQUEST_INVALID", `Invalid input for ${operation}`, error);
    }

    const session = this.selectSession(selector, definition.capability);
    if (session.pending.size >= this.options.maxPendingRequests) {
      throw new DesignPortError(
        "HOST_PENDING_LIMIT",
        `Host pending request limit reached (${this.options.maxPendingRequests})`,
        { host: session.host, sessionId: session.id },
      );
    }
    const requestId = randomUUID();
    const message = { type: "request" as const, requestId, operation, payload: parsedPayload };
    const encoded = encodeMessage(message);
    if (Buffer.byteLength(encoded) > this.options.maxMessageBytes) {
      throw new DesignPortError("PAYLOAD_TOO_LARGE", `Request ${operation} exceeds the bridge payload limit`);
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(new DesignPortError(
          "HOST_REQUEST_TIMEOUT",
          `Host did not answer ${operation} within ${this.options.requestTimeoutMs}ms`,
          { host: session.host, operation, requestId },
        ));
      }, this.options.requestTimeoutMs);
      session.pending.set(requestId, {
        operation: operation as OperationName,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        session.socket.send(encoded, (error?: Error) => {
          if (!error) return;
          const pending = session.pending.get(requestId);
          if (!pending) return;
          session.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new DesignPortError("HOST_SEND_FAILED", `Could not send ${operation} to host`, error));
        });
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(requestId);
        reject(new DesignPortError("HOST_SEND_FAILED", `Could not send ${operation} to host`, error));
      }
    });
  }

  private attachSocket(socket: WebSocket): void {
    const session: HostSession = {
      id: randomUUID(),
      socket,
      host: null,
      pluginVersion: null,
      documentId: null,
      documentName: null,
      capabilities: null,
      connectedAt: new Date().toISOString(),
      pending: new Map(),
      handshakeTimer: setTimeout(() => {
        this.closeWithError(session, "HANDSHAKE_TIMEOUT", "Host handshake deadline exceeded");
      }, this.options.handshakeTimeoutMs),
      lastEventSequence: 0,
    };
    this.sessions.set(session.id, session);

    socket.on("message", (data) => {
      if (rawDataBytes(data) > this.options.maxMessageBytes) {
        this.closeWithError(session, "PAYLOAD_TOO_LARGE", "Host message exceeds the bridge payload limit");
        return;
      }
      this.handleMessage(session, data);
    });
    socket.on("close", () => this.disconnect(session, "Socket closed"));
    socket.on("error", () => this.disconnect(session, "Socket error"));
  }

  private handleMessage(session: HostSession, data: RawData): void {
    let message: ProtocolMessage;
    try {
      message = decodeMessage(data.toString());
    } catch (error) {
      this.closeWithError(session, "INVALID_MESSAGE", "Invalid DesignPort protocol message", error);
      return;
    }

    if (message.type === "hello") {
      this.handleHello(session, message);
      return;
    }
    if (session.host === null) {
      this.closeWithError(session, "HANDSHAKE_REQUIRED", "Send an authenticated hello before other messages");
      return;
    }
    if (message.type === "response") {
      this.handleResponse(session, message);
      return;
    }
    if (message.type === "event") {
      if (message.payload.sequence <= session.lastEventSequence) {
        this.closeWithError(session, "INVALID_EVENT_SEQUENCE", "Host event sequence must increase monotonically");
        return;
      }
      session.lastEventSequence = message.payload.sequence;
      const snapshot = this.snapshot(session as HostSession & { host: HostKind });
      const record: HostEventRecord = {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        sessionId: session.id,
        host: snapshot.host,
        documentId: snapshot.documentId,
        sequence: message.payload.sequence,
        event: message.event,
        payload: message.payload,
      };
      this.eventLog.push(record);
      while (this.eventLog.length > this.options.maxEventLog) this.eventLog.shift();
      this.emit("hostEvent", snapshot, message);
      return;
    }
    if (message.type === "hello_ack" || message.type === "request") {
      this.closeWithError(session, "UNEXPECTED_MESSAGE", `Unexpected ${message.type} from host`);
    }
  }

  private handleHello(session: HostSession, message: HelloMessage): void {
    if (session.host !== null) {
      this.closeWithError(session, "DUPLICATE_HANDSHAKE", "Only one hello is permitted per connection");
      return;
    }
    if (message.pairingToken !== this.options.pairingToken) {
      this.closeWithError(session, "PAIRING_FAILED", "Host pairing authentication failed");
      return;
    }
    clearTimeout(session.handshakeTimer);
    session.host = message.host;
    session.pluginVersion = message.pluginVersion;
    session.documentId = message.documentId ?? null;
    session.documentName = message.documentName ?? null;
    session.capabilities = message.capabilities ?? null;

    try {
      this.send(session, {
        type: "hello_ack",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: session.id,
        serverVersion: this.options.serverVersion,
      });
    } catch (error) {
      this.closeWithError(session, "HOST_SEND_FAILED", "Could not send the host handshake acknowledgement", error);
      return;
    }
    this.emit("hostConnected", this.snapshot(session as HostSession & { host: HostKind }));
  }

  private handleResponse(session: HostSession, message: ResponseMessage): void {
    const pending = session.pending.get(message.requestId);
    if (!pending) return;
    session.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(new DesignPortError(message.error.code, message.error.message, message.error.details));
      return;
    }
    try {
      pending.resolve(parseOperationOutput(pending.operation, message.result));
    } catch (error) {
      pending.reject(new DesignPortError(
        "HOST_RESPONSE_INVALID",
        `Host returned an invalid response for ${pending.operation}`,
        error,
      ));
    }
  }

  private selectSession(
    selectorValue: HostKind | HostSelector | undefined,
    capability: string,
  ): HostSession & { host: HostKind } {
    const selector = normalizeSelector(selectorValue);
    const connected = [...this.sessions.values()].filter(
      (session): session is HostSession & { host: HostKind } => session.host !== null,
    );
    const matches = connected.filter((session) => (
      (!selector.host || session.host === selector.host)
      && (!selector.sessionId || session.id === selector.sessionId)
      && (!selector.documentId || session.documentId === selector.documentId)
    ));
    if (matches.length === 0) {
      throw new DesignPortError(
        "HOST_NOT_CONNECTED",
        selector.host ? `No ${selector.host} plugin matches the requested session` : "No design host plugin is connected",
        selector,
      );
    }
    if (matches.length > 1) {
      throw new DesignPortError(
        "HOST_SELECTION_REQUIRED",
        "More than one design host session matches; pass sessionId and documentId explicitly",
        { hosts: matches.map((item) => ({ host: item.host, sessionId: item.id, documentId: item.documentId })) },
      );
    }
    const selected = matches[0]!;
    if (!(selected.capabilities?.operations ?? []).includes(capability)) {
      throw new DesignPortError(
        "HOST_CAPABILITY_REQUIRED",
        `Host does not advertise the ${capability} operation`,
        { host: selected.host, capability },
      );
    }
    return selected;
  }

  private snapshot(session: HostSession & { host: HostKind }): HostSnapshot {
    return {
      sessionId: session.id,
      host: session.host,
      pluginVersion: session.pluginVersion ?? "unknown",
      documentId: session.documentId,
      documentName: session.documentName,
      capabilities: session.capabilities,
      connectedAt: session.connectedAt,
    };
  }

  private send(session: HostSession, message: ProtocolMessage): void {
    const encoded = encodeMessage(message);
    if (Buffer.byteLength(encoded) > this.options.maxMessageBytes) {
      throw new DesignPortError("PAYLOAD_TOO_LARGE", "Bridge message exceeds the configured payload limit");
    }
    session.socket.send(encoded);
  }

  private disconnect(session: HostSession, reason: string): void {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    clearTimeout(session.handshakeTimer);
    const snapshot = session.host === null
      ? null
      : this.snapshot(session as HostSession & { host: HostKind });
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DesignPortError("HOST_DISCONNECTED", `Design host disconnected: ${reason}`, {
        host: session.host,
        sessionId: session.id,
      }));
    }
    session.pending.clear();
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.close(1000, reason.slice(0, 120));
    }
    this.emit("hostDisconnected", snapshot);
  }

  private closeWithError(
    session: HostSession,
    code: string,
    message: string,
    details?: unknown,
  ): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      try {
        this.send(session, errorResponse("protocol", { code, message, details }));
      } catch {
        // The socket may have closed between parsing and the error response.
      }
      session.socket.close(1002, message.slice(0, 120));
    }
  }
}
