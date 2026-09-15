import { z } from "zod";

export const IR_SCHEMA_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;

export const hostKindSchema = z.enum(["figma", "xd"]);
export type HostKind = z.infer<typeof hostKindSchema>;

export const nodeKindSchema = z.enum([
  "root",
  "screen",
  "frame",
  "group",
  "rectangle",
  "ellipse",
  "line",
  "path",
  "text",
  "component",
  "instance",
  "repeat-grid",
  "unknown",
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof pointSchema>;

export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Bounds = z.infer<typeof boundsSchema>;

export const colorSchema = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1).optional(),
});
export type Color = z.infer<typeof colorSchema>;

export const affineTransformSchema = z.object({
  a: z.number().finite(),
  b: z.number().finite(),
  c: z.number().finite(),
  d: z.number().finite(),
  tx: z.number().finite(),
  ty: z.number().finite(),
});
export type AffineTransform = z.infer<typeof affineTransformSchema>;

export const fillSchema = z.object({
  type: z.enum(["solid", "gradient", "image", "unknown"]),
  color: colorSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  blendMode: z.string().min(1).optional(),
  resource: z.string().optional(),
  gradientType: z.enum(["linear", "radial", "angular", "diamond"]).optional(),
  gradientStops: z.array(z.object({
    position: z.number().min(0).max(1),
    color: colorSchema,
  })).optional(),
  gradientTransform: affineTransformSchema.optional(),
  imageScaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
  imageTransform: affineTransformSchema.optional(),
  imageScaleFactor: z.number().finite().positive().optional(),
  imageRotation: z.number().finite().optional(),
});
export type Fill = z.infer<typeof fillSchema>;

export const strokeSchema = z.object({
  fills: z.array(fillSchema),
  weight: z.number().finite().nonnegative().optional(),
  position: z.enum(["inside", "outside", "center"]).optional(),
  sideWeights: z.object({
    top: z.number().finite().nonnegative(),
    right: z.number().finite().nonnegative(),
    bottom: z.number().finite().nonnegative(),
    left: z.number().finite().nonnegative(),
  }).optional(),
  dashPattern: z.array(z.number().finite().nonnegative()).optional(),
  cap: z.string().min(1).optional(),
  join: z.string().min(1).optional(),
});
export type Stroke = z.infer<typeof strokeSchema>;

export const effectSchema = z.object({
  type: z.enum(["drop-shadow", "inner-shadow", "layer-blur", "background-blur", "unknown"]),
  color: colorSchema.optional(),
  offset: pointSchema.optional(),
  radius: z.number().finite().nonnegative().optional(),
  spread: z.number().finite().optional(),
  visible: z.boolean().optional(),
  blendMode: z.string().min(1).optional(),
});
export type Effect = z.infer<typeof effectSchema>;

export const designAssetSchema = z.object({
  mimeType: z.string().min(1),
  data: z.string().min(1),
  kind: z.enum(["image", "vector"]).optional(),
  imageScaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
});
export type DesignAsset = z.infer<typeof designAssetSchema>;

export const visualItemSchema = z.object({
  nodeId: z.string().min(1),
  nodeName: z.string(),
  mimeType: z.literal("image/png"),
  data: z.string().min(1),
  bounds: boundsSchema.nullable(),
  scale: z.number().finite().positive(),
});
export type VisualItem = z.infer<typeof visualItemSchema>;

export const visualContextSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  scope: z.enum(["selection", "screen"]),
  host: hostKindSchema,
  documentId: z.string().min(1),
  documentName: z.string(),
  items: z.array(visualItemSchema).min(1),
  exportedAt: z.string().datetime({ offset: true }),
});
export type VisualContext = z.infer<typeof visualContextSchema>;

export const typographySchema = z.object({
  family: z.string().optional(),
  style: z.string().optional(),
  size: z.number().finite().positive().optional(),
  weight: z.number().finite().positive().optional(),
  lineHeight: z.number().finite().positive().optional(),
  letterSpacing: z.number().finite().optional(),
  align: z.enum(["left", "center", "right", "justified"]).optional(),
  alignVertical: z.enum(["top", "center", "bottom"]).optional(),
  decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
  textCase: z.enum(["original", "upper", "lower", "title", "small-caps", "small-caps-forced"]).optional(),
  autoResize: z.enum(["none", "width-and-height", "height", "truncate"]).optional(),
  textTruncation: z.enum(["disabled", "ending"]).optional(),
  maxLines: z.number().int().positive().optional(),
  paragraphIndent: z.number().finite().optional(),
  paragraphSpacing: z.number().finite().nonnegative().optional(),
});
export type Typography = z.infer<typeof typographySchema>;

export const layoutSchema = z.object({
  mode: z.enum(["none", "horizontal", "vertical", "grid"]),
  gap: z.number().finite().optional(),
  padding: z
    .object({
      top: z.number().finite().nonnegative(),
      right: z.number().finite().nonnegative(),
      bottom: z.number().finite().nonnegative(),
      left: z.number().finite().nonnegative(),
    })
    .optional(),
  sizingHorizontal: z.enum(["fixed", "hug", "fill"]).optional(),
  sizingVertical: z.enum(["fixed", "hug", "fill"]).optional(),
  primaryAxisAlign: z.enum(["min", "center", "max", "space-between"]).optional(),
  counterAxisAlign: z.enum(["min", "center", "max", "baseline"]).optional(),
  counterAxisAlignContent: z.enum(["auto", "space-between"]).optional(),
  wrap: z.enum(["no-wrap", "wrap"]).optional(),
  counterAxisSpacing: z.number().finite().nonnegative().optional(),
  itemReverseZIndex: z.boolean().optional(),
  strokesIncludedInLayout: z.boolean().optional(),
  grid: z.object({
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
    rowGap: z.number().finite().nonnegative().optional(),
    columnGap: z.number().finite().nonnegative().optional(),
  }).optional(),
});
export type Layout = z.infer<typeof layoutSchema>;

export const constraintsSchema = z.object({
  horizontal: z.enum(["left", "right", "center", "left-right", "scale"]).optional(),
  vertical: z.enum(["top", "bottom", "center", "top-bottom", "scale"]).optional(),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const prototypeLinkSchema = z.object({
  trigger: z.string(),
  action: z.string(),
  destinationId: z.string().optional(),
  url: z.string().optional(),
  navigation: z.string().min(1).optional(),
  transition: z.string().optional(),
  duration: z.number().finite().nonnegative().optional(),
  preserveScrollPosition: z.boolean().optional(),
});
export type PrototypeLink = z.infer<typeof prototypeLinkSchema>;

export const nodeRefSchema = z.object({
  host: hostKindSchema,
  id: z.string().min(1),
});
export type NodeRef = z.infer<typeof nodeRefSchema>;

const unknownRecordSchema = z.record(z.string(), z.unknown());

export const designNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: nodeKindSchema,
  parentId: z.string().nullable(),
  children: z.array(z.string()),
  bounds: boundsSchema.nullable(),
  renderBounds: boundsSchema.nullable().optional(),
  visible: z.boolean(),
  locked: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blendMode: z.string().min(1).optional(),
  fills: z.array(fillSchema).optional(),
  strokes: z.array(strokeSchema).optional(),
  effects: z.array(effectSchema).optional(),
  cornerRadius: z.number().finite().nonnegative().optional(),
  cornerRadii: z.object({
    topLeft: z.number().finite().nonnegative(),
    topRight: z.number().finite().nonnegative(),
    bottomRight: z.number().finite().nonnegative(),
    bottomLeft: z.number().finite().nonnegative(),
  }).optional(),
  asset: designAssetSchema.optional(),
  rotation: z.number().finite().optional(),
  clipsContent: z.boolean().optional(),
  minWidth: z.number().finite().nonnegative().optional(),
  maxWidth: z.number().finite().nonnegative().optional(),
  minHeight: z.number().finite().nonnegative().optional(),
  maxHeight: z.number().finite().nonnegative().optional(),
  constraints: constraintsSchema.optional(),
  layoutAlign: z.enum(["min", "center", "max", "stretch", "inherit"]).optional(),
  layoutGrow: z.number().finite().nonnegative().optional(),
  layoutPositioning: z.enum(["auto", "absolute"]).optional(),
  gridPosition: z.object({
    row: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    rowSpan: z.number().int().positive().optional(),
    columnSpan: z.number().int().positive().optional(),
  }).optional(),
  text: z.string().optional(),
  typography: typographySchema.optional(),
  layout: layoutSchema.optional(),
  prototypeLinks: z.array(prototypeLinkSchema).optional(),
  hostData: unknownRecordSchema.optional(),
});
export type DesignNode = z.infer<typeof designNodeSchema>;

export const hostCapabilitiesSchema = z.object({
  host: hostKindSchema,
  pluginVersion: z.string(),
  operations: z.array(z.string()),
  supports: z.object({
    documentRead: z.boolean(),
    selectionRead: z.boolean(),
    createScreen: z.boolean(),
    createComponent: z.boolean(),
    updateSelection: z.boolean(),
    userActionRequiredForWrite: z.boolean(),
    visualRead: z.boolean().optional(),
  }),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const designIRSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  host: hostKindSchema,
  documentId: z.string().min(1),
  documentName: z.string(),
  rootId: z.string().min(1),
  nodes: z.record(z.string(), designNodeSchema),
  screens: z.array(nodeRefSchema),
  selection: z.array(nodeRefSchema),
  exportedAt: z.string().datetime({ offset: true }),
  capabilities: hostCapabilitiesSchema.optional(),
});
export type DesignIR = z.infer<typeof designIRSchema>;

export const contextIRSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  scope: z.enum(["selection", "screen", "document"]),
  host: hostKindSchema,
  documentId: z.string().min(1),
  documentName: z.string(),
  selection: z.array(nodeRefSchema),
  nodes: z.array(designNodeSchema),
  screenId: z.string().optional(),
  exportedAt: z.string().datetime({ offset: true }),
});
export type ContextIR = z.infer<typeof contextIRSchema>;

export const screenSpecSchema = z.object({
  name: z.string().min(1).max(200),
  width: z.number().finite().positive().default(1440),
  height: z.number().finite().positive().default(900),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  background: colorSchema.optional(),
});
export type ScreenSpec = z.infer<typeof screenSpecSchema>;

export const componentSpecSchema = z.object({
  name: z.string().min(1).max(200),
  width: z.number().finite().positive().default(240),
  height: z.number().finite().positive().default(120),
  kind: z.enum(["component", "symbol"]).default("component"),
  text: z.string().optional(),
  fill: colorSchema.optional(),
});
export type ComponentSpec = z.infer<typeof componentSpecSchema>;

export const designPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  bounds: boundsSchema.partial().optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fills: z.array(fillSchema).optional(),
  text: z.string().optional(),
  typography: typographySchema.optional(),
});
export type DesignPatch = z.infer<typeof designPatchSchema>;

export function nodeRef(host: HostKind, id: string): NodeRef {
  return { host, id };
}

export function parseDesignIR(value: unknown): DesignIR {
  return designIRSchema.parse(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
