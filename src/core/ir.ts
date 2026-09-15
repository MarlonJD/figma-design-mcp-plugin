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

const arbitraryValueSchema = z.unknown();

export const tokenModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type TokenMode = z.infer<typeof tokenModeSchema>;

export const designTokenSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum([
    "color",
    "number",
    "string",
    "boolean",
    "typography",
    "effect",
    "grid",
    "unknown",
  ]),
  value: arbitraryValueSchema.optional(),
  valuesByMode: z.record(z.string(), arbitraryValueSchema).optional(),
  collectionId: z.string().min(1).optional(),
  collectionName: z.string().min(1).optional(),
  modes: z.array(tokenModeSchema).optional(),
  description: z.string().optional(),
  scopes: z.array(z.string().min(1)).optional(),
  codeSyntax: z.record(z.string(), z.string()).optional(),
  source: z.enum([
    "variable",
    "paint-style",
    "text-style",
    "effect-style",
    "grid-style",
    "unknown",
  ]),
});
export type DesignToken = z.infer<typeof designTokenSchema>;

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
  gradientHandles: z.array(pointSchema).optional(),
  gradientCenter: pointSchema.optional(),
  gradientRadius: z.number().finite().nonnegative().optional(),
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
  byteSize: z.number().int().nonnegative().optional(),
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
  delay: z.number().finite().nonnegative().optional(),
  easing: z.string().min(1).optional(),
  direction: z.string().min(1).optional(),
  matchLayers: z.boolean().optional(),
  overlayPosition: pointSchema.optional(),
  openInNewTab: z.boolean().optional(),
  preserveScrollPosition: z.boolean().optional(),
  resetScrollPosition: z.boolean().optional(),
  resetInteractiveComponents: z.boolean().optional(),
  mediaAction: z.string().min(1).optional(),
  data: z.record(z.string(), arbitraryValueSchema).optional(),
});
export type PrototypeLink = z.infer<typeof prototypeLinkSchema>;

export const nodeRefSchema = z.object({
  host: hostKindSchema,
  id: z.string().min(1),
});
export type NodeRef = z.infer<typeof nodeRefSchema>;

export const designStyleRefsSchema = z.object({
  fill: z.string().min(1).optional(),
  stroke: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  effect: z.string().min(1).optional(),
  grid: z.string().min(1).optional(),
});
export type DesignStyleRefs = z.infer<typeof designStyleRefsSchema>;

export const textSegmentSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  characters: z.string(),
  typography: typographySchema.optional(),
  fills: z.array(fillSchema).optional(),
  styleRefs: designStyleRefsSchema.optional(),
  hyperlink: arbitraryValueSchema.optional(),
});
export type TextSegment = z.infer<typeof textSegmentSchema>;

export const variableBindingsSchema = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);
export type VariableBindings = z.infer<typeof variableBindingsSchema>;

export const componentPropertySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["boolean", "text", "instance-swap", "variant", "unknown"]),
  value: arbitraryValueSchema.optional(),
  defaultValue: arbitraryValueSchema.optional(),
  variantOptions: z.array(z.string()).optional(),
  preferredValues: z.array(z.object({
    type: z.enum(["component", "component-set", "unknown"]),
    key: z.string().min(1).optional(),
  })).optional(),
});
export type ComponentProperty = z.infer<typeof componentPropertySchema>;

export const componentMetadataSchema = z.object({
  id: z.string().min(1),
  setId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  variantProperties: z.record(z.string(), z.string()).optional(),
  states: z.record(z.string(), z.string()).optional(),
  properties: z.array(componentPropertySchema).optional(),
  mainComponentId: z.string().min(1).optional(),
  isVariant: z.boolean().optional(),
  isInstance: z.boolean().optional(),
});
export type ComponentMetadata = z.infer<typeof componentMetadataSchema>;

export const accessibilitySchema = z.object({
  role: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  altText: z.string().optional(),
  headingLevel: z.number().int().min(1).max(6).optional(),
  focusable: z.boolean().optional(),
  decorative: z.boolean().optional(),
  source: z.enum(["explicit", "inferred"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type Accessibility = z.infer<typeof accessibilitySchema>;

export const annotationSchema = z.object({
  label: z.string().optional(),
  labelMarkdown: z.string().optional(),
  categoryId: z.string().min(1).optional(),
  properties: z.array(z.string().min(1)).optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const viewportSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  orientation: z.enum(["portrait", "landscape", "square"]),
  breakpoint: z.enum(["compact", "medium", "expanded"]),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const screenDetailSchema = z.object({
  node: nodeRefSchema,
  name: z.string(),
  viewport: viewportSchema,
});
export type ScreenDetail = z.infer<typeof screenDetailSchema>;

export const paginationSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const exportStatsSchema = z.object({
  totalNodes: z.number().int().nonnegative(),
  returnedNodes: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  assetBytes: z.number().int().nonnegative(),
  assetsOmitted: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
});
export type ExportStats = z.infer<typeof exportStatsSchema>;

export const exportOptionsSchema = z.object({
  maxNodes: z.number().int().positive().max(10000).default(5000),
  nodeOffset: z.number().int().nonnegative().max(1000000).default(0),
  includeAssets: z.boolean().default(true),
  maxAssetBytes: z.number().int().positive().max(50000000).default(4000000),
  includeTokens: z.boolean().default(true),
});
export type ExportOptions = z.infer<typeof exportOptionsSchema>;

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
  description: z.string().optional(),
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
  transform: affineTransformSchema.optional(),
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
  styleRefs: designStyleRefsSchema.optional(),
  variableBindings: variableBindingsSchema.optional(),
  component: componentMetadataSchema.optional(),
  accessibility: accessibilitySchema.optional(),
  annotations: z.array(annotationSchema).optional(),
  text: z.string().optional(),
  textSegments: z.array(textSegmentSchema).optional(),
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
  features: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
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
  tokens: z.array(designTokenSchema).optional(),
  screenDetails: z.array(screenDetailSchema).optional(),
  pagination: paginationSchema.optional(),
  exportStats: exportStatsSchema.optional(),
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
  viewport: viewportSchema.optional(),
  tokens: z.array(designTokenSchema).optional(),
  pagination: paginationSchema.optional(),
  exportStats: exportStatsSchema.optional(),
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
