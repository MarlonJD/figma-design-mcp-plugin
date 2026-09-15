import { z } from "zod";
import {
  IR_SCHEMA_VERSION,
  type ContextIR,
  type DesignIR,
  type DesignNode,
} from "./ir.js";

export const auditSeveritySchema = z.enum(["info", "warning", "error"]);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

export const auditDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: auditSeveritySchema,
  message: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  field: z.string().min(1).optional(),
  suggestion: z.string().min(1).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type AuditDiagnostic = z.infer<typeof auditDiagnosticSchema>;

export const auditSummarySchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
});
export type AuditSummary = z.infer<typeof auditSummarySchema>;

export const designAuditSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  host: z.enum(["figma", "xd"]),
  documentId: z.string().min(1),
  documentName: z.string(),
  scope: z.enum(["document", "selection", "screen"]),
  screenId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  partial: z.boolean(),
  summary: auditSummarySchema,
  diagnostics: z.array(auditDiagnosticSchema),
  auditedAt: z.string().datetime({ offset: true }),
});
export type DesignAudit = z.infer<typeof designAuditSchema>;

type DesignContext = DesignIR | ContextIR;

function nodesFor(context: DesignContext): DesignNode[] {
  return Array.isArray(context.nodes) ? context.nodes : Object.values(context.nodes);
}

function isInteractive(node: DesignNode): boolean {
  if (node.prototypeLinks && node.prototypeLinks.length > 0) return true;
  return ["button", "checkbox", "link", "switch", "tab", "textbox"].includes(
    node.accessibility?.role ?? "",
  );
}

function hasImageFill(node: DesignNode): boolean {
  return node.fills?.some((fill) => fill.type === "image") ?? false;
}

function addDiagnostic(
  diagnostics: AuditDiagnostic[],
  diagnostic: AuditDiagnostic,
): void {
  diagnostics.push(diagnostic);
}

function auditNode(
  node: DesignNode,
  nodeMap: Map<string, DesignNode>,
  tokenIds: Set<string> | null,
  diagnostics: AuditDiagnostic[],
): void {
  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  const flowParent = parent?.layout && parent.layout.mode !== "none" ? parent : undefined;

  if (flowParent && node.layoutPositioning === "absolute") {
    addDiagnostic(diagnostics, {
      code: "absolute-child-in-flow",
      severity: "warning",
      nodeId: node.id,
      field: "layoutPositioning",
      message: `${node.name} is absolute-positioned inside a ${flowParent.layout?.mode} flow container.`,
      suggestion: "Keep it absolute only when it is an intentional overlay; otherwise use the parent flow layout.",
      evidence: { parentId: flowParent.id, parentLayout: flowParent.layout?.mode },
    });
  }

  if (node.layoutGrow !== undefined && (!parent || !parent.layout || parent.layout.mode === "none")) {
    addDiagnostic(diagnostics, {
      code: "grow-without-flow",
      severity: "warning",
      nodeId: node.id,
      field: "layoutGrow",
      message: `${node.name} requests growth but its parent has no flow layout metadata.`,
      suggestion: "Use a flow container or remove the grow signal before implementing the layout.",
    });
  }

  if (node.children.length >= 2 && !node.layout && node.kind !== "text" && node.kind !== "path") {
    addDiagnostic(diagnostics, {
      code: "missing-flow-metadata",
      severity: "info",
      nodeId: node.id,
      field: "layout",
      message: `${node.name} contains multiple children but exposes no flow layout metadata.`,
      suggestion: "Use bounds as a visual check and infer a maintainable row, column, or grid only when the image supports it.",
    });
  }

  if (isInteractive(node)
    && node.kind !== "text"
    && !node.accessibility?.label
    && !node.accessibility?.description) {
    addDiagnostic(diagnostics, {
      code: "interactive-missing-label",
      severity: "warning",
      nodeId: node.id,
      field: "accessibility.label",
      message: `${node.name} appears interactive but has no explicit accessible label or description.`,
      suggestion: "Add an explicit label in the design metadata or verify the visible child text is the control name.",
    });
  }

  if ((hasImageFill(node) || node.hostData?.isAsset === true)
    && node.accessibility?.decorative !== true
    && !node.accessibility?.altText
    && !node.accessibility?.label) {
    addDiagnostic(diagnostics, {
      code: "visual-missing-alt",
      severity: "info",
      nodeId: node.id,
      field: "accessibility.altText",
      message: `${node.name} contains visual content without alt text or a decorative decision.`,
      suggestion: "Decide whether the visual is decorative; otherwise provide meaningful alternative text.",
    });
  }

  if (node.accessibility?.role === "heading" && node.accessibility.headingLevel === undefined) {
    addDiagnostic(diagnostics, {
      code: "heading-missing-level",
      severity: "warning",
      nodeId: node.id,
      field: "accessibility.headingLevel",
      message: `${node.name} is identified as a heading without a heading level.`,
      suggestion: "Confirm the heading hierarchy before mapping it to the target platform.",
    });
  }

  node.prototypeLinks?.forEach((link) => {
    if (!link.destinationId && !link.url && ["node", "screen", "artboard", "navigate"].some((value) => link.action.includes(value))) {
      addDiagnostic(diagnostics, {
        code: "interaction-without-destination",
        severity: "warning",
        nodeId: node.id,
        field: "prototypeLinks",
        message: `${node.name} exposes a ${link.action} interaction without a destination or URL.`,
        suggestion: "Resolve the destination in the design file or preserve the unresolved interaction as a TODO.",
        evidence: { trigger: link.trigger, action: link.action },
      });
    }
  });

  if (node.component?.isInstance && !node.component.mainComponentId) {
    addDiagnostic(diagnostics, {
      code: "instance-missing-component-reference",
      severity: "info",
      nodeId: node.id,
      field: "component.mainComponentId",
      message: `${node.name} is an instance without a stable main component reference.`,
      suggestion: "Use the host-specific identity only as a fallback and verify the reusable component manually.",
    });
  }

  if (tokenIds) {
    const references = [
      ...Object.values(node.styleRefs ?? {}),
      ...Object.values(node.variableBindings ?? {}).flat(),
    ];
    references
      .filter((reference): reference is string => {
        if (typeof reference !== "string" || !reference) return false;
        return !tokenIds.has(reference);
      })
      .forEach((reference) => {
        addDiagnostic(diagnostics, {
          code: "unresolved-token-reference",
          severity: "info",
          nodeId: node.id,
          field: "styleRefs",
          message: `${node.name} references token or style ${reference}, which is not present in this export.`,
          suggestion: "Request a fuller token export or inspect the host-specific style catalog before inventing a replacement.",
        });
      });
  }
}

export function auditDesignContext(context: DesignContext): DesignAudit {
  const nodes = nodesFor(context);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const tokenIds = context.tokens ? new Set(context.tokens.map((token) => token.id)) : null;
  const diagnostics: AuditDiagnostic[] = [];

  nodes.forEach((node) => auditNode(node, nodeMap, tokenIds, diagnostics));

  const summary = diagnostics.reduce<AuditSummary>(
    (result, diagnostic) => {
      if (diagnostic.severity === "error") result.errors += 1;
      else if (diagnostic.severity === "warning") result.warnings += 1;
      else result.info += 1;
      return result;
    },
    { errors: 0, warnings: 0, info: 0, nodeCount: nodes.length },
  );
  const partial = context.partial === true || context.pagination?.hasMore === true;
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    host: context.host,
    documentId: context.documentId,
    documentName: context.documentName,
    scope: "scope" in context ? context.scope : "document",
    ...("screenId" in context && context.screenId ? { screenId: context.screenId } : {}),
    ...(context.snapshot?.id ? { snapshotId: context.snapshot.id } : {}),
    partial,
    summary,
    diagnostics,
    auditedAt: new Date().toISOString(),
  };
}
