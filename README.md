# DesignPort

DesignPort is a local MCP bridge that lets coding agents understand and work
with designs in Figma and Adobe XD.

It gives an agent structured design context instead of making the agent guess
from screenshots. A designer can keep working in the tool they know, while an
agent can read selections and screens, export a host-neutral design model, and
generate a starting point for web, React, Vue, Flutter, SwiftUI, or Jetpack
Compose.

DesignPort is an early, local-first project. It is intentionally small enough
to run on a designer's computer and clear enough to extend with more hosts and
code-generation targets.

## Why does this exist?

Design files contain valuable implementation decisions: hierarchy, spacing,
typography, colors, component boundaries, and screen relationships. Those
decisions are difficult for an agent to recover reliably when the only input is
a screenshot or a host-specific API dump.

DesignPort separates the problem into three parts:

1. A Figma or XD development plugin reads the open document.
2. The local bridge normalizes that information into `DesignIR`, a shared
   design representation.
3. MCP tools make the context available to coding agents and expose carefully
   scoped design operations.

The result is a common path from design to implementation:

```text
Figma / Adobe XD
        |
        | host plugin over localhost WebSocket
        v
DesignPort bridge + MCP server
        |
        | DesignIR
        v
Codex / Claude / another MCP client
        |
        v
HTML / React / future targets
```

The shared model is the important part. Figma-specific and XD-specific details
stay at the edge, so adding another host does not require rewriting the agent
integration.

## What it can do today

- Connect a Figma development plugin and an Adobe XD UXP development plugin.
- Read the current selection or a screen/artboard.
- Export a full document or a scoped `DesignIR` snapshot.
- Report connected hosts, capabilities, and recent host events.
- Generate a web export, a self-contained HTML export, or starter code for
  React, Vue, Flutter, SwiftUI, and Jetpack Compose.
- Create screens and basic components through host adapters.
- Apply a normalized patch to the current selection.
- Keep the bridge on loopback (`127.0.0.1`) by default.

The available MCP tools are:

| Tool | Purpose |
| --- | --- |
| `design.list_hosts` | List connected Figma and XD plugins. |
| `design.list_events` | Read recent selection, document, and write events. |
| `design.get_capabilities` | Inspect what a connected host supports. |
| `design.get_selection_context` | Read the current selection as normalized nodes. |
| `design.get_screen_context` | Read one screen/artboard and its descendants. |
| `design.export_ir` | Export document, selection, or screen context. |
| `design.generate_code` | Generate web, HTML, React, Vue, Flutter, SwiftUI, or Compose code. |
| `design.create_screen` | Create an artboard/screen. |
| `design.create_component` | Create a basic component or symbol where supported. |
| `design.update_selection` | Apply a normalized patch to the current selection. |
| `design.ping` | Check that a host can receive requests. |

See [EXAMPLES.md](EXAMPLES.md) for ready-to-copy tool arguments and common
workflows.

### Code generation targets

| Target | Files returned | Intended use |
| --- | --- | --- |
| `web` | `index.html`, `styles.css` | A normal two-file browser export. |
| `html` | `designport-export.html` | A self-contained browser preview. |
| `react` | `DesignPortScreen.tsx`, `DesignPortScreen.css` | React application starter. |
| `vue` | `DesignPortScreen.vue` | Vue single-file component starter. |
| `flutter` | `design_port_screen.dart` | Flutter widget starter. |
| `swiftui` | `DesignPortScreen.swift` | SwiftUI view starter. |
| `compose` | `DesignPortScreen.kt` | Jetpack Compose composable starter. |

Every target is generated from the same `DesignIR` snapshot. The mobile and
UI-framework outputs preserve geometry, colors, typography, and hierarchy as a
semantic first pass; application behavior, assets, and final accessibility
still need to be wired in the destination project.

### Semantic layout generation

Code generation is not a screenshot-to-pixels conversion. The generator uses
the host's explicit layout metadata first, including direction, gap, padding,
and fixed/hug/fill sizing. If a host does not expose that metadata, it makes a
conservative sibling-layout inference. Coordinates are retained only as the
fallback for genuinely free-form or ambiguous placement.

The same layout plan maps to the native primitive for each target:

| Design intent | Web / React / Vue | Flutter | SwiftUI | Compose |
| --- | --- | --- | --- | --- |
| Horizontal flow | CSS `flex-direction: row` | `Row` | `HStack` | `Row` |
| Vertical flow | CSS `flex-direction: column` | `Column` | `VStack` | `Column` |
| Fill remaining space | `flex: 1 1 0` | `Expanded` | `frame(maxWidth/maxHeight: .infinity)` | `weight(1f)` |
| Grid-like flow | CSS grid | `Wrap` | `LazyVGrid` | rows of weighted `Row`s |

Current native UI baselines are intentionally modern: Flutter uses the
official `cupertino_ui` package, SwiftUI emits iOS 26+/macOS 26+ Liquid Glass
APIs with a fallback, and Compose uses the latest stable Material 3 dependency
with dynamic color and `Scaffold`.

## Requirements

- Node.js 20 or newer and npm.
- Figma Desktop for the Figma adapter.
- Adobe XD and Adobe UXP Developer Tool for the XD adapter.
- An MCP client that can launch a local stdio server, such as Codex or Claude.

The XD adapter is development-plugin based. It is not distributed through the
Adobe XD Marketplace.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/MarlonJD/figma-design-mcp-plugin.git
cd figma-design-mcp-plugin
```

### 2. Install dependencies and verify the project

```bash
npm install
npm test
npm run typecheck
npm run build
```

The build output is written to `dist/` and is intentionally ignored by Git.

### 3. Start the local bridge

```bash
npm start
```

The process exposes MCP over stdin/stdout and opens the host-plugin bridge at
`ws://127.0.0.1:5514`.

To use a different local port or request timeout, set environment variables
before starting the process:

```bash
DESIGNPORT_PORT=5515 DESIGNPORT_REQUEST_TIMEOUT_MS=30000 npm start
```

The available variables are documented in [.env.example](.env.example). The
server reads them from the process environment; it does not load `.env` files
automatically.

### 4. Configure the MCP client

Build the project first, then point the MCP client at the compiled entrypoint.
Use an absolute path:

```json
{
  "mcpServers": {
    "designport": {
      "command": "node",
      "args": [
        "/absolute/path/to/figma-design-mcp-plugin/dist/src/index.js"
      ]
    }
  }
}
```

The MCP client starts one server process for its session. Start the DesignPort
process manually only when you are connecting a design plugin for a direct
development test; otherwise configure the MCP client and let it launch the
server.

### 5. Load a design host plugin

The bridge must be running before the plugin connects.

#### Figma

1. Open Figma Desktop.
2. Open **Plugins → Development → Import plugin from manifest…**.
3. Select `plugins/figma/manifest.json` from this repository.
4. Run **DesignPort Figma** from **Plugins → Development**.

The plugin uses a hidden UI iframe for the localhost WebSocket connection, so
no permanent panel is expected. Ask the MCP client to call
`design.list_hosts`; it should report a connected `figma` host.

#### Adobe XD

1. Install and open Adobe UXP Developer Tool.
2. Add the `plugins/xd` folder as a development plugin.
3. Launch Adobe XD and load the **DesignPort** command or panel.
4. Keep the DesignPort bridge running while using the panel.

XD read operations are available immediately. XD write requests are queued and
must be applied from the panel inside a user-initiated edit context.

## First useful workflow

With the bridge and one plugin connected, ask the MCP client to:

1. Call `design.get_selection_context` for the selected design.
2. Call `design.get_screen_context` for the selected screen/artboard.
3. Call `design.generate_code` with `target: "react"` or one of the native
   targets for a first-pass implementation.
4. Use the generated output as a starting point, then refine behavior and
   accessibility in application code.

The generator is deliberately a starter generator. It preserves useful layout
semantics, geometry, fills, typography, and hierarchy, but it is not a promise
of production-ready UI code. See the target-specific examples in
[EXAMPLES.md](EXAMPLES.md).

## Development

Run the TypeScript entrypoint directly during development:

```bash
npm run dev
```

Before opening a pull request, run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

The project layout is intentionally simple:

```text
src/core/       DesignIR and protocol contracts
src/bridge/     Local WebSocket host bridge
src/mcp/        MCP tool registration
src/codegen/    Web and cross-platform code generation
plugins/figma/  Figma development plugin
plugins/xd/     Adobe XD UXP development plugin
test/           Protocol, IR, bridge, and generator tests
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the protocol or adding
a host adapter.

## Security and data handling

The server listens on loopback by default and is designed for a trusted local
machine. A connected plugin can send design context to the local MCP process,
and write tools can modify the active design document. Do not bind the bridge
to a public interface without adding authentication and an explicit threat
model.

See [SECURITY.md](SECURITY.md) for reporting guidance and operational rules.

## License

Copyright (C) 2026 Burak Karahan.

DesignPort is licensed under the GNU General Public License v3.0 or any later
version. See [LICENSE](LICENSE).
