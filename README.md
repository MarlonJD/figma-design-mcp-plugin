# DesignPort

DesignPort is a local MCP bridge between coding agents and design hosts. It
keeps the shared design model independent from Figma and Adobe XD, while each
host contributes a small adapter plugin.

```text
Codex / Claude
      |
      | MCP over stdio
      v
DesignPort server
      |
      | localhost WebSocket
      +----------+----------+
      |                     |
  Figma plugin          XD plugin
      |                     |
  Figma API           XD scenegraph
```

## Current slice

- Versioned `DesignIR` for documents, screens, nodes, selection, styles, and
  host capabilities.
- Local WebSocket bridge with host registration, request/response correlation,
  reconnect-safe session cleanup, and bounded request timeouts.
- MCP tools for host discovery, context reads, IR export, screen/component
  creation, and selection updates.
- Adobe XD development plugin with document/selection export and basic shape,
  text, and artboard operations.
- Figma development plugin using the same bridge protocol and IR shape.
- Unit tests for protocol validation, IR normalization, and bridge routing.

## Run the server

```bash
npm install
npm test
npm run typecheck
npm run build
npm start
```

The process exposes MCP over stdin/stdout and starts the bridge on
`127.0.0.1:5514`. Configure an MCP client with:

```json
{
  "mcpServers": {
    "designport": {
      "command": "node",
      "args": ["/absolute/path/to/designport/dist/src/index.js"]
    }
  }
}
```

For local development, `npm run dev` starts the TypeScript entrypoint
directly.

## Load the plugins

### Adobe XD

Load `plugins/xd` through Adobe UXP Developer Tool. The plugin connects to the
bridge at `ws://127.0.0.1:5514` and exposes the same operations as the MCP
server. `design.update_selection` is intentionally treated as a capability:
the plugin queues a write when XD requires a user-initiated edit context and
the panel provides an explicit Apply action.

### Figma

Import `plugins/figma/manifest.json` as a development plugin. The plugin keeps
the network connection in its hidden UI iframe and executes document changes
in the Figma plugin sandbox.

## Design decisions

The IR contains only cross-host concepts: document, screen, group, shape,
text, component, instance, bounds, fills, typography, layout, and prototype
links. Host-specific properties live under `hostData` and are never required
by the common MCP tools. Adapters advertise actual capabilities rather than
pretending that Figma components and XD symbols are identical.

The bridge is local by default. A future remote deployment must add an
authenticated `wss://` transport; the current server deliberately does not
listen on non-loopback interfaces.
