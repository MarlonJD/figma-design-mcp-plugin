const BRIDGE_PROTOCOL_VERSION = 1;
const PLUGIN_VERSION = "0.1.0";

const CAPABILITIES = {
  host: "figma",
  pluginVersion: PLUGIN_VERSION,
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
    createComponent: true,
    updateSelection: true,
    userActionRequiredForWrite: false,
    visualRead: true,
  },
};

const MAX_ASSET_EXPORTS_PER_REQUEST = 64;
const assetCache = new Map();
const assetPromises = new Map();

figma.showUI(__html__, { visible: false, width: 1, height: 1 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
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

function effectsToIR(node) {
  if (!Array.isArray(node.effects) || !node.effects.length) return undefined;
  return node.effects.map((effect) => {
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
  return `${figma.root.id}:${node.id}`;
}

async function assetFor(node, exportState) {
  if (node.visible === false) return undefined;
  const isVector = node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || node.type === "POLYGON" || node.type === "STAR";
  const imagePaint = Array.isArray(node.fills)
    ? node.fills.find((paint) => paint && paint.type === "IMAGE" && paint.imageHash)
    : undefined;
  if (!isVector && !imagePaint) return undefined;

  const key = assetCacheKey(node);
  if (assetCache.has(key)) return assetCache.get(key);
  const pending = assetPromises.get(key);
  if (pending) return pending;
  if (exportState.assetExports >= MAX_ASSET_EXPORTS_PER_REQUEST) return undefined;
  exportState.assetExports += 1;

  const promise = (async () => {
    try {
      if (isVector) {
        const svg = await node.exportAsync({ format: "SVG_STRING", contentsOnly: true });
        if (typeof svg === "string" && svg.trim()) {
          return { mimeType: "image/svg+xml", data: svg, kind: "vector" };
        }
      }
      if (!imagePaint) return undefined;
      const bytes = await node.exportAsync({ format: "PNG", contentsOnly: true });
      return {
        mimeType: "image/png",
        data: figma.base64Encode(bytes),
        kind: "image",
        ...(typeof imagePaint.scaleMode === "string" ? { imageScaleMode: imagePaint.scaleMode.toLowerCase() } : {}),
      };
    } catch (_error) {
      // Keep the structural node when a host cannot export one asset.
      return undefined;
    }
  })();
  assetPromises.set(key, promise);
  try {
    const asset = await promise;
    assetCache.set(key, asset);
    return asset;
  } finally {
    assetPromises.delete(key);
  }
}

function typographyFor(node) {
  if (node.type !== "TEXT") return undefined;
  const result = {};
  if (node.fontName && node.fontName !== figma.mixed) {
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
    const trigger = reaction.trigger && reaction.trigger.type
      ? String(reaction.trigger.type).toLowerCase()
      : "unknown";
    const actions = Array.isArray(reaction.actions)
      ? reaction.actions
      : reaction.action
        ? [reaction.action]
        : [];
    actions.forEach((action) => {
      if (!action || typeof action.type !== "string") return;
      links.push({
        trigger,
        action: action.type.toLowerCase(),
        ...(typeof action.destinationId === "string" ? { destinationId: action.destinationId } : {}),
        ...(typeof action.url === "string" ? { url: action.url } : {}),
        ...(typeof action.navigation === "string" ? { navigation: action.navigation.toLowerCase() } : {}),
        ...(action.transition && typeof action.transition.type === "string"
          ? { transition: action.transition.type.toLowerCase() }
          : {}),
        ...(action.transition && Number.isFinite(action.transition.duration)
          ? { duration: Math.max(0, action.transition.duration) }
          : {}),
        ...(typeof action.preserveScrollPosition === "boolean"
          ? { preserveScrollPosition: action.preserveScrollPosition }
          : {}),
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

async function nodeToIR(node, parentId, topLevel, exportState) {
  const children = childrenOf(node);
  const corners = cornersToIR(node);
  const bounds = boundsFor(node);
  const renderBounds = renderBoundsFor(node, bounds);
  const fills = Array.isArray(node.fills) && node.fills.length ? paintsToIR(node.fills) : undefined;
  const strokes = strokesToIR(node);
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
  const result = {
    id: node.id,
    name: node.name || node.type,
    kind: kindFor(node, topLevel),
    parentId: parentId || null,
    children: children.map((child) => child.id),
    bounds,
    ...(renderBounds ? { renderBounds } : {}),
    visible: node.visible !== false,
    ...(opacity !== undefined ? { opacity } : {}),
    ...(blendModeFor(node.blendMode) ? { blendMode: blendModeFor(node.blendMode) } : {}),
    ...(fills ? { fills } : {}),
    ...(strokes ? { strokes } : {}),
    effects: effectsToIR(node),
    ...corners,
    asset: await assetFor(node, exportState),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(clipsContent ? { clipsContent } : {}),
    minWidth: Number.isFinite(node.minWidth) ? Math.max(0, node.minWidth) : undefined,
    maxWidth: Number.isFinite(node.maxWidth) ? Math.max(0, node.maxWidth) : undefined,
    minHeight: Number.isFinite(node.minHeight) ? Math.max(0, node.minHeight) : undefined,
    maxHeight: Number.isFinite(node.maxHeight) ? Math.max(0, node.maxHeight) : undefined,
    constraints: constraintsFor(node),
    ...(layoutAlign ? { layoutAlign } : {}),
    ...(layoutGrow !== undefined ? { layoutGrow } : {}),
    ...(layoutPositioning ? { layoutPositioning } : {}),
    gridPosition: gridPositionFor(node),
    text: node.type === "TEXT" ? node.characters : undefined,
    typography: typographyFor(node),
    layout: layoutFor(node, node.parent && node.parent.layoutMode),
    prototypeLinks: prototypeLinksFor(node),
    hostData: {
      figmaType: node.type,
      topLevel: Boolean(topLevel),
    },
  };
  return { result, children };
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

async function buildDocumentIR() {
  const page = figma.currentPage;
  const nodes = {};
  const exportState = { assetExports: 0 };
  const flattened = await collectSubtree(page, null, true, exportState);
  flattened.forEach((node) => {
    nodes[node.id] = node;
  });
  const info = documentInfo();
  const screens = page.children
    .filter((child) => child.type === "FRAME")
    .map((child) => ref(child.id));
  return {
    schemaVersion: 1,
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    rootId: page.id,
    nodes,
    screens,
    selection: selectionItems().map((item) => ref(item.id)),
    exportedAt: new Date().toISOString(),
  };
}

async function collectSubtree(node, parentId, topLevel, exportState) {
  const converted = await nodeToIR(node, parentId, topLevel, exportState);
  const childNodes = await Promise.all(
    converted.children.map((child) => collectSubtree(child, converted.result.id, false, exportState)),
  );
  return [converted.result, ...childNodes.flat()];
}

async function selectionContext() {
  const info = documentInfo();
  const selection = selectionItems();
  const exportState = { assetExports: 0 };
  const nodeLists = await Promise.all(
    selection.map((item) => collectSubtree(item, item.parent && item.parent.id, item.parent === figma.currentPage, exportState)),
  );
  const nodes = nodeLists.flat();
  return {
    schemaVersion: 1,
    scope: "selection",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selection.map((item) => ref(item.id)),
    nodes,
    exportedAt: new Date().toISOString(),
  };
}

function findScreen(screenId) {
  if (screenId) {
    const node = figma.getNodeById(screenId);
    return node && node.parent === figma.currentPage && node.type === "FRAME" ? node : null;
  }
  const selected = selectionItems().find((item) => item.parent === figma.currentPage && item.type === "FRAME");
  return selected || figma.currentPage.children.find((child) => child.type === "FRAME") || null;
}

async function screenContext(screenId) {
  const screen = findScreen(screenId);
  if (!screen) throw new Error("No Figma screen frame was found for the requested screen");
  const info = documentInfo();
  const exportState = { assetExports: 0 };
  const nodes = await collectSubtree(screen, screen.parent && screen.parent.id, true, exportState);
  const selection = selectionItems();
  return {
    schemaVersion: 1,
    scope: "screen",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: screen.id,
    selection: selection.map((item) => ref(item.id)),
    nodes,
    exportedAt: new Date().toISOString(),
  };
}

function visualTargets(scope, screenId) {
  if (scope === "screen") {
    const screen = findScreen(screenId);
    if (!screen) throw new Error("No Figma screen frame was found for the requested visual context");
    return [screen];
  }
  const selected = selectionItems();
  if (!selected.length) throw new Error("Figma selection is empty");
  return selected.slice(0, 4);
}

async function visualContext(scope, screenId) {
  const targets = visualTargets(scope, screenId);
  const items = [];
  for (const target of targets) {
    const bounds = boundsFor(target);
    const maxDimension = Math.max(bounds ? bounds.width : 0, bounds ? bounds.height : 0);
    const scale = maxDimension > 1024 ? Math.max(0.1, 1024 / maxDimension) : 1;
    const bytes = await target.exportAsync({
      format: "PNG",
      contentsOnly: true,
      constraint: { type: "SCALE", value: scale },
    });
    items.push({
      nodeId: target.id,
      nodeName: target.name || target.type,
      mimeType: "image/png",
      data: figma.base64Encode(bytes),
      bounds,
      scale,
    });
  }
  const info = documentInfo();
  return {
    schemaVersion: 1,
    scope,
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    items,
    exportedAt: new Date().toISOString(),
  };
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

function applyPatch(node, patch) {
  if (patch.name) node.name = patch.name;
  if (typeof patch.visible === "boolean") node.visible = patch.visible;
  if (Number.isFinite(patch.opacity)) node.opacity = clamp(patch.opacity, 0, 1);
  if (patch.bounds) {
    const width = Number.isFinite(patch.bounds.width) ? patch.bounds.width : node.width;
    const height = Number.isFinite(patch.bounds.height) ? patch.bounds.height : node.height;
    if (typeof node.resize === "function") node.resize(width, height);
    if (Number.isFinite(patch.bounds.x)) node.x = patch.bounds.x;
    if (Number.isFinite(patch.bounds.y)) node.y = patch.bounds.y;
  }
  if (Array.isArray(patch.fills) && patch.fills.length && "fills" in node) {
    node.fills = patch.fills.map((fill) => fill.color ? paintFromColor(fill.color) : { type: "SOLID", color: { r: 0, g: 0, b: 0 } });
  }
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

async function executeWrite(operation, payload) {
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
  if (operation === "update_selection") {
    const items = selectionItems();
    if (!items.length) throw new Error("Figma selection is empty");
    items.forEach((node) => applyPatch(node, (payload && payload.patch) || {}));
    return { status: "applied", nodes: items.map((item) => ref(item.id)) };
  }
  throw new Error(`Unsupported Figma write operation: ${operation}`);
}

function hostHello() {
  const info = documentInfo();
  return {
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
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
        result = await selectionContext();
        break;
      case "get_screen_context":
        result = await screenContext(request.payload && request.payload.screenId);
        break;
      case "get_visual_context":
        result = await visualContext(
          (request.payload && request.payload.scope) || "screen",
          request.payload && request.payload.screenId,
        );
        break;
      case "export_ir": {
        const scope = (request.payload && request.payload.scope) || "document";
        result = scope === "selection"
          ? await selectionContext()
          : scope === "screen"
            ? await screenContext(request.payload && request.payload.screenId)
            : await buildDocumentIR();
        break;
      }
      case "create_screen":
      case "create_component":
      case "update_selection":
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
  void selectionContext()
    .then((payload) => {
      sendToUI({
        type: "bridge_event",
        value: { type: "event", event: "selection.changed", payload },
      });
    })
    .catch((error) => {
      sendToUI({
        type: "bridge_event",
        value: {
          type: "event",
          event: "status",
          payload: { status: "error", message: error && error.message ? error.message : String(error) },
        },
      });
    });
});

figma.on("documentchange", () => {
  assetCache.clear();
  assetPromises.clear();
});
