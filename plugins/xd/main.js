const { entrypoints } = require("uxp");
const scenegraph = require("scenegraph");
const application = require("application");

const { Artboard, Rectangle, Text, Color } = scenegraph;

const BRIDGE_URL = "ws://127.0.0.1:5514";
const PLUGIN_VERSION = "0.1.0";

const CAPABILITIES = {
  host: "xd",
  pluginVersion: PLUGIN_VERSION,
  operations: [
    "ping",
    "get_capabilities",
    "get_selection_context",
    "get_screen_context",
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
  },
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

function nodeId(node) {
  if (!node) {
    return null;
  }
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
      return "group";
    case "Rectangle":
      return "rectangle";
    case "Ellipse":
      return "ellipse";
    case "Line":
      return "line";
    case "Path":
      return "path";
    case "Text":
      return "text";
    case "SymbolInstance":
      return "instance";
    case "RepeatGrid":
      return "repeat-grid";
    default:
      return "unknown";
  }
}

function childrenOf(node) {
  const children = node && node.children;
  if (!children || typeof children.forEach !== "function") {
    return [];
  }
  const result = [];
  children.forEach((child) => result.push(child));
  return result;
}

function boundsOf(node) {
  const value = node && (node.globalBounds || node.localBounds);
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
    return null;
  }
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    width: Math.max(0, Number(value.width) || 0),
    height: Math.max(0, Number(value.height) || 0),
  };
}

function colorFromXD(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (!Number.isFinite(value.r) || !Number.isFinite(value.g) || !Number.isFinite(value.b)) {
    return null;
  }
  const color = {
    r: clamp(value.r, 0, 1),
    g: clamp(value.g, 0, 1),
    b: clamp(value.b, 0, 1),
  };
  if (Number.isFinite(value.a)) {
    color.a = clamp(value.a, 0, 1);
  }
  return color;
}

function fillFromXD(value) {
  const color = colorFromXD(value);
  if (!color) {
    return value ? [{ type: "unknown" }] : [];
  }
  return [{
    type: "solid",
    color,
    opacity: Number.isFinite(value.a) ? clamp(value.a, 0, 1) : 1,
  }];
}

function typographyFromXD(node) {
  if (nodeKind(node) !== "text") {
    return undefined;
  }
  const typography = {};
  if (typeof node.fontFamily === "string") typography.family = node.fontFamily;
  if (typeof node.fontStyle === "string") typography.style = node.fontStyle;
  if (Number.isFinite(node.fontSize)) typography.size = node.fontSize;
  if (Number.isFinite(node.charSpacing)) typography.letterSpacing = node.charSpacing;
  if (typeof node.textAlign === "string") typography.align = node.textAlign;
  return Object.keys(typography).length ? typography : undefined;
}

function nodeToIR(node, parentId) {
  const id = nodeId(node);
  if (!id) {
    return null;
  }

  const children = childrenOf(node);
  const result = {
    id,
    name: typeof node.name === "string" ? node.name : nodeType(node),
    kind: nodeKind(node),
    parentId: parentId || null,
    children: children.map(nodeId).filter(Boolean),
    bounds: boundsOf(node),
    visible: node.visible !== false,
    hostData: {
      xdType: nodeType(node),
      guid: id,
      rotation: Number.isFinite(node.rotation) ? node.rotation : 0,
    },
  };

  if (typeof node.locked === "boolean") result.locked = node.locked;
  if (Number.isFinite(node.opacity)) result.opacity = clamp(node.opacity, 0, 1);
  if (node.fill) result.fills = fillFromXD(node.fill);
  if (typeof node.text === "string") result.text = node.text;
  const typography = typographyFromXD(node);
  if (typography) result.typography = typography;

  return { result, children };
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

function buildDocumentIR() {
  const root = scenegraph.root;
  const nodes = {};

  function visit(node, parentId) {
    const converted = nodeToIR(node, parentId);
    if (!converted) return;
    nodes[converted.result.id] = converted.result;
    converted.children.forEach((child) => visit(child, converted.result.id));
  }

  visit(root, null);
  const info = documentInfo();
  const rootId = nodeId(root) || info.documentId;
  const screens = childrenOf(root)
    .filter((child) => nodeKind(child) === "screen")
    .map((child) => ({ host: "xd", id: nodeId(child) }))
    .filter((ref) => ref.id);
  const selection = selectionItems()
    .map((item) => ({ host: "xd", id: nodeId(item) }))
    .filter((ref) => ref.id);

  return {
    schemaVersion: 1,
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    rootId,
    nodes,
    screens,
    selection,
    exportedAt: new Date().toISOString(),
  };
}

function addSubtree(node, parentId, result) {
  const converted = nodeToIR(node, parentId);
  if (!converted) return;
  result.push(converted.result);
  converted.children.forEach((child) => addSubtree(child, converted.result.id, result));
}

function selectionContext() {
  const info = documentInfo();
  const nodes = [];
  selectionItems().forEach((item) => addSubtree(item, item.parent ? nodeId(item.parent) : null, nodes));
  return {
    schemaVersion: 1,
    scope: "selection",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    selection: selectionItems()
      .map((item) => ({ host: "xd", id: nodeId(item) }))
      .filter((ref) => ref.id),
    nodes,
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

function screenContext(screenId) {
  const screen = findScreen(screenId);
  if (!screen) {
    throw new Error("No XD artboard was found for the requested screen");
  }
  const info = documentInfo();
  const nodes = [];
  addSubtree(screen, screen.parent ? nodeId(screen.parent) : null, nodes);
  return {
    schemaVersion: 1,
    scope: "screen",
    host: "xd",
    documentId: info.documentId,
    documentName: info.documentName,
    screenId: nodeId(screen),
    selection: selectionItems()
      .map((item) => ({ host: "xd", id: nodeId(item) }))
      .filter((ref) => ref.id),
    nodes,
    exportedAt: new Date().toISOString(),
  };
}

function colorToHex(color) {
  if (!color) return "#FFFFFF";
  const channel = (value) => Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function insertParent(selection, documentRoot) {
  return (selection && selection.insertionParent) || documentRoot || scenegraph.root;
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
    if (spec.background) {
      artboard.fill = new Color(colorToHex(spec.background));
    }
    selection.items = [artboard];
    return {
      status: "applied",
      node: { host: "xd", id: nodeId(artboard) },
      kind: "screen",
    };
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
    return {
      status: "applied",
      nodes: items.map((item) => ({ host: "xd", id: nodeId(item) })),
    };
  }

  const error = new Error(`Unsupported XD write operation: ${operation}`);
  error.code = "UNSUPPORTED_OPERATION";
  throw error;
}

function send(message) {
  if (state.socket && state.socket.readyState === 1) {
    state.socket.send(JSON.stringify(message));
  }
}

function sendResponse(requestId, ok, value) {
  if (ok) {
    send({ type: "response", requestId, ok: true, result: value });
  } else {
    send({ type: "response", requestId, ok: false, error: value });
  }
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
  sendEvent("write.queued", {
    pendingId,
    requestId: request.requestId,
    operation: request.operation,
  });
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
        sendResponse(request.requestId, true, selectionContext());
        return;
      case "get_screen_context":
        sendResponse(request.requestId, true, screenContext(request.payload && request.payload.screenId));
        return;
      case "export_ir": {
        const scope = (request.payload && request.payload.scope) || "document";
        if (scope === "selection") {
          sendResponse(request.requestId, true, selectionContext());
        } else if (scope === "screen") {
          sendResponse(request.requestId, true, screenContext(request.payload && request.payload.screenId));
        } else {
          sendResponse(request.requestId, true, buildDocumentIR());
        }
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
  if (state.socket && (state.socket.readyState === 0 || state.socket.readyState === 1)) {
    return;
  }
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
      if (message.type === "request") {
        void handleRequest(message);
      }
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
      <div class="copy">Selection and document context are available to the local MCP bridge.</div>
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
        if (state.socket && state.socket.readyState === 1) {
          sendEvent("selection.changed", selectionContext());
        }
      },
    },
  },
});
