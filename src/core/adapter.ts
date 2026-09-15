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
import { DesignPortBridge } from "../bridge/bridge-server.js";

export interface DesignHostAdapter {
  readonly host: HostKind;
  getCapabilities(): Promise<HostCapabilities>;
  getSelectionContext(options?: Partial<ExportOptions>): Promise<ContextIR>;
  getScreenContext(screenId?: string, options?: Partial<ExportOptions>): Promise<ContextIR>;
  getVisualContext(scope: "selection" | "screen", screenId?: string): Promise<VisualContext>;
  exportIR(
    scope: "document" | "selection" | "screen",
    screenId?: string,
    options?: Partial<ExportOptions>,
  ): Promise<DesignIR | ContextIR>;
  createScreen(spec: ScreenSpec): Promise<unknown>;
  createComponent(spec: ComponentSpec): Promise<unknown>;
  updateSelection(patch: DesignPatch): Promise<unknown>;
}

function optionsPayload(options?: Partial<ExportOptions>): { options: ExportOptions } {
  return { options: exportOptionsSchema.parse(options ?? {}) };
}

export class BridgeHostAdapter implements DesignHostAdapter {
  constructor(
    private readonly bridge: DesignPortBridge,
    readonly host: HostKind,
  ) {}

  async getCapabilities(): Promise<HostCapabilities> {
    return hostCapabilitiesSchema.parse(
      await this.bridge.request(this.host, "get_capabilities", {}),
    );
  }

  async getSelectionContext(options?: Partial<ExportOptions>): Promise<ContextIR> {
    return contextIRSchema.parse(
      await this.bridge.request(this.host, "get_selection_context", optionsPayload(options)),
    );
  }

  async getScreenContext(screenId?: string, options?: Partial<ExportOptions>): Promise<ContextIR> {
    const payload = {
      ...(screenId ? { screenId } : {}),
      ...optionsPayload(options),
    };
    return contextIRSchema.parse(
      await this.bridge.request(this.host, "get_screen_context", payload),
    );
  }

  async getVisualContext(
    scope: "selection" | "screen",
    screenId?: string,
  ): Promise<VisualContext> {
    const payload = {
      scope,
      ...(screenId ? { screenId } : {}),
    };
    return visualContextSchema.parse(
      await this.bridge.request(this.host, "get_visual_context", payload),
    );
  }

  async exportIR(
    scope: "document" | "selection" | "screen",
    screenId?: string,
    options?: Partial<ExportOptions>,
  ): Promise<DesignIR | ContextIR> {
    const payload = {
      scope,
      ...(screenId ? { screenId } : {}),
      ...optionsPayload(options),
    };
    const result = await this.bridge.request(this.host, "export_ir", payload);
    return scope === "document" ? designIRSchema.parse(result) : contextIRSchema.parse(result);
  }

  async createScreen(spec: ScreenSpec): Promise<unknown> {
    return this.bridge.request(this.host, "create_screen", screenSpecSchema.parse(spec));
  }

  async createComponent(spec: ComponentSpec): Promise<unknown> {
    return this.bridge.request(this.host, "create_component", componentSpecSchema.parse(spec));
  }

  async updateSelection(patch: DesignPatch): Promise<unknown> {
    return this.bridge.request(this.host, "update_selection", {
      patch: designPatchSchema.parse(patch),
    });
  }
}
