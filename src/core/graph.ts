import { z } from "zod";
import {
  captureScopeSchema,
  IR_SCHEMA_VERSION,
  viewportSchema,
  type ContextIR,
  type DesignIR,
  type DesignNode,
  type CaptureScope,
} from "./ir.js";

export const graphComponentSchema = z.object({
  nodeId: z.string().min(1),
  componentId: z.string().min(1),
  name: z.string(),
  mainComponentId: z.string().min(1).optional(),
  setId: z.string().min(1).optional(),
  isInstance: z.boolean().optional(),
  isVariant: z.boolean().optional(),
  variantProperties: z.record(z.string(), z.string()).optional(),
  states: z.record(z.string(), z.string()).optional(),
});
export type GraphComponent = z.infer<typeof graphComponentSchema>;

export const graphInteractionSchema = z.object({
  sourceNodeId: z.string().min(1),
  trigger: z.string(),
  action: z.string(),
  resolutionStatus: z.enum(["resolved", "unresolved", "unknown"]).default("unknown"),
  destinationId: z.string().min(1).optional(),
  url: z.string().optional(),
  navigation: z.string().min(1).optional(),
  transition: z.string().optional(),
  duration: z.number().finite().nonnegative().optional(),
  delay: z.number().finite().nonnegative().optional(),
  easing: z.string().min(1).optional(),
  direction: z.string().min(1).optional(),
  matchLayers: z.boolean().optional(),
  overlayPosition: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  openInNewTab: z.boolean().optional(),
  preserveScrollPosition: z.boolean().optional(),
  resetScrollPosition: z.boolean().optional(),
  resetInteractiveComponents: z.boolean().optional(),
  mediaAction: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type GraphInteraction = z.infer<typeof graphInteractionSchema>;

export const graphScreenSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  viewport: viewportSchema.optional(),
});
export type GraphScreen = z.infer<typeof graphScreenSchema>;

export const designGraphSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  host: z.enum(["figma", "xd"]),
  documentId: z.string().min(1),
  documentName: z.string(),
  scope: captureScopeSchema,
  snapshotId: z.string().min(1).optional(),
  captureId: z.string().min(1),
  responseType: z.enum(["full", "delta", "not-modified", "resync-required"]),
  partial: z.boolean(),
  components: z.array(graphComponentSchema),
  interactions: z.array(graphInteractionSchema),
  screens: z.array(graphScreenSchema),
  generatedAt: z.string().datetime({ offset: true }),
});
export type DesignGraph = z.infer<typeof designGraphSchema>;

type DesignContext = DesignIR | ContextIR;

function nodesFor(context: DesignContext): DesignNode[] {
  return Array.isArray(context.nodes) ? context.nodes : Object.values(context.nodes);
}

function scopeFor(context: DesignContext): CaptureScope {
  return "scope" in context && context.scope ? context.scope : "document";
}

export function buildDesignGraph(context: DesignContext): DesignGraph {
  const nodes = nodesFor(context);
  const components: GraphComponent[] = [];
  const interactions: GraphInteraction[] = [];
  nodes.forEach((node) => {
    if (node.component) {
      components.push({
        nodeId: node.id,
        componentId: node.component.id,
        name: node.component.name ?? node.name,
        ...(node.component.mainComponentId ? { mainComponentId: node.component.mainComponentId } : {}),
        ...(node.component.setId ? { setId: node.component.setId } : {}),
        ...(node.component.isInstance !== undefined ? { isInstance: node.component.isInstance } : {}),
        ...(node.component.isVariant !== undefined ? { isVariant: node.component.isVariant } : {}),
        ...(node.component.variantProperties ? { variantProperties: node.component.variantProperties } : {}),
        ...(node.component.states ? { states: node.component.states } : {}),
      });
    }
    node.prototypeLinks?.forEach((link) => {
      interactions.push({
        sourceNodeId: node.id,
        trigger: link.trigger,
        action: link.action,
        resolutionStatus: link.resolutionStatus,
        ...(link.destinationId ? { destinationId: link.destinationId } : {}),
        ...(link.url ? { url: link.url } : {}),
        ...(link.navigation ? { navigation: link.navigation } : {}),
        ...(link.transition ? { transition: link.transition } : {}),
        ...(link.duration !== undefined ? { duration: link.duration } : {}),
        ...(link.delay !== undefined ? { delay: link.delay } : {}),
        ...(link.easing ? { easing: link.easing } : {}),
        ...(link.direction ? { direction: link.direction } : {}),
        ...(link.matchLayers !== undefined ? { matchLayers: link.matchLayers } : {}),
        ...(link.overlayPosition ? { overlayPosition: link.overlayPosition } : {}),
        ...(link.openInNewTab !== undefined ? { openInNewTab: link.openInNewTab } : {}),
        ...(link.preserveScrollPosition !== undefined ? { preserveScrollPosition: link.preserveScrollPosition } : {}),
        ...(link.resetScrollPosition !== undefined ? { resetScrollPosition: link.resetScrollPosition } : {}),
        ...(link.resetInteractiveComponents !== undefined ? { resetInteractiveComponents: link.resetInteractiveComponents } : {}),
        ...(link.mediaAction ? { mediaAction: link.mediaAction } : {}),
        ...(link.data ? { data: link.data } : {}),
      });
    });
  });

  const screens: GraphScreen[] = ("screenDetails" in context ? context.screenDetails ?? [] : []).map((screen) => ({
    id: screen.node.id,
    name: screen.name,
    viewport: screen.viewport,
  }));
  if (screens.length === 0 && "screenId" in context && context.screenId) {
    const screenNode = nodes.find((node) => node.id === context.screenId);
    if (screenNode) {
      const bounds = screenNode.bounds;
      const viewport = bounds && bounds.width > 0 && bounds.height > 0
        ? {
            width: bounds.width,
            height: bounds.height,
            orientation: bounds.width === bounds.height
              ? "square" as const
              : bounds.width > bounds.height
                ? "landscape" as const
                : "portrait" as const,
            breakpoint: bounds.width < 600
              ? "compact" as const
              : bounds.width < 1024
                ? "medium" as const
                : "expanded" as const,
            breakpointSource: "heuristic" as const,
          }
        : undefined;
      screens.push({ id: screenNode.id, name: screenNode.name, ...(viewport ? { viewport } : {}) });
    }
  }

  return {
    schemaVersion: IR_SCHEMA_VERSION,
    host: context.host,
    documentId: context.documentId,
    documentName: context.documentName,
    scope: scopeFor(context),
    ...(context.snapshot?.id ? { snapshotId: context.snapshot.id } : {}),
    captureId: context.captureId,
    responseType: context.responseType,
    partial: context.responseType === "delta"
      || context.pagination?.hasMore === true
      || Object.values(context.coverage).some((entry) => entry.status !== "complete"),
    components,
    interactions,
    screens,
    generatedAt: new Date().toISOString(),
  };
}
