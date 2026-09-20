const BRIDGE_PROTOCOL_VERSION = 2;
const PLUGIN_VERSION = "0.6.0";
const PAIRING_TOKEN = "designport-local-pairing";

const CAPABILITIES = {
  host: "figma",
  pluginVersion: PLUGIN_VERSION,
  features: [
    "design-ir",
    "visual-context",
    "tokens",
    "style-bindings",
    "component-properties",
    "variant-states",
    "text-ranges",
    "interactions",
    "accessibility-signals",
    "responsive-layout",
    "asset-export",
    "pagination",
    "incremental-snapshots",
    "bounded-asset-retrieval",
    "capture-consistency",
    "node-tree-authoring",
    "prototype-authoring",
    "local-component-instance-authoring",
    "explicit-node-updates",
    "font-aware-text-updates",
    "auto-layout-authoring",
  ],
  limitations: [
    "solid-fill-authoring-only",
    "component-variant-authoring-deferred",
    "font-weight-is-set-through-font-style",
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
    "create_component",
    "create_node_tree",
    "update_selection",
    "set_prototype",
  ],
  supports: {
    documentRead: true,
    selectionRead: true,
    createScreen: true,
    createComponent: true,
    createNodeTree: true,
    updateSelection: true,
    setPrototype: true,
    userActionRequiredForWrite: false,
    visualRead: true,
  },
};

const MAX_ASSET_EXPORTS_PER_REQUEST = 64;
const MAX_ASSET_CACHE_BYTES = 32_000_000;
const assetCache = new Map();
const assetPromises = new Map();
let assetCacheBytes = 0;
const tokenCache = new Map();
const snapshotState = {
  sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  documentRevision: 0,
  selectionRevision: 0,
  selectionKey: "",
  changeLog: [],
  snapshots: new Map(),
  evictedSnapshotIds: new Set(),
  generation: 0,
  eventSequence: 0,
  lastCapture: new Map(),
  assets: new Map(),
  cursors: new Map(),
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

figma.showUI(__html__, { visible: false, width: 1, height: 1 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
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
  const key = selectionItems().map((item) => item.id).join(",");
  if (key === snapshotState.selectionKey) return;
  snapshotState.selectionKey = key;
  snapshotState.selectionRevision += 1;
  rememberChangedNodeIds(selectionItems().map((item) => item.id));
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
    id: entry.node.id,
    parentId: entry.parentId || null,
    children: childrenOf(entry.node).map((child) => child.id),
    name: entry.node.name,
    visible: entry.node.visible !== false,
    bounds: boundsFor(entry.node),
    text: entry.node.type === "TEXT" ? entry.node.characters : undefined,
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
  snapshotState.lastCapture.set(identity.scope, { snapshot, fingerprint, captureId });
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
    "text", "textSegments", "typography", "prototypeLinks",
    "untrustedText", "provenance",
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

function affineTransformFor(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  if (!Array.isArray(value[0]) || !Array.isArray(value[1]) || value[0].length !== 3 || value[1].length !== 3) {
    return undefined;
  }
  const values = [...value[0], ...value[1]];
  if (!values.every((item) => Number.isFinite(item))) return undefined;
  return {
    a: value[0][0],
    b: value[1][0],
    c: value[0][1],
    d: value[1][1],
    tx: value[0][2],
    ty: value[1][2],
  };
}

function blendModeFor(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return normalized === "normal" || normalized === "pass_through" ? undefined : normalized;
}

function ref(id) {
  return { host: "figma", id };
}

function kindFor(node, topLevel) {
  switch (node.type) {
    case "DOCUMENT": return "root";
    case "PAGE": return "root";
    case "FRAME": return topLevel ? "screen" : "frame";
    case "GROUP": return "group";
    case "RECTANGLE": return "rectangle";
    case "ELLIPSE": return "ellipse";
    case "LINE": return "line";
    case "VECTOR":
    case "BOOLEAN_OPERATION":
    case "POLYGON":
    case "STAR": return "path";
    case "TEXT": return "text";
    case "COMPONENT":
    case "COMPONENT_SET": return "component";
    case "INSTANCE": return "instance";
    default: return "unknown";
  }
}

function boundsFor(node) {
  const bounds = node.absoluteBoundingBox;
  if (!bounds) return null;
  return {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Math.max(0, Number(bounds.width) || 0),
    height: Math.max(0, Number(bounds.height) || 0),
  };
}

function localBoundsFor(node) {
  if (!node || !Number.isFinite(node.width) || !Number.isFinite(node.height)) return null;
  return {
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    width: Math.max(0, Number(node.width) || 0),
    height: Math.max(0, Number(node.height) || 0),
  };
}

function paintsToIR(paints) {
  if (!Array.isArray(paints)) return [];
  return paints.map((paint) => {
    const opacity = Number.isFinite(paint.opacity) ? clamp(paint.opacity, 0, 1) : 1;
    const common = {
      ...(opacity !== 1 ? { opacity } : {}),
      ...(paint.visible === false ? { visible: false } : {}),
      ...(blendModeFor(paint.blendMode) ? { blendMode: blendModeFor(paint.blendMode) } : {}),
    };
    if (paint.type === "SOLID" && paint.color) {
      return {
        type: "solid",
        color: {
          r: clamp(paint.color.r, 0, 1),
          g: clamp(paint.color.g, 0, 1),
          b: clamp(paint.color.b, 0, 1),
        },
        ...common,
      };
    }
    if (paint.type === "IMAGE") {
      return {
        type: "image",
        ...(paint.imageHash ? { resource: paint.imageHash } : {}),
        ...(typeof paint.scaleMode === "string" ? { imageScaleMode: paint.scaleMode.toLowerCase() } : {}),
        ...(affineTransformFor(paint.imageTransform) ? { imageTransform: affineTransformFor(paint.imageTransform) } : {}),
        ...(Number.isFinite(paint.scalingFactor) && paint.scalingFactor > 0 ? { imageScaleFactor: paint.scalingFactor } : {}),
        ...(Number.isFinite(paint.rotation) ? { imageRotation: paint.rotation } : {}),
        ...common,
      };
    }
    if (typeof paint.type === "string" && paint.type.startsWith("GRADIENT_") && Array.isArray(paint.gradientStops)) {
      const gradientType = {
        GRADIENT_LINEAR: "linear",
        GRADIENT_RADIAL: "radial",
        GRADIENT_ANGULAR: "angular",
        GRADIENT_DIAMOND: "diamond",
      }[paint.type];
      return {
        type: "gradient",
        ...(gradientType ? { gradientType } : {}),
        gradientStops: paint.gradientStops.map((stop) => ({
          position: clamp(stop.position, 0, 1),
          color: {
            r: clamp(stop.color.r, 0, 1),
            g: clamp(stop.color.g, 0, 1),
            b: clamp(stop.color.b, 0, 1),
            ...(Number.isFinite(stop.color.a) ? { a: clamp(stop.color.a, 0, 1) } : {}),
          },
        })),
        ...(Array.isArray(paint.gradientHandlePositions) && paint.gradientHandlePositions.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
          ? { gradientHandles: paint.gradientHandlePositions.map((point) => ({ x: point.x, y: point.y })) }
          : {}),
        ...(affineTransformFor(paint.gradientTransform) ? { gradientTransform: affineTransformFor(paint.gradientTransform) } : {}),
        ...common,
      };
    }
    return { type: "unknown", ...common };
  });
}

function strokesToIR(node) {
  if (!Array.isArray(node.strokes) || !node.strokes.length) return undefined;
  const position = {
    INSIDE: "inside",
    OUTSIDE: "outside",
    CENTER: "center",
  }[node.strokeAlign];
  const sideWeights = {
    top: node.strokeTopWeight,
    right: node.strokeRightWeight,
    bottom: node.strokeBottomWeight,
    left: node.strokeLeftWeight,
  };
  const hasSideWeights = Object.values(sideWeights).every((value) => Number.isFinite(value));
  return paintsToIR(node.strokes).map((fill) => ({
    fills: [fill],
    ...(Number.isFinite(node.strokeWeight) ? { weight: Math.max(0, node.strokeWeight) } : {}),
    ...(position ? { position } : {}),
    ...(hasSideWeights ? {
      sideWeights: Object.fromEntries(
        Object.entries(sideWeights).map(([key, value]) => [key, Math.max(0, value)]),
      ),
    } : {}),
    ...(Array.isArray(node.dashPattern) ? {
      dashPattern: node.dashPattern
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(0, value)),
    } : {}),
    ...(typeof node.strokeCap === "string" ? { cap: node.strokeCap.toLowerCase() } : {}),
    ...(typeof node.strokeJoin === "string" ? { join: node.strokeJoin.toLowerCase() } : {}),
  }));
}

function effectListToIR(effects) {
  if (!Array.isArray(effects) || !effects.length) return undefined;
  return effects.map((effect) => {
    const type = {
      DROP_SHADOW: "drop-shadow",
      INNER_SHADOW: "inner-shadow",
      LAYER_BLUR: "layer-blur",
      BACKGROUND_BLUR: "background-blur",
    }[effect.type] || "unknown";
    return {
      type,
      ...(effect.color ? {
        color: {
          r: clamp(effect.color.r, 0, 1),
          g: clamp(effect.color.g, 0, 1),
          b: clamp(effect.color.b, 0, 1),
          ...(Number.isFinite(effect.color.a) ? { a: clamp(effect.color.a, 0, 1) } : {}),
        },
      } : {}),
      ...(effect.offset ? {
        offset: {
          x: Number(effect.offset.x) || 0,
          y: Number(effect.offset.y) || 0,
        },
      } : {}),
      ...(Number.isFinite(effect.radius) ? { radius: Math.max(0, effect.radius) } : {}),
      ...(Number.isFinite(effect.spread) ? { spread: effect.spread } : {}),
      ...(typeof effect.visible === "boolean" ? { visible: effect.visible } : {}),
      ...(blendModeFor(effect.blendMode) ? { blendMode: blendModeFor(effect.blendMode) } : {}),
    };
  });
}

function effectsToIR(node) {
  return effectListToIR(node.effects);
}

function cornersToIR(node) {
  const result = {};
  if (typeof node.cornerRadius === "number" && Number.isFinite(node.cornerRadius) && node.cornerRadius > 0) {
    result.cornerRadius = Math.max(0, node.cornerRadius);
  }
  const corners = {
    topLeft: node.topLeftRadius,
    topRight: node.topRightRadius,
    bottomRight: node.bottomRightRadius,
    bottomLeft: node.bottomLeftRadius,
  };
  if (Object.values(corners).every((value) => Number.isFinite(value)) && Object.values(corners).some((value) => value > 0)) {
    result.cornerRadii = Object.fromEntries(
      Object.entries(corners).map(([key, value]) => [key, Math.max(0, value)]),
    );
  }
  return result;
}

function assetCacheKey(node) {
  return `${snapshotState.sessionId}:${figma.root.id}:${snapshotState.documentRevision}:${snapshotState.generation}:${node.id}`;
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
  const isVector = node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || node.type === "POLYGON" || node.type === "STAR";
  const imagePaint = Array.isArray(node.fills)
    ? node.fills.find((paint) => paint && paint.type === "IMAGE" && paint.imageHash)
    : undefined;
  if (!isVector && !imagePaint) return undefined;

  const key = assetCacheKey(node);
  const requestRevision = snapshotState.documentRevision;
  const includeAsset = (asset) => {
    if (!asset) {
      exportState.assetsOmitted += 1;
      return undefined;
    }
    const byteSize = Number.isFinite(asset.size)
      ? asset.size
      : typeof asset.data === "string"
        ? utf8ByteLength(asset.data)
        : 0;
    if (exportState.assetBytes + byteSize > exportState.options.maxAssetBytes) {
      exportState.assetsOmitted += 1;
      exportState.omissions.push({ kind: "budget", message: "Asset evidence exceeded maxAssetBytes.", nodeIds: [node.id] });
      return undefined;
    }
    exportState.assetCount += 1;
    exportState.assetBytes += byteSize;
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

  const promise = (async () => {
    try {
      if (isVector) {
        const svg = await node.exportAsync({ format: "SVG_STRING", contentsOnly: true });
        if (typeof svg === "string" && svg.trim()) {
          const artifact = {
            mimeType: "image/svg+xml",
            data: svg,
            kind: "vector",
            artifactId: `asset-${hashValue(`${key}|${svg}`)}`,
            digest: hashValue(svg),
            size: utf8ByteLength(svg),
            sourceNodeIds: [node.id],
          };
          snapshotState.assets.set(artifact.artifactId, artifact);
          return artifact;
        }
      }
      if (!imagePaint) return undefined;
      const bytes = await node.exportAsync({ format: "PNG", contentsOnly: true });
      const artifact = {
        mimeType: "image/png",
        data: figma.base64Encode(bytes),
        kind: "image",
        artifactId: `asset-${hashValue(`${key}|${bytes.length}|${bytes[0] || 0}`)}`,
        digest: hashValue(figma.base64Encode(bytes)),
        size: bytes.length,
        sourceNodeIds: [node.id],
        ...(typeof imagePaint.scaleMode === "string" ? { imageScaleMode: imagePaint.scaleMode.toLowerCase() } : {}),
      };
      snapshotState.assets.set(artifact.artifactId, artifact);
      return artifact;
    } catch (_error) {
      // Keep the structural node when a host cannot export one asset.
      exportState.omissions.push({ kind: "failed", message: "Host could not export this asset.", nodeIds: [node.id] });
      return undefined;
    }
  })();
  assetPromises.set(key, promise);
  try {
    const asset = await promise;
    if (requestRevision !== snapshotState.documentRevision) {
      exportState.assetsOmitted += 1;
      exportState.omissions.push({ kind: "failed", message: "Asset export completed after the document changed.", nodeIds: [node.id] });
      return undefined;
    }
    cacheAsset(key, asset);
    return includeAsset(asset);
  } finally {
    assetPromises.delete(key);
  }
}

function typographyFromValue(node) {
  if (!node) return undefined;
  const result = {};
  if (node.fontName && node.fontName !== figma.mixed && typeof node.fontName === "object") {
    if (typeof node.fontName.family === "string") result.family = node.fontName.family;
    if (typeof node.fontName.style === "string") result.style = node.fontName.style;
  }
  if (typeof node.fontSize === "number") result.size = node.fontSize;
  if (typeof node.fontWeight === "number") result.weight = node.fontWeight;
  if (typeof node.letterSpacing === "object" && typeof node.letterSpacing.value === "number") {
    result.letterSpacing = node.letterSpacing.unit === "PERCENT" && typeof node.fontSize === "number"
      ? node.fontSize * node.letterSpacing.value / 100
      : node.letterSpacing.value;
  }
  if (typeof node.lineHeight === "object" && typeof node.lineHeight.value === "number") {
    result.lineHeight = node.lineHeight.unit === "PERCENT" && typeof node.fontSize === "number"
      ? node.fontSize * node.lineHeight.value / 100
      : node.lineHeight.value;
  }
  if (typeof node.textDecoration === "string") {
    const decoration = {
      NONE: "none",
      UNDERLINE: "underline",
      STRIKETHROUGH: "strikethrough",
    }[node.textDecoration];
    if (decoration) result.decoration = decoration;
  }
  if (typeof node.textCase === "string") {
    const textCase = {
      ORIGINAL: "original",
      UPPER: "upper",
      LOWER: "lower",
      TITLE: "title",
      SMALL_CAPS: "small-caps",
      SMALL_CAPS_FORCED: "small-caps-forced",
    }[node.textCase];
    if (textCase) result.textCase = textCase;
  }
  if (typeof node.textAlignVertical === "string") {
    const alignVertical = {
      TOP: "top",
      CENTER: "center",
      BOTTOM: "bottom",
    }[node.textAlignVertical];
    if (alignVertical) result.alignVertical = alignVertical;
  }
  if (typeof node.textAutoResize === "string") {
    const autoResize = {
      NONE: "none",
      WIDTH_AND_HEIGHT: "width-and-height",
      HEIGHT: "height",
      TRUNCATE: "truncate",
    }[node.textAutoResize];
    if (autoResize) result.autoResize = autoResize;
  }
  if (typeof node.textTruncation === "string") {
    const textTruncation = {
      DISABLED: "disabled",
      ENDING: "ending",
    }[node.textTruncation];
    if (textTruncation) result.textTruncation = textTruncation;
  }
  if (Number.isInteger(node.maxLines) && node.maxLines > 0) result.maxLines = node.maxLines;
  if (Number.isFinite(node.paragraphIndent)) result.paragraphIndent = node.paragraphIndent;
  if (Number.isFinite(node.paragraphSpacing)) result.paragraphSpacing = Math.max(0, node.paragraphSpacing);
  if (typeof node.textAlignHorizontal === "string") {
    result.align = node.textAlignHorizontal.toLowerCase();
  }
  return Object.keys(result).length ? result : undefined;
}

function typographyFor(node) {
  return node.type === "TEXT" ? typographyFromValue(node) : undefined;
}

function textSegmentsFor(node) {
  if (node.type !== "TEXT" || typeof node.getStyledTextSegments !== "function") return undefined;
  const segments = safeRead(() => node.getStyledTextSegments([
    "fontName",
    "fontSize",
    "fontWeight",
    "textDecoration",
    "textCase",
    "lineHeight",
    "letterSpacing",
    "fills",
    "textStyleId",
    "fillStyleId",
    "hyperlink",
    "paragraphIndent",
    "paragraphSpacing",
  ]), []);
  if (!Array.isArray(segments) || !segments.length) return undefined;
  return segments.map((segment) => {
    const styleRefs = {};
    const textStyleId = nonEmptyString(segment.textStyleId);
    const fillStyleId = nonEmptyString(segment.fillStyleId);
    if (textStyleId) styleRefs.text = textStyleId;
    if (fillStyleId) styleRefs.fill = fillStyleId;
    const typography = typographyFromValue(segment);
    return {
      start: segment.start,
      end: segment.end,
      characters: typeof segment.characters === "string" ? segment.characters : "",
      ...(typography ? { typography } : {}),
      ...(Array.isArray(segment.fills) && segment.fills.length ? { fills: paintsToIR(segment.fills) } : {}),
      ...(Object.keys(styleRefs).length ? { styleRefs } : {}),
      ...(segment.hyperlink ? { hyperlink: tokenValueFor(segment.hyperlink) } : {}),
    };
  });
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

function styleRefsFor(node) {
  const refs = {};
  const fields = {
    fill: node.fillStyleId,
    stroke: node.strokeStyleId,
    text: node.textStyleId,
    effect: node.effectStyleId,
    grid: node.gridStyleId,
  };
  Object.entries(fields).forEach(([key, value]) => {
    const id = nonEmptyString(value);
    if (id) refs[key] = id;
  });
  return Object.keys(refs).length ? refs : undefined;
}

function variableBindingsFor(node) {
  const bound = safeRead(() => node.boundVariables, undefined);
  if (!bound || typeof bound !== "object") return undefined;
  const result = {};
  Object.entries(bound).forEach(([field, value]) => {
    const values = Array.isArray(value) ? value : [value];
    const ids = values
      .filter((item) => item && typeof item === "object" && item.type === "VARIABLE_ALIAS")
      .map((item) => item.id)
      .filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length) result[field] = ids;
  });
  return Object.keys(result).length ? result : undefined;
}

function componentPropertyTypeFor(value) {
  return {
    BOOLEAN: "boolean",
    TEXT: "text",
    INSTANCE_SWAP: "instance-swap",
    VARIANT: "variant",
  }[value] || "unknown";
}

function componentPropertiesFor(definitions, values) {
  const names = new Set([
    ...Object.keys(definitions && typeof definitions === "object" ? definitions : {}),
    ...Object.keys(values && typeof values === "object" ? values : {}),
  ]);
  const properties = [];
  names.forEach((key) => {
    const definition = definitions && definitions[key] && typeof definitions[key] === "object"
      ? definitions[key]
      : {};
    const value = values && values[key] && typeof values[key] === "object"
      ? values[key]
      : {};
    const source = Object.keys(value).length ? value : definition;
    const type = componentPropertyTypeFor(source.type || definition.type);
    const property = {
      key,
      name: key.replace(/#.*$/, ""),
      type,
      ...(Object.prototype.hasOwnProperty.call(value, "value") ? { value: value.value } : {}),
      ...(Object.prototype.hasOwnProperty.call(definition, "defaultValue") ? { defaultValue: definition.defaultValue } : {}),
      ...(Array.isArray(definition.variantOptions) ? { variantOptions: [...definition.variantOptions] } : {}),
      ...(Array.isArray(definition.preferredValues) ? {
        preferredValues: definition.preferredValues.map((item) => ({
          type: {
            COMPONENT: "component",
            COMPONENT_SET: "component-set",
          }[item.type] || "unknown",
          ...(typeof item.key === "string" ? { key: item.key } : {}),
        })),
      } : {}),
    };
    properties.push(property);
  });
  return properties.length ? properties : undefined;
}

function statesFor(variantProperties) {
  if (!variantProperties || typeof variantProperties !== "object") return undefined;
  const states = {};
  Object.entries(variantProperties).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    if (/(state|status|interaction|mode)/i.test(key)) states[key] = value;
  });
  return Object.keys(states).length ? states : undefined;
}

function componentFor(node) {
  const isInstance = node.type === "INSTANCE";
  const isComponent = node.type === "COMPONENT" || node.type === "COMPONENT_SET";
  const mainComponent = isInstance ? safeRead(() => node.mainComponent, null) : null;
  const base = isComponent ? node : mainComponent;
  const variantProperties = safeRead(() => node.variantProperties, null);
  const definitions = safeRead(
    () => (node.componentPropertyDefinitions || (base && base.componentPropertyDefinitions)),
    undefined,
  );
  const values = isInstance ? safeRead(() => node.componentProperties, undefined) : undefined;
  if (!base && !variantProperties && !definitions) return undefined;

  const parent = base && base.parent && base.parent.type === "COMPONENT_SET"
    ? base.parent
    : null;
  const variant = variantProperties && typeof variantProperties === "object"
    ? Object.fromEntries(Object.entries(variantProperties).filter(([, value]) => typeof value === "string"))
    : undefined;
  const baseId = base && typeof base.id === "string" ? base.id : node.id;
  const properties = componentPropertiesFor(definitions, values);
  const states = statesFor(variant);
  return {
    id: baseId,
    ...(parent && typeof parent.id === "string" ? { setId: parent.id } : {}),
    ...(base && nonEmptyString(base.name) ? { name: base.name } : {}),
    ...(base && nonEmptyString(base.description) ? { description: base.description } : {}),
    ...(variant && Object.keys(variant).length ? { variantProperties: variant } : {}),
    ...(properties ? { properties } : {}),
    ...(states ? { states } : {}),
    ...(mainComponent && typeof mainComponent.id === "string" ? { mainComponentId: mainComponent.id } : {}),
    ...(parent || (isComponent && node.parent && node.parent.type === "COMPONENT_SET") ? { isVariant: true } : {}),
    ...(isInstance ? { isInstance: true } : {}),
  };
}

function annotationsFor(node) {
  const annotations = safeRead(() => node.annotations, undefined);
  if (!Array.isArray(annotations) || !annotations.length) return undefined;
  const result = annotations.map((annotation) => ({
    ...(typeof annotation.label === "string" ? { label: annotation.label } : {}),
    ...(typeof annotation.labelMarkdown === "string" ? { labelMarkdown: annotation.labelMarkdown } : {}),
    ...(typeof annotation.categoryId === "string" ? { categoryId: annotation.categoryId } : {}),
    ...(Array.isArray(annotation.properties) ? {
      properties: annotation.properties
        .map((property) => property && property.type)
        .filter((type) => typeof type === "string"),
    } : {}),
    untrusted: true,
  }));
  return result.length ? result : undefined;
}

function pluginDataFor(node, key) {
  return nonEmptyString(safeRead(() => node.getSharedPluginData("designport", key), ""));
}

function booleanData(value) {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function inferredAccessibilityFor(node) {
  const name = `${node.name || ""} ${node.type || ""}`.toLowerCase();
  const tokens = name.split(/[\s_-]+/).filter(Boolean);
  const hasToken = (value) => tokens.includes(value);
  const headingMatch = name.match(/(?:^|[\s_-])h([1-6])(?:$|[\s_-])|(?:^|[\s_-])heading(?:$|[\s_-])/);
  if (headingMatch || node.type === "TEXT" && /title|heading/.test(name)) {
    return {
      role: "heading",
      ...(headingMatch && headingMatch[1] ? { headingLevel: Number(headingMatch[1]) } : {}),
      confidence: 0.55,
    };
  }
  const rolePatterns = [
    ["button", ["button", "cta"]],
    ["link", ["link", "hyperlink"]],
    ["checkbox", ["checkbox"]],
    ["switch", ["switch", "toggle"]],
    ["textbox", ["input", "textfield", "search"]],
    ["tab", ["tab"]],
    ["navigation", ["navigation", "navbar", "bottom-nav"]],
    ["img", ["image", "photo", "avatar", "thumbnail"]],
  ];
  const match = rolePatterns.find(([, roleTokens]) => roleTokens.some((token) => hasToken(token)));
  return match ? { role: match[0], confidence: 0.4 } : undefined;
}

function accessibilityFor(node) {
  let configured = {};
  const rawConfig = pluginDataFor(node, "accessibility");
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) configured = parsed;
    } catch (_error) {
      configured = {};
    }
  }
  const configuredRole = nonEmptyString(configured.role) || pluginDataFor(node, "a11y.role");
  const configuredLabel = typeof configured.label === "string" ? configured.label : nonEmptyString(pluginDataFor(node, "a11y.label"));
  const configuredDescription = typeof configured.description === "string"
    ? configured.description
    : nonEmptyString(pluginDataFor(node, "a11y.description"));
  const configuredAltText = typeof configured.altText === "string" ? configured.altText : nonEmptyString(pluginDataFor(node, "a11y.altText"));
  const configuredHeadingLevel = Number(configured.headingLevel || pluginDataFor(node, "a11y.headingLevel"));
  const configuredFocusable = typeof configured.focusable === "boolean"
    ? configured.focusable
    : booleanData(pluginDataFor(node, "a11y.focusable"));
  const configuredDecorative = typeof configured.decorative === "boolean"
    ? configured.decorative
    : booleanData(pluginDataFor(node, "a11y.decorative"));
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
  const label = configuredLabel !== undefined
    ? configuredLabel
    : role && ["button", "link", "tab", "img", "textbox"].includes(role) && node.type === "TEXT"
      ? node.characters
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
          ? { label: { source: "inferred", sourceField: "node.characters", inferenceRuleVersion: "accessibility-name-v2" } }
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

function tokenValueFor(value) {
  if (Array.isArray(value)) return value.map(tokenValueFor);
  if (!value || typeof value !== "object") return value;
  if (value.type === "VARIABLE_ALIAS" && typeof value.id === "string") {
    return { alias: value.id };
  }
  if (Number.isFinite(value.r) && Number.isFinite(value.g) && Number.isFinite(value.b)) {
    return {
      r: clamp(value.r, 0, 1),
      g: clamp(value.g, 0, 1),
      b: clamp(value.b, 0, 1),
      ...(Number.isFinite(value.a) ? { a: clamp(value.a, 0, 1) } : {}),
    };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== "function")
      .map(([key, item]) => [key, tokenValueFor(item)]),
  );
}

function layoutGridsToIR(grids) {
  if (!Array.isArray(grids) || !grids.length) return undefined;
  return grids.map((grid) => ({
    ...(typeof grid.pattern === "string" ? { pattern: grid.pattern.toLowerCase() } : {}),
    ...(Number.isFinite(grid.sectionSize) ? { sectionSize: grid.sectionSize } : {}),
    ...(Number.isFinite(grid.gutterSize) ? { gutterSize: grid.gutterSize } : {}),
    ...(Number.isFinite(grid.offset) ? { offset: grid.offset } : {}),
    ...(typeof grid.alignment === "string" ? { alignment: grid.alignment.toLowerCase() } : {}),
    ...(grid.color ? { color: tokenValueFor(grid.color) } : {}),
  }));
}

async function readLocalList(owner, asyncName, syncName) {
  if (owner && typeof owner[asyncName] === "function") {
    try {
      return await owner[asyncName]();
    } catch (_error) {
      // Fall through to the synchronous API for older/runtime-limited files.
    }
  }
  if (owner && typeof owner[syncName] === "function") {
    try {
      return owner[syncName]();
    } catch (_error) {
      return [];
    }
  }
  return [];
}

function styleTokenFor(style, source, type, value) {
  if (!style || typeof style.id !== "string") return undefined;
  return {
    id: style.id,
    name: nonEmptyString(style.name) || style.id,
    type,
    value: tokenValueFor(value),
    ...(nonEmptyString(style.description) ? { description: style.description } : {}),
    source,
  };
}

async function tokenCatalog(options) {
  if (!options.includeTokens || options.detail === "summary") return [];
  const key = `${snapshotState.sessionId}:${figma.root.id}:${snapshotState.documentRevision}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const promise = (async () => {
    const variablesAPI = figma.variables || figma;
    const [paintStyles, textStyles, effectStyles, gridStyles, collections, variables] = await Promise.all([
      readLocalList(figma, "getLocalPaintStylesAsync", "getLocalPaintStyles"),
      readLocalList(figma, "getLocalTextStylesAsync", "getLocalTextStyles"),
      readLocalList(figma, "getLocalEffectStylesAsync", "getLocalEffectStyles"),
      readLocalList(figma, "getLocalGridStylesAsync", "getLocalGridStyles"),
      readLocalList(variablesAPI, "getLocalVariableCollectionsAsync", "getLocalVariableCollections"),
      readLocalList(variablesAPI, "getLocalVariablesAsync", "getLocalVariables"),
    ]);
    const result = [];
    paintStyles.forEach((style) => {
      const token = styleTokenFor(style, "paint-style", "color", paintsToIR(style.paints));
      if (token) result.push(token);
    });
    textStyles.forEach((style) => {
      const token = styleTokenFor(style, "text-style", "typography", typographyFromValue(style));
      if (token) result.push(token);
    });
    effectStyles.forEach((style) => {
      const token = styleTokenFor(style, "effect-style", "effect", effectListToIR(style.effects));
      if (token) result.push(token);
    });
    gridStyles.forEach((style) => {
      const token = styleTokenFor(style, "grid-style", "grid", layoutGridsToIR(style.layoutGrids));
      if (token) result.push(token);
    });
    const collectionById = new Map(
      collections
        .filter((collection) => collection && typeof collection.id === "string")
        .map((collection) => [collection.id, collection]),
    );
    variables.forEach((variable) => {
      if (!variable || typeof variable.id !== "string") return;
      const collection = collectionById.get(variable.variableCollectionId);
      const modes = Array.isArray(collection && collection.modes) ? collection.modes : [];
      const valuesByMode = {};
      modes.forEach((mode) => {
        if (Object.prototype.hasOwnProperty.call(variable.valuesByMode || {}, mode.modeId)) {
          valuesByMode[mode.modeId] = tokenValueFor(variable.valuesByMode[mode.modeId]);
        }
      });
      const defaultMode = modes.find((mode) => mode.modeId === (collection && collection.defaultModeId));
      const defaultValue = defaultMode && Object.prototype.hasOwnProperty.call(valuesByMode, defaultMode.modeId)
        ? valuesByMode[defaultMode.modeId]
        : undefined;
      const type = {
        COLOR: "color",
        FLOAT: "number",
        STRING: "string",
        BOOLEAN: "boolean",
      }[variable.resolvedType] || "unknown";
      result.push({
        id: variable.id,
        name: nonEmptyString(variable.name) || variable.id,
        type,
        ...(defaultValue !== undefined ? { value: defaultValue } : {}),
        ...(Object.keys(valuesByMode).length ? { valuesByMode } : {}),
        ...(collection && typeof collection.id === "string" ? { collectionId: collection.id } : {}),
        ...(collection && nonEmptyString(collection.name) ? { collectionName: collection.name } : {}),
        ...(modes.length ? { modes: modes.map((mode) => ({ id: mode.modeId, name: mode.name || mode.modeId })) } : {}),
        ...(nonEmptyString(variable.description) ? { description: variable.description } : {}),
        ...(Array.isArray(variable.scopes) && variable.scopes.length ? { scopes: [...variable.scopes] } : {}),
        ...(variable.codeSyntax && typeof variable.codeSyntax === "object" ? {
          codeSyntax: Object.fromEntries(
            Object.entries(variable.codeSyntax).filter(([, value]) => typeof value === "string"),
          ),
        } : {}),
        resolutionStatus: Object.values(valuesByMode).some((value) => value && typeof value === "object" && value.alias)
          ? "alias"
          : "resolved",
        source: "variable",
      });
    });
    const aliases = new Map(result
      .filter((token) => token.source === "variable" && token.value && typeof token.value === "object" && token.value.alias)
      .map((token) => [token.id, token.value.alias]));
    result.forEach((token) => {
      let current = token.id;
      const visited = new Set();
      while (aliases.has(current) && !visited.has(current)) {
        visited.add(current);
        current = aliases.get(current);
      }
      if (visited.has(current)) {
        token.aliasCycle = true;
        token.resolutionStatus = "cycle";
      } else if (aliases.has(token.id)) {
        token.aliasOf = aliases.get(token.id);
      }
    });
    return result;
  })();
  tokenCache.set(key, promise);
  try {
    return await promise;
  } catch (_error) {
    tokenCache.delete(key);
    return [];
  }
}

function layoutFor(node, parentLayoutMode) {
  const sizing = (value) => {
    if (value === "FIXED" || value === "HUG" || value === "FILL") {
      return value.toLowerCase();
    }
    return undefined;
  };
  const mode = node.layoutMode && node.layoutMode !== "NONE"
    ? node.layoutMode.toLowerCase()
    : "none";
  const sizingHorizontal = sizing(node.layoutSizingHorizontal);
  const sizingVertical = sizing(node.layoutSizingVertical);
  const primaryAxisAlign = {
    MIN: "min",
    CENTER: "center",
    MAX: "max",
    SPACE_BETWEEN: "space-between",
  }[node.primaryAxisAlignItems];
  const counterAxisAlign = {
    MIN: "min",
    CENTER: "center",
    MAX: "max",
    BASELINE: "baseline",
  }[node.counterAxisAlignItems];
  const counterAxisAlignContent = {
    AUTO: "auto",
    SPACE_BETWEEN: "space-between",
  }[node.counterAxisAlignContent];
  const wrap = {
    NO_WRAP: "no-wrap",
    WRAP: "wrap",
  }[node.layoutWrap];
  const grid = {};
  if (mode === "grid") {
    if (Number.isInteger(node.gridRowCount) && node.gridRowCount > 0) grid.rows = node.gridRowCount;
    if (Number.isInteger(node.gridColumnCount) && node.gridColumnCount > 0) grid.columns = node.gridColumnCount;
    if (Number.isFinite(node.gridRowGap) && node.gridRowGap > 0) grid.rowGap = node.gridRowGap;
    if (Number.isFinite(node.gridColumnGap) && node.gridColumnGap > 0) grid.columnGap = node.gridColumnGap;
  }
  const hasGridMetadata = mode === "grid" && Object.keys(grid).length > 0;
  const parentUsesLayout = parentLayoutMode === "HORIZONTAL"
    || parentLayoutMode === "VERTICAL"
    || parentLayoutMode === "GRID";
  const padding = {
    top: Number(node.paddingTop) || 0,
    right: Number(node.paddingRight) || 0,
    bottom: Number(node.paddingBottom) || 0,
    left: Number(node.paddingLeft) || 0,
  };
  const hasPadding = Object.values(padding).some((value) => value > 0);
  const hasLayoutMetadata = mode !== "none"
    || parentUsesLayout && (
      sizingHorizontal
      || sizingVertical
      || primaryAxisAlign
      || counterAxisAlign
      || node.layoutPositioning === "ABSOLUTE"
    )
    || counterAxisAlignContent === "space-between"
    || wrap === "wrap"
    || Number.isFinite(node.counterAxisSpacing) && node.counterAxisSpacing > 0
    || node.itemReverseZIndex === true
    || node.strokesIncludedInLayout === true
    || hasGridMetadata;
  if (!hasLayoutMetadata) return undefined;
  return {
    mode,
    ...(typeof node.itemSpacing === "number" && node.itemSpacing !== 0 ? { gap: node.itemSpacing } : {}),
    ...(hasPadding ? { padding } : {}),
    ...(sizingHorizontal ? { sizingHorizontal } : {}),
    ...(sizingVertical ? { sizingVertical } : {}),
    ...(primaryAxisAlign ? { primaryAxisAlign } : {}),
    ...(counterAxisAlign ? { counterAxisAlign } : {}),
    ...(counterAxisAlignContent === "space-between" ? { counterAxisAlignContent } : {}),
    ...(wrap === "wrap" ? { wrap } : {}),
    ...(Number.isFinite(node.counterAxisSpacing) && node.counterAxisSpacing > 0 ? { counterAxisSpacing: node.counterAxisSpacing } : {}),
    ...(node.itemReverseZIndex === true ? { itemReverseZIndex: true } : {}),
    ...(node.strokesIncludedInLayout === true ? { strokesIncludedInLayout: true } : {}),
    ...(hasGridMetadata ? { grid } : {}),
  };
}

function constraintsFor(node) {
  if (!node.constraints) return undefined;
  const horizontal = {
    LEFT: "left",
    RIGHT: "right",
    CENTER: "center",
    LEFT_RIGHT: "left-right",
    SCALE: "scale",
  }[node.constraints.horizontal];
  const vertical = {
    TOP: "top",
    BOTTOM: "bottom",
    CENTER: "center",
    TOP_BOTTOM: "top-bottom",
    SCALE: "scale",
  }[node.constraints.vertical];
  if (!horizontal && !vertical) return undefined;
  return {
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
  };
}

function prototypeLinksFor(node) {
  if (!Array.isArray(node.reactions) || !node.reactions.length) return undefined;
  const links = [];
  node.reactions.forEach((reaction) => {
    const triggerObject = reaction.trigger || {};
    const trigger = triggerObject.type
      ? String(triggerObject.type).toLowerCase()
      : "unknown";
    const triggerData = Object.fromEntries(
      ["timeout", "delay", "device", "keyCodes", "mediaHitTime"]
        .filter((key) => triggerObject[key] !== undefined)
        .map((key) => [key, triggerObject[key]]),
    );
    const actions = Array.isArray(reaction.actions)
      ? reaction.actions
      : reaction.action
        ? [reaction.action]
      : [];
    actions.forEach((action) => {
      if (!action || typeof action.type !== "string") return;
      const data = {
        ...(Object.keys(triggerData).length ? { trigger: triggerData } : {}),
        ...(action.transition && action.transition.easing && action.transition.easing.easingFunctionCubicBezier
          ? { easingFunctionCubicBezier: action.transition.easing.easingFunctionCubicBezier }
          : {}),
        ...(action.transition && action.transition.easing && action.transition.easing.easingFunctionSpring
          ? { easingFunctionSpring: action.transition.easing.easingFunctionSpring }
          : {}),
        ...(typeof action.variableId === "string" ? { variableId: action.variableId } : {}),
        ...(typeof action.variableCollectionId === "string" ? { variableCollectionId: action.variableCollectionId } : {}),
        ...(action.variableValue !== undefined ? { variableValue: tokenValueFor(action.variableValue) } : {}),
        ...(Array.isArray(action.conditionalBlocks) ? { conditionalBlocks: action.conditionalBlocks } : {}),
        ...(action.data && typeof action.data === "object" ? action.data : {}),
      };
      const destinationId = typeof action.destinationId === "string" ? action.destinationId : undefined;
      const actionType = action.type.toLowerCase();
      links.push({
        trigger,
        action: actionType,
        resolutionStatus: destinationId || typeof action.url === "string"
          ? "resolved"
          : /navigate|overlay|swap|back/.test(actionType) ? "unresolved" : "unknown",
        ...(destinationId ? { destinationId } : {}),
        ...(typeof action.url === "string" ? { url: action.url } : {}),
        ...(typeof action.navigation === "string" ? { navigation: action.navigation.toLowerCase() } : {}),
        ...(action.transition && typeof action.transition.type === "string"
          ? { transition: action.transition.type.toLowerCase() }
          : {}),
        ...(action.transition && Number.isFinite(action.transition.duration)
          ? { duration: Math.max(0, action.transition.duration) }
          : {}),
        ...(action.transition && action.transition.easing && typeof action.transition.easing.type === "string"
          ? { easing: action.transition.easing.type.toLowerCase() }
          : {}),
        ...(action.transition && typeof action.transition.direction === "string"
          ? { direction: action.transition.direction.toLowerCase() }
          : {}),
        ...(action.transition && typeof action.transition.matchLayers === "boolean"
          ? { matchLayers: action.transition.matchLayers }
          : {}),
        ...(action.overlayRelativePosition && Number.isFinite(action.overlayRelativePosition.x)
          && Number.isFinite(action.overlayRelativePosition.y)
          ? { overlayPosition: { x: action.overlayRelativePosition.x, y: action.overlayRelativePosition.y } }
          : {}),
        ...(typeof action.openInNewTab === "boolean" ? { openInNewTab: action.openInNewTab } : {}),
        ...(typeof action.preserveScrollPosition === "boolean"
          ? { preserveScrollPosition: action.preserveScrollPosition }
          : {}),
        ...(typeof action.resetScrollPosition === "boolean"
          ? { resetScrollPosition: action.resetScrollPosition }
          : {}),
        ...(typeof action.resetInteractiveComponents === "boolean"
          ? { resetInteractiveComponents: action.resetInteractiveComponents }
          : {}),
        ...(typeof action.mediaAction === "string" ? { mediaAction: action.mediaAction.toLowerCase() } : {}),
        ...(Object.keys(data).length ? { data } : {}),
      });
    });
  });
  return links.length ? links : undefined;
}

function childrenOf(node) {
  return Array.isArray(node.children) ? node.children : [];
}

function gridPositionFor(node) {
  const position = {};
  if (Number.isInteger(node.gridRowAnchorIndex) && node.gridRowAnchorIndex >= 0) {
    position.row = node.gridRowAnchorIndex;
  }
  if (Number.isInteger(node.gridColumnAnchorIndex) && node.gridColumnAnchorIndex >= 0) {
    position.column = node.gridColumnAnchorIndex;
  }
  if (Number.isInteger(node.gridRowSpan) && node.gridRowSpan > 0) position.rowSpan = node.gridRowSpan;
  if (Number.isInteger(node.gridColumnSpan) && node.gridColumnSpan > 0) position.columnSpan = node.gridColumnSpan;
  return position.row !== undefined || position.column !== undefined ? position : undefined;
}

function renderBoundsFor(node, layoutBounds) {
  const rawBounds = node.absoluteRenderBounds;
  if (!rawBounds) return undefined;
  const renderBounds = {
    x: Number(rawBounds.x) || 0,
    y: Number(rawBounds.y) || 0,
    width: Math.max(0, Number(rawBounds.width) || 0),
    height: Math.max(0, Number(rawBounds.height) || 0),
  };
  if (
    layoutBounds &&
    renderBounds.x === layoutBounds.x &&
    renderBounds.y === layoutBounds.y &&
    renderBounds.width === layoutBounds.width &&
    renderBounds.height === layoutBounds.height
  ) {
    return undefined;
  }
  return renderBounds;
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
  return {
    width: bounds.width,
    height: bounds.height,
    orientation,
    breakpoint,
    breakpointSource: "heuristic",
  };
}

function screenDetailsFor(page) {
  return childrenOf(page)
    .filter((child) => child.type === "FRAME")
    .map((child) => {
      const bounds = boundsFor(child);
      const viewport = viewportFor(bounds);
      return viewport ? {
        node: ref(child.id),
        name: child.name || child.type,
        viewport,
      } : undefined;
    })
    .filter(Boolean);
}

function documentPages() {
  return childrenOf(figma.root).filter((child) => child.type === "PAGE");
}

function documentScreens() {
  return documentPages().flatMap((page) => childrenOf(page).filter((child) => child.type === "FRAME"));
}

function screenDetailsForDocument() {
  return documentPages().flatMap((page) => screenDetailsFor(page));
}

async function nodeToIR(node, parentId, topLevel, exportState) {
  const children = childrenOf(node);
  const corners = cornersToIR(node);
  const bounds = boundsFor(node);
  const localBounds = localBoundsFor(node);
  const renderBounds = renderBoundsFor(node, bounds);
  const transform = affineTransformFor(node.relativeTransform);
  const fills = Array.isArray(node.fills) && node.fills.length ? paintsToIR(node.fills) : undefined;
  const strokes = strokesToIR(node);
  const effects = effectsToIR(node);
  const opacity = Number.isFinite(node.opacity) && node.opacity !== 1
    ? clamp(node.opacity, 0, 1)
    : undefined;
  const rotation = Number.isFinite(node.rotation) && node.rotation !== 0 ? node.rotation : undefined;
  const clipsContent = node.clipsContent === true ? true : undefined;
  const layoutAlign = typeof node.layoutAlign === "string" && node.layoutAlign !== "INHERIT"
    ? node.layoutAlign.toLowerCase()
    : undefined;
  const layoutGrow = Number.isFinite(node.layoutGrow) && node.layoutGrow > 0
    ? node.layoutGrow
    : undefined;
  const layoutPositioning = node.layoutPositioning === "ABSOLUTE" ? "absolute" : undefined;
  const styleRefs = styleRefsFor(node);
  const variableBindings = variableBindingsFor(node);
  const component = componentFor(node);
  const accessibility = accessibilityFor(node);
  const annotations = annotationsFor(node);
  const textSegments = textSegmentsFor(node);
  const typography = typographyFor(node);
  const layout = layoutFor(node, node.parent && node.parent.layoutMode);
  const constraints = constraintsFor(node);
  const gridPosition = gridPositionFor(node);
  const prototypeLinks = prototypeLinksFor(node);
  const description = nonEmptyString(node.description);
  const asset = exportState.options.detail === "full"
    ? await assetFor(node, exportState)
    : undefined;
  const devStatus = safeRead(() => node.devStatus, null);
  const hostData = {
    figmaType: node.type,
    topLevel: Boolean(topLevel),
    ...(safeRead(() => node.isAsset, false) === true ? { isAsset: true } : {}),
    ...(devStatus ? { devStatus } : {}),
  };
  const result = {
    id: node.id,
    name: node.name || node.type,
    kind: kindFor(node, topLevel),
    parentId: parentId || null,
    children: children.map((child) => child.id),
    bounds,
    ...(localBounds ? { localBounds } : {}),
    ...(bounds ? { worldBounds: bounds } : {}),
    ...(renderBounds ? { renderBounds } : {}),
    visible: node.visible !== false,
    ...(typeof node.locked === "boolean" && node.locked ? { locked: true } : {}),
    ...(description ? { description } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(blendModeFor(node.blendMode) ? { blendMode: blendModeFor(node.blendMode) } : {}),
    ...(fills ? { fills } : {}),
    ...(strokes ? { strokes } : {}),
    ...(effects ? { effects } : {}),
    ...corners,
    ...(asset ? { asset } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(transform ? { transform } : {}),
    ...(clipsContent ? { clipsContent } : {}),
    ...(Number.isFinite(node.minWidth) ? { minWidth: Math.max(0, node.minWidth) } : {}),
    ...(Number.isFinite(node.maxWidth) ? { maxWidth: Math.max(0, node.maxWidth) } : {}),
    ...(Number.isFinite(node.minHeight) ? { minHeight: Math.max(0, node.minHeight) } : {}),
    ...(Number.isFinite(node.maxHeight) ? { maxHeight: Math.max(0, node.maxHeight) } : {}),
    ...(constraints ? { constraints } : {}),
    ...(layoutAlign ? { layoutAlign } : {}),
    ...(layoutGrow !== undefined ? { layoutGrow } : {}),
    ...(layoutPositioning ? { layoutPositioning } : {}),
    ...(gridPosition ? { gridPosition } : {}),
    ...(styleRefs ? { styleRefs } : {}),
    ...(variableBindings ? { variableBindings } : {}),
    ...(component ? { component } : {}),
    ...(accessibility ? { accessibility } : {}),
    ...(annotations ? { annotations } : {}),
    ...(node.type === "TEXT" ? { text: node.characters, untrustedText: true } : {}),
    ...(textSegments ? { textSegments } : {}),
    ...(typography ? { typography } : {}),
    ...(layout ? { layout } : {}),
    ...(prototypeLinks ? { prototypeLinks } : {}),
    provenance: {
      bounds: { source: "host", sourceField: "absoluteBoundingBox" },
      ...(localBounds ? { localBounds: { source: "host", sourceField: "x,y,width,height" } } : {}),
      ...(bounds ? { worldBounds: { source: "host", sourceField: "absoluteBoundingBox" } } : {}),
      ...(layout ? { layout: { source: "host", sourceField: "layoutMode" } } : {}),
      ...(constraints ? { constraints: { source: "host", sourceField: "constraints" } } : {}),
      ...(styleRefs ? { styleRefs: { source: "host", sourceField: "*StyleId" } } : {}),
      ...(variableBindings ? { variableBindings: { source: "host", sourceField: "boundVariables" } } : {}),
    },
    hostData,
  };
  return nodeForDetail(result, exportState.options.detail);
}

function documentInfo() {
  return {
    documentId: figma.root.id,
    documentName: figma.root.name || "Untitled Figma file",
  };
}

function selectionItems() {
  return figma.currentPage.selection || [];
}

function flattenSubtree(node, parentId, topLevel, entries) {
  const pending = [{ node, parentId, topLevel }];
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    const children = childrenOf(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      pending.push({
        node: child,
        parentId: current.node.id,
        topLevel: current.node.type === "PAGE" && child.type === "FRAME",
      });
    }
  }
}

function defaultCoverage(options, exportState, tokens) {
  const coverage = {
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
  return coverage;
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
  const exportState = exportStateFor(options);
  const nodes = [];
  for (const entry of entries) {
    const node = await nodeToIR(entry.node, entry.parentId, entry.topLevel, exportState);
    if (!node) continue;
    if (typeof node.text === "string") {
      exportState.textBytes += utf8ByteLength(node.text);
      if (exportState.textBytes > options.maxTextBytes) {
        delete node.text;
        delete node.textSegments;
        delete node.untrustedText;
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
  const root = figma.root;
  const entries = [];
  flattenSubtree(root, null, true, entries);
  const identity = captureIdentity("document", undefined, [root.id], selectionItems().map((item) => item.id), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const screenDetails = screenDetailsForDocument();
  const info = documentInfo();
  const pages = documentPages().map((page) => ref(page.id));
  const screens = documentScreens().map((screen) => ref(screen.id));
  return responseForCapture({
    schemaVersion: 2,
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    rootId: root.id,
    scope: "document",
    nodes: {},
    pages,
    screens,
    selection: selectionItems().map((item) => ref(item.id)),
    ...(screenDetails.length ? { screenDetails } : {}),
    exportedAt: new Date().toISOString(),
  }, current, options, true);
}

async function selectionContext(options) {
  const selection = selectionItems();
  const entries = [];
  selection.forEach((item) => flattenSubtree(item, item.parent && item.parent.id, item.parent === figma.currentPage, entries));
  const pageId = figma.currentPage.id;
  const identity = captureIdentity("selection", pageId, selection.map((item) => item.id), selection.map((item) => item.id), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const info = documentInfo();
  return responseForCapture({
    schemaVersion: 2,
    scope: "selection",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selection.map((item) => ref(item.id)),
    exportedAt: new Date().toISOString(),
    nodes: [],
  }, current, options, false);
}

function findPage(pageId) {
  if (!pageId) return figma.currentPage;
  const node = figma.getNodeById(pageId);
  return node && node.type === "PAGE" && node.parent === figma.root ? node : null;
}

async function pageContext(pageId, options) {
  const page = findPage(pageId || options.pageId);
  if (!page) throw new Error("No Figma page was found for the requested page scope");
  const entries = [];
  flattenSubtree(page, null, true, entries);
  const identity = captureIdentity("page", page.id, [page.id], selectionItems().map((item) => item.id), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const info = documentInfo();
  return responseForCapture({
    schemaVersion: 2,
    scope: "page",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    pageId: page.id,
    selection: selectionItems().map((item) => ref(item.id)),
    nodes: [],
    ...(screenDetailsFor(page).length ? { screenDetails: screenDetailsFor(page) } : {}),
    exportedAt: new Date().toISOString(),
  }, current, options, false);
}

function findScreen(screenId) {
  if (screenId) {
    const node = figma.getNodeById(screenId);
    return node && node.parent && node.parent.type === "PAGE" && node.type === "FRAME" ? node : null;
  }
  const selected = selectionItems().find((item) => item.parent === figma.currentPage && item.type === "FRAME");
  return selected || figma.currentPage.children.find((child) => child.type === "FRAME") || null;
}

async function screenContext(screenId, options) {
  const screen = findScreen(screenId);
  if (!screen) throw new Error("No Figma screen frame was found for the requested screen");
  const entries = [];
  flattenSubtree(screen, screen.parent && screen.parent.id, true, entries);
  const identity = captureIdentity("screen", screen.parent && screen.parent.id, [screen.id], selectionItems().map((item) => item.id), options);
  const current = await materializeEntries(entries, identity, captureOptionsFor(options));
  const info = documentInfo();
  const selection = selectionItems();
  const viewport = viewportFor(boundsFor(screen));
  return responseForCapture({
    schemaVersion: 2,
    scope: "screen",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: screen.id,
    selection: selection.map((item) => ref(item.id)),
    ...(viewport ? { viewport } : {}),
    exportedAt: new Date().toISOString(),
    nodes: [],
  }, current, options, false);
}

function visualTargets(scope, screenId, pageId) {
  if (scope === "page") {
    const page = findPage(pageId);
    if (!page) throw new Error("No Figma page was found for the requested visual context");
    return [page];
  }
  if (scope === "screen") {
    const screen = findScreen(screenId);
    if (!screen) throw new Error("No Figma screen frame was found for the requested visual context");
    return [screen];
  }
  const selected = selectionItems();
  if (!selected.length) throw new Error("Figma selection is empty");
  return selected;
}

async function visualContext(scope, screenId, options = {}) {
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
  targets.forEach((target) => flattenSubtree(
    target,
    target.parent && target.parent.id,
    scope === "page" || target.parent === figma.currentPage,
    entries,
  ));
  const identity = captureIdentity(
    scope,
    scope === "page" ? targets[0].id : scope === "screen" ? targets[0].parent && targets[0].parent.id : figma.currentPage.id,
    targets.map((target) => target.id),
    selectionItems().map((item) => item.id),
    {
      ...DEFAULT_EXPORT_OPTIONS,
      detail: "full",
      includeAssets: false,
      includeTokens: false,
      maxAssetBytes: 0,
      maxTextBytes: 0,
      maxTokenRecords: 0,
    },
  );
  const captureId = captureIdFor(identity, entries);
  const items = [];
  let imageBytes = 0;
  let imagePixels = 0;
  for (const target of targets) {
    const bounds = boundsFor(target);
    const maxDimension = Math.max(bounds ? bounds.width : 0, bounds ? bounds.height : 0);
    const area = Math.max(1, (bounds ? bounds.width : 1) * (bounds ? bounds.height : 1));
    const scale = Math.min(
      1,
      maxDimension > 1024 ? 1024 / maxDimension : 1,
      Math.sqrt(normalizedOptions.maxImagePixels / area),
    );
    const bytes = await target.exportAsync({
      format: "PNG",
      contentsOnly: true,
      constraint: { type: "SCALE", value: scale },
    });
    const encoded = figma.base64Encode(bytes);
    const encodedBytes = utf8ByteLength(encoded);
    if (imageBytes + encodedBytes > normalizedOptions.maxImageBytes) {
      const error = new Error("Rendered PNG exceeds maxImageBytes");
      error.code = "VISUAL_BUDGET_EXCEEDED";
      throw error;
    }
    imageBytes += encodedBytes;
    const pixelWidth = Math.max(1, Math.ceil((bounds ? bounds.width : 1) * scale));
    const pixelHeight = Math.max(1, Math.ceil((bounds ? bounds.height : 1) * scale));
    imagePixels += pixelWidth * pixelHeight;
    if (imagePixels > normalizedOptions.maxImagePixels) {
      const error = new Error("Rendered PNG pixels exceed maxImagePixels");
      error.code = "VISUAL_BUDGET_EXCEEDED";
      throw error;
    }
    items.push({
      nodeId: target.id,
      nodeName: target.name || target.type,
      mimeType: "image/png",
      data: encoded,
      bounds,
      scale,
      pixelWidth,
      pixelHeight,
      cropOrigin: bounds ? { x: bounds.x, y: bounds.y } : undefined,
      worldToPixel: bounds ? { a: scale, b: 0, c: 0, d: scale, tx: -bounds.x * scale, ty: -bounds.y * scale } : undefined,
      captureId,
    });
  }
  const info = documentInfo();
  return {
    schemaVersion: 2,
    scope,
    host: "figma",
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

function paintFromColor(color) {
  return {
    type: "SOLID",
    color: {
      r: clamp(color.r, 0, 1),
      g: clamp(color.g, 0, 1),
      b: clamp(color.b, 0, 1),
    },
    ...(Number.isFinite(color.a) ? { opacity: clamp(color.a, 0, 1) } : {}),
  };
}

function writeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isContainerNode(node) {
  return Boolean(node && ["PAGE", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(node.type));
}

function layoutModeValue(value) {
  if (value === "horizontal") return "HORIZONTAL";
  if (value === "vertical") return "VERTICAL";
  if (value === "none") return "NONE";
  return undefined;
}

function layoutSizingValue(value) {
  if (value === "fixed") return "FIXED";
  if (value === "hug") return "HUG";
  if (value === "fill") return "FILL";
  return undefined;
}

function assertNodeTreeSpec(spec) {
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length < 1 || spec.nodes.length > 256) {
    throw writeError("AUTHORING_INVALID", "Node-tree authoring requires between 1 and 256 nodes.");
  }
  if (JSON.stringify(spec).length > 2_000_000) {
    throw writeError("AUTHORING_PAYLOAD_TOO_LARGE", "Node-tree authoring payload exceeds the 2 MB limit.");
  }
  const byRef = new Map();
  if (spec.nodes.filter((node) => node && !node.parentRef).length > 32) {
    throw writeError("AUTHORING_INVALID", "A node-tree request may contain at most 32 roots.");
  }
  spec.nodes.forEach((node) => {
    if (!node || typeof node.ref !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(node.ref)) {
      throw writeError("AUTHORING_INVALID", "Every authored node needs a valid local reference.");
    }
    if (byRef.has(node.ref)) throw writeError("AUTHORING_INVALID", `Duplicate node reference: ${node.ref}.`);
    if (!node.kind || !["frame", "text", "rectangle", "component", "instance"].includes(node.kind)) {
      throw writeError("AUTHORING_INVALID", `Unsupported authored node kind: ${node.kind}.`);
    }
    byRef.set(node.ref, node);
  });

  const depthFor = (node, path, depth) => {
    if (depth > 12) throw writeError("AUTHORING_INVALID", "Node-tree depth may not exceed 12.");
    if (!node.parentRef) return;
    const parent = byRef.get(node.parentRef);
    if (!parent) throw writeError("AUTHORING_INVALID", `Unknown parent reference: ${node.parentRef}.`);
    if (path.includes(parent.ref)) throw writeError("AUTHORING_INVALID", "Node-tree parent relationships may not contain cycles.");
    depthFor(parent, [...path, parent.ref], depth + 1);
  };

  spec.nodes.forEach((node) => {
    const parent = node.parentRef ? byRef.get(node.parentRef) : undefined;
    if (node.parentRef && !parent) throw writeError("AUTHORING_INVALID", `Unknown parent reference: ${node.parentRef}.`);
    if (parent && !["frame", "component"].includes(parent.kind)) {
      throw writeError("AUTHORING_INVALID", `Node ${node.ref} cannot be nested under ${parent.kind}.`);
    }
    depthFor(node, [node.ref], 1);
    const layout = { ...(node.layout || {}), mode: node.layout && node.layout.mode || "none" };
    const parentMode = parent && parent.layout && parent.layout.mode && parent.layout.mode !== "none"
      ? parent.layout.mode
      : undefined;
    const hasSizing = Boolean(layout.sizingHorizontal || layout.sizingVertical);
    if (layout.mode !== "none" && !["frame", "component"].includes(node.kind)) {
      throw writeError("AUTHORING_INVALID", `Only frame and component nodes may own auto layout (${node.ref}).`);
    }
    if (layout.mode === "none" && (layout.gap !== undefined || layout.padding || layout.primaryAxisAlign
      || layout.counterAxisAlign || layout.wrap || layout.counterAxisSpacing !== undefined)) {
      throw writeError("AUTHORING_INVALID", `Node ${node.ref} has flow properties without auto layout.`);
    }
    if (hasSizing && !parentMode && node.kind === "rectangle") {
      throw writeError("AUTHORING_INVALID", `Rectangle ${node.ref} needs an auto-layout parent for sizing.`);
    }
    if (hasSizing && !parentMode && node.kind === "frame" && layout.mode === "none") {
      throw writeError("AUTHORING_INVALID", `Frame ${node.ref} needs auto layout for its sizing.`);
    }
    if ((layout.sizingHorizontal === "fill" || layout.sizingVertical === "fill") && !parentMode) {
      throw writeError("AUTHORING_INVALID", `Fill sizing requires an auto-layout parent (${node.ref}).`);
    }
    if ((layout.sizingHorizontal === "hug" || layout.sizingVertical === "hug")
      && node.kind !== "text" && node.kind !== "instance" && layout.mode === "none") {
      throw writeError("AUTHORING_INVALID", `Hug sizing requires an auto-layout frame/component/instance (${node.ref}).`);
    }
    if (parentMode && node.positioning !== "absolute" && (node.x !== undefined || node.y !== undefined)) {
      throw writeError("AUTHORING_INVALID", `Flow child ${node.ref} cannot set x/y without absolute positioning.`);
    }
    if (node.kind === "text" && typeof node.text !== "string") {
      throw writeError("AUTHORING_INVALID", `Text node ${node.ref} requires text.`);
    }
    if (node.kind !== "text" && (node.text !== undefined || node.typography !== undefined)) {
      throw writeError("AUTHORING_INVALID", `Only text nodes may set text or typography (${node.ref}).`);
    }
    if (node.kind === "instance" && typeof node.componentId !== "string") {
      throw writeError("AUTHORING_INVALID", `Instance ${node.ref} requires an existing local componentId.`);
    }
    if (node.kind !== "instance" && (node.componentId !== undefined || node.textOverrides !== undefined)) {
      throw writeError("AUTHORING_INVALID", `componentId and textOverrides are only valid for instance nodes (${node.ref}).`);
    }
    if (node.kind === "instance" && (node.fill !== undefined || node.stroke !== undefined
      || node.cornerRadius !== undefined || node.cornerRadii !== undefined || node.clipsContent !== undefined)) {
      throw writeError("AUTHORING_INVALID", `Instance ${node.ref} only supports native sizing, positioning, visibility, and exposed text overrides.`);
    }
    if (node.kind === "instance" && node.textOverrides && Object.keys(node.textOverrides).length > 8) {
      throw writeError("AUTHORING_INVALID", `Instance ${node.ref} may override at most 8 exposed text properties.`);
    }
    if (node.kind === "instance" && node.textOverrides && JSON.stringify(node.textOverrides).length > 20000) {
      throw writeError("AUTHORING_INVALID", `Instance ${node.ref} text overrides exceed the 20 KB limit.`);
    }
    if (node.positioning === "absolute" && !parentMode) {
      throw writeError("AUTHORING_INVALID", `Absolute positioning requires an auto-layout parent (${node.ref}).`);
    }
  });
}

function applyPaintAndGeometry(node, spec) {
  if (spec.fill !== undefined && "fills" in node) node.fills = [paintFromColor(spec.fill)];
  if (spec.stroke !== undefined && "strokes" in node) {
    node.strokes = [paintFromColor(spec.stroke.color)];
    node.strokeWeight = spec.stroke.weight;
    node.strokeAlign = spec.stroke.position === "center" ? "CENTER" : spec.stroke.position === "outside" ? "OUTSIDE" : "INSIDE";
  }
  if (spec.cornerRadius !== undefined) {
    if (!("cornerRadius" in node)) throw writeError("UNSUPPORTED_AUTHORING", `Node ${node.type} does not support cornerRadius.`);
    node.cornerRadius = spec.cornerRadius;
  }
  if (spec.cornerRadii !== undefined) {
    if (!("topLeftRadius" in node)) throw writeError("UNSUPPORTED_AUTHORING", `Node ${node.type} does not support individual corner radii.`);
    node.topLeftRadius = spec.cornerRadii.topLeft;
    node.topRightRadius = spec.cornerRadii.topRight;
    node.bottomRightRadius = spec.cornerRadii.bottomRight;
    node.bottomLeftRadius = spec.cornerRadii.bottomLeft;
  }
  if (Number.isFinite(spec.opacity)) node.opacity = clamp(spec.opacity, 0, 1);
  if (typeof spec.visible === "boolean") node.visible = spec.visible;
  if (typeof spec.clipsContent === "boolean" && "clipsContent" in node) node.clipsContent = spec.clipsContent;
}

function fontKey(font) {
  if (!font || typeof font !== "object" || typeof font.family !== "string" || typeof font.style !== "string") return "";
  return `${font.family}\u0000${font.style}\u0000${JSON.stringify(font.variationSettings || {})}`;
}

function fontFromNode(node) {
  if (node && node.fontName && typeof node.fontName === "object" && typeof node.fontName.family === "string" && typeof node.fontName.style === "string") {
    return { family: node.fontName.family, style: node.fontName.style };
  }
  return { family: "Inter", style: "Regular" };
}

async function loadFontsForText(node, typography) {
  if (node.hasMissingFont === true) throw writeError("FONT_MISSING", `Text node ${node.id} has a missing font.`);
  const fonts = new Map();
  const add = (font) => {
    const key = fontKey(font);
    if (key) fonts.set(key, font);
  };
  if (typeof node.getRangeAllFontNames === "function" && typeof node.characters === "string" && node.characters.length > 0) {
    const existing = node.getRangeAllFontNames(0, node.characters.length);
    if (Array.isArray(existing)) existing.forEach(add);
  }
  add(fontFromNode(node));
  if (typography && (typography.family || typography.style)) {
    add({
      family: typography.family || fontFromNode(node).family,
      style: typography.style || fontFromNode(node).style,
    });
  }
  await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)));
}

function typographyFont(node, typography) {
  const current = fontFromNode(node);
  return {
    family: typography.family || current.family,
    style: typography.style || current.style,
  };
}

async function applyTypography(node, text, typography) {
  if (text === undefined && typography === undefined) return;
  if (!node || node.type !== "TEXT") throw writeError("TEXT_TARGET_REQUIRED", "Text and typography updates require a text node.");
  if (typography && typography.weight !== undefined) {
    throw writeError("UNSUPPORTED_TYPOGRAPHY_FIELD", "Figma font weight is read-only; provide the font family and style instead.");
  }
  await loadFontsForText(node, typography || {});
  if (typography && (typography.family || typography.style)) node.fontName = typographyFont(node, typography);
  if (text !== undefined) {
    if (typeof node.autoRename === "boolean") node.autoRename = false;
    node.characters = text;
  }
  if (!typography) return;
  if (typography.size !== undefined) node.fontSize = typography.size;
  if (typography.lineHeight !== undefined) node.lineHeight = { unit: "PIXELS", value: typography.lineHeight };
  if (typography.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: typography.letterSpacing };
  if (typography.align !== undefined) node.textAlignHorizontal = typography.align === "center"
    ? "CENTER" : typography.align === "right" ? "RIGHT" : typography.align === "justified" ? "JUSTIFIED" : "LEFT";
  if (typography.alignVertical !== undefined) node.textAlignVertical = typography.alignVertical === "center"
    ? "CENTER" : typography.alignVertical === "bottom" ? "BOTTOM" : "TOP";
  if (typography.decoration !== undefined) node.textDecoration = typography.decoration === "underline"
    ? "UNDERLINE" : typography.decoration === "strikethrough" ? "STRIKETHROUGH" : "NONE";
  if (typography.textCase !== undefined) node.textCase = {
    original: "ORIGINAL",
    upper: "UPPER",
    lower: "LOWER",
    title: "TITLE",
    "small-caps": "SMALL_CAPS",
    "small-caps-forced": "SMALL_CAPS_FORCED",
  }[typography.textCase];
  if (typography.paragraphIndent !== undefined) node.paragraphIndent = typography.paragraphIndent;
  if (typography.paragraphSpacing !== undefined) node.paragraphSpacing = typography.paragraphSpacing;
  if (typography.textTruncation !== undefined) node.textTruncation = typography.textTruncation === "ending" ? "ENDING" : "DISABLED";
  if (typography.maxLines !== undefined) node.maxLines = typography.maxLines;
}

function applyLayoutMode(node, layout) {
  if (!layout || layout.mode === undefined) return;
  const mode = layoutModeValue(layout.mode);
  if (!mode) throw writeError("AUTHORING_INVALID", `Unsupported auto-layout mode: ${layout.mode}.`);
  if (mode !== "NONE" && !isContainerNode(node)) throw writeError("LAYOUT_TARGET_REQUIRED", "Only frame-like nodes can own auto layout.");
  if (mode === "NONE" && !isContainerNode(node)) return;
  node.layoutMode = mode;
}

function applyLayoutProperties(node, layout) {
  if (!layout) return;
  const mode = node.layoutMode;
  const hasFlowProperties = layout.gap !== undefined || layout.padding || layout.primaryAxisAlign
    || layout.counterAxisAlign || layout.wrap || layout.counterAxisSpacing !== undefined;
  if (hasFlowProperties && mode !== "HORIZONTAL" && mode !== "VERTICAL") {
    throw writeError("AUTHORING_INVALID", "Gap, padding, and alignment require horizontal or vertical auto layout.");
  }
  if (layout.gap !== undefined) node.itemSpacing = layout.gap;
  if (layout.padding) {
    node.paddingTop = layout.padding.top;
    node.paddingRight = layout.padding.right;
    node.paddingBottom = layout.padding.bottom;
    node.paddingLeft = layout.padding.left;
  }
  if (layout.primaryAxisAlign !== undefined) node.primaryAxisAlignItems = layout.primaryAxisAlign === "center"
    ? "CENTER" : layout.primaryAxisAlign === "max" ? "MAX" : layout.primaryAxisAlign === "space-between" ? "SPACE_BETWEEN" : "MIN";
  if (layout.counterAxisAlign !== undefined) node.counterAxisAlignItems = layout.counterAxisAlign === "center"
    ? "CENTER" : layout.counterAxisAlign === "max" ? "MAX" : layout.counterAxisAlign === "baseline" ? "BASELINE" : "MIN";
  if (layout.wrap !== undefined) node.layoutWrap = layout.wrap === "wrap" ? "WRAP" : "NO_WRAP";
  if (layout.counterAxisSpacing !== undefined) node.counterAxisSpacing = layout.counterAxisSpacing;
  const parentMode = node.parent && node.parent.layoutMode;
  const applySizing = (property, value) => {
    if (value === undefined) return;
    const sizing = layoutSizingValue(value);
    if (!sizing) throw writeError("AUTHORING_INVALID", `Unsupported sizing value: ${value}.`);
    if (sizing === "FILL" && parentMode !== "HORIZONTAL" && parentMode !== "VERTICAL") {
      throw writeError("AUTHORING_INVALID", "Fill sizing requires an auto-layout parent.");
    }
    if (sizing === "HUG" && node.type !== "TEXT" && node.layoutMode === "NONE") {
      throw writeError("AUTHORING_INVALID", "Hug sizing requires a text node or auto-layout frame.");
    }
    node[property] = sizing;
  };
  // Figma only accepts these setters after the parent layout mode exists.
  applySizing("layoutSizingHorizontal", layout.sizingHorizontal);
  applySizing("layoutSizingVertical", layout.sizingVertical);
}

function applyBounds(node, bounds, coordinateSpace, positioning) {
  if (!bounds) return;
  const parentMode = node.parent && node.parent.layoutMode;
  if ((Number.isFinite(bounds.x) || Number.isFinite(bounds.y))
    && (parentMode === "HORIZONTAL" || parentMode === "VERTICAL")
    && positioning !== "absolute"
    && node.layoutPositioning !== "ABSOLUTE") {
    throw writeError("AUTHORING_INVALID", "Flow children cannot set x/y without absolute positioning.");
  }
  const width = Number.isFinite(bounds.width) ? bounds.width : node.width;
  const height = Number.isFinite(bounds.height) ? bounds.height : node.height;
  if ((Number.isFinite(bounds.width) || Number.isFinite(bounds.height)) && typeof node.resize === "function") {
    if (!(width > 0) || !(height > 0)) throw writeError("AUTHORING_INVALID", "Node dimensions must be positive.");
    node.resize(width, height);
  }
  if (Number.isFinite(bounds.x) || Number.isFinite(bounds.y)) {
    if (coordinateSpace === "world" && node.parent && node.parent.absoluteBoundingBox) {
      if (Number.isFinite(bounds.x)) node.x = bounds.x - node.parent.absoluteBoundingBox.x;
      if (Number.isFinite(bounds.y)) node.y = bounds.y - node.parent.absoluteBoundingBox.y;
    } else {
      if (Number.isFinite(bounds.x)) node.x = bounds.x;
      if (Number.isFinite(bounds.y)) node.y = bounds.y;
    }
  }
}

function validatePatchForNode(node, patch) {
  const unsupported = Object.keys(patch || {}).filter((key) => ![
    "coordinateSpace", "name", "bounds", "visible", "opacity", "fills", "text", "typography",
    "layout", "parentId", "stroke", "cornerRadius", "cornerRadii",
  ].includes(key));
  if (unsupported.length) throw writeError("UNSUPPORTED_PATCH_FIELD", `Figma does not support these patch fields: ${unsupported.join(", ")}`);
  if (Array.isArray(patch.fills) && patch.fills.some((fill) => fill.type !== "solid" || !fill.color)) {
    throw writeError("UNSUPPORTED_PATCH_FIELD", "Figma writes currently support solid fills only.");
  }
  if (patch.text !== undefined || patch.typography !== undefined) {
    if (!node || node.type !== "TEXT") throw writeError("TEXT_TARGET_REQUIRED", "Text and typography updates require a text node.");
    if (patch.typography && patch.typography.weight !== undefined) {
      throw writeError("UNSUPPORTED_TYPOGRAPHY_FIELD", "Figma font weight is read-only; provide the font family and style instead.");
    }
  }
  if (patch.layout) {
    const layout = patch.layout;
    const mode = layout.mode === undefined ? node.layoutMode : layout.mode;
    if (layout.mode !== undefined && layout.mode !== "none" && !isContainerNode(node)) {
      throw writeError("LAYOUT_TARGET_REQUIRED", "Only frame-like nodes can own auto layout.");
    }
    if (layout.mode === "none" && (layout.gap !== undefined || layout.padding || layout.primaryAxisAlign
      || layout.counterAxisAlign || layout.wrap || layout.counterAxisSpacing !== undefined)) {
      throw writeError("AUTHORING_INVALID", "Gap, padding, and alignment require horizontal or vertical auto layout.");
    }
    const hasSizing = Boolean(layout.sizingHorizontal || layout.sizingVertical);
    if (hasSizing && mode === "none" && node.type !== "TEXT"
      && (!node.parent || !["HORIZONTAL", "VERTICAL"].includes(node.parent.layoutMode))) {
      throw writeError("AUTHORING_INVALID", "Frame sizing requires auto layout or an auto-layout parent.");
    }
    if ((layout.sizingHorizontal === "fill" || layout.sizingVertical === "fill")
      && (!node.parent || !["HORIZONTAL", "VERTICAL"].includes(node.parent.layoutMode))) {
      throw writeError("AUTHORING_INVALID", "Fill sizing requires an auto-layout parent.");
    }
    if ((layout.sizingHorizontal === "hug" || layout.sizingVertical === "hug")
      && node.type !== "TEXT" && mode === "none") {
      throw writeError("AUTHORING_INVALID", "Hug sizing requires a text node or auto-layout frame.");
    }
  }
  if (patch.cornerRadius !== undefined && patch.cornerRadii !== undefined) {
    throw writeError("AUTHORING_INVALID", "Use cornerRadius or cornerRadii, not both.");
  }
  if (patch.bounds && (Number.isFinite(patch.bounds.width) && patch.bounds.width <= 0
    || Number.isFinite(patch.bounds.height) && patch.bounds.height <= 0)) {
    throw writeError("AUTHORING_INVALID", "Updated node dimensions must be positive.");
  }
}

async function applyPatch(node, patch) {
  validatePatchForNode(node, patch);
  await applyTypography(node, patch.text, patch.typography);
  if (patch.name) node.name = patch.name;
  if (typeof patch.visible === "boolean") node.visible = patch.visible;
  if (Number.isFinite(patch.opacity)) node.opacity = clamp(patch.opacity, 0, 1);
  if (patch.bounds) applyBounds(node, patch.bounds, patch.coordinateSpace, node.layoutPositioning === "ABSOLUTE" ? "absolute" : undefined);
  if (Array.isArray(patch.fills) && "fills" in node) {
    node.fills = patch.fills.map((fill) => paintFromColor(fill.color));
  }
  if (patch.stroke !== undefined) applyPaintAndGeometry(node, patch);
  if (patch.cornerRadius !== undefined || patch.cornerRadii !== undefined) applyPaintAndGeometry(node, patch);
  if (patch.layout) {
    applyLayoutMode(node, patch.layout);
    applyLayoutProperties(node, patch.layout);
    if (node.type === "TEXT" && patch.typography && patch.typography.autoResize !== undefined) {
      node.textAutoResize = patch.typography.autoResize === "width-and-height"
        ? "WIDTH_AND_HEIGHT" : patch.typography.autoResize === "height" ? "HEIGHT" : patch.typography.autoResize === "truncate" ? "TRUNCATE" : "NONE";
    }
  }
  if (node.type === "TEXT" && patch.typography && patch.typography.autoResize !== undefined) {
    node.textAutoResize = patch.typography.autoResize === "width-and-height"
      ? "WIDTH_AND_HEIGHT" : patch.typography.autoResize === "height" ? "HEIGHT" : patch.typography.autoResize === "truncate" ? "TRUNCATE" : "NONE";
  }
}

function documentAncestor(node) {
  let current = node;
  while (current && current.parent) current = current.parent;
  return current;
}

function localComponentForInstance(spec) {
  const component = figma.getNodeById(spec.componentId);
  if (!component || component.type !== "COMPONENT") {
    throw writeError("INSTANCE_COMPONENT_UNAVAILABLE", `Component ${spec.componentId} is unavailable or is not a component.`);
  }
  if (component.remote === true) {
    throw writeError("INSTANCE_COMPONENT_REMOTE", `Component ${spec.componentId} is remote; only local components are supported.`);
  }
  if (documentAncestor(component) !== figma.root) {
    throw writeError("INSTANCE_COMPONENT_DOCUMENT_MISMATCH", `Component ${spec.componentId} is not in the connected document.`);
  }
  if (typeof component.createInstance !== "function") {
    throw writeError("INSTANCE_AUTHORING_UNSUPPORTED", "The connected Figma host cannot create local component instances.");
  }
  return component;
}

function applyInstanceTextOverrides(node, overrides) {
  if (!overrides) return;
  if (typeof node.setProperties !== "function") {
    throw writeError("INSTANCE_TEXT_OVERRIDE_UNSUPPORTED", "The connected Figma host cannot set instance text properties.");
  }
  const properties = node.componentProperties || {};
  Object.entries(overrides).forEach(([key, value]) => {
    const property = properties[key];
    if (!property || property.type !== "TEXT") {
      throw writeError("INSTANCE_TEXT_OVERRIDE_UNAVAILABLE", `Instance text property ${key} is not exposed by the component.`);
    }
    if (typeof value !== "string") {
      throw writeError("INSTANCE_TEXT_OVERRIDE_INVALID", `Instance text property ${key} must be a string.`);
    }
  });
  node.setProperties(overrides);
}

function descendantIds(node) {
  const ids = [];
  const pending = childrenOf(node).slice();
  while (pending.length) {
    const child = pending.shift();
    if (!child || !child.id) continue;
    ids.push(child.id);
    pending.unshift(...childrenOf(child));
  }
  return ids;
}

async function createAuthoredNode(spec, created) {
  let node;
  if (spec.kind === "frame") node = figma.createFrame();
  else if (spec.kind === "rectangle") node = figma.createRectangle();
  else if (spec.kind === "component") node = figma.createComponent();
  else if (spec.kind === "text") node = figma.createText();
  else if (spec.kind === "instance") node = localComponentForInstance(spec).createInstance();
  else throw writeError("AUTHORING_INVALID", `Unsupported authored node kind: ${spec.kind}.`);
  created.push(node);

  if (spec.kind === "text") {
    await applyTypography(node, spec.text, spec.typography);
    if (spec.typography && spec.typography.autoResize !== undefined) {
      node.textAutoResize = spec.typography.autoResize === "width-and-height"
        ? "WIDTH_AND_HEIGHT" : spec.typography.autoResize === "height" ? "HEIGHT" : spec.typography.autoResize === "truncate" ? "TRUNCATE" : "NONE";
    }
  }
  if (spec.kind !== "instance") applyLayoutMode(node, spec.layout);
  if (spec.kind === "instance") applyInstanceTextOverrides(node, spec.textOverrides);
  if (Number.isFinite(spec.width) || Number.isFinite(spec.height)) {
    const width = Number.isFinite(spec.width) ? spec.width : node.width || 100;
    const height = Number.isFinite(spec.height) ? spec.height : node.height || 100;
    if (typeof node.resize === "function") node.resize(width, height);
  }
  applyPaintAndGeometry(node, spec);
  return node;
}

async function createNodeTree(spec) {
  assertNodeTreeSpec(spec);
  const orderedNodes = [];
  const pending = new Set(spec.nodes.map((node) => node.ref));
  while (pending.size > 0) {
    let progressed = false;
    for (const specNode of spec.nodes) {
      if (!pending.has(specNode.ref)) continue;
      if (specNode.parentRef && pending.has(specNode.parentRef)) continue;
      orderedNodes.push(specNode);
      pending.delete(specNode.ref);
      progressed = true;
    }
    if (!progressed) throw writeError("AUTHORING_INVALID", "Node-tree parent relationships could not be ordered.");
  }
  const created = [];
  const createdByRef = new Map();
  try {
    for (const specNode of orderedNodes) {
      if (specNode.parentRef && !createdByRef.has(specNode.parentRef)) {
        throw writeError("AUTHORING_INVALID", `Parent ${specNode.parentRef} must be created before child ${specNode.ref}.`);
      }
      const node = await createAuthoredNode(specNode, created);
      createdByRef.set(specNode.ref, node);
      if (specNode.parentRef) {
        const parent = createdByRef.get(specNode.parentRef);
        if (!parent || !isContainerNode(parent)) throw writeError("AUTHORING_INVALID", `Parent ${specNode.parentRef} cannot contain children.`);
        parent.appendChild(node);
      }
      if (specNode.positioning === "absolute") node.layoutPositioning = "ABSOLUTE";
      applyLayoutProperties(node, specNode.layout);
      applyBounds(node, {
        ...(Number.isFinite(specNode.x) ? { x: specNode.x } : {}),
        ...(Number.isFinite(specNode.y) ? { y: specNode.y } : {}),
        ...(Number.isFinite(specNode.width) ? { width: specNode.width } : {}),
        ...(Number.isFinite(specNode.height) ? { height: specNode.height } : {}),
      }, "parent", specNode.positioning);
      // Set the requested name after text content so Figma cannot auto-rename it.
      node.name = specNode.name;
    }
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      try {
        if (created[index] && typeof created[index].remove === "function" && !created[index].removed) created[index].remove();
      } catch (_cleanupError) {
        // Cleanup is best effort and is restricted to nodes created by this task.
      }
    }
    throw error;
  }
  const referenceMap = Object.fromEntries(spec.nodes.map((item) => [item.ref, createdByRef.get(item.ref).id]));
  const createdNodeIds = [];
  spec.nodes.forEach((item) => {
    const node = createdByRef.get(item.ref);
    createdNodeIds.push(node.id);
    if (item.kind === "instance") createdNodeIds.push(...descendantIds(node));
  });
  const rootNodeIds = spec.nodes.filter((item) => !item.parentRef).map((item) => createdByRef.get(item.ref).id);
  return {
    status: "applied",
    createdNodeIds,
    rootNodeIds,
    referenceMap,
    nodes: spec.nodes.map((item) => ({
      reference: item.ref,
      node: ref(createdByRef.get(item.ref).id),
      ...(item.parentRef ? { parentReference: item.parentRef } : {}),
      ...(item.kind === "instance" ? { descendantIds: descendantIds(createdByRef.get(item.ref)) } : {}),
    })),
    kind: "node-tree",
  };
}

async function createComponent(spec) {
  const component = figma.createComponent();
  component.name = spec.name || "DesignPort Component";
  component.resize(Number(spec.width) || 240, Number(spec.height) || 120);
  if (Number.isFinite(spec.x)) component.x = spec.x;
  if (Number.isFinite(spec.y)) component.y = spec.y;
  if (spec.fill) component.fills = [paintFromColor(spec.fill)];
  if (spec.text) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    const label = figma.createText();
    label.characters = spec.text;
    label.name = "Label";
    label.x = 16;
    label.y = 16;
    component.appendChild(label);
  }
  figma.currentPage.selection = [component];
  return { status: "applied", node: ref(component.id), kind: "component" };
}

function validateWriteState(payload, operation) {
  syncSelectionRevision();
  const expected = payload && payload.expectedSnapshotId;
  const baseline = expected && snapshotState.snapshots.get(expected);
  if (!baseline) {
    const error = new Error("Write requires a known complete capture snapshot");
    error.code = snapshotState.evictedSnapshotIds.has(expected) ? "WRITE_BASELINE_EVICTED" : "WRITE_BASELINE_UNKNOWN";
    throw error;
  }
  const info = documentInfo();
  if (!baseline.snapshot.complete) {
    const error = new Error("Write requires a complete capture snapshot");
    error.code = "WRITE_BASELINE_INCOMPLETE";
    throw error;
  }
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
  const expectedPageId = baseline.snapshot.identity.pageId;
  if (baseline.snapshot.identity.documentId !== info.documentId
    || baseline.snapshot.documentRevision !== snapshotState.documentRevision
    || expectedPageId && expectedPageId !== figma.currentPage.id) {
    const error = new Error("The expected capture is stale; read a fresh capture before writing");
    error.code = "WRITE_STALE_CAPTURE";
    throw error;
  }
  if (operation === "update_selection") {
    const targetIds = Array.isArray(payload.targetIds) ? payload.targetIds : [];
    const capturedIds = new Set((baseline.nodes || []).map((node) => node.id));
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length || !targetIds.every((id) => capturedIds.has(id))) {
      throw writeError("WRITE_TARGET_MISMATCH", "Write targets must be explicit nodes in the expected capture scope.");
    }
    if (payload.patch && payload.patch.parentId && !capturedIds.has(payload.patch.parentId)) {
      throw writeError("WRITE_TARGET_MISMATCH", "A reparent target must be in the expected capture scope.");
    }
  }
  return baseline;
}

function clonePrototypeValue(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function nodeIsInDocument(node) {
  return Boolean(node && documentAncestor(node) === figma.root);
}

function nodeIsOnCurrentPage(node) {
  let current = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current === figma.currentPage;
}

function topLevelPrototypeFrame(node) {
  return Boolean(node && node.type === "FRAME" && node.parent === figma.currentPage && nodeIsInDocument(node));
}

function containingTopLevelPrototypeFrame(node) {
  let current = node;
  while (current && current.type !== "PAGE") {
    if (topLevelPrototypeFrame(current)) return current;
    current = current.parent;
  }
  return null;
}

function validatePrototypeRequest(payload, baseline) {
  const links = Array.isArray(payload && payload.links) ? payload.links : [];
  const flowStartingPoints = Array.isArray(payload && payload.flowStartingPoints) ? payload.flowStartingPoints : [];
  if (!links.length && !flowStartingPoints.length) {
    throw writeError("PROTOTYPE_INVALID", "Prototype authoring requires at least one link or flow starting point.");
  }
  if (links.length > 256 || flowStartingPoints.length > 64) {
    throw writeError("PROTOTYPE_INVALID", "Prototype authoring batches are limited to 256 links and 64 flow starting points.");
  }
  if (JSON.stringify({ links, flowStartingPoints }).length > 512000) {
    throw writeError("PROTOTYPE_PAYLOAD_TOO_LARGE", "Prototype authoring payload exceeds the 512 KB limit.");
  }

  const capturedIds = new Set((baseline.nodes || []).map((node) => node.id));
  const resolvedLinks = [];
  const affectedNodeIds = new Set();
  const sourceNodes = new Map();
  links.forEach((link) => {
    if (!link || typeof link.sourceNodeId !== "string" || !link.sourceNodeId) {
      throw writeError("PROTOTYPE_INVALID", "Every prototype link needs an explicit sourceNodeId.");
    }
    if (!capturedIds.has(link.sourceNodeId)) {
      throw writeError("WRITE_TARGET_MISMATCH", "Prototype link sources must be explicit nodes in the expected complete capture scope.");
    }
    const source = figma.getNodeById(link.sourceNodeId);
    if (!source || !nodeIsOnCurrentPage(source)) {
      throw writeError("PROTOTYPE_SOURCE_UNAVAILABLE", `Prototype source ${link.sourceNodeId} is unavailable on the captured page.`);
    }
    if (["DOCUMENT", "PAGE"].includes(source.type)
      || typeof source.setReactionsAsync !== "function" || !Array.isArray(source.reactions)) {
      throw writeError("PROTOTYPE_SOURCE_UNSUPPORTED", `Prototype source ${link.sourceNodeId} cannot set native reactions.`);
    }
    if (link.mode !== "set" && link.mode !== "clear") {
      throw writeError("PROTOTYPE_INVALID", "Prototype link mode must be set or clear.");
    }
    if (link.trigger !== undefined && link.trigger !== "on_click") {
      throw writeError("PROTOTYPE_INVALID", "Only on_click prototype triggers are supported.");
    }
    if (link.transition !== undefined && link.transition !== "instant") {
      throw writeError("PROTOTYPE_INVALID", "Only instant prototype transitions are supported.");
    }
    if (link.mode === "set") {
      if (typeof link.destinationNodeId !== "string" || !link.destinationNodeId) {
        throw writeError("PROTOTYPE_INVALID", "Setting a prototype link requires destinationNodeId.");
      }
      if (link.clearScope !== undefined) {
        throw writeError("PROTOTYPE_INVALID", "clearScope is only valid when clearing a prototype link.");
      }
      const destination = figma.getNodeById(link.destinationNodeId);
      if (!topLevelPrototypeFrame(destination)) {
        throw writeError("PROTOTYPE_DESTINATION_INVALID", `Prototype destination ${link.destinationNodeId} must be a top-level frame on the current Figma page.`);
      }
      const sourceScreen = containingTopLevelPrototypeFrame(source);
      if (sourceScreen && sourceScreen.id === destination.id) {
        throw writeError("PROTOTYPE_SELF_LINK", "Prototype navigation destination must be a different top-level frame from the source.");
      }
      affectedNodeIds.add(link.destinationNodeId);
      resolvedLinks.push({ link, source, destination });
    } else {
      if (link.clearScope !== "matching" && link.clearScope !== "all") {
        throw writeError("PROTOTYPE_INVALID", "Clearing a prototype link requires clearScope=matching or clearScope=all.");
      }
      if (link.clearScope === "matching") {
        if (typeof link.destinationNodeId !== "string" || !link.destinationNodeId) {
          throw writeError("PROTOTYPE_INVALID", "Matching clear requires destinationNodeId.");
        }
        const destination = figma.getNodeById(link.destinationNodeId);
        if (!topLevelPrototypeFrame(destination)) {
          throw writeError("PROTOTYPE_DESTINATION_INVALID", `Prototype destination ${link.destinationNodeId} must be a top-level frame on the current Figma page.`);
        }
        affectedNodeIds.add(link.destinationNodeId);
        resolvedLinks.push({ link, source, destination });
      } else {
        if (link.destinationNodeId !== undefined) {
          throw writeError("PROTOTYPE_INVALID", "All-link clear cannot include destinationNodeId.");
        }
        resolvedLinks.push({ link, source });
      }
    }
    sourceNodes.set(source.id, source);
    affectedNodeIds.add(source.id);
  });

  const seenFlowIds = new Set();
  const resolvedFlows = flowStartingPoints.map((flow) => {
    if (!flow || typeof flow.nodeId !== "string" || !flow.nodeId) {
      throw writeError("PROTOTYPE_INVALID", "Every flow starting point needs an explicit nodeId.");
    }
    if (seenFlowIds.has(flow.nodeId)) {
      throw writeError("PROTOTYPE_INVALID", `Duplicate flow starting point nodeId: ${flow.nodeId}.`);
    }
    seenFlowIds.add(flow.nodeId);
    if (flow.mode !== "set" && flow.mode !== "clear") {
      throw writeError("PROTOTYPE_INVALID", "Flow starting point mode must be set or clear.");
    }
    if (flow.mode === "set" && (typeof flow.name !== "string" || !flow.name)) {
      throw writeError("PROTOTYPE_INVALID", "Setting a flow starting point requires a name.");
    }
    if (flow.mode === "clear" && flow.name !== undefined) {
      throw writeError("PROTOTYPE_INVALID", "Clearing a flow starting point cannot include a name.");
    }
    const node = figma.getNodeById(flow.nodeId);
    if (!topLevelPrototypeFrame(node)) {
      throw writeError("PROTOTYPE_FLOW_INVALID", `Flow starting point ${flow.nodeId} must be a top-level frame on the current Figma page.`);
    }
    affectedNodeIds.add(flow.nodeId);
    return { flow, node };
  });

  return {
    links: resolvedLinks,
    flows: resolvedFlows,
    sourceNodes,
    affectedNodeIds: [...affectedNodeIds],
  };
}

function matchingPrototypeAction(action, destinationNodeId) {
  return Boolean(action
    && action.type === "NODE"
    && action.destinationId === destinationNodeId
    && action.navigation === "NAVIGATE");
}

function clearMatchingPrototypeReactions(reactions, destinationNodeId) {
  let cleared = 0;
  const next = [];
  reactions.forEach((reaction) => {
    if (!reaction || !reaction.trigger || reaction.trigger.type !== "ON_CLICK") {
      next.push(reaction);
      return;
    }
    if (Array.isArray(reaction.actions)) {
      const actions = reaction.actions.filter((action) => {
        const matches = matchingPrototypeAction(action, destinationNodeId);
        if (matches) cleared += 1;
        return !matches;
      });
      if (actions.length) next.push(actions.length === reaction.actions.length ? reaction : { ...reaction, actions });
      return;
    }
    if (matchingPrototypeAction(reaction.action, destinationNodeId)) {
      cleared += 1;
      return;
    }
    next.push(reaction);
  });
  return { reactions: next, cleared };
}

function countPrototypeActions(reactions) {
  return reactions.reduce((count, reaction) => count + (Array.isArray(reaction && reaction.actions)
    ? reaction.actions.length
    : reaction && reaction.action ? 1 : 0), 0);
}

async function setPrototype(payload, baseline) {
  const validated = validatePrototypeRequest(payload, baseline);
  const reactionState = new Map();
  validated.sourceNodes.forEach((node, id) => {
    const before = clonePrototypeValue(node.reactions || []);
    reactionState.set(id, { node, before, next: clonePrototypeValue(before) });
  });
  const beforeFlows = clonePrototypeValue(Array.isArray(figma.currentPage.flowStartingPoints)
    ? figma.currentPage.flowStartingPoints
    : []);
  const nextFlows = clonePrototypeValue(beforeFlows);
  let linksSet = 0;
  let linksCleared = 0;
  let flowsSet = 0;
  let flowsCleared = 0;

  validated.links.forEach(({ link, source }) => {
    const state = reactionState.get(source.id);
    if (link.mode === "set") {
      state.next.push({
        trigger: { type: "ON_CLICK" },
        actions: [{
          type: "NODE",
          destinationId: link.destinationNodeId,
          navigation: "NAVIGATE",
          transition: null,
        }],
      });
      linksSet += 1;
    } else if (link.clearScope === "all") {
      linksCleared += countPrototypeActions(state.next);
      state.next = [];
    } else {
      const result = clearMatchingPrototypeReactions(state.next, link.destinationNodeId);
      state.next = result.reactions;
      linksCleared += result.cleared;
    }
  });

  validated.flows.forEach(({ flow }) => {
    const index = nextFlows.findIndex((entry) => entry && entry.nodeId === flow.nodeId);
    if (flow.mode === "set") {
      const entry = { nodeId: flow.nodeId, name: flow.name };
      if (index >= 0) nextFlows[index] = entry;
      else nextFlows.push(entry);
      flowsSet += 1;
    } else if (index >= 0) {
      nextFlows.splice(index, 1);
      flowsCleared += 1;
    }
  });

  const changedReactions = [...reactionState.values()].filter((state) => JSON.stringify(state.before) !== JSON.stringify(state.next));
  const changedFlows = JSON.stringify(beforeFlows) !== JSON.stringify(nextFlows);
  try {
    for (const state of changedReactions) await state.node.setReactionsAsync(state.next);
    if (changedFlows) figma.currentPage.flowStartingPoints = nextFlows;
  } catch (error) {
    const rollbackErrors = [];
    for (const state of changedReactions) {
      try {
        await state.node.setReactionsAsync(state.before);
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError && rollbackError.message || rollbackError));
      }
    }
    if (changedFlows) {
      try {
        figma.currentPage.flowStartingPoints = beforeFlows;
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError && rollbackError.message || rollbackError));
      }
    }
    if (rollbackErrors.length) {
      throw writeError("PROTOTYPE_ROLLBACK_FAILED", "Prototype write failed and native rollback was incomplete.", {
        originalError: String(error && error.message || error),
        rollbackErrors,
      });
    }
    throw error;
  }

  return {
    status: "applied",
    affectedNodeIds: validated.affectedNodeIds,
    linksSet,
    linksCleared,
    flowsSet,
    flowsCleared,
  };
}

async function executeWrite(operation, payload) {
  const baseline = validateWriteState(payload || {}, operation);
  if (operation === "create_screen") {
    const spec = payload || {};
    const frame = figma.createFrame();
    frame.name = spec.name || "DesignPort Screen";
    frame.resize(Number(spec.width) || 1440, Number(spec.height) || 900);
    if (Number.isFinite(spec.x)) frame.x = spec.x;
    if (Number.isFinite(spec.y)) frame.y = spec.y;
    if (spec.background) frame.fills = [paintFromColor(spec.background)];
    figma.currentPage.selection = [frame];
    return { status: "applied", node: ref(frame.id), kind: "screen" };
  }
  if (operation === "create_component") return createComponent(payload || {});
  if (operation === "create_node_tree") return createNodeTree(payload || {});
  if (operation === "set_prototype") return setPrototype(payload || {}, baseline);
  if (operation === "update_selection") {
    const targetIds = Array.isArray(payload && payload.targetIds) ? payload.targetIds : [];
    const items = targetIds.map((id) => figma.getNodeById(id)).filter(Boolean);
    if (items.length !== targetIds.length) {
      throw writeError("WRITE_TARGET_UNAVAILABLE", "One or more write target IDs are unavailable.");
    }
    if (!items.length) throw writeError("WRITE_TARGET_MISMATCH", "At least one explicit write target is required.");
    const patch = (payload && payload.patch) || {};
    items.forEach((node) => validatePatchForNode(node, patch));
    let parent;
    if (patch.parentId) {
      parent = figma.getNodeById(patch.parentId);
      if (!parent || !isContainerNode(parent)) throw writeError("WRITE_TARGET_UNAVAILABLE", "The requested reparent target is unavailable or cannot contain children.");
      items.forEach((node) => {
        if (node === parent) throw writeError("WRITE_TARGET_MISMATCH", "A node cannot be reparented to itself.");
        let current = parent;
        while (current) {
          if (current === node) throw writeError("WRITE_TARGET_MISMATCH", "A node cannot be reparented into its own descendant.");
          current = current.parent;
        }
      });
    }
    if (parent) items.forEach((node) => parent.appendChild(node));
    await Promise.all(items.map((node) => applyPatch(node, patch)));
    return { status: "applied", nodes: items.map((item) => ref(item.id)) };
  }
  throw new Error(`Unsupported Figma write operation: ${operation}`);
}

function hostHello() {
  const info = documentInfo();
  return {
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    pairingToken: PAIRING_TOKEN,
    host: "figma",
    pluginVersion: PLUGIN_VERSION,
    documentId: info.documentId,
    documentName: info.documentName,
    capabilities: CAPABILITIES,
  };
}

function sendToUI(message) {
  figma.ui.postMessage(message);
}

function errorPayload(error) {
  return {
    code: error && error.code ? error.code : "FIGMA_PLUGIN_ERROR",
    message: error && error.message ? error.message : String(error),
    ...(error && error.details !== undefined ? { details: error.details } : {}),
  };
}

function eventPayload(affectedNodeIds, removedNodeIds) {
  syncSelectionRevision();
  const info = documentInfo();
  const unique = (ids) => Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean))).slice(0, 200);
  return {
    sequence: ++snapshotState.eventSequence,
    documentId: info.documentId,
    documentRevision: snapshotState.documentRevision,
    selectionRevision: snapshotState.selectionRevision,
    affectedNodeIds: unique(affectedNodeIds),
    removedNodeIds: unique(removedNodeIds),
  };
}

async function handleRequest(request) {
  try {
    let result;
    switch (request.operation) {
      case "ping":
        result = { ok: true, host: "figma", at: new Date().toISOString() };
        break;
      case "get_capabilities":
        result = CAPABILITIES;
        break;
      case "get_selection_context":
        result = await selectionContext(exportOptionsFor(request.payload));
        break;
      case "get_screen_context":
        result = await screenContext(
          request.payload && request.payload.screenId,
          exportOptionsFor(request.payload),
        );
        break;
      case "get_visual_context":
        result = await visualContext(
          (request.payload && request.payload.scope) || "screen",
          request.payload && request.payload.screenId,
          request.payload || {},
        );
        break;
      case "export_ir": {
        const scope = (request.payload && request.payload.scope) || "document";
        const options = exportOptionsFor(request.payload);
        result = scope === "selection"
          ? await selectionContext(options)
          : scope === "screen"
            ? await screenContext(request.payload && request.payload.screenId, options)
            : scope === "page"
              ? await pageContext(request.payload && request.payload.pageId, options)
            : await buildDocumentIR(options);
        break;
      }
      case "get_asset":
        result = await getAsset(request.payload || {});
        break;
      case "get_operation_status":
        result = { pendingId: request.payload && request.payload.pendingId, status: "applied", operation: "unknown", message: "Figma writes are applied synchronously." };
        break;
      case "create_screen":
      case "create_component":
      case "create_node_tree":
      case "update_selection":
      case "set_prototype":
        result = await executeWrite(request.operation, request.payload);
        break;
      default:
        throw new Error(`Unknown DesignPort operation: ${request.operation}`);
    }
    sendToUI({ type: "bridge_response", value: { type: "response", requestId: request.requestId, ok: true, result } });
  } catch (error) {
    sendToUI({ type: "bridge_response", value: { type: "response", requestId: request.requestId, ok: false, error: errorPayload(error) } });
  }
}

figma.ui.onmessage = (message) => {
  if (message.type === "ui_ready") {
    sendToUI({ type: "host_hello", hello: hostHello() });
    return;
  }
  if (message.type === "bridge_request") {
    void handleRequest(message.request);
  }
};

figma.on("selectionchange", () => {
  sendToUI({
    type: "bridge_event",
    value: {
      type: "event",
      event: "selection.changed",
      payload: eventPayload(selectionItems().map((item) => item.id), []),
    },
  });
});

figma.on("documentchange", (event) => {
  snapshotState.documentRevision += 1;
  const changes = event && Array.isArray(event.documentChanges) ? event.documentChanges : [];
  const affectedNodeIds = [];
  const removedNodeIds = [];
  changes.forEach((change) => {
    const id = change && (change.id || change.node && change.node.id);
    const type = typeof (change && change.type) === "string" ? change.type.toUpperCase() : "";
    const deleted = type === "DELETE" || type === "DELETED" || type === "REMOVED";
    rememberChangedNodeIds(deleted ? [] : [id], deleted ? [id] : []);
    if (deleted) removedNodeIds.push(id);
    else affectedNodeIds.push(id);
  });
  clearAssetCache();
  tokenCache.clear();
  sendToUI({
    type: "bridge_event",
    value: {
      type: "event",
      event: "document.changed",
      payload: eventPayload(affectedNodeIds, removedNodeIds),
    },
  });
});
