# DesignPort Figma plugin

This is the Figma development plugin for the local DesignPort bridge. It uses
the same `DesignIR` and WebSocket protocol as the Adobe XD adapter.

## Load it locally

1. Start the DesignPort server from the repository root:

   ```bash
   npm start
   ```

2. In Figma Desktop, open **Plugins → Development → Import plugin from
   manifest…**.
3. Select this directory's `manifest.json`.
4. Run **DesignPort Figma** from **Plugins → Development**.

The manifest allows the development-only localhost bridge. The plugin keeps
the WebSocket connection in a hidden UI iframe and performs document reads, PNG
rendering, and writes in Figma's plugin sandbox, so it does not display a
permanent panel.

## Capabilities

The plugin can report capabilities, read selections and screens, render PNG
visual context, and export the shared IR. The Figma adapter preserves the
signals an agent needs to reconstruct a responsive interface: paint stacks
and gradients, image/vector assets, typography, corner radii, effects,
constraints, auto-layout/grid metadata, absolute positioning, and prototype
links when the document exposes them. It can also create basic
screens/components, create a bounded native node tree, and apply supported
explicit-ID patches. Figma writes are applied immediately by the plugin.

`design.create_node_tree` accepts frame, text, rectangle, component, and local
component `instance` nodes with caller-local references. It supports solid
fills, essential strokes and corner radii, editable text, font-aware
typography, and horizontal/vertical Auto Layout with gap, padding, alignment,
and fixed/hug/fill sizing. Instances reference an existing local component in
the same document and may override only exposed text properties. The operation
is bounded to 256 nodes, depth 12, 20,000 characters per text node, and a 2 MB
JSON payload. Roots are created on the current page without depending on the
current selection; a failed task removes only nodes created by that task, and
instance results include their created descendant IDs.

`design.update_selection` now addresses explicit IDs present in the expected
complete snapshot scope. The public bridge session selector and the native
snapshot session are separate: callers select the connection with `sessionId`
and pass `snapshot.identity.sessionId` as `captureSessionId`. It does not
require the nodes to remain selected and supports text, typography, geometry,
solid fills, essential stroke/corner properties, and the supported Auto Layout
fields. `design.set_prototype` adds a bounded native interaction slice: it
sets or explicitly clears instant on-click navigation links and named flow
starting points. Sources must be captured; destinations must be top-level
frames on the current page, including when they are outside a source-screen
capture, and a set destination must be a different top-level frame from the
source's containing frame. Same-screen navigation self-links are rejected
before native mutation. The full batch is validated before native mutation and prior
reactions/flow starts are restored if a setter fails. Variant systems, remote
component import, and arbitrary interaction authoring remain deferred. Font
weight is set by choosing a font style because Figma exposes `fontWeight` as
read-only.

The export also includes local variables/styles as `tokens`, node style and
variable bindings, mixed text style ranges, component properties and variant
state values, accessibility/annotation metadata, and interaction details. A
request can set `maxNodes`, an opaque `cursor`, `includeAssets`, `maxAssetBytes`,
`includeTokens`, text/token/response budgets, and `detail` (`summary`,
`structure`, or `full`). The response reports `captureId`, `responseType`,
`pagination`, `exportStats`, coverage, and a complete `snapshot`. Reuse
`knownSnapshotId` to receive `responseType: "not-modified"`, or set
`changedOnly` to receive whole-node upserts and `removedNodeIds` for a safe
cache merge. Incompatible baselines require a fresh capture.

Asset data is embedded only for visible vector and image-painted nodes. If a
host export fails, the structural node remains available and the missing
asset is not replaced with a guessed shape.

For the full setup, tool list, and examples, see the repository
[README](../../README.md) and [EXAMPLES.md](../../EXAMPLES.md).
