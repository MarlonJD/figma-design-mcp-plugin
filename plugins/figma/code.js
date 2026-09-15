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

figma.showUI(__html__, { visible: false, width: 1, height: 1 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
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
    if (paint.type !== "SOLID" || !paint.color) {
      return { type: "unknown", opacity: Number.isFinite(paint.opacity) ? clamp(paint.opacity, 0, 1) : 1 };
    }
    return {
      type: "solid",
      color: {
        r: clamp(paint.color.r, 0, 1),
        g: clamp(paint.color.g, 0, 1),
        b: clamp(paint.color.b, 0, 1),
        ...(Number.isFinite(paint.opacity) ? { a: clamp(paint.opacity, 0, 1) } : {}),
      },
      opacity: Number.isFinite(paint.opacity) ? clamp(paint.opacity, 0, 1) : 1,
    };
  });
}

function strokesToIR(node) {
  if (!Array.isArray(node.strokes)) return undefined;
  const position = {
    INSIDE: "inside",
    OUTSIDE: "outside",
    CENTER: "center",
  }[node.strokeAlign];
  return paintsToIR(node.strokes).map((fill) => ({
    fills: [fill],
    ...(Number.isFinite(node.strokeWeight) ? { weight: Math.max(0, node.strokeWeight) } : {}),
    ...(position ? { position } : {}),
  }));
}

function typographyFor(node) {
  if (node.type !== "TEXT") return undefined;
  const result = {};
  if (node.fontName && node.fontName !== figma.mixed) {
    if (typeof node.fontName.family === "string") result.family = node.fontName.family;
    if (typeof node.fontName.style === "string") result.style = node.fontName.style;
  }
  if (typeof node.fontSize === "number") result.size = node.fontSize;
  if (typeof node.letterSpacing === "object" && typeof node.letterSpacing.value === "number") {
    result.letterSpacing = node.letterSpacing.value;
  }
  if (typeof node.textAlignHorizontal === "string") {
    result.align = node.textAlignHorizontal.toLowerCase();
  }
  return Object.keys(result).length ? result : undefined;
}

function layoutFor(node) {
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
  if (mode === "none" && !sizingHorizontal && !sizingVertical) return undefined;
  return {
    mode,
    ...(typeof node.itemSpacing === "number" ? { gap: node.itemSpacing } : {}),
    padding: {
      top: Number(node.paddingTop) || 0,
      right: Number(node.paddingRight) || 0,
      bottom: Number(node.paddingBottom) || 0,
      left: Number(node.paddingLeft) || 0,
    },
    ...(sizingHorizontal ? { sizingHorizontal } : {}),
    ...(sizingVertical ? { sizingVertical } : {}),
  };
}

function childrenOf(node) {
  return Array.isArray(node.children) ? node.children : [];
}

function nodeToIR(node, parentId, topLevel) {
  const children = childrenOf(node);
  const result = {
    id: node.id,
    name: node.name || node.type,
    kind: kindFor(node, topLevel),
    parentId: parentId || null,
    children: children.map((child) => child.id),
    bounds: boundsFor(node),
    visible: node.visible !== false,
    opacity: Number.isFinite(node.opacity) ? clamp(node.opacity, 0, 1) : undefined,
    fills: Array.isArray(node.fills) ? paintsToIR(node.fills) : undefined,
    strokes: strokesToIR(node),
    text: node.type === "TEXT" ? node.characters : undefined,
    typography: typographyFor(node),
    layout: layoutFor(node),
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

function buildDocumentIR() {
  const page = figma.currentPage;
  const nodes = {};

  function visit(node, parentId, topLevel) {
    const converted = nodeToIR(node, parentId, topLevel);
    nodes[converted.result.id] = converted.result;
    converted.children.forEach((child) => visit(child, converted.result.id, false));
  }

  visit(page, null, true);
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

function addSubtree(node, parentId, result, topLevel) {
  const converted = nodeToIR(node, parentId, topLevel);
  result.push(converted.result);
  converted.children.forEach((child) => addSubtree(child, converted.result.id, result, false));
}

function selectionContext() {
  const info = documentInfo();
  const nodes = [];
  selectionItems().forEach((item) => addSubtree(item, item.parent && item.parent.id, nodes, item.parent === figma.currentPage));
  return {
    schemaVersion: 1,
    scope: "selection",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selectionItems().map((item) => ref(item.id)),
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

function screenContext(screenId) {
  const screen = findScreen(screenId);
  if (!screen) throw new Error("No Figma screen frame was found for the requested screen");
  const info = documentInfo();
  const nodes = [];
  addSubtree(screen, screen.parent && screen.parent.id, nodes, true);
  return {
    schemaVersion: 1,
    scope: "screen",
    host: "figma",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: screen.id,
    selection: selectionItems().map((item) => ref(item.id)),
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
        result = selectionContext();
        break;
      case "get_screen_context":
        result = screenContext(request.payload && request.payload.screenId);
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
          ? selectionContext()
          : scope === "screen"
            ? screenContext(request.payload && request.payload.screenId)
            : buildDocumentIR();
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
  sendToUI({
    type: "bridge_event",
    value: { type: "event", event: "selection.changed", payload: selectionContext() },
  });
});
