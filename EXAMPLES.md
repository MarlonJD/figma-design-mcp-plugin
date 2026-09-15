# DesignPort agent-harness examples

These examples assume that the bridge is running and that a Figma or Adobe XD
development plugin is connected. DesignPort returns evidence; the agent uses
that evidence to implement the screen in the target repository.

## Discover the connected host

```json
{
  "tool": "design.list_hosts",
  "arguments": {}
}
```

If Figma and XD are open at the same time, pass `host` explicitly in every
subsequent call.

## Read one complete screen

This is the normal design-to-implementation call. It returns a scoped
`DesignIR` plus a PNG image block in one MCP response:

```json
{
  "tool": "design.get_design_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT"
  }
}
```

The text block contains `properties`, followed by one or more `image` content
blocks in the same MCP response. The properties include hierarchy, bounds and
render bounds, fills, gradients, typography and mixed text ranges, layout
metadata, tokens/style references, assets, effects, corner radii, transforms,
component properties and variant states, accessibility signals, annotations,
constraints, grid/absolute placement, and prototype links when the host
exposes them.

Use both layers in the same reasoning pass:

```text
1. Read the image to understand appearance and visual hierarchy.
2. Read properties.nodes to understand ownership and semantic structure.
3. Prefer explicit layout metadata, constraints, and child positioning over raw coordinates.
4. Reuse the destination repository's existing components and tokens.
5. Implement the smallest responsive structure that explains the evidence.
6. Render the implementation and compare it with the returned image.
7. Fix the largest visual or structural mismatch, then repeat.
```

For a large screen, request a bounded first page and continue with the returned
offset:

```json
{
  "tool": "design.get_design_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "maxNodes": 1000,
    "includeAssets": true,
    "maxAssetBytes": 2000000,
    "includeTokens": true
  }
}
```

If `properties.pagination.hasMore` is `true`, call the same tool with
`nodeOffset` set to `properties.pagination.nextOffset`. Use
`properties.exportStats` to see how many assets and tokens were actually
returned.

For a fast first pass, request only the structural evidence:

```json
{
  "tool": "design.get_design_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "detail": "structure",
    "includeAssets": false
  }
}
```

The three detail modes are `summary` (hierarchy, bounds, and layout signals),
`structure` (those signals plus component, token, accessibility, text-range,
and interaction evidence), and `full` (visual styling and embedded assets).

## Reuse a snapshot and request only changes

Save the returned `properties.snapshot.id` in the harness cache. To check the
same export without receiving all nodes again:

```json
{
  "tool": "design.export_ir",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "detail": "structure",
    "includeAssets": false,
    "knownSnapshotId": "SNAPSHOT_ID_FROM_CACHE"
  }
}
```

When the revision is unchanged, the response contains `unchanged: true` and
an empty node collection. After the design changes, use the same snapshot as a
baseline and request a delta:

```json
{
  "tool": "design.export_ir",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "detail": "structure",
    "includeAssets": false,
    "knownSnapshotId": "SNAPSHOT_ID_FROM_CACHE",
    "changedOnly": true
  }
}
```

Merge `nodes` by ID and remove any IDs in `properties.snapshot.deletedNodeIds`.
A changed-only or paginated response is marked `partial: true`; it does not
replace the complete cached context.

## Read a selection

Use a selection for a component or a small group:

```json
{
  "tool": "design.get_selection_context",
  "arguments": {
    "host": "figma"
  }
}
```

For a selection image, call:

```json
{
  "tool": "design.get_visual_context",
  "arguments": {
    "host": "figma",
    "scope": "selection"
  }
}
```

## Export only structured context

Use this when the harness wants to keep the image and properties as separate
messages or cache the normalized snapshot:

```json
{
  "tool": "design.export_ir",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT"
  }
}
```

The same operation supports `scope: "selection"` and `scope: "document"`.

## Audit and graph the design before implementation

Run a deterministic audit over a screen or document:

```json
{
  "tool": "design.audit_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "detail": "full"
  }
}
```

The result includes a summary and diagnostics for issues such as an unlabeled
interactive node, an absolute child inside a flow, or an unresolved token.
If the context is paginated, treat the audit as partial.

For a compact implementation plan, read the reusable-component and navigation
graph:

```json
{
  "tool": "design.get_graph",
  "arguments": {
    "host": "figma",
    "scope": "document",
    "detail": "structure"
  }
}
```

## Recognize semantic layout

A Figma auto-layout frame is represented explicitly rather than reduced to a
list of pixel offsets:

```json
{
  "id": "screen-1",
  "kind": "screen",
  "layout": {
    "mode": "horizontal",
    "gap": 24,
    "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 },
    "sizingHorizontal": "fixed",
    "sizingVertical": "fixed",
    "primaryAxisAlign": "min",
    "counterAxisAlign": "center",
    "wrap": "no-wrap"
  },
  "children": ["sidebar-1", "content-1"]
}
```

The agent should infer a responsive split layout from this evidence: a fixed
sidebar and a content region that fills the remaining width. A child with
`layoutPositioning: "absolute"` is an intentional overlay and should remain
positioned relative to its parent. Coordinates are still useful for checking
the result and for genuinely free-form children; they are not the primary
layout instruction when flow metadata exists.

## Use exported assets correctly

When available, an image or vector node contains an `asset` object:

```json
{
  "kind": "path",
  "asset": {
    "kind": "vector",
    "mimeType": "image/svg+xml",
    "data": "<exported asset data>"
  }
}
```

Use the exported asset itself for icons and images. Do not redraw an icon from
its bounding box or replace a photo with a colored rectangle. If an asset is
missing, keep the node's semantic role and report the limitation rather than
pretending the visual is exact.

## Visual comparison loop

A useful harness prompt after the first implementation is:

> Compare the current implementation with the DesignPort visual reference.
> Check frame size, page background, major regions, order, spacing, text
> wrapping, typography weight, asset presence, border radius, shadows, and
> bottom navigation. List the three largest mismatches, fix only those, render
> again, and repeat until the remaining differences are intentional.

The loop should preserve semantic structure. A two-column design should remain
a flex/grid or native row structure; adding dozens of absolute coordinates to
hide a mismatch makes the implementation less responsive and harder to keep
in sync.

For a repeatable local gate, save the host PNG as `reference.png`, render the
implementation at the same viewport as `properties.viewport`, and run:

```bash
npm run visual:compare -- reference.png candidate.png --regions=8x8 --json
```

The evaluator composites transparent pixels over white, checks dimensions first,
and reports `changedBounds` plus per-region similarity and changed-pixel ratios
so the agent can focus its next iteration. To inspect the mismatch visually,
also write a heatmap and overlay:

```bash
npm run visual:compare -- reference.png candidate.png \
  --heatmap-output=artifacts/diff-heatmap.png \
  --overlay-output=artifacts/diff-overlay.png
```

The default thresholds are intentionally small but not exact-pixel strict; tune
them for anti-aliasing and font-rendering differences with
`--pixel-threshold`, `--max-mae`, and `--max-changed`.

## Tokens, states, and accessibility

Use `node.styleRefs` and `properties.tokens` before inventing new colors,
spacing values, or type styles. A Figma component/instance exposes
`node.component.variantProperties`, `node.component.states`, and
`node.component.properties`; an XD symbol instance exposes its symbol identity
when XD makes it available. These fields are evidence, not generated framework
code.

Accessibility values explicitly stored by the DesignPort plugin data convention
take precedence. The supported keys are `accessibility` (JSON) or individual
`a11y.role`, `a11y.label`, `a11y.description`, `a11y.altText`,
`a11y.headingLevel`, `a11y.focusable`, and `a11y.decorative` values. Name-based
roles are marked `source: "inferred"` with a lower confidence so the agent
must review them instead of treating them as final accessibility decisions.

## Host writes

Writes are deliberately separate from reads. Create a screen in a scratch file
while testing:

```json
{
  "tool": "design.create_screen",
  "arguments": {
    "host": "figma",
    "name": "DesignPort Example",
    "width": 390,
    "height": 844,
    "background": { "r": 0.96, "g": 0.97, "b": 0.98, "a": 1 }
  }
}
```

To apply a narrow change to the current selection:

```json
{
  "tool": "design.update_selection",
  "arguments": {
    "host": "figma",
    "patch": {
      "name": "Primary Button / Hover",
      "opacity": 0.92,
      "bounds": { "width": 176 }
    }
  }
}
```

Keep write operations explicit and narrow. Figma applies supported writes
immediately; XD queues writes for the user-initiated Apply action in its panel.

## A practical agent prompt

> Read the selected screen with DesignPort. First summarize its hierarchy,
> layout model, reusable components, assets, states, and interactions. Then
> implement it in the existing project stack using current repository
> conventions. Use the DesignIR for structure and the PNG for visual truth.
> Do not modify the design file. After rendering, compare the result and fix
> the three largest mismatches.
