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

The text block contains `properties`, and the response also contains one or
more `image` blocks under `visual`. The properties include hierarchy, bounds
and render bounds, fills, gradients, typography, layout metadata, assets,
effects, corner radii, constraints, grid/absolute placement, and prototype
links when the host exposes them.

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
    "counterAxisAlign": "stretch",
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
