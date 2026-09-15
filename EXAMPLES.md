# DesignPort examples

These examples assume that:

1. Dependencies are installed with `npm install`.
2. The bridge is running with `npm start`, or is being launched by the MCP
   client.
3. A Figma or Adobe XD development plugin is connected.

The snippets below show MCP tool names and JSON arguments. The exact UI for
calling a tool depends on the MCP client.

## Discover the connected host

Start with:

```json
{
  "tool": "design.list_hosts",
  "arguments": {}
}
```

If both Figma and XD are open, pass `host` explicitly in every subsequent
call. This avoids accidentally reading or changing the wrong document.

The response includes each host's session, document name, capabilities, and
supported operations.

## Read the current selection

```json
{
  "tool": "design.get_selection_context",
  "arguments": {
    "host": "figma"
  }
}
```

This returns a scoped context object containing the selected node references
and normalized nodes. It is useful when asking an agent to explain or implement
one component instead of an entire screen.

## Read a screen or artboard

Let the host choose the selected screen, or provide a screen ID returned by a
previous context/export call:

```json
{
  "tool": "design.get_screen_context",
  "arguments": {
    "host": "figma",
    "screenId": "SCREEN_ID_FROM_CONTEXT"
  }
}
```

The same call works for XD by changing `host` to `"xd"` and using an XD node
ID.

## Read the visual context

Render the same screen as PNG image content. The response includes image
content plus node metadata such as the node ID, name, bounds, and scale:

```json
{
  "tool": "design.get_visual_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT"
  }
}
```

## Read properties, visual, and code together

Use the aggregate tool when an agent needs the complete implementation
context in one MCP response. It returns the scoped `DesignIR` properties, a
PNG image block, and the generated files for the selected target:

```json
{
  "tool": "design.get_design_context",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "react",
    "includeVisual": true
  }
}
```

This is the recommended input for an LLM. The model can compare the visual
result with the hierarchy and layout metadata, then improve the generated
implementation without treating pixel coordinates as the layout model.

## Export the shared DesignIR

Export a whole document:

```json
{
  "tool": "design.export_ir",
  "arguments": {
    "host": "figma",
    "scope": "document"
  }
}
```

Export only the selection:

```json
{
  "tool": "design.export_ir",
  "arguments": {
    "host": "figma",
    "scope": "selection"
  }
}
```

Export one screen:

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

Use the returned IR when you need a stable, host-neutral snapshot for a code
review, a transformation, or another tool.

## Generate HTML

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "html"
  }
}
```

The result contains a self-contained `designport-export.html` file. It is
useful for quickly viewing the normalized geometry and hierarchy in a browser.

## Generate React

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "react"
  }
}
```

The result contains `DesignPortScreen.tsx` and `DesignPortScreen.css`. Treat
these as a first pass: wire real data, keyboard behavior, responsive rules,
and accessibility semantics in the application that consumes them.

## Generate a web export

Use the `web` target when you want a conventional browser output with a
separate stylesheet:

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "web"
  }
}
```

The result contains `index.html` and `styles.css`. The `html` target shown
above is the single-file alternative.

## Generate Vue

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "vue"
  }
}
```

The result contains `DesignPortScreen.vue`, a Vue single-file component with a
template and scoped styles.

## Generate Flutter

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "flutter"
  }
}
```

The result contains `design_port_screen.dart` with a `DesignPortApp` entry point
and a `DesignPortScreen` `StatelessWidget`. It imports only
`package:flutter/widgets.dart`, so it has no Material or Cupertino package
dependency. The output uses the SDK's style-neutral core widgets and keeps
layout semantics explicit: `Row`/`Column`/`Wrap`, `Expanded`/`Flexible`,
`SizedBox`, `Stack`, and accessible `Semantics` actions.

Auto-layout rows and columns become `Row`/`Column`; fill-sized siblings become
`Expanded`, and hug-sized siblings become `Flexible`.

## Generate SwiftUI

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "swiftui"
  }
}
```

The result contains `DesignPortScreen.swift` with a SwiftUI `View` and a
preview. It targets iOS 26+/macOS 26+ Liquid Glass APIs and keeps a material
fallback for older deployment targets. Add it to an iOS or macOS target and
replace the static placeholders with application data and behavior.

## Generate Jetpack Compose

```json
{
  "tool": "design.generate_code",
  "arguments": {
    "host": "figma",
    "scope": "screen",
    "screenId": "SCREEN_ID_FROM_CONTEXT",
    "target": "compose"
  }
}
```

The result contains `DesignPortScreen.kt` with a `@Composable` function. Add
the file to an Android Compose module with the latest stable Material 3
dependency used by this generator:

```kotlin
implementation("androidx.compose.material3:material3:1.4.0")
```

The generated theme uses Material 3 dynamic color on Android 12+ and falls
back to light/dark Material 3 schemes on older Android versions. Auto-layout
rows and columns become `Row`/`Column`; fill-sized siblings become
`weight(1f)`.

## Generate a responsive split layout

For a screen with a fixed sidebar and a fill-sized main panel, expose the
screen's layout metadata in `DesignIR` (Figma Auto Layout does this directly):

```json
{
  "layout": {
    "mode": "horizontal",
    "gap": 24,
    "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 }
  }
}
```

Mark the sidebar as `sizingHorizontal: "fixed"` and the main panel as
`sizingHorizontal: "fill"`. The same MCP call then produces CSS flex, Flutter
`Row` + `Expanded`, SwiftUI `HStack` + an infinite-width frame, and Compose
`Row` + `weight(1f)`. The agent can use the returned `DesignIR` properties to
review or refine the result instead of reverse-engineering the layout from a
screenshot.

## Create a screen

Use a scratch document while testing write operations:

```json
{
  "tool": "design.create_screen",
  "arguments": {
    "host": "figma",
    "name": "DesignPort Example",
    "width": 390,
    "height": 844,
    "background": {
      "r": 0.96,
      "g": 0.97,
      "b": 0.98,
      "a": 1
    }
  }
}
```

The same normalized request is accepted by the XD adapter where the host
supports it.

## Create a basic component

```json
{
  "tool": "design.create_component",
  "arguments": {
    "host": "figma",
    "name": "Primary Button",
    "width": 160,
    "height": 48,
    "kind": "component",
    "text": "Continue",
    "fill": {
      "r": 0.12,
      "g": 0.32,
      "b": 0.86,
      "a": 1
    }
  }
}
```

Host capability responses are authoritative. For example, XD does not claim
support for creating a new symbol definition when its runtime cannot perform
that operation.

## Update the current selection

```json
{
  "tool": "design.update_selection",
  "arguments": {
    "host": "figma",
    "patch": {
      "name": "Primary Button / Hover",
      "opacity": 0.92,
      "bounds": {
        "width": 176
      }
    }
  }
}
```

Keep write requests narrow and confirm the selected document before applying
them. Figma applies supported writes immediately. XD queues writes for the
explicit Apply action in its panel.

## Inspect events

```json
{
  "tool": "design.list_events",
  "arguments": {
    "host": "figma"
  }
}
```

Events include selection changes, document changes, and write status updates.
The bridge keeps a bounded in-memory event log; it is not a permanent audit
store.

## A practical agent prompt

After selecting a screen in Figma or XD, a useful prompt is:

> Read the current screen with DesignPort. Summarize its hierarchy, identify
> reusable components, and generate a React first pass. Do not modify the
> design file.

For an implementation pass:

> Read the selected component with DesignPort. Generate React, preserve the
> typography and spacing tokens you can infer, and list any assumptions before
> writing application code.
