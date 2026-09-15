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
  okResponse,
  type EventMessage,
  type HelloMessage,
  type ProtocolMessage,
  type ResponseMessage,
} from "../core/protocol.js";

export interface BridgeOptions {
  host: string;
  port: number;
  requestTimeoutMs: number;
  serverVersion: string;
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
  host: HostKind;
  event: EventMessage["event"];
  payload: unknown;
}

interface PendingRequest {
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
}

export interface BridgeEvents {
  hostConnected: (snapshot: HostSnapshot) => void;
  hostDisconnected: (snapshot: HostSnapshot | null) => void;
  hostEvent: (snapshot: HostSnapshot, message: EventMessage) => void;
}

export class DesignPortBridge extends EventEmitter {
  private readonly options: BridgeOptions;
  private readonly sessions = new Map<string, HostSession>();
  private readonly activeByHost = new Map<HostKind, string>();
  private readonly eventLog: HostEventRecord[] = [];
  private server: WebSocketServer | null = null;

  constructor(options: BridgeOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      return this.address();
    }

    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
    });
    this.server = server;
    server.on("connection", (socket) => this.attachSocket(socket));

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
    if (!server) {
      return;
    }

    for (const session of [...this.sessions.values()]) {
      this.disconnect(session, "Bridge stopped");
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
    host: HostKind | undefined,
    operation: string,
    payload: unknown,
  ): Promise<T> {
    const session = this.selectSession(host);
    const requestId = randomUUID();
    const message = {
      type: "request" as const,
      requestId,
      operation,
      payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(
          new DesignPortError(
            "HOST_REQUEST_TIMEOUT",
            `Host did not answer ${operation} within ${this.options.requestTimeoutMs}ms`,
            { host: session.host, operation, requestId },
          ),
        );
      }, this.options.requestTimeoutMs);

      session.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        session.socket.send(encodeMessage(message));
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(requestId);
        reject(error);
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
    };
    this.sessions.set(session.id, session);

    socket.on("message", (data) => this.handleMessage(session, data));
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
      this.closeWithError(session, "HANDSHAKE_REQUIRED", "Send hello before other messages");
      return;
    }

    if (message.type === "response") {
      this.handleResponse(session, message);
      return;
    }

    if (message.type === "event") {
      const snapshot = this.snapshot(session as HostSession & { host: HostKind });
      const record: HostEventRecord = {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        host: snapshot.host,
        event: message.event,
        payload: message.payload,
      };
      this.eventLog.push(record);
      if (this.eventLog.length > 100) {
        this.eventLog.shift();
      }
      this.emit("hostEvent", snapshot, message);
      return;
    }

    if (message.type === "hello_ack" || message.type === "request") {
      this.closeWithError(session, "UNEXPECTED_MESSAGE", `Unexpected ${message.type} from host`);
    }
  }

  private handleHello(session: HostSession, message: HelloMessage): void {
    const previousSessionId = this.activeByHost.get(message.host);
    if (previousSessionId && previousSessionId !== session.id) {
      const previous = this.sessions.get(previousSessionId);
      if (previous) {
        this.disconnect(previous, "Superseded by a newer host session");
      }
    }

    session.host = message.host;
    session.pluginVersion = message.pluginVersion;
    session.documentId = message.documentId ?? null;
    session.documentName = message.documentName ?? null;
    session.capabilities = message.capabilities ?? null;
    this.activeByHost.set(message.host, session.id);

    session.socket.send(
      encodeMessage({
        type: "hello_ack",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: session.id,
        serverVersion: this.options.serverVersion,
      }),
    );
    this.emit("hostConnected", this.snapshot(session as HostSession & { host: HostKind }));
  }

  private handleResponse(session: HostSession, message: ResponseMessage): void {
    const pending = session.pending.get(message.requestId);
    if (!pending) {
      return;
    }

    session.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    const error = message.error;
    pending.reject(
      new DesignPortError(
        error?.code ?? "HOST_ERROR",
        error?.message ?? "The host rejected the request",
        error?.details,
      ),
    );
  }

  private selectSession(host: HostKind | undefined): HostSession & { host: HostKind } {
    if (host) {
      const sessionId = this.activeByHost.get(host);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session || session.host === null) {
        throw new DesignPortError("HOST_NOT_CONNECTED", `No ${host} plugin is connected`, { host });
      }
      return session as HostSession & { host: HostKind };
    }

    const connected = this.listHosts();
    if (connected.length === 0) {
      throw new DesignPortError("HOST_NOT_CONNECTED", "No design host plugin is connected");
    }
    if (connected.length > 1) {
      throw new DesignPortError(
        "HOST_SELECTION_REQUIRED",
        "More than one design host is connected; pass host explicitly",
        { hosts: connected.map((item) => item.host) },
      );
    }

    const selected = connected[0];
    if (!selected) {
      throw new DesignPortError("HOST_NOT_CONNECTED", "The selected design host disconnected");
    }
    const session = this.sessions.get(selected.sessionId);
    if (!session || session.host === null) {
      throw new DesignPortError("HOST_NOT_CONNECTED", "The selected design host disconnected");
    }
    return session as HostSession & { host: HostKind };
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

  private disconnect(session: HostSession, reason: string): void {
    if (!this.sessions.has(session.id)) {
      return;
    }

    this.sessions.delete(session.id);
    if (session.host && this.activeByHost.get(session.host) === session.id) {
      this.activeByHost.delete(session.host);
    }

    const snapshot = session.host === null ? null : this.snapshot(session as HostSession & { host: HostKind });
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new DesignPortError("HOST_DISCONNECTED", `Design host disconnected: ${reason}`, {
          host: session.host,
        }),
      );
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
        session.socket.send(
          encodeMessage(
            errorResponse("protocol", {
              code,
              message,
              details,
            }),
          ),
        );
      } catch {
        // The socket may have closed between parsing and the error response.
      }
      session.socket.close(1002, message.slice(0, 120));
    }
  }
}
