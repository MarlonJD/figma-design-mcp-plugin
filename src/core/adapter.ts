import { z } from "zod";
import {
  componentSpecSchema,
  contextIRSchema,
  designIRSchema,
  designPatchSchema,
  hostCapabilitiesSchema,
  type ComponentSpec,
  type ContextIR,
  type DesignIR,
  type DesignPatch,
  type HostCapabilities,
  type HostKind,
  type ExportOptions,
  type VisualContext,
  exportOptionsSchema,
  screenSpecSchema,
  type ScreenSpec,
  visualContextSchema,
} from "./ir.js";
import { DesignPortBridge, type HostSelector } from "../bridge/bridge-server.js";

export interface DesignHostAdapter {
  readonly host: HostKind | HostSelector;
  getCapabilities(): Promise<HostCapabilities>;
  getSelectionContext(options?: Partial<ExportOptions>): Promise<ContextIR>;
  getScreenContext(screenId?: string, options?: Partial<ExportOptions>): Promise<ContextIR>;
  getVisualContext(
    scope: "selection" | "screen" | "page",
    screenId?: string,
    options?: { pageId?: string; maxImagePixels?: number; maxImageBytes?: number },
  ): Promise<VisualContext>;
  exportIR(
    scope: "document" | "page" | "selection" | "screen",
    screenId?: string,
    options?: Partial<ExportOptions>,
  ): Promise<DesignIR | ContextIR>;
  createScreen(spec: ScreenSpec & { expectedSnapshotId: string }): Promise<unknown>;
  createComponent(spec: ComponentSpec & { expectedSnapshotId: string }): Promise<unknown>;
  updateSelection(payload: {
    patch: DesignPatch;
    targetIds: string[];
    expectedSnapshotId: string;
    documentId?: string;
    sessionId?: string;
  }): Promise<unknown>;
}

function optionsPayload(options?: Partial<ExportOptions>): { options: ExportOptions } {
  return { options: exportOptionsSchema.parse(options ?? {}) };
}

export class BridgeHostAdapter implements DesignHostAdapter {
  constructor(
    private readonly bridge: DesignPortBridge,
    readonly host: HostKind | HostSelector,
  ) {}

  async getCapabilities(): Promise<HostCapabilities> {
    return hostCapabilitiesSchema.parse(await this.bridge.request(this.host, "get_capabilities", {}));
  }

  async getSelectionContext(options?: Partial<ExportOptions>): Promise<ContextIR> {
    return contextIRSchema.parse(await this.bridge.request(
      this.host,
      "get_selection_context",
      optionsPayload(options),
    ));
  }

  async getScreenContext(screenId?: string, options?: Partial<ExportOptions>): Promise<ContextIR> {
    const payload = { ...(screenId ? { screenId } : {}), ...optionsPayload(options) };
    return contextIRSchema.parse(await this.bridge.request(this.host, "get_screen_context", payload));
  }

  async getVisualContext(
    scope: "selection" | "screen" | "page",
    screenId?: string,
    options?: { pageId?: string; maxImagePixels?: number; maxImageBytes?: number },
  ): Promise<VisualContext> {
    const payload = {
      scope,
      ...(screenId ? { screenId } : {}),
      ...(options?.pageId ? { pageId: options.pageId } : {}),
      ...(options?.maxImagePixels ? { maxImagePixels: options.maxImagePixels } : {}),
      ...(options?.maxImageBytes ? { maxImageBytes: options.maxImageBytes } : {}),
    };
    return visualContextSchema.parse(await this.bridge.request(this.host, "get_visual_context", payload));
  }

  async exportIR(
    scope: "document" | "page" | "selection" | "screen",
    screenId?: string,
    options?: Partial<ExportOptions>,
  ): Promise<DesignIR | ContextIR> {
    const normalizedOptions = exportOptionsSchema.parse(options ?? {});
    const payload = {
      scope,
      ...(screenId ? { screenId } : {}),
      ...(normalizedOptions.pageId ? { pageId: normalizedOptions.pageId } : {}),
      options: normalizedOptions,
    };
    const result = await this.bridge.request(this.host, "export_ir", payload);
    return scope === "document" ? designIRSchema.parse(result) : contextIRSchema.parse(result);
  }

  async createScreen(spec: ScreenSpec & { expectedSnapshotId: string }): Promise<unknown> {
    return this.bridge.request(this.host, "create_screen", screenSpecSchema.extend({
      expectedSnapshotId: z.string().min(1),
    }).parse(spec));
  }

  async createComponent(spec: ComponentSpec & { expectedSnapshotId: string }): Promise<unknown> {
    return this.bridge.request(this.host, "create_component", componentSpecSchema.extend({
      expectedSnapshotId: z.string().min(1),
    }).parse(spec));
  }

  async updateSelection(payload: {
    patch: DesignPatch;
    targetIds: string[];
    expectedSnapshotId: string;
    documentId?: string;
    sessionId?: string;
  }): Promise<unknown> {
    return this.bridge.request(this.host, "update_selection", payload);
  }
}
