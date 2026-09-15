const { entrypoints } = require("uxp");
const { localFileSystem, formats } = require("uxp").storage;
const scenegraph = require("scenegraph");
const application = require("application");

const { Artboard, Rectangle, Text, Color } = scenegraph;

const BRIDGE_URL = "ws://127.0.0.1:5514";
const PLUGIN_VERSION = "0.3.0";
const MAX_ASSET_EXPORTS_PER_REQUEST = 64;

const CAPABILITIES = {
  host: "xd",
  pluginVersion: PLUGIN_VERSION,
  features: [
    "design-ir",
    "visual-context",
    "style-bindings",
    "text-ranges",
    "interactions",
    "accessibility-signals",
    "responsive-layout",
    "asset-export",
    "pagination",
    "incremental-snapshots",
  ],
  limitations: [
    "component-creation-unsupported",
    "component-state-coverage-depends-on-xd-uxp-surface",
    "interaction-api-excludes-hover-and-component-state-transitions",
  ],
  operations: [
    "ping",
    "get_capabilities",
    "get_selection_context",
    "get_screen_context",
    "get_visual_context",
    "export_ir",
    "create_screen",
    "create_component",
    "update_selection",
  ],
  supports: {
    documentRead: true,
    selectionRead: true,
    createScreen: true,
    createComponent: false,
    updateSelection: true,
    userActionRequiredForWrite: true,
    visualRead: true,
  },
};

const DEFAULT_EXPORT_OPTIONS = {
  maxNodes: 5000,
  nodeOffset: 0,
  includeAssets: true,
  maxAssetBytes: 4000000,
  includeTokens: true,
  detail: "full",
  changedOnly: false,
};

const assetCache = new Map();
const assetPromises = new Map();
const snapshotState = {
  sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  documentRevision: 0,
  selectionRevision: 0,
  selectionKey: "",
  changeLog: [],
  snapshots: new Map(),
};

const state = {
  socket: null,
  panelRoot: null,
  statusNode: null,
  pendingNode: null,
  applyButton: null,
  pendingWrites: [],
  reconnectTimer: null,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function safeRead(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function exportOptionsFor(payload) {
  const input = payload && payload.options && typeof payload.options === "object"
    ? payload.options
    : {};
  return {
    maxNodes: Number.isInteger(input.maxNodes) && input.maxNodes > 0
      ? Math.min(10000, input.maxNodes)
      : DEFAULT_EXPORT_OPTIONS.maxNodes,
    nodeOffset: Number.isInteger(input.nodeOffset) && input.nodeOffset >= 0
      ? Math.min(1000000, input.nodeOffset)
      : DEFAULT_EXPORT_OPTIONS.nodeOffset,
    includeAssets: input.includeAssets !== false,
    maxAssetBytes: Number.isInteger(input.maxAssetBytes) && input.maxAssetBytes > 0
      ? Math.min(50000000, input.maxAssetBytes)
      : DEFAULT_EXPORT_OPTIONS.maxAssetBytes,
    includeTokens: input.includeTokens !== false,
    detail: input.detail === "summary" || input.detail === "structure" || input.detail === "full"
      ? input.detail
      : DEFAULT_EXPORT_OPTIONS.detail,
    ...(typeof input.knownSnapshotId === "string" && input.knownSnapshotId.trim()
      ? { knownSnapshotId: input.knownSnapshotId.trim() }
      : {}),
    changedOnly: input.changedOnly === true,
  };
}

function rememberChangedNodeIds(ids, deletedIds) {
  const normalized = Array.from(new Set(
    (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && id),
  ));
  const deleted = Array.from(new Set(
    (Array.isArray(deletedIds) ? deletedIds : [deletedIds]).filter((id) => typeof id === "string" && id),
  ));
  if (!normalized.length && !deleted.length) return;
  snapshotState.changeLog.push({
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    ids: normalized,
    deletedIds: deleted,
  });
  if (snapshotState.changeLog.length > 256) snapshotState.changeLog.shift();
}

function syncSelectionRevision() {
  const items = selectionItems();
  const key = items.map((item) => nodeId(item)).filter(Boolean).join(",");
  if (key === snapshotState.selectionKey) return;
  snapshotState.selectionKey = key;
  snapshotState.selectionRevision += 1;
  rememberChangedNodeIds(items.map((item) => nodeId(item)));
}

function snapshotFor(scope, screenId, options) {
  syncSelectionRevision();
  const info = documentInfo();
  const optionKey = [
    options.detail,
    options.includeAssets,
    options.maxAssetBytes,
    options.includeTokens,
  ].join(":");
  const id = [
    snapshotState.sessionId,
    info.documentId,
    snapshotState.documentRevision,
    snapshotState.selectionRevision,
    scope,
    screenId || "",
    optionKey,
  ].join("|");
  const known = options.knownSnapshotId
    ? snapshotState.snapshots.get(options.knownSnapshotId)
    : undefined;
  const changedNodeIds = new Set();
  const deletedNodeIds = new Set();
  snapshotState.changeLog.forEach((change) => {
    if (!known
      || change.documentRevision > known.documentRevision
      || change.selectionRevision > known.selectionRevision) {
      change.ids.forEach((nodeId) => changedNodeIds.add(nodeId));
      change.deletedIds.forEach((nodeId) => deletedNodeIds.add(nodeId));
    }
  });
  deletedNodeIds.forEach((nodeId) => changedNodeIds.delete(nodeId));
  const snapshot = {
    id,
    scope,
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    ...(screenId ? { screenId } : {}),
    ...(changedNodeIds.size
      ? { changedNodeIds: Array.from(changedNodeIds).slice(-2000) }
      : {}),
    ...(deletedNodeIds.size
      ? { deletedNodeIds: Array.from(deletedNodeIds).slice(-2000) }
      : {}),
    generatedAt: new Date().toISOString(),
  };
  snapshotState.snapshots.set(id, {
    documentRevision: snapshot.documentRevision,
    selectionRevision: snapshot.selectionRevision,
  });
  if (snapshotState.snapshots.size > 128) {
    const first = snapshotState.snapshots.keys().next().value;
    if (first) snapshotState.snapshots.delete(first);
  }
  return snapshot;
}

function nodeForDetail(node, detail) {
  if (detail === "full") return node;
  const summaryKeys = new Set([
    "id", "name", "kind", "parentId", "children", "bounds", "renderBounds",
    "visible", "locked", "description", "rotation", "transform", "clipsContent",
    "minWidth", "maxWidth", "minHeight", "maxHeight", "constraints", "layoutAlign",
    "layoutGrow", "layoutPositioning", "gridPosition", "layout", "hostData",
  ]);
  const structureKeys = new Set([
    ...summaryKeys,
    "styleRefs", "variableBindings", "component", "accessibility", "annotations",
    "text", "textSegments", "typography", "prototypeLinks",
  ]);
  const keys = detail === "summary" ? summaryKeys : structureKeys;
  return Object.fromEntries(Object.entries(node).filter(([key]) => keys.has(key)));
}

function exportStateFor(options) {
  return {
    options,
    assetExports: 0,
    assetCount: 0,
    assetBytes: 0,
    assetsOmitted: 0,
  };
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  return value.length;
}

function nodeId(node) {
  if (typeof node === "string") return node;
  if (!node) return null;
  return node.guid || node.id || null;
}

function nodeType(node) {
  return node && node.constructor && node.constructor.name
    ? node.constructor.name
    : "Unknown";
}

function nodeKind(node) {
  switch (nodeType(node)) {
    case "RootNode":
      return "root";
    case "Artboard":
      return "screen";
    case "Group":
    case "BooleanGroup":
      return "group";
    case "Rectangle":
      return "rectangle";
    case "Ellipse":
      return "ellipse";
    case "Line":
      return "line";
    case "Path":
    case "Polygon":
      return "path";
    case "Text":
      return "text";
    case "Symbol":
    case "Component":
      return "component";
    case "SymbolInstance":
    case "ComponentInstance":
      return "instance";
    case "RepeatGrid":
      return "repeat-grid";
    default:
      return "unknown";
  }
}

function childrenOf(node) {
  const children = node && node.children;
  if (!children || typeof children.forEach !== "function") return [];
  const result = [];
  children.forEach((child) => result.push(child));
  return result;
}

function boxFrom(value) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    width: Math.max(0, Number(value.width) || 0),
    height: Math.max(0, Number(value.height) || 0),
  };
}

function boundsOf(node) {
  return boxFrom(node && (node.globalBounds || node.localBounds));
}

function renderBoundsOf(node) {
  const bounds = boxFrom(node && node.globalDrawBounds);
  const layoutBounds = boundsOf(node);
  if (!bounds || !layoutBounds) return bounds;
  if (
    bounds.x === layoutBounds.x
    && bounds.y === layoutBounds.y
    && bounds.width === layoutBounds.width
    && bounds.height === layoutBounds.height
  ) return undefined;
  return bounds;
}

function affineTransformFor(value) {
  if (!value || typeof value !== "object") return undefined;
  const values = [value.a, value.b, value.c, value.d, value.e, value.f];
  if (!values.every((item) => Number.isFinite(item))) return undefined;
  return { a: value.a, b: value.b, c: value.c, d: value.d, tx: value.e, ty: value.f };
}

function colorFromXD(value) {
  if (!value || typeof value !== "object") return null;
  if (!Number.isFinite(value.r) || !Number.isFinite(value.g) || !Number.isFinite(value.b)) return null;
  const channelScale = Math.max(Math.abs(value.r), Math.abs(value.g), Math.abs(value.b)) > 1 ? 255 : 1;
  const color = {
    r: clamp(value.r / channelScale, 0, 1),
    g: clamp(value.g / channelScale, 0, 1),
    b: clamp(value.b / channelScale, 0, 1),
  };
  if (Number.isFinite(value.a)) color.a = clamp(value.a / (channelScale > 1 || value.a > 1 ? 255 : 1), 0, 1);
  return color;
}

function valueTypeName(value) {
  if (!value || typeof value !== "object") return "";
  return `${value.type || ""} ${value.constructor && value.constructor.name || ""}`.toLowerCase();
}

function gradientTypeFor(value) {
  const name = valueTypeName(value);
  if (name.includes("radial")) return "radial";
  if (name.includes("angular") || name.includes("conical")) return "angular";
  if (name.includes("diamond")) return "diamond";
  return "linear";
}

function scaleModeFor(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("fill")) return "fill";
  if (normalized.includes("fit")) return "fit";
  if (normalized.includes("crop")) return "crop";
  if (normalized.includes("tile")) return "tile";
  return undefined;
}

function fillRecordFromXD(value) {
  const color = colorFromXD(value);
  if (color) {
    return {
      type: "solid",
      color,
      ...(color.a !== undefined ? { opacity: color.a } : {}),
    };
  }

  const typeName = valueTypeName(value);
  if (typeName.includes("imagefill") || typeName.includes("image")) {
    const resource = nonEmptyString(value.assetId) || nonEmptyString(value.imageAssetId);
    const scaleMode = scaleModeFor(value.scaleBehavior || value.scaleMode);
    const imageTransform = affineTransformFor(value.transform || value.imageTransform);
    return {
      type: "image",
      ...(resource ? { resource } : {}),
      ...(scaleMode ? { imageScaleMode: scaleMode } : {}),
      ...(imageTransform ? { imageTransform } : {}),
      ...(Number.isFinite(value.scale) && value.scale > 0 ? { imageScaleFactor: value.scale } : {}),
      ...(Number.isFinite(value.rotation) ? { imageRotation: value.rotation } : {}),
    };
  }

  const stops = Array.isArray(value && value.colorStops)
    ? value.colorStops
    : Array.isArray(value && value.stops)
      ? value.stops
      : [];
  if (typeName.includes("gradient") || stops.length) {
    const gradientStops = stops
      .map((stop) => {
        const stopColor = colorFromXD(stop && (stop.color || stop.value));
        const position = Number.isFinite(stop && stop.position)
          ? stop.position
          : Number.isFinite(stop && stop.stop)
            ? stop.stop
          : Number.isFinite(stop && stop.offset)
            ? stop.offset
            : 0;
        return stopColor ? { position: clamp(position, 0, 1), color: stopColor } : null;
      })
      .filter(Boolean);
    const gradientTransform = affineTransformFor(value.transform || value.gradientTransform);
    const center = typeof value.getCenterPoint === "function"
      ? safeRead(() => value.getCenterPoint(), null)
      : value.center;
    const gradientCenter = center && Number.isFinite(center.x) && Number.isFinite(center.y)
      ? { x: center.x, y: center.y }
      : undefined;
    return {
      type: "gradient",
      gradientType: gradientTypeFor(value),
      ...(gradientStops.length ? { gradientStops } : {}),
      ...(gradientCenter ? { gradientCenter } : {}),
      ...(Number.isFinite(value.endR) && value.endR >= 0 ? { gradientRadius: value.endR } : Number.isFinite(value.radius) && value.radius >= 0 ? { gradientRadius: value.radius } : {}),
      ...(gradientTransform ? { gradientTransform } : {}),
    };
  }

  return { type: "unknown" };
}

function fillsFromXD(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(fillRecordFromXD);
  return [fillRecordFromXD(value)];
}

function strokeFor(node) {
  if (!node || node.strokeEnabled === false || !node.stroke) return undefined;
  const fills = fillsFromXD(node.stroke);
  if (!fills.length) return undefined;
  const positionValue = typeof node.strokePosition === "string"
    ? node.strokePosition.toLowerCase()
    : undefined;
  const position = ["inside", "outside", "center"].includes(positionValue)
    ? positionValue
    : undefined;
  const dashPattern = Array.isArray(node.strokeDashArray)
    ? node.strokeDashArray.filter((value) => Number.isFinite(value)).map((value) => Math.max(0, value))
    : undefined;
  const cap = nonEmptyString(node.strokeEndCaps || node.strokeCap);
  const join = nonEmptyString(node.strokeJoins || node.strokeJoin);
  return {
    fills,
    ...(Number.isFinite(node.strokeWidth) ? { weight: Math.max(0, node.strokeWidth) } : {}),
    ...(position ? { position } : {}),
    ...(dashPattern && dashPattern.length ? { dashPattern } : {}),
    ...(cap ? { cap: cap.toLowerCase() } : {}),
    ...(join ? { join: join.toLowerCase() } : {}),
  };
}

function effectsFor(node) {
  const effects = [];
  const shadow = safeRead(() => node.shadow, null);
  const innerShadow = safeRead(() => node.innerShadow, null);
  const addShadow = (value, type) => {
    if (!value) return;
    const offsetSource = value.offset || value;
    const offset = Number.isFinite(offsetSource.x) && Number.isFinite(offsetSource.y)
      ? { x: offsetSource.x, y: offsetSource.y }
      : undefined;
    const color = colorFromXD(value.color);
    effects.push({
      type,
      ...(color ? { color } : {}),
      ...(offset ? { offset } : {}),
      ...(Number.isFinite(value.blur)
        ? { radius: Math.max(0, value.blur) }
        : Number.isFinite(value.radius) ? { radius: Math.max(0, value.radius) } : {}),
      ...(Number.isFinite(value.spread) ? { spread: value.spread } : {}),
      ...(typeof value.visible === "boolean" ? { visible: value.visible } : {}),
    });
  };
  addShadow(shadow, "drop-shadow");
  addShadow(innerShadow, "inner-shadow");
  const blur = safeRead(() => node.blur, null);
  if (Number.isFinite(blur)) {
    effects.push({ type: "layer-blur", radius: Math.max(0, blur) });
  } else if (blur && typeof blur === "object") {
    effects.push({
      type: "layer-blur",
      ...(Number.isFinite(blur.value) ? { radius: Math.max(0, blur.value) } : {}),
      ...(Number.isFinite(blur.strength) ? { radius: Math.max(0, blur.strength) } : {}),
      ...(typeof blur.visible === "boolean" ? { visible: blur.visible } : {}),
    });
  }
  return effects.length ? effects : undefined;
}

function cornersFor(node) {
  const values = safeRead(() => node.effectiveCornerRadii || node.cornerRadii, null);
  const list = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? [values.topLeft, values.topRight, values.bottomRight, values.bottomLeft]
      : [];
  if (list.length >= 4 && list.every((value) => Number.isFinite(value))) {
    return {
      cornerRadii: {
        topLeft: Math.max(0, list[0]),
        topRight: Math.max(0, list[1]),
        bottomRight: Math.max(0, list[2]),
        bottomLeft: Math.max(0, list[3]),
      },
    };
  }
  if (Number.isFinite(node.cornerRadius) && node.cornerRadius > 0) {
    return { cornerRadius: Math.max(0, node.cornerRadius) };
  }
  return {};
}

function textAlignFor(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("justify")) return "justified";
  if (normalized.includes("center")) return "center";
  if (normalized.includes("right")) return "right";
  if (normalized.includes("left")) return "left";
  return undefined;
}

function typographyFromXD(value, fallback) {
  const source = value || fallback;
  if (!source) return undefined;
  const typography = {};
  const font = source.fontName || source.font;
  if (typeof source.fontFamily === "string") typography.family = source.fontFamily;
  else if (font && typeof font.family === "string") typography.family = font.family;
  if (typeof source.fontStyle === "string") typography.style = source.fontStyle;
  else if (font && typeof font.style === "string") typography.style = font.style;
  if (Number.isFinite(source.fontSize) && source.fontSize > 0) typography.size = source.fontSize;
  if (Number.isFinite(source.fontWeight) && source.fontWeight > 0) typography.weight = source.fontWeight;
  if (Number.isFinite(source.charSpacing)) typography.letterSpacing = source.charSpacing;
  if (Number.isFinite(source.lineHeight) && source.lineHeight > 0) typography.lineHeight = source.lineHeight;
  else if (Number.isFinite(source.lineSpacing) && source.lineSpacing > 0) typography.lineHeight = source.lineSpacing;
  const align = textAlignFor(source.textAlign || source.textAlignHorizontal);
  if (align) typography.align = align;
  if (source.underline === true) typography.decoration = "underline";
  else if (source.strikethrough === true) typography.decoration = "strikethrough";
  const textCase = typeof source.textTransform === "string" ? source.textTransform.toLowerCase() : undefined;
  if (["original", "upper", "lower", "title", "small-caps", "small-caps-forced"].includes(textCase)) {
    typography.textCase = textCase;
  }
  return Object.keys(typography).length ? typography : undefined;
}

function textSegmentsFor(node) {
  if (nodeKind(node) !== "text") return undefined;
  const ranges = safeRead(() => node.styleRanges, []);
  if (!Array.isArray(ranges) || !ranges.length) return undefined;
  const text = typeof node.text === "string" ? node.text : "";
  let cursor = 0;
  const segments = [];
  ranges.forEach((range) => {
    const start = Number.isInteger(range.start)
      ? range.start
      : Number.isInteger(range.from)
        ? range.from
        : cursor;
    const end = Number.isInteger(range.end)
      ? range.end
      : Number.isInteger(range.to)
        ? range.to
        : Number.isInteger(range.length)
          ? start + range.length
          : text.length;
    const safeStart = Math.max(0, Math.min(text.length, start));
    const safeEnd = Math.max(safeStart, Math.min(text.length, end));
    const typography = typographyFromXD(range, node);
    const fills = range.fills
      ? fillsFromXD(range.fills)
      : range.fill
        ? fillsFromXD(range.fill)
        : undefined;
    const styleRefs = {};
    const styleId = nonEmptyString(range.styleId || range.characterStyleId);
    if (styleId) styleRefs.text = styleId;
    segments.push({
      start: safeStart,
      end: safeEnd,
      characters: text.slice(safeStart, safeEnd),
      ...(typography ? { typography } : {}),
      ...(fills && fills.length ? { fills } : {}),
      ...(Object.keys(styleRefs).length ? { styleRefs } : {}),
      ...(range.hyperlink ? { hyperlink: range.hyperlink } : {}),
    });
    cursor = safeEnd;
  });
  return segments.length ? segments : undefined;
}

function normalizeMode(value) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z]/g, "_") : "";
}

function paddingFor(value) {
  const raw = value && value.values !== undefined ? value.values : value;
  if (Array.isArray(raw)) {
    if (raw.length === 1 && Number.isFinite(raw[0])) {
      return { top: raw[0], right: raw[0], bottom: raw[0], left: raw[0] };
    }
    if (raw.length >= 4 && raw.slice(0, 4).every((item) => Number.isFinite(item))) {
      return { top: raw[0], right: raw[1], bottom: raw[2], left: raw[3] };
    }
  }
  if (!raw || typeof raw !== "object") return undefined;
  const names = ["top", "right", "bottom", "left"];
  if (!names.some((name) => Number.isFinite(raw[name]))) return undefined;
  return Object.fromEntries(names.map((name) => [name, Math.max(0, Number(raw[name]) || 0)]));
}

function sizingFor(...values) {
  for (const value of values) {
    const normalized = normalizeMode(value);
    if (normalized.includes("HUG") || normalized.includes("CONTENT")) return "hug";
    if (normalized.includes("FILL") || normalized.includes("STRETCH") || normalized.includes("RESPONSIVE")) return "fill";
    if (normalized.includes("FIXED")) return "fixed";
  }
  return undefined;
}

function layoutFor(node) {
  const layout = safeRead(() => node.layout, null);
  if (!layout || typeof layout !== "object") return undefined;
  const stack = layout.stack && typeof layout.stack === "object" ? layout.stack : {};
  const orientation = normalizeMode(stack.orientation || stack.direction || layout.orientation);
  const type = normalizeMode(layout.type);
  const mode = orientation.includes("HORIZONTAL")
    ? "horizontal"
    : orientation.includes("VERTICAL")
      ? "vertical"
      : type.includes("STACK") && normalizeMode(stack.orientation).includes("HORIZONTAL")
        ? "horizontal"
        : type.includes("STACK") && normalizeMode(stack.orientation).includes("VERTICAL")
          ? "vertical"
          : "none";
  const padding = paddingFor(layout.padding);
  const gap = Number.isFinite(stack.spacing)
    ? stack.spacing
    : Number.isFinite(stack.gap)
      ? stack.gap
      : Number.isFinite(layout.gap)
        ? layout.gap
        : undefined;
  const sizingHorizontal = sizingFor(node.horizontalResizing, layout.horizontalResizing);
  const sizingVertical = sizingFor(node.verticalResizing, layout.verticalResizing);
  const positioningValue = normalizeMode(layout.positioning || node.layoutPositioning);
  const layoutPositioning = positioningValue.includes("ABSOLUTE") ? "absolute" : undefined;
  const meaningful = Boolean(
    (type && !type.includes("NONE"))
    || mode !== "none"
    || padding
    || gap !== undefined
    || sizingHorizontal
    || sizingVertical
    || layoutPositioning,
  );
  if (!meaningful) return undefined;
  return {
    mode,
    ...(Number.isFinite(gap) && gap >= 0 ? { gap } : {}),
    ...(padding ? { padding } : {}),
    ...(sizingHorizontal ? { sizingHorizontal } : {}),
    ...(sizingVertical ? { sizingVertical } : {}),
  };
}

function layoutPositioningFor(node) {
  const layout = safeRead(() => node.layout, null);
  const value = normalizeMode(layout && layout.positioning || node.layoutPositioning);
  return value.includes("ABSOLUTE") ? "absolute" : undefined;
}

function constraintFor(value, axis) {
  const normalized = normalizeMode(value);
  if (normalized.includes("LEFT_RIGHT") || normalized.includes("TOP_BOTTOM") || normalized === "BOTH") {
    return axis === "horizontal" ? "left-right" : "top-bottom";
  }
  if (normalized.includes("LEFT")) return "left";
  if (normalized.includes("RIGHT")) return "right";
  if (normalized.includes("TOP")) return "top";
  if (normalized.includes("BOTTOM")) return "bottom";
  if (normalized.includes("CENTER")) return "center";
  if (normalized.includes("SCALE")) return "scale";
  return undefined;
}

function constraintsFor(node) {
  const horizontal = constraintFor(node.horizontalConstraints, "horizontal");
  const vertical = constraintFor(node.verticalConstraints, "vertical");
  if (!horizontal && !vertical) return undefined;
  return {
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
  };
}

function pluginDataFor(node, key) {
  const readers = [
    () => node.sharedPluginData && typeof node.sharedPluginData.getItem === "function"
      ? node.sharedPluginData.getItem("designport", key)
      : undefined,
    () => typeof node.getSharedPluginData === "function" ? node.getSharedPluginData("designport", key) : undefined,
    () => typeof node.getPluginData === "function" ? node.getPluginData(key) : undefined,
    () => node.sharedPluginData && node.sharedPluginData.designport && node.sharedPluginData.designport[key],
    () => {
      const data = node.pluginData;
      if (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, key)) return data[key];
      if (key === "tokens" && Array.isArray(data)) return data;
      if (key === "accessibility" && data && typeof data === "object"
        && ["role", "label", "description", "altText", "headingLevel", "focusable", "decorative"]
          .some((field) => Object.prototype.hasOwnProperty.call(data, field))) return data;
      return undefined;
    },
  ];
  for (const read of readers) {
    const value = safeRead(read, undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") return value;
  }
  return undefined;
}

function objectPluginDataFor(node, key) {
  const raw = pluginDataFor(node, key);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch (_error) {
      return undefined;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
}

function styleRefsFor(node) {
  const refs = {};
  const fields = {
    fill: ["fillStyleId", "fillStyle", "colorStyleId"],
    stroke: ["strokeStyleId", "strokeStyle"],
    text: ["textStyleId", "characterStyleId"],
    effect: ["effectStyleId", "effectStyle"],
    grid: ["gridStyleId", "gridStyle"],
  };
  Object.entries(fields).forEach(([kind, candidates]) => {
    const value = candidates
      .map((field) => safeRead(() => node[field], undefined))
      .find((item) => typeof item === "string" && item.trim());
    if (value) refs[kind] = value.trim();
  });
  const configured = objectPluginDataFor(node, "styleRefs");
  if (configured) {
    Object.entries(configured).forEach(([kind, value]) => {
      if (["fill", "stroke", "text", "effect", "grid"].includes(kind)
        && typeof value === "string" && value.trim()) refs[kind] = value.trim();
    });
  }
  return Object.keys(refs).length ? refs : undefined;
}

function variableBindingsFor(node) {
  const configured = objectPluginDataFor(node, "variableBindings");
  if (!configured) return undefined;
  const bindings = {};
  Object.entries(configured).forEach(([field, value]) => {
    const ids = (Array.isArray(value) ? value : [value])
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
    if (ids.length) bindings[field] = ids;
  });
  return Object.keys(bindings).length ? bindings : undefined;
}

function inferredAccessibilityFor(node) {
  const name = `${node.name || ""} ${nodeType(node)}`.toLowerCase();
  const headingMatch = name.match(/(?:^|[\s/_-])h([1-6])(?:$|[\s/_-])|(?:^|[\s/_-])heading(?:$|[\s/_-])/);
  if (headingMatch || nodeKind(node) === "text" && /title|heading/.test(name)) {
    return {
      role: "heading",
      ...(headingMatch && headingMatch[1] ? { headingLevel: Number(headingMatch[1]) } : {}),
      confidence: 0.55,
    };
  }
  const rolePatterns = [
    ["button", /button|cta/],
    ["link", /link|hyperlink/],
    ["checkbox", /checkbox/],
    ["switch", /switch|toggle/],
    ["textbox", /input|textfield|text-field|search/],
    ["tab", /tab/],
    ["navigation", /navigation|navbar|nav-bar|bottom-nav/],
    ["img", /image|photo|avatar|thumbnail/],
  ];
  const match = rolePatterns.find(([, pattern]) => pattern.test(name));
  return match ? { role: match[0], confidence: 0.4 } : undefined;
}

function booleanData(value) {
  if (value === true || value === false) return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function accessibilityFor(node) {
  let configured = pluginDataFor(node, "accessibility");
  if (typeof configured === "string") {
    try {
      const parsed = JSON.parse(configured);
      configured = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      configured = {};
    }
  }
  if (!configured || typeof configured !== "object") configured = {};
  const configuredRole = nonEmptyString(configured.role) || nonEmptyString(pluginDataFor(node, "a11y.role"));
  const configuredLabel = typeof configured.label === "string" ? configured.label : pluginDataFor(node, "a11y.label");
  const configuredDescription = typeof configured.description === "string" ? configured.description : pluginDataFor(node, "a11y.description");
  const configuredAltText = typeof configured.altText === "string" ? configured.altText : pluginDataFor(node, "a11y.altText");
  const configuredHeadingLevel = Number(configured.headingLevel || pluginDataFor(node, "a11y.headingLevel"));
  const configuredFocusable = typeof configured.focusable === "boolean" ? configured.focusable : booleanData(pluginDataFor(node, "a11y.focusable"));
  const configuredDecorative = typeof configured.decorative === "boolean" ? configured.decorative : booleanData(pluginDataFor(node, "a11y.decorative"));
  const inferred = inferredAccessibilityFor(node) || {};
  const explicit = Boolean(
    configuredRole
    || configuredLabel !== undefined
    || configuredDescription !== undefined
    || configuredAltText !== undefined
    || Number.isInteger(configuredHeadingLevel)
    || configuredFocusable !== undefined
    || configuredDecorative !== undefined,
  );
  const role = configuredRole || inferred.role;
  const nodeText = typeof node.text === "string" ? node.text : "";
  const label = configuredLabel !== undefined
    ? configuredLabel
    : role && ["button", "link", "tab", "img", "textbox"].includes(role) && nodeKind(node) === "text"
      ? nodeText
      : undefined;
  const description = configuredDescription || nonEmptyString(node.description);
  const headingLevel = Number.isInteger(configuredHeadingLevel) && configuredHeadingLevel >= 1 && configuredHeadingLevel <= 6
    ? configuredHeadingLevel
    : inferred.headingLevel;
  if (!role && label === undefined && description === undefined && configuredAltText === undefined && headingLevel === undefined
    && configuredFocusable === undefined && configuredDecorative === undefined) return undefined;
  return {
    ...(role ? { role } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(configuredAltText !== undefined ? { altText: configuredAltText } : {}),
    ...(headingLevel !== undefined ? { headingLevel } : {}),
    ...(configuredFocusable !== undefined ? { focusable: configuredFocusable } : {}),
    ...(configuredDecorative !== undefined ? { decorative: configuredDecorative } : {}),
    source: explicit ? "explicit" : "inferred",
    confidence: explicit ? 1 : inferred.confidence,
  };
}

function annotationsFor(node) {
  const annotations = safeRead(() => node.annotations, []);
  if (!Array.isArray(annotations) || !annotations.length) return undefined;
  const result = annotations.map((annotation) => ({
    ...(typeof annotation.label === "string" ? { label: annotation.label } : {}),
    ...(typeof annotation.labelMarkdown === "string" ? { labelMarkdown: annotation.labelMarkdown } : {}),
    ...(typeof annotation.categoryId === "string" ? { categoryId: annotation.categoryId } : {}),
    ...(Array.isArray(annotation.properties) ? {
      properties: annotation.properties.map((property) => property && property.type).filter((type) => typeof type === "string"),
    } : {}),
  }));
  return result.length ? result : undefined;
}

function statesFor(variantProperties) {
  if (!variantProperties || typeof variantProperties !== "object") return undefined;
  const states = {};
  Object.entries(variantProperties).forEach(([key, value]) => {
    if (typeof value === "string" && /(state|status|interaction|mode)/i.test(key)) states[key] = value;
  });
  return Object.keys(states).length ? states : undefined;
}

function componentFor(node) {
  const kind = nodeKind(node);
  const instance = kind === "instance";
  const component = kind === "component";
  if (!instance && !component) return undefined;
  const symbolId = nonEmptyString(node.symbolId) || nonEmptyString(node.symbol && node.symbol.guid);
  const id = symbolId || nodeId(node);
  if (!id) return undefined;
  const variantProperties = safeRead(() => node.variantProperties, undefined);
  const variant = variantProperties && typeof variantProperties === "object"
    ? Object.fromEntries(Object.entries(variantProperties).filter(([, value]) => typeof value === "string"))
    : undefined;
  const states = statesFor(variant);
  return {
    id,
    ...(typeof node.name === "string" ? { name: node.name } : {}),
    ...(variant && Object.keys(variant).length ? { variantProperties: variant } : {}),
    ...(states ? { states } : {}),
    ...(instance ? { ...(symbolId ? { mainComponentId: symbolId } : {}), isInstance: true } : {}),
  };
}

function snakeCase(value) {
  return String(value || "unknown")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function prototypeLinksFor(node) {
  const interactions = safeRead(() => node.triggeredInteractions, []);
  if (!Array.isArray(interactions) || !interactions.length) return undefined;
  const links = [];
  interactions.forEach((interaction) => {
    const triggerObject = interaction && interaction.trigger || {};
    const action = interaction && interaction.action || {};
    if (!action || typeof action !== "object") return;
    const actionType = snakeCase(action.type);
    const destination = action.destination || action.destinationArtboard;
    const transition = action.transition || {};
    const data = {};
    if (triggerObject && typeof triggerObject === "object") {
      ["time", "delay", "key", "keyName"].forEach((key) => {
        if (triggerObject[key] !== undefined) data[key] = triggerObject[key];
      });
    }
    links.push({
      trigger: snakeCase(triggerObject.type || "unknown"),
      action: actionType || "unknown",
      ...(nodeId(destination) ? { destinationId: nodeId(destination) } : {}),
      ...(typeof action.url === "string" ? { url: action.url } : {}),
      ...(actionType.includes("artboard") || actionType.includes("overlay") ? { navigation: "navigate" } : {}),
      ...(typeof transition.type === "string" ? { transition: snakeCase(transition.type) } : {}),
      ...(Number.isFinite(transition.duration) ? { duration: Math.max(0, transition.duration) } : {}),
      ...(typeof transition.easing === "string"
        ? { easing: snakeCase(transition.easing) }
        : transition.easing && typeof transition.easing.type === "string"
          ? { easing: snakeCase(transition.easing.type) }
          : {}),
      ...(typeof action.preserveScrollPosition === "boolean" ? { preserveScrollPosition: action.preserveScrollPosition } : {}),
      ...(Object.keys(data).length ? { data } : {}),
    });
  });
  return links.length ? links : undefined;
}

function tokenCatalog(options) {
  if (!options.includeTokens || options.detail === "summary") return [];
  const raw = pluginDataFor(scenegraph.root, "tokens");
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const tokenTypes = new Set(["color", "number", "string", "boolean", "typography", "effect", "grid", "unknown"]);
  const tokenSources = new Set(["variable", "paint-style", "text-style", "effect-style", "grid-style", "unknown"]);
  return parsed
    .filter((token) => token && typeof token.id === "string" && typeof token.name === "string")
    .map((token) => ({
      ...token,
      type: tokenTypes.has(token.type) ? token.type : "unknown",
      source: tokenSources.has(token.source) ? token.source : "unknown",
    }));
}

function imageFillFor(node) {
  const fill = safeRead(() => node.fill, null);
  const name = valueTypeName(fill);
  return Boolean(fill && (name.includes("imagefill") || name.includes("image")));
}

function bytesFromArrayBuffer(value) {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function base64FromArrayBuffer(value) {
  const bytes = bytesFromArrayBuffer(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | (second >> 4)];
    result += index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : "=";
    result += index + 2 < bytes.length ? alphabet[third & 63] : "=";
  }
  return result;
}

function stringFromBytes(value) {
  const bytes = bytesFromArrayBuffer(value);
  if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

async function readText(file) {
  if (formats.utf8) {
    try {
      const value = await file.read({ format: formats.utf8 });
      if (typeof value === "string") return value;
    } catch (_error) {
      // Fall through to binary decoding for older UXP runtimes.
    }
  }
  return stringFromBytes(await file.read({ format: formats.binary }));
}

async function createRendition(node, type, extension, index) {
  const folder = await localFileSystem.getTemporaryFolder();
  const file = await folder.createFile(`designport-${Date.now()}-${index}.${extension}`);
  const renditionType = application.RenditionType && application.RenditionType[type]
    ? application.RenditionType[type]
    : type.toLowerCase();
  await application.createRenditions([{
    node,
    outputFile: file,
    type: renditionType,
    scale: 1,
  }]);
  return file;
}

async function exportNodeAsset(node, kind) {
  try {
    const file = await createRendition(node, "SVG", "svg", "asset");
    const data = await readText(file);
    if (data && data.trim()) {
      return { mimeType: "image/svg+xml", data, kind, byteSize: utf8ByteLength(data) };
    }
  } catch (_error) {
    // Some XD nodes cannot be rendered as SVG; PNG is the safe fallback.
  }
  try {
    const file = await createRendition(node, "PNG", "png", "asset");
    const bytes = await file.read({ format: formats.binary });
    return {
      mimeType: "image/png",
      data: base64FromArrayBuffer(bytes),
      kind,
      byteSize: bytesFromArrayBuffer(bytes).byteLength,
    };
  } catch (_error) {
    return undefined;
  }
}

function assetCacheKey(node) {
  return `${documentInfo().documentId}:${nodeId(node)}`;
}

async function assetFor(node, exportState) {
  if (!exportState.options.includeAssets || node.visible === false) return undefined;
  const kind = nodeKind(node);
  const isVector = kind === "path";
  const isImage = imageFillFor(node);
  if (!isVector && !isImage) return undefined;
  const key = assetCacheKey(node);
  const includeAsset = (asset) => {
    if (!asset) {
      exportState.assetsOmitted += 1;
      return undefined;
    }
    const byteSize = Number.isFinite(asset.byteSize) ? asset.byteSize : 0;
    if (exportState.assetBytes + byteSize > exportState.options.maxAssetBytes) {
      exportState.assetsOmitted += 1;
      return undefined;
    }
    exportState.assetCount += 1;
    exportState.assetBytes += byteSize;
    return asset;
  };
  if (assetCache.has(key)) return includeAsset(assetCache.get(key));
  const pending = assetPromises.get(key);
  if (pending) return includeAsset(await pending);
  if (exportState.assetExports >= MAX_ASSET_EXPORTS_PER_REQUEST) {
    exportState.assetsOmitted += 1;
    return undefined;
  }
  exportState.assetExports += 1;
  const promise = exportNodeAsset(node, isImage ? "image" : "vector");
  assetPromises.set(key, promise);
  try {
    const asset = await promise;
    assetCache.set(key, asset);
    return includeAsset(asset);
  } finally {
    assetPromises.delete(key);
  }
}

function viewportFor(bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  const orientation = bounds.width === bounds.height
    ? "square"
    : bounds.width > bounds.height
      ? "landscape"
      : "portrait";
  const breakpoint = bounds.width < 600
    ? "compact"
    : bounds.width < 1024
      ? "medium"
      : "expanded";
  return { width: bounds.width, height: bounds.height, orientation, breakpoint };
}

function screenDetailsFor(root) {
  return childrenOf(root)
    .filter((child) => nodeKind(child) === "screen")
    .map((child) => {
      const viewport = viewportFor(boundsOf(child));
      return viewport
        ? { node: { host: "xd", id: nodeId(child) }, name: child.name || nodeType(child), viewport }
        : undefined;
    })
    .filter(Boolean);
}

async function nodeToIR(node, parentId, topLevel, exportState) {
  const id = nodeId(node);
  if (!id) return null;
  const children = childrenOf(node);
  const bounds = boundsOf(node);
  const renderBounds = renderBoundsOf(node);
  const transform = affineTransformFor(safeRead(() => node.transform, null));
  const fills = safeRead(() => node.fillEnabled === false ? [] : fillsFromXD(node.fill), []);
  const stroke = strokeFor(node);
  const effects = effectsFor(node);
  const corners = cornersFor(node);
  const typography = typographyFromXD(node);
  const textSegments = textSegmentsFor(node);
  const layout = layoutFor(node);
  const layoutPositioning = layoutPositioningFor(node);
  const constraints = constraintsFor(node);
  const component = componentFor(node);
  const accessibility = accessibilityFor(node);
  const annotations = annotationsFor(node);
  const prototypeLinks = prototypeLinksFor(node);
  const styleRefs = styleRefsFor(node);
  const variableBindings = variableBindingsFor(node);
  const asset = exportState.options.detail === "full"
    ? await assetFor(node, exportState)
    : undefined;
  const description = nonEmptyString(node.description);
  const blendMode = nonEmptyString(node.blendMode);
  const hostData = {
    xdType: nodeType(node),
    guid: id,
    ...(Number.isFinite(node.rotation) ? { rotation: node.rotation } : {}),
    ...(nonEmptyString(node.symbolId) ? { symbolId: node.symbolId } : {}),
    ...(node.isMaster === true ? { isMaster: true } : {}),
    topLevel: Boolean(topLevel),
  };
  return nodeForDetail({
    id,
    name: typeof node.name === "string" ? node.name : nodeType(node),
    kind: nodeKind(node),
    parentId: parentId || null,
    children: children.map(nodeId).filter(Boolean),
    bounds,
    ...(renderBounds ? { renderBounds } : {}),
    visible: node.visible !== false,
    ...(typeof node.locked === "boolean" ? { locked: node.locked } : {}),
    ...(description ? { description } : {}),
    ...(Number.isFinite(node.opacity) ? { opacity: clamp(node.opacity, 0, 1) } : {}),
    ...(blendMode && blendMode.toLowerCase() !== "normal" ? { blendMode: blendMode.toLowerCase() } : {}),
    ...(fills.length ? { fills } : {}),
    ...(stroke ? { strokes: [stroke] } : {}),
    ...(effects ? { effects } : {}),
    ...corners,
    ...(asset ? { asset } : {}),
    ...(transform ? { transform } : {}),
    ...(constraints ? { constraints } : {}),
    ...(layoutPositioning ? { layoutPositioning } : {}),
    ...(typeof node.layoutAlign === "string" ? { layoutAlign: node.layoutAlign.toLowerCase() } : {}),
    ...(Number.isFinite(node.layoutGrow) && node.layoutGrow > 0 ? { layoutGrow: node.layoutGrow } : {}),
    ...(layout ? { layout } : {}),
    ...(styleRefs ? { styleRefs } : {}),
    ...(variableBindings ? { variableBindings } : {}),
    ...(component ? { component } : {}),
    ...(accessibility ? { accessibility } : {}),
    ...(annotations ? { annotations } : {}),
    ...(typeof node.text === "string" ? { text: node.text } : {}),
    ...(textSegments ? { textSegments } : {}),
    ...(typography ? { typography } : {}),
    ...(prototypeLinks ? { prototypeLinks } : {}),
    hostData,
  }, exportState.options.detail);
}

function documentInfo() {
  const root = scenegraph.root;
  const activeDocument = application.activeDocument;
  return {
    documentId: nodeId(root) || (activeDocument && activeDocument.guid) || "xd-document",
    documentName: (activeDocument && activeDocument.name) || "Untitled XD document",
  };
}

function selectionItems() {
  return (scenegraph.selection && scenegraph.selection.items) || [];
}

function flattenSubtree(node, parentId, topLevel, entries) {
  entries.push({ node, parentId, topLevel });
  childrenOf(node).forEach((child) => flattenSubtree(child, nodeId(node), false, entries));
}

async function serializeEntries(entries, options, snapshot) {
  const unchanged = options.knownSnapshotId === snapshot.id;
  const changedIds = options.changedOnly && snapshot.changedNodeIds
    ? new Set(snapshot.changedNodeIds)
    : null;
  const sourceEntries = unchanged
    ? []
    : changedIds && changedIds.size
      ? entries.filter((entry) => changedIds.has(nodeId(entry.node)))
      : entries;
  const selected = sourceEntries.slice(options.nodeOffset, options.nodeOffset + options.maxNodes);
  const exportState = exportStateFor(options);
  const nodes = [];
  for (const entry of selected) {
    const node = await nodeToIR(entry.node, entry.parentId, entry.topLevel, exportState);
    if (node) nodes.push(node);
  }
  const hasMore = options.nodeOffset + nodes.length < sourceEntries.length;
  const partial = !unchanged && (
    Boolean(options.changedOnly && changedIds && changedIds.size)
    || options.nodeOffset > 0
    || hasMore
    || sourceEntries.length < entries.length
  );
  return {
    nodes,
    ...(unchanged ? { unchanged: true } : {}),
    ...(partial ? { partial: true } : {}),
    pagination: {
      offset: options.nodeOffset,
      limit: options.maxNodes,
      total: sourceEntries.length,
      returned: nodes.length,
      hasMore,
      ...(hasMore ? { nextOffset: options.nodeOffset + nodes.length } : {}),
    },
    exportStats: {
      totalNodes: entries.length,
      returnedNodes: nodes.length,
      assetCount: exportState.assetCount,
      assetBytes: exportState.assetBytes,
      assetsOmitted: exportState.assetsOmitted,
      tokenCount: 0,
    },
  };
}

async function buildDocumentIR(options) {
  const root = scenegraph.root;
  const entries = [];
  flattenSubtree(root, null, true, entries);
  const snapshot = snapshotFor("document", undefined, options);
  const serialized = await serializeEntries(entries, options, snapshot);
  const tokens = serialized.unchanged ? [] : tokenCatalog(options);
  const screens = childrenOf(root)
    .filter((child) => nodeKind(child) === "screen")
    .map((child) => ({ host: "xd", id: nodeId(child) }))
    .filter((ref) => ref.id);
  const screenDetails = screenDetailsFor(root);
  const info = documentInfo();
  const nodes = {};
  serialized.nodes.forEach((node) => { nodes[node.id] = node; });
  return {
    schemaVersion: 1,
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    rootId: nodeId(root) || info.documentId,
    nodes,
    screens,
    selection: selectionItems().map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    snapshot,
    ...(serialized.unchanged ? { unchanged: true } : {}),
    ...(serialized.partial ? { partial: true } : {}),
    ...(tokens.length ? { tokens } : {}),
    ...(screenDetails.length ? { screenDetails } : {}),
    pagination: serialized.pagination,
    exportStats: { ...serialized.exportStats, tokenCount: tokens.length },
    exportedAt: new Date().toISOString(),
  };
}

async function selectionContext(options) {
  const info = documentInfo();
  const selection = selectionItems();
  const entries = [];
  selection.forEach((item) => flattenSubtree(item, item.parent ? nodeId(item.parent) : null, item.parent === scenegraph.root, entries));
  const snapshot = snapshotFor("selection", undefined, options);
  const serialized = await serializeEntries(entries, options, snapshot);
  const tokens = serialized.unchanged ? [] : tokenCatalog(options);
  return {
    schemaVersion: 1,
    scope: "selection",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selection.map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    nodes: serialized.nodes,
    snapshot,
    ...(serialized.unchanged ? { unchanged: true } : {}),
    ...(serialized.partial ? { partial: true } : {}),
    ...(tokens.length ? { tokens } : {}),
    pagination: serialized.pagination,
    exportStats: { ...serialized.exportStats, tokenCount: tokens.length },
    exportedAt: new Date().toISOString(),
  };
}

function findNode(id) {
  if (!id) return null;
  try {
    return scenegraph.getNodeByGUID(id) || null;
  } catch (_error) {
    return null;
  }
}

function findScreen(id) {
  if (id) {
    const node = findNode(id);
    return node && nodeKind(node) === "screen" ? node : null;
  }
  const selected = selectionItems().find((item) => nodeKind(item) === "screen");
  if (selected) return selected;
  return childrenOf(scenegraph.root).find((item) => nodeKind(item) === "screen") || null;
}

async function screenContext(screenId, options) {
  const screen = findScreen(screenId);
  if (!screen) throw new Error("No XD artboard was found for the requested screen");
  const info = documentInfo();
  const entries = [];
  flattenSubtree(screen, screen.parent ? nodeId(screen.parent) : null, true, entries);
  const snapshot = snapshotFor("screen", nodeId(screen), options);
  const serialized = await serializeEntries(entries, options, snapshot);
  const tokens = serialized.unchanged ? [] : tokenCatalog(options);
  const viewport = viewportFor(boundsOf(screen));
  return {
    schemaVersion: 1,
    scope: "screen",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: nodeId(screen),
    selection: selectionItems().map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    snapshot,
    ...(serialized.unchanged ? { unchanged: true } : {}),
    ...(serialized.partial ? { partial: true } : {}),
    ...(viewport ? { viewport } : {}),
    nodes: serialized.nodes,
    ...(tokens.length ? { tokens } : {}),
    pagination: serialized.pagination,
    exportStats: { ...serialized.exportStats, tokenCount: tokens.length },
    exportedAt: new Date().toISOString(),
  };
}

function visualTargets(scope, screenId) {
  if (scope === "screen") {
    const screen = findScreen(screenId);
    if (!screen) throw new Error("No XD artboard was found for the requested visual context");
    return [screen];
  }
  const selected = selectionItems();
  if (!selected.length) throw new Error("XD selection is empty");
  return selected.slice(0, 4);
}

async function visualContext(scope, screenId) {
  const targets = visualTargets(scope, screenId);
  const items = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const bounds = boundsOf(target);
    const maxDimension = Math.max(bounds ? bounds.width : 0, bounds ? bounds.height : 0);
    const scale = maxDimension > 1024 ? Math.max(0.1, 1024 / maxDimension) : 1;
    const folder = await localFileSystem.getTemporaryFolder();
    const file = await folder.createFile(`designport-${Date.now()}-${index}.png`);
    await application.createRenditions([{
      node: target,
      outputFile: file,
      type: application.RenditionType.PNG,
      scale,
    }]);
    const bytes = await file.read({ format: formats.binary });
    items.push({
      nodeId: nodeId(target),
      nodeName: typeof target.name === "string" ? target.name : nodeType(target),
      mimeType: "image/png",
      data: base64FromArrayBuffer(bytes),
      bounds,
      scale,
    });
  }
  const info = documentInfo();
  return {
    schemaVersion: 1,
    scope,
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    items,
    exportedAt: new Date().toISOString(),
  };
}

function colorToHex(color) {
  if (!color) return "#FFFFFF";
  const channel = (value) => Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function applyPatch(node, patch) {
  if (patch.name) node.name = patch.name;
  if (typeof patch.visible === "boolean") node.visible = patch.visible;
  if (Number.isFinite(patch.opacity)) node.opacity = clamp(patch.opacity, 0, 1);
  if (patch.text !== undefined && nodeKind(node) === "text") node.text = patch.text;
  if (Array.isArray(patch.fills) && patch.fills[0] && patch.fills[0].color && node.fill !== undefined) {
    node.fill = new Color(colorToHex(patch.fills[0].color));
  }
  if (patch.bounds && (Number.isFinite(patch.bounds.width) || Number.isFinite(patch.bounds.height))) {
    const current = node.localBounds;
    node.resize(
      Number.isFinite(patch.bounds.width) ? patch.bounds.width : current.width,
      Number.isFinite(patch.bounds.height) ? patch.bounds.height : current.height,
    );
  }
}

function executeWrite(operation, payload, selection, documentRoot) {
  if (operation === "create_screen") {
    const spec = payload || {};
    const artboard = new Artboard();
    artboard.name = spec.name || "DesignPort Screen";
    artboard.resize(Number(spec.width) || 1440, Number(spec.height) || 900);
    documentRoot.addChild(artboard);
    if (Number.isFinite(spec.x) || Number.isFinite(spec.y)) {
      artboard.moveInParentCoordinates(Number(spec.x) || 0, Number(spec.y) || 0);
    }
    if (spec.background) artboard.fill = new Color(colorToHex(spec.background));
    selection.items = [artboard];
    return { status: "applied", node: { host: "xd", id: nodeId(artboard) }, kind: "screen" };
  }

  if (operation === "create_component") {
    const error = new Error("XD cannot create a new component definition through the plugin API");
    error.code = "XD_COMPONENT_CREATION_UNSUPPORTED";
    throw error;
  }

  if (operation === "update_selection") {
    const items = selection.items || [];
    if (!items.length) {
      const error = new Error("XD selection is empty");
      error.code = "EMPTY_SELECTION";
      throw error;
    }
    const patch = (payload && payload.patch) || {};
    items.forEach((node) => applyPatch(node, patch));
    selection.items = items;
    return { status: "applied", nodes: items.map((item) => ({ host: "xd", id: nodeId(item) })) };
  }

  const error = new Error(`Unsupported XD write operation: ${operation}`);
  error.code = "UNSUPPORTED_OPERATION";
  throw error;
}

function send(message) {
  if (state.socket && state.socket.readyState === 1) state.socket.send(JSON.stringify(message));
}

function sendResponse(requestId, ok, value) {
  send({ type: "response", requestId, ok, ...(ok ? { result: value } : { error: value }) });
}

function sendEvent(event, payload) {
  send({ type: "event", event, payload });
}

function errorPayload(error) {
  return {
    code: error && error.code ? error.code : "XD_PLUGIN_ERROR",
    message: error && error.message ? error.message : String(error),
  };
}

function queueWrite(request) {
  const pendingId = `xd-pending-${Date.now()}-${state.pendingWrites.length + 1}`;
  state.pendingWrites.push({ pendingId, request });
  renderPanel();
  sendResponse(request.requestId, true, {
    status: "queued",
    pendingId,
    requiresUserAction: true,
    pendingCount: state.pendingWrites.length,
    message: "Open the DesignPort panel and press Apply to edit the XD document.",
  });
  sendEvent("write.queued", { pendingId, requestId: request.requestId, operation: request.operation });
}

async function handleRequest(request) {
  try {
    switch (request.operation) {
      case "ping":
        sendResponse(request.requestId, true, { ok: true, host: "xd", at: new Date().toISOString() });
        return;
      case "get_capabilities":
        sendResponse(request.requestId, true, CAPABILITIES);
        return;
      case "get_selection_context":
        sendResponse(request.requestId, true, await selectionContext(exportOptionsFor(request.payload)));
        return;
      case "get_screen_context":
        sendResponse(request.requestId, true, await screenContext(request.payload && request.payload.screenId, exportOptionsFor(request.payload)));
        return;
      case "get_visual_context":
        sendResponse(request.requestId, true, await visualContext(
          (request.payload && request.payload.scope) || "screen",
          request.payload && request.payload.screenId,
        ));
        return;
      case "export_ir": {
        const scope = (request.payload && request.payload.scope) || "document";
        const options = exportOptionsFor(request.payload);
        const result = scope === "selection"
          ? await selectionContext(options)
          : scope === "screen"
            ? await screenContext(request.payload && request.payload.screenId, options)
            : await buildDocumentIR(options);
        sendResponse(request.requestId, true, result);
        return;
      }
      case "create_screen":
      case "create_component":
      case "update_selection":
        queueWrite(request);
        return;
      default: {
        const error = new Error(`Unknown DesignPort operation: ${request.operation}`);
        error.code = "UNKNOWN_OPERATION";
        throw error;
      }
    }
  } catch (error) {
    sendResponse(request.requestId, false, errorPayload(error));
  }
}

function connect() {
  if (state.socket && (state.socket.readyState === 0 || state.socket.readyState === 1)) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  try {
    const socket = new WebSocket(BRIDGE_URL);
    state.socket = socket;
    socket.onopen = () => {
      const info = documentInfo();
      send({
        type: "hello",
        protocolVersion: 1,
        host: "xd",
        pluginVersion: PLUGIN_VERSION,
        documentId: info.documentId,
        documentName: info.documentName,
        capabilities: CAPABILITIES,
      });
      setStatus("Connected");
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_error) {
        setStatus("Bridge sent invalid JSON");
        return;
      }
      if (message.type === "request") void handleRequest(message);
    };
    socket.onerror = () => setStatus("Bridge unavailable");
    socket.onclose = () => {
      if (state.socket === socket) state.socket = null;
      setStatus("Disconnected");
      if (!state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          connect();
        }, 2500);
      }
    };
  } catch (error) {
    setStatus(`Connect failed: ${error.message}`);
  }
}

function disconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function setStatus(text) {
  if (state.statusNode) state.statusNode.textContent = text;
}

function applyNextPending() {
  const item = state.pendingWrites.shift();
  if (!item) {
    renderPanel();
    return;
  }
  try {
    let result;
    application.editDocument((selection, documentRoot) => {
      result = executeWrite(item.request.operation, item.request.payload, selection, documentRoot);
    });
    snapshotState.documentRevision += 1;
    rememberChangedNodeIds([
      result && result.node && result.node.id,
      ...(result && Array.isArray(result.nodes) ? result.nodes.map((node) => node && node.id) : []),
    ]);
    assetCache.clear();
    assetPromises.clear();
    renderPanel();
    sendEvent("write.applied", {
      pendingId: item.pendingId,
      requestId: item.request.requestId,
      operation: item.request.operation,
      result,
    });
  } catch (error) {
    renderPanel();
    sendEvent("write.failed", {
      pendingId: item.pendingId,
      requestId: item.request.requestId,
      operation: item.request.operation,
      error: errorPayload(error),
    });
    setStatus(`Write failed: ${error.message}`);
  }
}

function renderPanel() {
  if (!state.panelRoot) return;
  if (state.pendingNode) {
    state.pendingNode.textContent = state.pendingWrites.length
      ? `${state.pendingWrites.length} pending write${state.pendingWrites.length === 1 ? "" : "s"}`
      : "No pending writes";
  }
  if (state.applyButton) state.applyButton.disabled = state.pendingWrites.length === 0;
}

function setupPanel(rootNode) {
  if (state.panelRoot === rootNode) {
    renderPanel();
    return;
  }
  state.panelRoot = rootNode;
  rootNode.innerHTML = `
    <style>
      .wrap { font-family: sans-serif; padding: 12px; color: #e8e8e8; background: #252525; min-height: 160px; }
      .title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
      .copy { color: #aaa; line-height: 1.35; margin-bottom: 10px; }
      .status { color: #9bd7ff; margin: 8px 0; }
      .pending { margin: 10px 0; }
      button { width: 100%; margin-top: 6px; padding: 7px; }
    </style>
    <div class="wrap">
      <div class="title">DesignPort XD</div>
      <div class="copy">Selection, structure, assets, and visual context are available to the local MCP bridge.</div>
      <div class="status">Disconnected</div>
      <div class="pending">No pending writes</div>
      <button id="connect">Reconnect</button>
      <button id="apply" uxp-variant="cta" disabled>Apply pending write</button>
    </div>`;
  state.statusNode = rootNode.querySelector(".status");
  state.pendingNode = rootNode.querySelector(".pending");
  state.applyButton = rootNode.querySelector("#apply");
  rootNode.querySelector("#connect").addEventListener("click", connect);
  state.applyButton.addEventListener("click", applyNextPending);
  renderPanel();
  connect();
}

entrypoints.setup({
  plugin: {
    create() {
      connect();
    },
    destroy() {
      disconnect();
    },
  },
  commands: {
    designportConnect() {
      connect();
    },
  },
  panels: {
    designportPanel: {
      create(rootNode) {
        setupPanel(rootNode);
      },
      show(rootNode) {
        setupPanel(rootNode);
      },
      update() {
        void selectionContext({
          ...DEFAULT_EXPORT_OPTIONS,
          maxNodes: 500,
          includeAssets: false,
          includeTokens: false,
        }).then((payload) => sendEvent("selection.changed", payload));
      },
    },
  },
});
