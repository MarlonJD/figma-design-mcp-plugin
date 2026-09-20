const { entrypoints } = require("uxp");
const { localFileSystem, formats } = require("uxp").storage;
const scenegraph = require("scenegraph");
const application = require("application");

const { Artboard, Rectangle, Text, Color } = scenegraph;

const BRIDGE_URL = "ws://127.0.0.1:5514";
const BRIDGE_PROTOCOL_VERSION = 2;
const PLUGIN_VERSION = "0.5.0";
const PAIRING_TOKEN = "designport-local-pairing";
const MAX_ASSET_EXPORTS_PER_REQUEST = 64;
const MAX_PENDING_WRITES = 32;
const WRITE_TTL_MS = 60_000;
const MAX_ASSET_CACHE_BYTES = 32_000_000;

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
    "bounded-asset-retrieval",
    "capture-consistency",
    "explicit-node-updates",
  ],
  limitations: [
    "component-creation-unsupported",
    "node-tree-authoring-unsupported",
    "auto-layout-authoring-unsupported",
    "typography-updates-unsupported",
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
    "get_asset",
    "get_operation_status",
    "create_screen",
    "update_selection",
  ],
  supports: {
    documentRead: true,
    selectionRead: true,
    createScreen: true,
    createComponent: false,
    createNodeTree: false,
    updateSelection: true,
    userActionRequiredForWrite: true,
    visualRead: true,
  },
};

const DEFAULT_EXPORT_OPTIONS = {
  maxNodes: 5000,
  cursor: undefined,
  includeAssets: true,
  maxAssetBytes: 4000000,
  includeTokens: true,
  detail: "full",
  changedOnly: false,
  includePages: false,
  maxTextBytes: 200000,
  maxTokenRecords: 5000,
  maxImagePixels: 8000000,
  maxResponseBytes: 12000000,
};

const assetCache = new Map();
const assetPromises = new Map();
let assetCacheBytes = 0;
const snapshotState = {
  sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  documentRevision: 0,
  selectionRevision: 0,
  selectionKey: "",
  documentSignature: "",
  changeLog: [],
  snapshots: new Map(),
  evictedSnapshotIds: new Set(),
  generation: 0,
  eventSequence: 0,
  assets: new Map(),
  cursors: new Map(),
};

const state = {
  socket: null,
  panelRoot: null,
  statusNode: null,
  pendingNode: null,
  applyButton: null,
  pendingWrites: [],
  writeStatuses: new Map(),
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
    ...(typeof input.cursor === "string" && input.cursor.trim()
      ? { cursor: input.cursor.trim() }
      : {}),
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
    pageId: typeof input.pageId === "string" && input.pageId.trim() ? input.pageId.trim() : undefined,
    includePages: input.includePages === true,
    maxTextBytes: Number.isInteger(input.maxTextBytes) && input.maxTextBytes > 0
      ? Math.min(50000000, input.maxTextBytes)
      : DEFAULT_EXPORT_OPTIONS.maxTextBytes,
    maxTokenRecords: Number.isInteger(input.maxTokenRecords) && input.maxTokenRecords > 0
      ? Math.min(100000, input.maxTokenRecords)
      : DEFAULT_EXPORT_OPTIONS.maxTokenRecords,
    maxImagePixels: Number.isInteger(input.maxImagePixels) && input.maxImagePixels > 0
      ? Math.min(100000000, input.maxImagePixels)
      : DEFAULT_EXPORT_OPTIONS.maxImagePixels,
    maxResponseBytes: Number.isInteger(input.maxResponseBytes) && input.maxResponseBytes > 0
      ? Math.min(100000000, input.maxResponseBytes)
      : DEFAULT_EXPORT_OPTIONS.maxResponseBytes,
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

function documentSignature() {
  const entries = [];
  const pending = [{ node: scenegraph.root, parentId: null }];
  while (pending.length) {
    const current = pending.pop();
    const children = childrenOf(current.node);
    entries.push({
      id: nodeId(current.node),
      parentId: current.parentId || null,
      children: children.map((child) => nodeId(child)),
      name: current.node && current.node.name,
      visible: current.node && current.node.visible !== false,
      bounds: boundsOf(current.node),
      text: nodeKind(current.node) === "text" ? current.node.text : undefined,
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: children[index], parentId: nodeId(current.node) });
    }
  }
  return hashValue(entries);
}

function syncDocumentRevision() {
  const signature = documentSignature();
  if (!snapshotState.documentSignature) {
    snapshotState.documentSignature = signature;
    return;
  }
  if (signature === snapshotState.documentSignature) return;
  snapshotState.documentSignature = signature;
  snapshotState.documentRevision += 1;
  rememberChangedNodeIds([]);
  clearAssetCache();
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
}

function hashValue(value) {
  let hash = 2166136261;
  const text = typeof value === "string" ? value : stableValue(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function captureShape(options) {
  return {
    detail: options.detail,
    includeAssets: options.includeAssets,
    includeTokens: options.includeTokens,
    maxAssetBytes: options.maxAssetBytes,
    maxTextBytes: options.maxTextBytes,
    maxTokenRecords: options.maxTokenRecords,
  };
}

function captureIdentity(scope, pageId, rootIds, selectedIds, options) {
  const info = documentInfo();
  return {
    sessionId: snapshotState.sessionId,
    documentId: info.documentId,
    scope,
    ...(pageId ? { pageId } : {}),
    scopeRootIds: Array.from(new Set(rootIds.filter(Boolean))),
    selectedIds: Array.from(new Set(selectedIds.filter(Boolean))),
    normalizationVersion: "designport-ir-v2",
    evidenceShape: captureShape(options),
  };
}

function captureIdFor(identity, entries) {
  const observable = entries.map((entry) => ({
    id: nodeId(entry.node),
    parentId: entry.parentId || null,
    children: childrenOf(entry.node).map((child) => nodeId(child)),
    name: entry.node.name,
    visible: entry.node.visible !== false,
    bounds: boundsOf(entry.node),
    text: nodeKind(entry.node) === "text" ? entry.node.text : undefined,
  }));
  return `capture-${hashValue({
    identity: { ...identity, evidenceShape: undefined },
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    observable,
  })}`;
}

function snapshotFor(identity, captureId, fingerprint, nodes, tokens, complete) {
  const id = `snapshot-${hashValue({ identity, fingerprint })}`;
  const snapshot = {
    id,
    captureId,
    identity,
    scope: identity.scope,
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    generation: ++snapshotState.generation,
    complete,
    generatedAt: new Date().toISOString(),
  };
  snapshotState.snapshots.set(id, {
    snapshot,
    identity,
    captureId,
    fingerprint,
    nodes,
    tokens,
  });
  while (snapshotState.snapshots.size > 128) {
    const first = snapshotState.snapshots.keys().next().value;
    if (!first) break;
    const evicted = snapshotState.snapshots.get(first);
    snapshotState.snapshots.delete(first);
    snapshotState.evictedSnapshotIds.add(first);
    if (evicted && !Array.from(snapshotState.snapshots.values()).some((item) => item.captureId === evicted.captureId)) {
      for (const [artifactId, asset] of snapshotState.assets) {
        if (asset.captureId === evicted.captureId) snapshotState.assets.delete(artifactId);
      }
    }
  }
  return snapshot;
}

function nodeForDetail(node, detail) {
  if (detail === "full") return node;
  const summaryKeys = new Set([
    "id", "name", "kind", "parentId", "children", "bounds", "renderBounds",
    "localBounds", "worldBounds",
    "visible", "locked", "description", "rotation", "transform", "clipsContent",
    "minWidth", "maxWidth", "minHeight", "maxHeight", "constraints", "layoutAlign",
    "layoutGrow", "layoutPositioning", "gridPosition", "layout", "hostData",
  ]);
  const structureKeys = new Set([
    ...summaryKeys,
    "styleRefs", "variableBindings", "component", "accessibility", "annotations",
    "text", "textSegments", "typography", "prototypeLinks", "untrustedText", "provenance",
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
    textBytes: 0,
    tokenRecords: 0,
    tokenBudgetExceeded: false,
    imagePixels: 0,
    omissions: [],
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

function localBoundsOf(node) {
  return boxFrom(node && node.localBounds);
}

function worldBoundsOf(node) {
  return boxFrom(node && node.globalBounds);
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
  const characterSpacing = Number.isFinite(source.charSpacing)
    ? source.charSpacing
    : Number.isFinite(source.characterSpacing)
      ? source.characterSpacing
      : undefined;
  if (characterSpacing !== undefined) {
    typography.letterSpacing = typography.size
      ? typography.size * characterSpacing / 1000
      : characterSpacing / 1000;
  }
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
  const sources = value && typeof value === "object"
    ? [value.position, value.anchor, value.type, value.mode, value.value, value.name, value.constraint, value.size, value.sizing]
    : [value];
  for (const source of sources) {
    const normalized = normalizeMode(source);
    if (normalized.includes("LEFT_RIGHT") || normalized.includes("TOP_BOTTOM") || normalized === "BOTH") {
      return axis === "horizontal" ? "left-right" : "top-bottom";
    }
    if (axis === "horizontal") {
      if (normalized.includes("LEFT")) return "left";
      if (normalized.includes("RIGHT")) return "right";
      if (normalized.includes("CENTER")) return "center";
    } else {
      if (normalized.includes("TOP")) return "top";
      if (normalized.includes("BOTTOM")) return "bottom";
      if (normalized.includes("CENTER")) return "center";
    }
    if (normalized.includes("SCALE")) return "scale";
    if (normalized.includes("STRETCH") || normalized.includes("FILL") || normalized.includes("RESPONSIVE")) {
      return axis === "horizontal" ? "left-right" : "top-bottom";
    }
  }
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
  const headingMatch = name.match(/(?:^|[\s_-])h([1-6])(?:$|[\s_-])|(?:^|[\s_-])heading(?:$|[\s_-])/);
  if (headingMatch || nodeKind(node) === "text" && /title|heading/.test(name)) {
    return {
      role: "heading",
      ...(headingMatch && headingMatch[1] ? { headingLevel: Number(headingMatch[1]) } : {}),
      confidence: 0.55,
    };
  }
  const rolePatterns = [
    ["button", /(?:^|[\s_-])(?:button|cta)(?:$|[\s_-])/],
    ["link", /(?:^|[\s_-])(?:link|hyperlink)(?:$|[\s_-])/],
    ["checkbox", /(?:^|[\s_-])checkbox(?:$|[\s_-])/],
    ["switch", /(?:^|[\s_-])(?:switch|toggle)(?:$|[\s_-])/],
    ["textbox", /(?:^|[\s_-])(?:input|textfield|text-field|search)(?:$|[\s_-])/],
    ["tab", /(?:^|[\s_-])tab(?:$|[\s_-])/],
    ["navigation", /(?:^|[\s_-])(?:navigation|navbar|nav-bar|bottom-nav)(?:$|[\s_-])/],
    ["img", /(?:^|[\s_-])(?:image|photo|avatar|thumbnail)(?:$|[\s_-])/],
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
  const configuredLabel = typeof configured.label === "string" ? configured.label : nonEmptyString(pluginDataFor(node, "a11y.label"));
  const configuredDescription = typeof configured.description === "string" ? configured.description : nonEmptyString(pluginDataFor(node, "a11y.description"));
  const configuredAltText = typeof configured.altText === "string" ? configured.altText : nonEmptyString(pluginDataFor(node, "a11y.altText"));
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
    source: configuredRole || configuredLabel !== undefined || configuredDescription !== undefined
      || configuredAltText !== undefined || configuredFocusable !== undefined || configuredDecorative !== undefined
      ? "plugin-data" : inferred.role ? "inferred" : "host",
    confidence: explicit ? 1 : inferred.confidence,
    provenance: {
      ...(configuredRole
        ? { role: { source: "plugin-data", sourceField: "designport.accessibility.role" } }
        : inferred.role
          ? { role: { source: "inferred", sourceField: "node.name", inferenceRuleVersion: "accessibility-name-v2" } }
          : {}),
      ...(configuredLabel !== undefined
        ? { label: { source: "plugin-data", sourceField: "designport.accessibility.label" } }
        : label !== undefined
          ? { label: { source: "inferred", sourceField: "node.text", inferenceRuleVersion: "accessibility-name-v2" } }
          : {}),
      ...(description !== undefined
        ? { description: { source: configuredDescription ? "plugin-data" : "host", sourceField: configuredDescription ? "designport.accessibility.description" : "node.description" } }
        : {}),
      ...(configuredAltText !== undefined
        ? { altText: { source: "plugin-data", sourceField: "designport.accessibility.altText" } }
        : {}),
    },
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
    untrusted: true,
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
    const destinationId = nodeId(destination);
    links.push({
      trigger: snakeCase(triggerObject.type || "unknown"),
      action: actionType,
      resolutionStatus: destinationId || typeof action.url === "string"
        ? "resolved"
        : /navigate|overlay|swap|back/.test(actionType) ? "unresolved" : "unknown",
      ...(destinationId ? { destinationId } : {}),
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

async function removeTemporaryFile(file) {
  if (!file) return;
  try {
    if (typeof file.delete === "function") await file.delete();
    else if (typeof file.remove === "function") await file.remove();
  } catch (_error) {
    // Temporary storage cleanup is best effort on older UXP runtimes.
  }
}

async function exportNodeAsset(node, kind) {
  let file;
  try {
    file = await createRendition(node, "SVG", "svg", "asset");
    const data = await readText(file);
    if (data && data.trim()) {
      return {
        mimeType: "image/svg+xml",
        data,
        kind,
        size: utf8ByteLength(data),
        artifactId: `asset-${hashValue(`${nodeId(node)}|${data}`)}`,
        digest: hashValue(data),
        sourceNodeIds: [nodeId(node)],
      };
    }
  } catch (_error) {
    // Some XD nodes cannot be rendered as SVG; PNG is the safe fallback.
  } finally {
    await removeTemporaryFile(file);
    file = undefined;
  }
  try {
    file = await createRendition(node, "PNG", "png", "asset");
    const bytes = await file.read({ format: formats.binary });
    const encoded = base64FromArrayBuffer(bytes);
    return {
      mimeType: "image/png",
      data: encoded,
      kind,
      size: bytesFromArrayBuffer(bytes).byteLength,
      artifactId: `asset-${hashValue(`${nodeId(node)}|${encoded}`)}`,
      digest: hashValue(encoded),
      sourceNodeIds: [nodeId(node)],
    };
  } catch (_error) {
    return undefined;
  } finally {
    await removeTemporaryFile(file);
  }
}

function assetCacheKey(node) {
  return `${snapshotState.sessionId}:${documentInfo().documentId}:${snapshotState.documentRevision}:${snapshotState.generation}:${nodeId(node)}`;
}

function cacheAsset(key, asset) {
  if (!asset) return;
  const size = Number.isFinite(asset.size) ? asset.size : 0;
  const previous = assetCache.get(key);
  if (previous) assetCacheBytes -= Number.isFinite(previous.size) ? previous.size : 0;
  assetCache.delete(key);
  assetCache.set(key, asset);
  assetCacheBytes += size;
  while (assetCacheBytes > MAX_ASSET_CACHE_BYTES && assetCache.size > 1) {
    const first = assetCache.keys().next().value;
    if (!first) break;
    const removed = assetCache.get(first);
    assetCache.delete(first);
    assetCacheBytes -= removed && Number.isFinite(removed.size) ? removed.size : 0;
  }
}

function clearAssetCache() {
  assetCache.clear();
  assetCacheBytes = 0;
  assetPromises.clear();
}

async function assetFor(node, exportState) {
  if (!exportState.options.includeAssets || node.visible === false) return undefined;
  const kind = nodeKind(node);
  const isVector = kind === "path";
  const isImage = imageFillFor(node);
  if (!isVector && !isImage) return undefined;
  const key = assetCacheKey(node);
  const requestRevision = snapshotState.documentRevision;
  const includeAsset = (asset) => {
    if (!asset) {
      exportState.assetsOmitted += 1;
      exportState.omissions.push({ kind: "failed", message: "Host could not export this asset.", nodeIds: [nodeId(node)] });
      return undefined;
    }
    const size = Number.isFinite(asset.size) ? asset.size : 0;
    if (exportState.assetBytes + size > exportState.options.maxAssetBytes) {
      exportState.assetsOmitted += 1;
      exportState.omissions.push({ kind: "budget", message: "Asset evidence exceeded maxAssetBytes.", nodeIds: [nodeId(node)], artifactId: asset.artifactId });
      return undefined;
    }
    exportState.assetCount += 1;
    exportState.assetBytes += size;
    return asset;
  };
  if (assetCache.has(key)) {
    const cached = assetCache.get(key);
    assetCache.delete(key);
    assetCache.set(key, cached);
    return includeAsset(cached);
  }
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
    if (requestRevision !== snapshotState.documentRevision) {
      exportState.assetsOmitted += 1;
      exportState.omissions.push({ kind: "failed", message: "Asset export completed after the document changed.", nodeIds: [nodeId(node)] });
      return undefined;
    }
    cacheAsset(key, asset);
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
  return { width: bounds.width, height: bounds.height, orientation, breakpoint, breakpointSource: "heuristic" };
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
  const localBounds = localBoundsOf(node);
  const worldBounds = worldBoundsOf(node);
  const bounds = worldBounds || localBounds;
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
    ...(localBounds ? { localBounds } : {}),
    ...(worldBounds ? { worldBounds } : {}),
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
    ...(typeof node.text === "string" ? { text: node.text, untrustedText: true } : {}),
    ...(textSegments ? { textSegments } : {}),
    ...(typography ? { typography } : {}),
    ...(prototypeLinks ? { prototypeLinks } : {}),
    provenance: {
      ...(localBounds ? { localBounds: { source: "host", sourceField: "localBounds" } } : {}),
      ...(worldBounds ? { worldBounds: { source: "host", sourceField: "globalBounds" } } : {}),
      ...(transform ? { transform: { source: "host", sourceField: "transform" } } : {}),
      ...(constraints ? { constraints: { source: "host", sourceField: "horizontalConstraints,verticalConstraints" } } : {}),
      ...(layout ? { layout: { source: "host", sourceField: "layout" } } : {}),
      ...(styleRefs ? { styleRefs: { source: "host", sourceField: "styleRefs" } } : {}),
      ...(variableBindings ? { variableBindings: { source: "plugin-data", sourceField: "designport.variableBindings" } } : {}),
    },
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
  const pending = [{ node, parentId, topLevel }];
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    const children = childrenOf(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: children[index],
        parentId: nodeId(current.node),
        topLevel: false,
      });
    }
  }
}

function defaultCoverage(options, exportState, tokens) {
  return {
    geometry: { status: "complete" },
    layout: { status: "complete" },
    typography: { status: "complete" },
    tokens: options.includeTokens && options.detail !== "summary"
      ? { status: exportState.tokenBudgetExceeded ? "partial" : "complete", ...(exportState.tokenBudgetExceeded ? { reason: "Token record budget reached." } : {}) }
      : { status: "omitted", reason: "Token evidence was not requested for this detail shape." },
    components: { status: "complete" },
    interactions: { status: "complete" },
    assets: options.includeAssets && options.detail === "full"
      ? { status: exportState.assetsOmitted ? "partial" : "complete", ...(exportState.assetsOmitted ? { reason: "Some asset exports exceeded a budget or were unavailable." } : {}) }
      : { status: "omitted", reason: "Asset evidence was not requested for this detail shape." },
    accessibility: { status: "complete" },
  };
}

function captureOptionsFor(options) {
  return {
    maxNodes: options.maxNodes,
    includeAssets: options.includeAssets,
    maxAssetBytes: options.maxAssetBytes,
    includeTokens: options.includeTokens,
    detail: options.detail,
    cursor: undefined,
    knownSnapshotId: undefined,
    changedOnly: false,
    pageId: options.pageId,
    includePages: options.includePages,
    maxTextBytes: options.maxTextBytes,
    maxTokenRecords: options.maxTokenRecords,
    maxImagePixels: options.maxImagePixels,
    maxResponseBytes: options.maxResponseBytes,
  };
}

async function materializeEntries(entries, identity, options) {
  syncDocumentRevision();
  syncSelectionRevision();
  const exportState = exportStateFor(options);
  const nodes = [];
  for (const entry of entries) {
    const node = await nodeToIR(entry.node, entry.parentId, entry.topLevel, exportState);
    if (!node) continue;
    if (typeof node.text === "string") {
      exportState.textBytes += utf8ByteLength(node.text);
      if (exportState.textBytes > options.maxTextBytes) {
        delete node.text;
        delete node.untrustedText;
        delete node.textSegments;
        exportState.omissions.push({ kind: "budget", message: "Text evidence exceeded maxTextBytes.", nodeIds: [node.id] });
      }
    }
    nodes.push(node);
  }
  let tokens = await tokenCatalog(options);
  if (tokens.length > options.maxTokenRecords) {
    exportState.tokenBudgetExceeded = true;
    exportState.omissions.push({ kind: "budget", message: "Token evidence exceeded maxTokenRecords." });
    tokens = tokens.slice(0, options.maxTokenRecords);
  }
  exportState.tokenRecords = tokens.length;
  const captureId = captureIdFor(identity, entries);
  nodes.forEach((node) => {
    if (!node.asset || !node.asset.artifactId) return;
    node.asset = { ...node.asset, captureId };
    snapshotState.assets.set(node.asset.artifactId, node.asset);
  });
  const fingerprint = hashValue({ nodes, tokens });
  const snapshot = snapshotFor(
    identity,
    captureId,
    fingerprint,
    nodes,
    tokens,
    exportState.omissions.length === 0,
  );
  return {
    nodes,
    tokens,
    exportState,
    captureId,
    fingerprint,
    snapshot,
    identity,
    options,
    coverage: defaultCoverage(options, exportState, tokens),
    stats: {
      totalNodes: entries.length,
      returnedNodes: nodes.length,
      assetCount: exportState.assetCount,
      assetBytes: exportState.assetBytes,
      assetsOmitted: exportState.assetsOmitted,
      tokenCount: tokens.length,
      textBytes: exportState.textBytes,
      tokenRecords: exportState.tokenRecords,
      imagePixels: exportState.imagePixels,
      responseBytes: 0,
    },
  };
}

function shapeCompatible(left, right) {
  return left && right && stableValue(left.identity) === stableValue(right.identity);
}

function cursorParts(cursor) {
  if (typeof cursor !== "string" || !cursor.trim()) return null;
  return snapshotState.cursors.get(cursor) || { unknown: true };
}

function cursorFor(current, sourceNodes, responseType, removedNodeIds, tokenState, offset) {
  const sourceNodeIds = sourceNodes.map((node) => node.id);
  const cursor = `cursor-${hashValue({
    snapshotId: current.snapshot.id,
    responseType,
    sourceNodeIds,
    removedNodeIds,
    tokenState,
    offset,
  })}`;
  snapshotState.cursors.set(cursor, {
    snapshotId: current.snapshot.id,
    responseType,
    sourceNodeIds,
    removedNodeIds,
    tokenState,
    offset,
  });
  while (snapshotState.cursors.size > 256) {
    const first = snapshotState.cursors.keys().next().value;
    if (!first) break;
    snapshotState.cursors.delete(first);
  }
  return cursor;
}

function resyncResult(base, current, reason) {
  return {
    ...base,
    captureId: current.captureId,
    captureIdentity: current.snapshot.identity,
    snapshot: current.snapshot,
    responseType: "resync-required",
    resyncReason: reason,
    nodes: Array.isArray(base.nodes) ? [] : {},
    ...(base.tokens !== undefined ? { tokens: [] } : {}),
    tokenState: "omitted",
    omissions: [{ kind: "unavailable", message: reason.message }],
    coverage: current.coverage,
    pagination: { limit: current.options.maxNodes, total: current.nodes.length, returned: 0, hasMore: false },
    exportStats: { ...current.stats, returnedNodes: 0, responseBytes: 0 },
  };
}

function responseForCapture(base, current, options, asRecord) {
  const cursor = cursorParts(options.cursor);
  if (options.cursor && !cursor) {
    return resyncResult(base, current, { code: "CURSOR_INVALID", message: "Pagination cursor is malformed." });
  }
  if (options.cursor && cursor.unknown) {
    return resyncResult(base, current, { code: "CURSOR_UNKNOWN", message: "The pagination cursor does not address a known host capture." });
  }
  const knownId = options.knownSnapshotId;
  const knownBaseline = knownId ? snapshotState.snapshots.get(knownId) : undefined;
  const cursorBaseline = cursor ? snapshotState.snapshots.get(cursor.snapshotId) : undefined;
  const baseline = cursorBaseline || knownBaseline;
  if (knownId && !baseline) {
    return resyncResult(base, current, {
      code: snapshotState.evictedSnapshotIds.has(knownId) ? "BASELINE_EVICTED" : "BASELINE_UNKNOWN",
      message: snapshotState.evictedSnapshotIds.has(knownId)
        ? "The requested baseline was evicted from the host capture store."
        : "The requested baseline is not known to this plugin session.",
    });
  }
  if (cursor && !cursorBaseline) {
    return resyncResult(base, current, {
      code: snapshotState.evictedSnapshotIds.has(cursor.snapshotId) ? "CURSOR_EVICTED" : "CURSOR_UNKNOWN",
      message: snapshotState.evictedSnapshotIds.has(cursor.snapshotId)
        ? "The pagination capture was evicted from the host capture store."
        : "The pagination cursor does not address a known host capture.",
    });
  }
  if (cursor && knownId && cursor.snapshotId !== knownId) {
    return resyncResult(base, current, { code: "CURSOR_BASELINE_MISMATCH", message: "The pagination cursor and known baseline address different captures." });
  }
  if (baseline && (!baseline.snapshot.complete || !shapeCompatible(baseline, current.snapshot))) {
    return resyncResult(base, current, {
      code: baseline.snapshot.complete ? "BASELINE_INCOMPATIBLE" : "BASELINE_INCOMPLETE",
      message: baseline.snapshot.complete
        ? "The requested baseline was captured with an incompatible scope or evidence shape."
        : "The requested baseline was not a complete capture.",
    });
  }
  if (baseline && !current.snapshot.complete) {
    return resyncResult(base, current, {
      code: "CAPTURE_INCOMPLETE",
      message: "The current capture is incomplete and cannot safely be used for an incremental response.",
    });
  }
  if (cursor && cursor.snapshotId !== current.snapshot.id) {
    return resyncResult(base, current, { code: "CURSOR_STALE", message: "Pagination cursor does not address the current stored capture." });
  }

  let responseType = "full";
  let sourceNodes = current.nodes;
  let removedNodeIds = [];
  let tokenState = options.includeTokens && options.detail !== "summary" ? "replaced" : "omitted";
  let responseTokens = tokenState === "replaced" ? current.tokens : undefined;
  if (cursor) {
    const currentById = new Map(current.nodes.map((node) => [node.id, node]));
    sourceNodes = cursor.sourceNodeIds.map((id) => currentById.get(id)).filter(Boolean);
    if (sourceNodes.length !== cursor.sourceNodeIds.length) {
      return resyncResult(base, current, { code: "CURSOR_CAPTURE_CHANGED", message: "The stored capture no longer contains the nodes addressed by this cursor." });
    }
    responseType = cursor.responseType;
    removedNodeIds = cursor.removedNodeIds;
    tokenState = cursor.tokenState;
    responseTokens = tokenState === "replaced" ? current.tokens : undefined;
  } else if (knownBaseline) {
    const same = knownBaseline.fingerprint === current.fingerprint;
    if (options.changedOnly) {
      if (same) {
        responseType = "not-modified";
        sourceNodes = [];
        tokenState = "unchanged";
        responseTokens = undefined;
      } else {
        responseType = "delta";
        const oldNodes = new Map(knownBaseline.nodes.map((node) => [node.id, node]));
        const newIds = new Set(current.nodes.map((node) => node.id));
        sourceNodes = current.nodes.filter((node) => stableValue(node) !== stableValue(oldNodes.get(node.id)));
        removedNodeIds = knownBaseline.nodes.filter((node) => !newIds.has(node.id)).map((node) => node.id);
        tokenState = stableValue(knownBaseline.tokens) === stableValue(current.tokens) ? "unchanged" : "replaced";
        responseTokens = tokenState === "replaced" ? current.tokens : undefined;
      }
    } else if (same) {
      responseType = "not-modified";
      sourceNodes = [];
      tokenState = "unchanged";
      responseTokens = undefined;
    }
  }

  const offset = cursor ? cursor.offset : 0;
  let selectedNodes = responseType === "not-modified"
    ? []
    : sourceNodes.slice(offset, offset + options.maxNodes);
  const omissions = [...current.exportState.omissions];
  let nextCursor;
  const nextCursorFor = () => {
    const nextOffset = offset + selectedNodes.length;
    if (nextOffset >= sourceNodes.length) return undefined;
    nextCursor = nextCursor || cursorFor(
      current,
      sourceNodes,
      responseType,
      removedNodeIds,
      tokenState,
      nextOffset,
    );
    return nextCursor;
  };
  const pagination = () => {
    const next = nextCursorFor();
    return {
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: options.maxNodes,
    total: sourceNodes.length,
    returned: selectedNodes.length,
    hasMore: offset + selectedNodes.length < sourceNodes.length,
      ...(next ? { nextCursor: next } : {}),
    };
  };
  const build = () => ({
    ...base,
    captureId: current.captureId,
    captureIdentity: current.snapshot.identity,
    snapshot: current.snapshot,
    responseType,
    ...(removedNodeIds.length ? { removedNodeIds } : {}),
    tokenState,
    ...(responseTokens !== undefined ? { tokens: responseTokens } : {}),
    ...(omissions.length ? { omissions } : {}),
    coverage: current.coverage,
    pagination: pagination(),
    exportStats: {
      ...current.stats,
      returnedNodes: selectedNodes.length,
      responseBytes: 0,
    },
    nodes: asRecord
      ? Object.fromEntries(selectedNodes.map((node) => [node.id, node]))
      : selectedNodes,
  });
  let response = build();
  while (utf8ByteLength(JSON.stringify(response)) > options.maxResponseBytes && selectedNodes.length > 0) {
    selectedNodes = selectedNodes.slice(0, -1);
    if (!omissions.some((item) => item.message.includes("maxResponseBytes"))) {
      omissions.push({ kind: "budget", message: "Response exceeded maxResponseBytes; retrieve the next cursor for omitted nodes." });
    }
    response = build();
  }
  const responseBytes = utf8ByteLength(JSON.stringify(response));
  response.exportStats.responseBytes = responseBytes;
  if (responseBytes > options.maxResponseBytes) {
    return resyncResult(base, current, { code: "RESPONSE_BUDGET_EXCEEDED", message: "The requested response budget is too small for its required metadata." });
  }
  return response;
}

async function buildDocumentIR(options) {
  const root = scenegraph.root;
  const entries = [];
  flattenSubtree(root, null, true, entries);
  const identity = captureIdentity("document", undefined, [nodeId(root)], selectionItems().map((item) => nodeId(item)), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const screens = childrenOf(root)
    .filter((child) => nodeKind(child) === "screen")
    .map((child) => ({ host: "xd", id: nodeId(child) }))
    .filter((ref) => ref.id);
  const screenDetails = screenDetailsFor(root);
  const info = documentInfo();
  return responseForCapture({
    schemaVersion: 2,
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    rootId: nodeId(root) || info.documentId,
    scope: "document",
    nodes: {},
    screens,
    selection: selectionItems().map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    ...(screenDetails.length ? { screenDetails } : {}),
    ...(options.includePages ? { pages: [{ host: "xd", id: nodeId(root) || info.documentId }] } : {}),
    exportedAt: new Date().toISOString(),
  }, current, options, true);
}

async function selectionContext(options) {
  const info = documentInfo();
  const selection = selectionItems();
  const entries = [];
  selection.forEach((item) => flattenSubtree(item, item.parent ? nodeId(item.parent) : null, item.parent === scenegraph.root, entries));
  const identity = captureIdentity("selection", undefined, selection.map((item) => nodeId(item)), selection.map((item) => nodeId(item)), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  return responseForCapture({
    schemaVersion: 2,
    scope: "selection",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selection.map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    nodes: [],
    exportedAt: new Date().toISOString(),
  }, current, options, false);
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
  const identity = captureIdentity("screen", undefined, [nodeId(screen)], selectionItems().map((item) => nodeId(item)), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const viewport = viewportFor(boundsOf(screen));
  return responseForCapture({
    schemaVersion: 2,
    scope: "screen",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: nodeId(screen),
    selection: selectionItems().map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    ...(viewport ? { viewport } : {}),
    nodes: [],
    exportedAt: new Date().toISOString(),
  }, current, options, false);
}

async function pageContext(pageId, options) {
  const root = pageRoot(pageId);
  const info = documentInfo();
  const entries = [];
  flattenSubtree(root, null, true, entries);
  const identity = captureIdentity("page", nodeId(root), [nodeId(root)], selectionItems().map((item) => nodeId(item)), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  return responseForCapture({
    schemaVersion: 2,
    scope: "page",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    pageId: nodeId(root),
    selection: selectionItems().map((item) => ({ host: "xd", id: nodeId(item) })).filter((ref) => ref.id),
    nodes: [],
    exportedAt: new Date().toISOString(),
  }, current, options, false);
}

function pageRoot(pageId) {
  const root = scenegraph.root;
  const rootId = nodeId(root);
  if (pageId && pageId !== rootId) throw new Error("XD does not expose independent page scopes; use an artboard screen scope");
  return root;
}

function visualTargets(scope, screenId, pageId) {
  if (scope === "page") return [pageRoot(pageId)];
  if (scope === "screen") {
    const screen = findScreen(screenId);
    if (!screen) throw new Error("No XD artboard was found for the requested visual context");
    return [screen];
  }
  const selected = selectionItems();
  if (!selected.length) throw new Error("XD selection is empty");
  return selected;
}

function pngDimensions(value) {
  const bytes = bytesFromArrayBuffer(value);
  if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return undefined;
  return {
    width: (bytes[16] * 0x1000000) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19],
    height: (bytes[20] * 0x1000000) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23],
  };
}

async function visualContext(scope, screenId, options = {}) {
  syncDocumentRevision();
  syncSelectionRevision();
  const normalizedOptions = {
    maxImagePixels: Number.isInteger(options.maxImagePixels) && options.maxImagePixels > 0
      ? Math.min(100000000, options.maxImagePixels)
      : DEFAULT_EXPORT_OPTIONS.maxImagePixels,
    maxImageBytes: Number.isInteger(options.maxImageBytes) && options.maxImageBytes > 0
      ? Math.min(50000000, options.maxImageBytes)
      : 12000000,
  };
  const targets = visualTargets(scope, screenId, options.pageId);
  const entries = [];
  targets.forEach((target) => flattenSubtree(target, target.parent ? nodeId(target.parent) : null, true, entries));
  const identity = captureIdentity(
    scope,
    scope === "page" ? nodeId(targets[0]) : undefined,
    targets.map((target) => nodeId(target)),
    selectionItems().map((item) => nodeId(item)),
    { ...DEFAULT_EXPORT_OPTIONS, detail: "full", includeAssets: false, includeTokens: false },
  );
  const captureId = captureIdFor(identity, entries);
  const items = [];
  let imagePixels = 0;
  let imageBytes = 0;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const bounds = boundsOf(target);
    const maxDimension = Math.max(bounds ? bounds.width : 0, bounds ? bounds.height : 0);
    const area = Math.max(1, (bounds ? bounds.width : 1) * (bounds ? bounds.height : 1));
    const scale = Math.min(1, maxDimension > 1024 ? 1024 / maxDimension : 1, Math.sqrt(normalizedOptions.maxImagePixels / area));
    let file;
    try {
      const folder = await localFileSystem.getTemporaryFolder();
      file = await folder.createFile(`designport-${Date.now()}-${index}.png`);
      await application.createRenditions([{
        node: target,
        outputFile: file,
        type: application.RenditionType.PNG,
        scale,
      }]);
      const bytes = await file.read({ format: formats.binary });
      const encoded = base64FromArrayBuffer(bytes);
      const encodedBytes = utf8ByteLength(encoded);
      if (imageBytes + encodedBytes > normalizedOptions.maxImageBytes) {
        const error = new Error("Rendered PNG exceeds maxImageBytes");
        error.code = "VISUAL_BUDGET_EXCEEDED";
        throw error;
      }
      imageBytes += encodedBytes;
      const dimensions = pngDimensions(bytes) || {
        width: Math.max(1, Math.ceil((bounds ? bounds.width : 1) * scale)),
        height: Math.max(1, Math.ceil((bounds ? bounds.height : 1) * scale)),
      };
      imagePixels += dimensions.width * dimensions.height;
      if (imagePixels > normalizedOptions.maxImagePixels) {
        const error = new Error("Rendered PNG pixels exceed maxImagePixels");
        error.code = "VISUAL_BUDGET_EXCEEDED";
        throw error;
      }
      items.push({
        nodeId: nodeId(target),
        nodeName: typeof target.name === "string" ? target.name : nodeType(target),
        mimeType: "image/png",
        data: encoded,
        bounds,
        scale,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        cropOrigin: bounds ? { x: bounds.x, y: bounds.y } : undefined,
        worldToPixel: bounds ? { a: scale, b: 0, c: 0, d: scale, tx: -bounds.x * scale, ty: -bounds.y * scale } : undefined,
        captureId,
      });
    } finally {
      await removeTemporaryFile(file);
    }
  }
  const info = documentInfo();
  return {
    schemaVersion: 2,
    scope,
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    captureId,
    captureIdentity: identity,
    items,
    exportedAt: new Date().toISOString(),
  };
}

async function getAsset(payload) {
  const artifactId = payload && payload.artifactId;
  const captureId = payload && payload.captureId;
  const maxBytes = Number.isInteger(payload && payload.maxBytes) && payload.maxBytes > 0
    ? Math.min(50000000, payload.maxBytes)
    : 4000000;
  const asset = snapshotState.assets.get(artifactId);
  if (!asset) {
    const error = new Error("Requested asset is unavailable or expired");
    error.code = "ASSET_UNAVAILABLE";
    throw error;
  }
  if (asset.captureId !== captureId) {
    const error = new Error("Requested asset belongs to a different capture");
    error.code = "ASSET_CAPTURE_MISMATCH";
    throw error;
  }
  if (asset.size > maxBytes) {
    const error = new Error("Requested asset exceeds maxBytes");
    error.code = "ASSET_BUDGET_EXCEEDED";
    throw error;
  }
  return asset;
}

function colorToHex(color) {
  if (!color) return "#FFFFFF";
  const channel = (value) => Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function applyPatch(node, patch) {
  const unsupported = Object.keys(patch || {}).filter((key) => ![
    "coordinateSpace", "name", "bounds", "visible", "opacity", "fills", "text",
  ].includes(key));
  if (unsupported.length) {
    const error = new Error(`XD does not support these patch fields: ${unsupported.join(", ")}`);
    error.code = "UNSUPPORTED_PATCH_FIELD";
    throw error;
  }
  if (Array.isArray(patch.fills) && patch.fills.some((fill) => fill.type !== "solid" || !fill.color)) {
    const error = new Error("XD writes currently support solid fills only");
    error.code = "UNSUPPORTED_PATCH_FIELD";
    throw error;
  }
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
  if (patch.bounds && (Number.isFinite(patch.bounds.x) || Number.isFinite(patch.bounds.y))) {
    const current = node.localBounds || { x: 0, y: 0 };
    const x = Number.isFinite(patch.bounds.x) ? patch.bounds.x : current.x;
    const y = Number.isFinite(patch.bounds.y) ? patch.bounds.y : current.y;
    if (patch.coordinateSpace === "world" && node.globalBounds && node.parent && node.parent.globalBounds) {
      const parentBounds = node.parent.globalBounds;
      node.moveInParentCoordinates(x - (Number(parentBounds.x) || 0), y - (Number(parentBounds.y) || 0));
    } else if (typeof node.moveInParentCoordinates === "function") {
      node.moveInParentCoordinates(x, y);
    }
  }
}

function validateWriteState(payload, selection, operation) {
  syncDocumentRevision();
  syncSelectionRevision();
  const expected = payload && payload.expectedSnapshotId;
  const baseline = expected && snapshotState.snapshots.get(expected);
  if (!baseline) {
    const error = new Error("Write requires a known complete capture snapshot");
    error.code = snapshotState.evictedSnapshotIds.has(expected) ? "WRITE_BASELINE_EVICTED" : "WRITE_BASELINE_UNKNOWN";
    throw error;
  }
  const info = documentInfo();
  if (payload.documentId && payload.documentId !== info.documentId) {
    const error = new Error("Write documentId does not match the connected document");
    error.code = "WRITE_DOCUMENT_MISMATCH";
    throw error;
  }
  if (payload.sessionId && payload.sessionId !== baseline.snapshot.identity.sessionId) {
    const error = new Error("Write sessionId does not match the expected capture");
    error.code = "WRITE_SESSION_MISMATCH";
    throw error;
  }
  if (!baseline.snapshot.complete
    || baseline.snapshot.identity.documentId !== info.documentId
    || baseline.snapshot.documentRevision !== snapshotState.documentRevision) {
    const error = new Error("The expected capture is stale; read a fresh capture before writing");
    error.code = "WRITE_STALE_CAPTURE";
    throw error;
  }
  if (operation === "update_selection") {
    const targetIds = Array.isArray(payload.targetIds) ? payload.targetIds : [];
    const capturedIds = new Set((baseline.nodes || []).map((node) => node.id));
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length || !targetIds.every((id) => capturedIds.has(id))) {
      const error = new Error("Write targets must be explicit nodes in the expected capture scope");
      error.code = "WRITE_TARGET_MISMATCH";
      throw error;
    }
    if (payload.patch && payload.patch.parentId && !capturedIds.has(payload.patch.parentId)) {
      const error = new Error("A reparent target must be in the expected capture scope");
      error.code = "WRITE_TARGET_MISMATCH";
      throw error;
    }
  }
  return baseline;
}

function executeWrite(operation, payload, selection, documentRoot) {
  validateWriteState(payload || {}, selection, operation);
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
    const targetIds = Array.isArray(payload && payload.targetIds) ? payload.targetIds : [];
    const items = targetIds.map((id) => findNode(id));
    if (!items.length || items.some((item) => !item)) {
      const error = new Error("One or more XD write target IDs are unavailable");
      error.code = "WRITE_TARGET_UNAVAILABLE";
      throw error;
    }
    const patch = (payload && payload.patch) || {};
    items.forEach((node) => applyPatch(node, patch));
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

function eventPayload(payload = {}) {
  syncDocumentRevision();
  syncSelectionRevision();
  const info = documentInfo();
  const ids = (value) => Array.from(new Set((Array.isArray(value) ? value : []).filter(Boolean))).slice(0, 200);
  return {
    sequence: ++snapshotState.eventSequence,
    documentId: info.documentId,
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    affectedNodeIds: ids(payload.affectedNodeIds),
    removedNodeIds: ids(payload.removedNodeIds),
    ...(payload.status ? { status: String(payload.status).slice(0, 160) } : {}),
    ...(payload.operation ? { operation: String(payload.operation).slice(0, 80) } : {}),
    ...(payload.pendingId ? { pendingId: String(payload.pendingId).slice(0, 160) } : {}),
    ...(payload.requestId ? { requestId: String(payload.requestId).slice(0, 160) } : {}),
    ...(payload.errorCode ? { errorCode: String(payload.errorCode).slice(0, 80) } : {}),
  };
}

function sendEvent(event, payload) {
  send({ type: "event", event, payload: eventPayload(payload) });
}

function errorPayload(error) {
  return {
    code: error && error.code ? error.code : "XD_PLUGIN_ERROR",
    message: error && error.message ? error.message : String(error),
    ...(error && error.details !== undefined ? { details: error.details } : {}),
  };
}

function queueWrite(request) {
  if (state.pendingWrites.length >= MAX_PENDING_WRITES) {
    const error = new Error("XD write queue is full");
    error.code = "XD_WRITE_QUEUE_FULL";
    throw error;
  }
  const pendingId = `xd-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = Date.now() + WRITE_TTL_MS;
  state.pendingWrites.push({ pendingId, request, expiresAt });
  state.writeStatuses.set(pendingId, {
    pendingId,
    status: "queued",
    operation: request.operation,
    message: "Waiting for the user to apply the XD write.",
    expiresAt,
  });
  renderPanel();
  sendResponse(request.requestId, true, {
    status: "queued",
    pendingId,
    requiresUserAction: true,
    pendingCount: state.pendingWrites.length,
    message: "Open the DesignPort panel and press Apply to edit the XD document.",
  });
  sendEvent("write.queued", { pendingId, requestId: request.requestId, operation: request.operation, status: "queued" });
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
          request.payload || {},
        ));
        return;
      case "export_ir": {
        const scope = (request.payload && request.payload.scope) || "document";
        const options = exportOptionsFor(request.payload);
        const result = scope === "selection"
          ? await selectionContext(options)
          : scope === "screen"
            ? await screenContext(request.payload && request.payload.screenId, options)
            : scope === "page"
              ? await pageContext(request.payload && request.payload.pageId, options)
              : await buildDocumentIR(options);
        sendResponse(request.requestId, true, result);
        return;
      }
      case "get_asset":
        sendResponse(request.requestId, true, await getAsset(request.payload || {}));
        return;
      case "get_operation_status": {
        const pendingId = request.payload && request.payload.pendingId;
        const status = state.writeStatuses.get(pendingId);
        sendResponse(request.requestId, true, status
          ? {
            pendingId: status.pendingId,
            status: status.status,
            operation: status.operation,
            ...(status.message ? { message: status.message } : {}),
            ...(status.error ? { error: status.error } : {}),
          }
          : {
            pendingId,
            status: "failed",
            operation: "unknown",
            message: "The requested XD operation status is unavailable.",
          });
        return;
      }
      case "create_screen":
      case "update_selection":
        queueWrite(request);
        return;
      case "create_node_tree": {
        const error = new Error("XD cannot author a bounded native node tree through the public UXP surface");
        error.code = "XD_NODE_TREE_AUTHORING_UNSUPPORTED";
        throw error;
      }
      case "create_component": {
        const error = new Error("XD cannot create a new component definition through the plugin API");
        error.code = "XD_COMPONENT_CREATION_UNSUPPORTED";
        throw error;
      }
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
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        host: "xd",
        pluginVersion: PLUGIN_VERSION,
        pairingToken: PAIRING_TOKEN,
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
  if (item.expiresAt <= Date.now()) {
    state.writeStatuses.set(item.pendingId, {
      pendingId: item.pendingId,
      status: "expired",
      operation: item.request.operation,
      message: "The queued XD write expired before it was applied.",
    });
    renderPanel();
    sendEvent("write.failed", {
      pendingId: item.pendingId,
      requestId: item.request.requestId,
      operation: item.request.operation,
      status: "expired",
      errorCode: "WRITE_EXPIRED",
    });
    return;
  }
  try {
    let result;
    application.editDocument((selection, documentRoot) => {
      result = executeWrite(item.request.operation, item.request.payload, selection, documentRoot);
    });
    snapshotState.documentRevision += 1;
    snapshotState.documentSignature = documentSignature();
    state.writeStatuses.set(item.pendingId, {
      pendingId: item.pendingId,
      status: "applied",
      operation: item.request.operation,
      message: "The XD write was applied.",
    });
    rememberChangedNodeIds([
      result && result.node && result.node.id,
      ...(result && Array.isArray(result.nodes) ? result.nodes.map((node) => node && node.id) : []),
    ]);
    clearAssetCache();
    renderPanel();
    sendEvent("write.applied", {
      pendingId: item.pendingId,
      requestId: item.request.requestId,
      operation: item.request.operation,
      status: "applied",
      affectedNodeIds: [
        result && result.node && result.node.id,
        ...(result && Array.isArray(result.nodes) ? result.nodes.map((node) => node && node.id) : []),
      ],
    });
  } catch (error) {
    state.writeStatuses.set(item.pendingId, {
      pendingId: item.pendingId,
      status: "failed",
      operation: item.request.operation,
      message: error && error.message ? error.message : String(error),
      error: errorPayload(error),
    });
    renderPanel();
    sendEvent("write.failed", {
      pendingId: item.pendingId,
      requestId: item.request.requestId,
      operation: item.request.operation,
      status: "failed",
      errorCode: error && error.code ? error.code : "XD_PLUGIN_ERROR",
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
        sendEvent("selection.changed", {
          affectedNodeIds: selectionItems().map((item) => nodeId(item)),
          status: "selection-changed",
        });
      },
    },
  },
});
