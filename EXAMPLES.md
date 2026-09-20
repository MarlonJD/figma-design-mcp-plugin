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
cursor:

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
`cursor` set to `properties.pagination.nextCursor`. Use
`properties.exportStats` and `properties.omissions` to see how many assets and
tokens were actually returned and why anything was omitted.

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

When the revision is unchanged, the response contains
`responseType: "not-modified"` and an empty node collection. After the design
changes, use the same snapshot as a baseline and request a delta:

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

Merge whole-node `nodes` by ID and remove any IDs in
`properties.removedNodeIds`. If the response is `resync-required`, discard the
cached baseline and request a fresh full capture. A changed-only or paginated
response must not replace the complete cached context.

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

Writes are deliberately separate from reads. First capture a complete document
or page snapshot and retain its `snapshot.id`, `snapshot.identity.sessionId`,
`documentId`, and the bridge `sessionId` returned by `design.list_hosts`. Pass
the bridge selector and document/snapshot guards to every write; an explicit
`design.update_selection` also passes the native capture session as
`captureSessionId`. Create a screen in a scratch file while testing:

```json
{
  "tool": "design.create_screen",
  "arguments": {
    "host": "figma",
    "sessionId": "BRIDGE_SESSION_ID_FROM_design.list_hosts",
    "documentId": "DOCUMENT_ID_FROM_CAPTURE",
    "expectedSnapshotId": "SNAPSHOT_ID_FROM_CAPTURE",
    "name": "DesignPort Example",
    "width": 390,
    "height": 844,
    "background": { "r": 0.96, "g": 0.97, "b": 0.98, "a": 1 }
  }
}
```

For a nested Figma wireframe, use one bounded native node-tree operation. Local
references are caller-owned and the response returns every created host ID:

```json
{
  "tool": "design.create_node_tree",
  "arguments": {
    "host": "figma",
    "sessionId": "BRIDGE_SESSION_ID_FROM_design.list_hosts",
    "documentId": "DOCUMENT_ID_FROM_CAPTURE",
    "expectedSnapshotId": "SNAPSHOT_ID_FROM_CAPTURE",
    "nodes": [
      {
        "ref": "screen",
        "kind": "frame",
        "name": "Example screen",
        "width": 1440,
        "height": 900,
        "fill": { "r": 0.96, "g": 0.97, "b": 0.98, "a": 1 },
        "layout": {
          "mode": "vertical",
          "gap": 16,
          "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 },
          "sizingHorizontal": "fixed",
          "sizingVertical": "fixed"
        }
      },
      {
        "ref": "title",
        "parentRef": "screen",
        "kind": "text",
        "name": "Title",
        "text": "Editable title",
        "typography": { "family": "Inter", "style": "Bold", "size": 24 },
        "layout": { "sizingHorizontal": "fill", "sizingVertical": "hug" }
      }
    ]
  }
}
```

The operation is bounded to 256 nodes, depth 12, 20,000 characters per text
node, and a 2 MB JSON payload. Roots are created on the current Figma page;
children use `parentRef`. Auto-layout parents must be created before their
children logically, although the host orders valid references before
mutation. `fill` sizing is only valid for auto-layout children, and `hug` is
only valid for text or auto-layout frame/component nodes.
For native instances, sizing is inherited from the referenced component; use
fixed or fill sizing when the instance is a child of an auto-layout parent.

An existing local Figma component can be instantiated without importing or
cloning a remote document. The component ID must belong to the same document;
only exposed text property keys may be overridden. The response includes the
instance reference and its newly created descendant IDs:

```json
{
  "ref": "primary-action",
  "kind": "instance",
  "name": "Open planning",
  "componentId": "LOCAL_COMPONENT_ID",
  "width": 220,
  "height": 52,
  "textOverrides": { "Label#0:0": "Open planning" }
}
```

To apply a narrow change to explicit IDs from the captured scope:

```json
{
  "tool": "design.update_selection",
  "arguments": {
    "host": "figma",
    "sessionId": "BRIDGE_SESSION_ID_FROM_design.list_hosts",
    "captureSessionId": "SNAPSHOT.identity.sessionId",
    "documentId": "DOCUMENT_ID_FROM_CAPTURE",
    "expectedSnapshotId": "SNAPSHOT_ID_FROM_CAPTURE",
    "targetIds": ["TEXT_NODE_ID_FROM_CAPTURE"],
    "patch": {
      "text": "Updated through DesignPort",
      "typography": { "family": "Inter", "style": "Medium", "size": 17 }
    }
  }
}
```

For `design.update_selection`, these two session fields are intentionally
different: `sessionId` selects the live bridge connection returned by
`design.list_hosts`, while `captureSessionId` is the native host session stored
in the expected snapshot identity. The bridge maps the latter to the native
write guard; do not omit either identity when targeting a specific host.

The same explicit-ID operation can update supported `bounds`, solid `fills`,
`stroke`, corner properties, and Auto Layout `layout` fields. It does not
require the target to remain selected, but it rejects stale snapshots,
cross-document IDs, and targets outside the captured scope. Figma applies
supported writes immediately; XD queues supported writes for the user-initiated
Apply action in its panel and explicitly rejects node-tree, typography, and
Auto Layout authoring.

To connect screens, use `design.set_prototype` with the native capture session
from `snapshot.identity.sessionId`, not the bridge connection ID. Sources must
be in the complete expected capture. Destinations and flow starts may be
outside a source-screen capture, but they must be top-level frames on the same
Figma page and document. A set destination must also be different from the
source's containing top-level frame; same-screen navigation self-links are
rejected before mutation:

```json
{
  "tool": "design.set_prototype",
  "arguments": {
    "host": "figma",
    "sessionId": "BRIDGE_SESSION_ID_FROM_design.list_hosts",
    "captureSessionId": "SNAPSHOT.identity.sessionId",
    "documentId": "DOCUMENT_ID_FROM_CAPTURE",
    "expectedSnapshotId": "SOURCE_SCREEN_SNAPSHOT_ID",
    "links": [
      {
        "sourceNodeId": "SOURCE_CONTROL_ID",
        "destinationNodeId": "DESTINATION_FRAME_ID",
        "mode": "set",
        "trigger": "on_click",
        "transition": "instant"
      },
      {
        "sourceNodeId": "SOURCE_CONTROL_ID",
        "destinationNodeId": "OLD_DESTINATION_FRAME_ID",
        "mode": "clear",
        "clearScope": "matching"
      }
    ],
    "flowStartingPoints": [
      { "nodeId": "DESTINATION_FRAME_ID", "name": "Planning", "mode": "set" }
    ]
  }
}
```

The complete batch is validated before any reaction or flow mutation. The
result reports `affectedNodeIds`, `linksSet`, `linksCleared`, `flowsSet`, and
`flowsCleared`. `clearScope: "matching"` preserves unrelated interactions;
`clearScope: "all"` is the explicit opt-in to remove every source reaction.
Native values are restored if a setter fails.

## Reproduce the Avia wireframe fixture

The checked-in fixture creates three 1440×900 desktop screens for the fictional
Avia workflow: Department Manager risk profile, Planning draft, and Finance
budget review. It checks native parent relationships, editable text, Auto
Layout, returned IDs, and one explicit text update plus one explicit layout
update. It never uses HTML or screenshots as structural proof.

Run it with a dedicated bridge port; the runner starts its own ephemeral bridge
and waits for a Figma host rather than attaching to a coordinator-owned 5514
process:

```bash
npm run fixture:avia -- --host-timeout-ms 120000
```

Point the development plugin at the bridge URL printed by the runner before
the timeout expires. The runner prints a machine-readable JSON result after
the MCP calls complete. This static runner does not wire prototype links; use
the bounded operation above from the coordinator-owned full-screen generator.

## A practical agent prompt

> Read the selected screen with DesignPort. First summarize its hierarchy,
> layout model, reusable components, assets, states, and interactions. Then
> implement it in the existing project stack using current repository
> conventions. Use the DesignIR for structure and the PNG for visual truth.
> Do not modify the design file. After rendering, compare the result and fix
> the three largest mismatches.
