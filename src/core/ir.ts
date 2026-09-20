import { z } from "zod";

export const IR_SCHEMA_VERSION = 2 as const;
export const PROTOCOL_VERSION = 2 as const;
export const NORMALIZATION_VERSION = "designport-ir-v2" as const;

export const hostKindSchema = z.enum(["figma", "xd"]);
export type HostKind = z.infer<typeof hostKindSchema>;

export const captureScopeSchema = z.enum(["document", "page", "selection", "screen"]);
export type CaptureScope = z.infer<typeof captureScopeSchema>;

export const captureResponseTypeSchema = z.enum([
  "full",
  "delta",
  "not-modified",
  "resync-required",
]);
export type CaptureResponseType = z.infer<typeof captureResponseTypeSchema>;

export const evidenceDetailSchema = z.enum(["summary", "structure", "full"]);
export type EvidenceDetail = z.infer<typeof evidenceDetailSchema>;

export const evidenceShapeSchema = z.object({
  detail: evidenceDetailSchema,
  includeAssets: z.boolean(),
  includeTokens: z.boolean(),
  maxAssetBytes: z.number().int().nonnegative(),
  maxTextBytes: z.number().int().nonnegative(),
  maxTokenRecords: z.number().int().nonnegative(),
});
export type EvidenceShape = z.infer<typeof evidenceShapeSchema>;

export const captureIdentitySchema = z.object({
  sessionId: z.string().min(1),
  documentId: z.string().min(1),
  scope: captureScopeSchema,
  pageId: z.string().min(1).optional(),
  scopeRootIds: z.array(z.string().min(1)),
  selectedIds: z.array(z.string().min(1)),
  normalizationVersion: z.literal(NORMALIZATION_VERSION),
  evidenceShape: evidenceShapeSchema,
});
export type CaptureIdentity = z.infer<typeof captureIdentitySchema>;

export const coverageStatusSchema = z.enum([
  "complete",
  "partial",
  "unsupported",
  "omitted",
  "failed",
]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export const coverageEntrySchema = z.object({
  status: coverageStatusSchema,
  reason: z.string().min(1).optional(),
  fields: z.array(z.string().min(1)).optional(),
});
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export const coverageSchema = z.object({
  geometry: coverageEntrySchema,
  layout: coverageEntrySchema,
  typography: coverageEntrySchema,
  tokens: coverageEntrySchema,
  components: coverageEntrySchema,
  interactions: coverageEntrySchema,
  assets: coverageEntrySchema,
  accessibility: coverageEntrySchema,
});
export type Coverage = z.infer<typeof coverageSchema>;

export const provenanceSourceSchema = z.enum(["host", "plugin-data", "inferred"]);
export const provenanceSchema = z.object({
  source: provenanceSourceSchema,
  sourceField: z.string().min(1),
  inferenceRuleVersion: z.string().min(1).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const omissionReasonSchema = z.object({
  kind: z.enum([
    "budget",
    "unsupported",
    "unavailable",
    "failed",
    "not-requested",
    "privacy",
  ]),
  message: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).max(2000).optional(),
  artifactId: z.string().min(1).optional(),
});
export type OmissionReason = z.infer<typeof omissionReasonSchema>;

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
  resolutionStatus: z.enum(["resolved", "alias", "unavailable", "cycle"]).optional(),
  aliasOf: z.string().min(1).optional(),
  aliasCycle: z.boolean().optional(),
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
  data: z.string().min(1).optional(),
  kind: z.enum(["image", "vector"]).optional(),
  imageScaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
  artifactId: z.string().min(1).optional(),
  digest: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  sourceNodeIds: z.array(z.string().min(1)).max(2000).optional(),
  captureId: z.string().min(1).optional(),
  omission: omissionReasonSchema.optional(),
});
export type DesignAsset = z.infer<typeof designAssetSchema>;

export const visualItemSchema = z.object({
  nodeId: z.string().min(1),
  nodeName: z.string(),
  mimeType: z.literal("image/png"),
  data: z.string().min(1),
  bounds: boundsSchema.nullable(),
  scale: z.number().finite().positive(),
  pixelWidth: z.number().int().positive(),
  pixelHeight: z.number().int().positive(),
  cropOrigin: pointSchema.optional(),
  worldToPixel: affineTransformSchema.optional(),
  captureId: z.string().min(1),
});
export type VisualItem = z.infer<typeof visualItemSchema>;

export const visualContextSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  scope: z.enum(["selection", "screen", "page"]),
  host: hostKindSchema,
  documentId: z.string().min(1),
  documentName: z.string(),
  captureId: z.string().min(1),
  captureIdentity: captureIdentitySchema,
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
  resolutionStatus: z.enum(["resolved", "unresolved", "unknown"]).default("unknown"),
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
  source: provenanceSourceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.record(z.string().min(1), provenanceSchema).optional(),
});
export type Accessibility = z.infer<typeof accessibilitySchema>;

export const annotationSchema = z.object({
  label: z.string().optional(),
  labelMarkdown: z.string().optional(),
  categoryId: z.string().min(1).optional(),
  properties: z.array(z.string().min(1)).optional(),
  untrusted: z.boolean().optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const viewportSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  orientation: z.enum(["portrait", "landscape", "square"]),
  breakpoint: z.enum(["compact", "medium", "expanded"]),
  breakpointSource: z.enum(["authored", "heuristic", "unknown"]).optional(),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const screenDetailSchema = z.object({
  node: nodeRefSchema,
  name: z.string(),
  viewport: viewportSchema,
});
export type ScreenDetail = z.infer<typeof screenDetailSchema>;

export const paginationSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const exportStatsSchema = z.object({
  totalNodes: z.number().int().nonnegative(),
  returnedNodes: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  assetBytes: z.number().int().nonnegative(),
  assetsOmitted: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  textBytes: z.number().int().nonnegative(),
  tokenRecords: z.number().int().nonnegative(),
  imagePixels: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
});
export type ExportStats = z.infer<typeof exportStatsSchema>;

export const snapshotSchema = z.object({
  id: z.string().min(1),
  captureId: z.string().min(1),
  identity: captureIdentitySchema,
  scope: captureScopeSchema,
  documentRevision: z.number().int().nonnegative(),
  selectionRevision: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  complete: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const exportOptionsSchema = z.object({
  maxNodes: z.number().int().positive().max(10000).default(5000),
  cursor: z.string().min(1).optional(),
  includeAssets: z.boolean().default(true),
  maxAssetBytes: z.number().int().positive().max(50000000).default(4000000),
  includeTokens: z.boolean().default(true),
  detail: evidenceDetailSchema.default("full"),
  knownSnapshotId: z.string().min(1).optional(),
  changedOnly: z.boolean().default(false),
  pageId: z.string().min(1).optional(),
  includePages: z.boolean().default(false),
  maxTextBytes: z.number().int().positive().max(50000000).default(200000),
  maxTokenRecords: z.number().int().positive().max(100000).default(5000),
  maxImagePixels: z.number().int().positive().max(100000000).default(8000000),
  maxResponseBytes: z.number().int().positive().max(100000000).default(12000000),
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
  localBounds: boundsSchema.nullable().optional(),
  worldBounds: boundsSchema.nullable().optional(),
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
  untrustedText: z.boolean().optional(),
  textSegments: z.array(textSegmentSchema).optional(),
  typography: typographySchema.optional(),
  layout: layoutSchema.optional(),
  prototypeLinks: z.array(prototypeLinkSchema).optional(),
  provenance: z.record(z.string().min(1), provenanceSchema).optional(),
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
    createNodeTree: z.boolean(),
    updateSelection: z.boolean(),
    setPrototype: z.boolean(),
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
  pages: z.array(nodeRefSchema).optional(),
  screens: z.array(nodeRefSchema),
  selection: z.array(nodeRefSchema),
  scope: captureScopeSchema.optional(),
  pageId: z.string().min(1).optional(),
  captureId: z.string().min(1),
  captureIdentity: captureIdentitySchema,
  exportedAt: z.string().datetime({ offset: true }),
  capabilities: hostCapabilitiesSchema.optional(),
  snapshot: snapshotSchema.optional(),
  responseType: captureResponseTypeSchema,
  removedNodeIds: z.array(z.string().min(1)).max(2000).optional(),
  resyncReason: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
  tokenState: z.enum(["replaced", "unchanged", "omitted", "failed"]).optional(),
  omissions: z.array(omissionReasonSchema).max(2000).optional(),
  coverage: coverageSchema,
  tokens: z.array(designTokenSchema).optional(),
  screenDetails: z.array(screenDetailSchema).optional(),
  pagination: paginationSchema.optional(),
  exportStats: exportStatsSchema.optional(),
});
export type DesignIR = z.infer<typeof designIRSchema>;

export const contextIRSchema = z.object({
  schemaVersion: z.literal(IR_SCHEMA_VERSION),
  scope: captureScopeSchema,
  host: hostKindSchema,
  documentId: z.string().min(1),
  documentName: z.string(),
  selection: z.array(nodeRefSchema),
  nodes: z.array(designNodeSchema),
  screenId: z.string().optional(),
  pageId: z.string().min(1).optional(),
  captureId: z.string().min(1),
  captureIdentity: captureIdentitySchema,
  snapshot: snapshotSchema.optional(),
  responseType: captureResponseTypeSchema,
  removedNodeIds: z.array(z.string().min(1)).max(2000).optional(),
  resyncReason: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
  tokenState: z.enum(["replaced", "unchanged", "omitted", "failed"]).optional(),
  omissions: z.array(omissionReasonSchema).max(2000).optional(),
  coverage: coverageSchema,
  viewport: viewportSchema.optional(),
  tokens: z.array(designTokenSchema).optional(),
  pagination: paginationSchema.optional(),
  exportStats: exportStatsSchema.optional(),
  exportedAt: z.string().datetime({ offset: true }),
});
export type ContextIR = z.infer<typeof contextIRSchema>;

const authoringReferenceSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "References must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.");

const authoringColorSchema = colorSchema.strict();

export const authoringNodeKindSchema = z.enum([
  "frame",
  "text",
  "rectangle",
  "component",
  "instance",
]);
export type AuthoringNodeKind = z.infer<typeof authoringNodeKindSchema>;

const authoringPaddingSchema = z.object({
  top: z.number().finite().nonnegative(),
  right: z.number().finite().nonnegative(),
  bottom: z.number().finite().nonnegative(),
  left: z.number().finite().nonnegative(),
}).strict();

const authoringStrokeSchema = z.object({
  color: authoringColorSchema,
  weight: z.number().finite().nonnegative().max(1000).default(1),
  position: z.enum(["inside", "outside", "center"]).default("inside"),
}).strict();
export type AuthoringStroke = z.infer<typeof authoringStrokeSchema>;

const authoringLayoutFields = {
  mode: z.enum(["none", "horizontal", "vertical"]),
  gap: z.number().finite().nonnegative().max(10000).optional(),
  padding: authoringPaddingSchema.optional(),
  sizingHorizontal: z.enum(["fixed", "hug", "fill"]).optional(),
  sizingVertical: z.enum(["fixed", "hug", "fill"]).optional(),
  primaryAxisAlign: z.enum(["min", "center", "max", "space-between"]).optional(),
  counterAxisAlign: z.enum(["min", "center", "max", "baseline"]).optional(),
  wrap: z.enum(["no-wrap", "wrap"]).optional(),
  counterAxisSpacing: z.number().finite().nonnegative().max(10000).optional(),
};

export const authoringLayoutSchema = z.object({
  ...authoringLayoutFields,
  mode: authoringLayoutFields.mode.default("none"),
}).strict();
export type AuthoringLayout = z.infer<typeof authoringLayoutSchema>;

export const authoringLayoutPatchSchema = z.object({
  ...authoringLayoutFields,
  mode: authoringLayoutFields.mode.optional(),
}).strict();
export type AuthoringLayoutPatch = z.infer<typeof authoringLayoutPatchSchema>;

export const authoringTypographySchema = z.object({
  family: z.string().min(1).max(120).optional(),
  style: z.string().min(1).max(120).optional(),
  size: z.number().finite().positive().max(1000).optional(),
  lineHeight: z.number().finite().positive().max(10000).optional(),
  letterSpacing: z.number().finite().max(10000).optional(),
  align: z.enum(["left", "center", "right", "justified"]).optional(),
  alignVertical: z.enum(["top", "center", "bottom"]).optional(),
  decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
  textCase: z.enum(["original", "upper", "lower", "title", "small-caps", "small-caps-forced"]).optional(),
  autoResize: z.enum(["none", "width-and-height", "height", "truncate"]).optional(),
  textTruncation: z.enum(["disabled", "ending"]).optional(),
  maxLines: z.number().int().positive().max(1000).optional(),
  paragraphIndent: z.number().finite().max(10000).optional(),
  paragraphSpacing: z.number().finite().nonnegative().max(10000).optional(),
}).strict();
export type AuthoringTypography = z.infer<typeof authoringTypographySchema>;

const authoringCornerRadiiSchema = z.object({
  topLeft: z.number().finite().nonnegative().max(10000),
  topRight: z.number().finite().nonnegative().max(10000),
  bottomRight: z.number().finite().nonnegative().max(10000),
  bottomLeft: z.number().finite().nonnegative().max(10000),
}).strict();

export const authoringNodeSchema = z.object({
  ref: authoringReferenceSchema,
  kind: authoringNodeKindSchema,
  parentRef: authoringReferenceSchema.optional(),
  name: z.string().min(1).max(200),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().positive().max(100000).optional(),
  height: z.number().finite().positive().max(100000).optional(),
  componentId: z.string().min(1).max(200).optional(),
  textOverrides: z.record(z.string().min(1).max(120), z.string().max(2000)).optional(),
  fill: authoringColorSchema.optional(),
  stroke: authoringStrokeSchema.optional(),
  cornerRadius: z.number().finite().nonnegative().max(10000).optional(),
  cornerRadii: authoringCornerRadiiSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  text: z.string().max(20000).optional(),
  typography: authoringTypographySchema.optional(),
  layout: authoringLayoutSchema.optional(),
  positioning: z.enum(["auto", "absolute"]).default("auto"),
  clipsContent: z.boolean().optional(),
}).strict().superRefine((node, context) => {
  if (node.kind === "text" && node.text === undefined) {
    context.addIssue({ code: "custom", path: ["text"], message: "Text nodes require text." });
  }
  if (node.kind !== "text" && (node.text !== undefined || node.typography !== undefined)) {
    context.addIssue({ code: "custom", path: ["text"], message: "Only text nodes may set text or typography." });
  }
  if (node.kind === "instance" && node.componentId === undefined) {
    context.addIssue({ code: "custom", path: ["componentId"], message: "Instance nodes require an existing local componentId." });
  }
  if (node.kind !== "instance" && (node.componentId !== undefined || node.textOverrides !== undefined)) {
    context.addIssue({ code: "custom", path: ["componentId"], message: "componentId and textOverrides are only valid for instance nodes." });
  }
  if (node.kind === "instance") {
    if (node.fill !== undefined || node.stroke !== undefined || node.cornerRadius !== undefined
      || node.cornerRadii !== undefined || node.clipsContent !== undefined) {
      context.addIssue({ code: "custom", path: ["kind"], message: "Instance nodes only support native sizing, positioning, visibility, and exposed text overrides." });
    }
    if (node.textOverrides && Object.keys(node.textOverrides).length > 8) {
      context.addIssue({ code: "custom", path: ["textOverrides"], message: "An instance may override at most 8 exposed text properties." });
    }
    if (node.textOverrides && JSON.stringify(node.textOverrides).length > 20000) {
      context.addIssue({ code: "custom", path: ["textOverrides"], message: "Instance text overrides exceed the 20 KB limit." });
    }
  }
  if (node.kind !== "frame" && node.kind !== "component" && node.layout?.mode !== undefined && node.layout.mode !== "none") {
    context.addIssue({ code: "custom", path: ["layout", "mode"], message: "Only frame and component nodes may own auto layout." });
  }
  if (node.kind === "text" && node.layout?.mode !== undefined && node.layout.mode !== "none") {
    context.addIssue({ code: "custom", path: ["layout", "mode"], message: "Text nodes cannot own auto layout." });
  }
  if (node.positioning === "absolute" && !node.parentRef) {
    context.addIssue({ code: "custom", path: ["positioning"], message: "Absolute positioning requires a parent reference." });
  }
  if (node.cornerRadius !== undefined && node.cornerRadii !== undefined) {
    context.addIssue({ code: "custom", path: ["cornerRadii"], message: "Use cornerRadius or cornerRadii, not both." });
  }
});
export type AuthoringNode = z.infer<typeof authoringNodeSchema>;

export const nodeTreeSpecSchema = z.object({
  nodes: z.array(authoringNodeSchema).min(1).max(256),
}).strict().superRefine((spec, context) => {
  const jsonLength = JSON.stringify(spec).length;
  if (jsonLength > 2_000_000) {
    context.addIssue({ code: "custom", path: [], message: "Node-tree payload exceeds the 2 MB authoring limit." });
  }

  const byRef = new Map<string, AuthoringNode>();
  spec.nodes.forEach((node, index) => {
    if (byRef.has(node.ref)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "ref"], message: `Duplicate node reference: ${node.ref}.` });
    }
    byRef.set(node.ref, node);
  });

  const roots = spec.nodes.filter((node) => !node.parentRef);
  if (roots.length > 32) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A node-tree request may contain at most 32 roots." });
  }

  const depthFor = (node: AuthoringNode, path: string[], depth: number): void => {
    if (depth > 12) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Node-tree depth may not exceed 12." });
      return;
    }
    if (!node.parentRef) return;
    const parent = byRef.get(node.parentRef);
    if (!parent) {
      context.addIssue({ code: "custom", path: ["nodes", ...path, "parentRef"], message: `Unknown parent reference: ${node.parentRef}.` });
      return;
    }
    if (path.includes(parent.ref)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Node-tree parent relationships may not contain cycles." });
      return;
    }
    depthFor(parent, [...path, parent.ref], depth + 1);
  };

  spec.nodes.forEach((node, index) => {
    const parent = node.parentRef ? byRef.get(node.parentRef) : undefined;
    if (node.parentRef && !parent) {
      context.addIssue({ code: "custom", path: ["nodes", index, "parentRef"], message: `Unknown parent reference: ${node.parentRef}.` });
      return;
    }
    if (parent && parent.kind !== "frame" && parent.kind !== "component") {
      context.addIssue({ code: "custom", path: ["nodes", index, "parentRef"], message: "Only frame and component nodes may have children." });
    }
    depthFor(node, [node.ref], 1);

    const parentLayout = parent?.layout?.mode;
    const layout = node.layout;
    const hasSizing = Boolean(layout?.sizingHorizontal || layout?.sizingVertical);
    if (hasSizing && !parentLayout && node.kind === "rectangle") {
      context.addIssue({ code: "custom", path: ["nodes", index, "layout"], message: "Rectangle sizing requires an auto-layout parent." });
    }
    if (hasSizing && parentLayout === undefined && node.kind === "frame" && layout?.mode === "none") {
      context.addIssue({ code: "custom", path: ["nodes", index, "layout"], message: "A frame with sizing must own auto layout or be inside an auto-layout parent." });
    }
    if (layout?.sizingHorizontal === "fill" || layout?.sizingVertical === "fill") {
      if (!parentLayout || parentLayout === "none") {
        context.addIssue({ code: "custom", path: ["nodes", index, "layout"], message: "Fill sizing requires an auto-layout parent." });
      }
    }
    if ((layout?.sizingHorizontal === "hug" || layout?.sizingVertical === "hug")
      && node.kind !== "text" && node.kind !== "instance"
      && layout?.mode === "none") {
      context.addIssue({ code: "custom", path: ["nodes", index, "layout"], message: "Hug sizing requires a text node or a native auto-layout frame/component/instance." });
    }
    if (parentLayout && parentLayout !== "none" && node.positioning === "auto" && (node.x !== undefined || node.y !== undefined)) {
      context.addIssue({ code: "custom", path: ["nodes", index], message: "Flow children cannot set x/y; use absolute positioning for overlays." });
    }
    if (node.positioning === "absolute" && (!parentLayout || parentLayout === "none")) {
      context.addIssue({ code: "custom", path: ["nodes", index, "positioning"], message: "Absolute positioning requires an auto-layout parent." });
    }
    if (layout?.mode === "none" && (layout.gap !== undefined || layout.padding !== undefined || layout.primaryAxisAlign !== undefined
      || layout.counterAxisAlign !== undefined || layout.wrap !== undefined || layout.counterAxisSpacing !== undefined)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "layout"], message: "Gap, padding, and alignment require horizontal or vertical auto layout." });
    }
  });
});
export type NodeTreeSpec = z.infer<typeof nodeTreeSpecSchema>;

export const prototypeLinkWriteSchema = z.object({
  sourceNodeId: z.string().min(1),
  destinationNodeId: z.string().min(1).optional(),
  mode: z.enum(["set", "clear"]),
  trigger: z.literal("on_click").default("on_click"),
  transition: z.literal("instant").default("instant"),
  clearScope: z.enum(["matching", "all"]).optional(),
}).strict().superRefine((link, context) => {
  if (link.mode === "set") {
    if (!link.destinationNodeId) {
      context.addIssue({ code: "custom", path: ["destinationNodeId"], message: "Setting a prototype link requires destinationNodeId." });
    }
    if (link.clearScope !== undefined) {
      context.addIssue({ code: "custom", path: ["clearScope"], message: "clearScope is only valid when clearing a prototype link." });
    }
  } else if (link.clearScope === "matching" && !link.destinationNodeId) {
    context.addIssue({ code: "custom", path: ["destinationNodeId"], message: "Matching clear requires destinationNodeId." });
  } else if (link.clearScope === "all" && link.destinationNodeId) {
    context.addIssue({ code: "custom", path: ["destinationNodeId"], message: "All-link clear cannot include destinationNodeId." });
  } else if (link.clearScope === undefined) {
    context.addIssue({ code: "custom", path: ["clearScope"], message: "Clearing requires clearScope=matching or clearScope=all." });
  }
});
export type PrototypeLinkWrite = z.infer<typeof prototypeLinkWriteSchema>;

export const prototypeFlowStartingPointSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  mode: z.enum(["set", "clear"]).default("set"),
}).strict().superRefine((flow, context) => {
  if (flow.mode === "set" && !flow.name) {
    context.addIssue({ code: "custom", path: ["name"], message: "Setting a flow starting point requires a name." });
  }
  if (flow.mode === "clear" && flow.name !== undefined) {
    context.addIssue({ code: "custom", path: ["name"], message: "Clearing a flow starting point cannot include a name." });
  }
});
export type PrototypeFlowStartingPoint = z.infer<typeof prototypeFlowStartingPointSchema>;

export const setPrototypeSpecSchema = z.object({
  links: z.array(prototypeLinkWriteSchema).max(256).default([]),
  flowStartingPoints: z.array(prototypeFlowStartingPointSchema).max(64).default([]),
}).strict().superRefine((spec, context) => {
  if (!spec.links.length && !spec.flowStartingPoints.length) {
    context.addIssue({ code: "custom", path: [], message: "Prototype authoring requires at least one link or flow starting point." });
  }
  const flowIds = new Set<string>();
  spec.flowStartingPoints.forEach((flow, index) => {
    if (flowIds.has(flow.nodeId)) {
      context.addIssue({ code: "custom", path: ["flowStartingPoints", index, "nodeId"], message: `Duplicate flow starting point nodeId: ${flow.nodeId}.` });
    }
    flowIds.add(flow.nodeId);
  });
  if (JSON.stringify(spec).length > 512_000) {
    context.addIssue({ code: "custom", path: [], message: "Prototype authoring payload exceeds the 512 KB limit." });
  }
});
export type SetPrototypeSpec = z.infer<typeof setPrototypeSpecSchema>;

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
  coordinateSpace: z.enum(["parent", "world"]).default("parent"),
  name: z.string().min(1).max(200).optional(),
  bounds: boundsSchema.partial().optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fills: z.array(fillSchema).optional(),
  text: z.string().max(20000).optional(),
  typography: authoringTypographySchema.optional(),
  layout: authoringLayoutPatchSchema.optional(),
  parentId: z.string().min(1).optional(),
  stroke: authoringStrokeSchema.optional(),
  cornerRadius: z.number().finite().nonnegative().max(10000).optional(),
  cornerRadii: authoringCornerRadiiSchema.optional(),
}).strict();
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
