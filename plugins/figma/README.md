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
screens/components and apply supported selection patches. Figma writes are
applied immediately by the plugin.

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
