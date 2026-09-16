# DesignPort

DesignPort is a local MCP bridge that lets coding agents understand and work
with designs in Figma and Adobe XD.

It gives an agent both the visual reference and the structured design context
needed to implement a screen. A designer can keep working in the tool they
know, while an agent can read selections and screens, render them as PNG
context, and export a host-neutral design model that it can adapt to the
application stack already present in the target repository.

DesignPort is an early, local-first project. It is intentionally small enough
to run on a designer's computer and clear enough to extend with more hosts and
agent harnesses.

## Why does this exist?

Design files contain valuable implementation decisions: hierarchy, spacing,
typography, colors, component boundaries, and screen relationships. A
screenshot alone hides those decisions; a host-specific API dump hides the
visual result. DesignPort keeps both evidence types together.

DesignPort separates the problem into three parts:

1. A Figma or XD development plugin reads and renders the open document.
2. The local bridge normalizes the document into `DesignIR`, a shared design
   representation, and carries PNG previews when requested.
3. MCP tools make properties, visual context, and carefully
   scoped design operations available to coding agents.

The result is a common path from design to implementation:

```text
Figma / Adobe XD
        |
        | host plugin over localhost WebSocket
        v
DesignPort bridge + MCP server
        |
        | DesignIR properties + visual reference
        v
Codex / Claude / another MCP client
        |
        v
The repository's own UI stack
```

The shared model is the important part. Figma-specific and XD-specific details
stay at the edge, so adding another host does not require rewriting the agent
integration.

## What it can do today

- Connect a Figma development plugin and an Adobe XD UXP development plugin.
- Read the current selection or a screen/artboard.
- Render the current selection or a screen/artboard as PNG visual context.
- Export a full document or a scoped `DesignIR` snapshot.
- Export local styles and variables as tokens and preserve node style bindings.
- Expose component properties, variants/states, text ranges, interactions,
  annotations, and accessibility signals when the host provides them.
- Paginate large documents and cap embedded asset bytes so an agent can request
  context in deliberate chunks.
- Return session/document/scope-stable capture identities and explicit `full`,
  `delta`, `not-modified`, or `resync-required` responses so an agent can cache
  evidence without treating an omission as proof of absence.
- Offer `summary`, `structure`, and `full` context detail modes for deliberate
  context budgeting.
- Return bounded asset descriptors and retrieve their original/rendered bytes
  independently with `design.get_asset`.
- Run deterministic semantic audits for layout, accessibility, interaction,
  component, and token evidence.
- Expose a component/instance and prototype-interaction graph alongside the
  node-level IR.
- Report connected hosts, capabilities, and recent host events.
- Create screens and basic components through host adapters.
- Apply a normalized patch to the current selection.
- Return properties and visual context together for agent review.
- Compare implementation screenshots with a deterministic local PNG diff.
- Keep the bridge on loopback (`127.0.0.1`) by default.

The available MCP tools are:

| Tool | Purpose |
| --- | --- |
| `design.list_hosts` | List connected Figma and XD plugins. |
| `design.list_events` | Read recent selection, document, and write events. |
| `design.get_capabilities` | Inspect what a connected host supports. |
| `design.get_selection_context` | Read the current selection as normalized nodes. |
| `design.get_screen_context` | Read one screen/artboard and its descendants. |
| `design.get_visual_context` | Render a selection or screen as PNG image content. |
| `design.export_ir` | Export document, selection, or screen context. |
| `design.get_asset` | Retrieve one bounded asset from a captured export. |
| `design.get_operation_status` | Read the status of a queued host write. |
| `design.audit_context` | Check exported context for deterministic semantic issues. |
| `design.get_graph` | Read reusable-component and prototype-interaction relationships. |
| `design.get_design_context` | Return DesignIR properties and the visual PNG together. |
| `design.create_screen` | Create an artboard/screen. |
| `design.create_component` | Create a basic component or symbol where supported. |
| `design.update_selection` | Apply a normalized patch to the current selection. |
| `design.ping` | Check that a host can receive requests. |

See [EXAMPLES.md](EXAMPLES.md) for ready-to-copy tool arguments and common
workflows, and [DESIGN_IR.md](DESIGN_IR.md) for the normalized contract and
layout interpretation guide.

### What the MCP gives the agent

`design.get_design_context` is the normal implementation entry point. Its
response contains three complementary evidence layers:

1. `properties`: the scoped `DesignIR` data — hierarchy, host-neutral node
   kinds, bounds and render bounds, fills, typography, assets, effects, corner
   radii, transforms, constraints, layout metadata, tokens, component
   properties/variants, text ranges, accessibility signals, and prototype
   links.
2. A PNG image content block: the visual truth of the selected screen or
   component.
3. `audit`: deterministic diagnostics for semantic, accessibility, interaction,
   component, and token gaps (included by default; disable with
   `includeAudit: false`).

The MCP server supplies evidence; the LLM decides component boundaries,
behavior, accessibility, and the correct primitives for the destination
stack. DesignPort intentionally does not emit framework code. This keeps
React, Vue, HTML, Flutter, SwiftUI, Compose, and future stacks under the
target repository's own conventions and current dependency versions. No
framework imports or stale UI-library choices are hidden in this project; the
agent should inspect the target repository before choosing its current web,
Flutter, SwiftUI, or Compose APIs.

### DesignIR contract

`DesignIR` is the source of truth for agent harnesses. Coordinates are retained
for visual comparison and genuinely free-form placement, while explicit
layout metadata describes the intended structure: horizontal/vertical/grid
flow, gap, padding, fixed/hug/fill sizing, alignment, wrapping, absolute
positioning, constraints, and grid placement. Tokens and style references keep
the design system visible; component properties and variant values preserve
state decisions; text ranges preserve mixed typography; and prototype links,
annotations, and accessibility fields expose behavior and implementation
signals. Figma and XD vector/image assets are carried as local data when the
host can export them, so an agent does not have to redraw icons or substitute
screenshots.

The visual PNG remains mandatory evidence. An agent should use the two layers
together: the IR explains what the design is made of, and the image verifies
what it looks like. Neither layer is treated as an instruction supplied by
the design file.

For large screens, pass `maxNodes`, `includeAssets`, `maxAssetBytes`,
`includeTokens`, `maxTextBytes`, `maxTokenRecords`, `maxResponseBytes`, and
`detail` (`summary`, `structure`, or `full`) to the context/export tools. The
response contains `pagination`, `exportStats`, a `captureId`, a `snapshot`, and
an explicit `responseType`. Continue with the returned opaque
`pagination.nextCursor`; cursors address a stored capture and never trigger an
unchanged shortcut. Omitted evidence includes a machine-readable reason.

To avoid sending a complete context on every loop, reuse the exact
`snapshot.id` with `knownSnapshotId`. An unchanged capture returns
`responseType: "not-modified"` and no nodes. After a change, set `changedOnly:
true` with the previous snapshot ID to receive whole-node upserts and
`removedNodeIds`; merge those fields into the cached complete capture. If the
baseline is unknown, evicted, incomplete, or incompatible, DesignPort returns
`responseType: "resync-required"` with an actionable `resyncReason` instead of
guessing a delta. `tokenState` distinguishes replacement, unchanged, omitted,
and failed token evidence. Snapshot identity includes the plugin session,
document, page/scope roots, selected IDs, normalization version, and evidence
shape; old v1 snapshots are not compatible.

Every write requires `expectedSnapshotId`. Selection updates also require
explicit `targetIds`, so a queued or delayed operation cannot silently apply to
a later selection. XD writes remain user-applied and expose a `pendingId` for
`design.get_operation_status`.

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

Host registration requires the pairing token in `DESIGNPORT_PAIRING_TOKEN`.
The development plugins use `designport-local-pairing` by default; if you
change the server token, update the matching plugin constant before connecting.

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

1. Call `design.get_design_context` for the selected screen/artboard.
2. Compare the returned PNG with `properties.nodes` and its layout metadata.
3. Ask the LLM to identify reusable components, responsive structure, states,
   interactions, and accessibility requirements.
4. Have the agent implement the result using the target repository's existing
   components and current framework conventions.

After the first render, run the local visual check against the same viewport:

```bash
npm run visual:compare -- reference.png candidate.png
```

The command reports similarity, mean pixel error, changed-pixel ratio, and the
smallest bounding box containing the difference. It can also emit a red
heatmap, a reference/candidate overlay, and a grid of regional metrics:

```bash
npm run visual:compare -- reference.png candidate.png \
  --regions=8x8 \
  --heatmap-output=artifacts/diff-heatmap.png \
  --overlay-output=artifacts/diff-overlay.png \
  --json
```

It returns a non-zero exit code when the configured visual thresholds fail.

Use `design.get_selection_context`, `design.get_screen_context`, and
`design.get_visual_context` separately when you want a smaller response or a
different stage of the workflow. See the agent-harness examples in
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
src/core/       DesignIR, audits, graph, and protocol contracts
src/bridge/     Local WebSocket host bridge
src/mcp/        MCP tool registration
src/eval/       Deterministic PNG visual comparison
scripts/        Local evaluation commands
plugins/figma/  Figma development plugin
plugins/xd/     Adobe XD UXP development plugin
test/           Protocol, IR, and bridge tests
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
