# DesignIR guide

`DesignIR` is the host-neutral evidence contract between a design application
and an agent harness. It describes what the host can prove; it does not try to
turn a design into framework code.

DesignPort deliberately stops at evidence. It has no React/Vue/HTML/Flutter/
SwiftUI/Compose code generator and therefore cannot silently select an old
framework import. The consuming agent reads the target repository's manifests,
lockfiles, and existing components before implementing the IR.

## Evidence layers

Each node can carry several independent layers:

- `bounds`, `renderBounds`, `transform`, and child order preserve geometry and
  the visual comparison anchor.
- `layout`, `constraints`, `layoutAlign`, `layoutGrow`, and
  `layoutPositioning` preserve flow intent. Prefer these fields over recreating
  a screen from dozens of absolute coordinates.
- `fills`, `strokes`, `effects`, `cornerRadii`, `typography`, and
  `textSegments` preserve visual styling, including mixed text runs.
- `tokens` and `styleRefs` preserve the design system and its bindings.
- `component.variantProperties`, `component.states`, and
  `component.properties` preserve reusable-component decisions.
- `prototypeLinks`, `annotations`, and `accessibility` preserve behavior and
  implementation signals. Inferred accessibility is explicitly marked with a
  lower confidence.
- `asset` contains a local SVG/PNG when the host can export one. A missing
  asset is represented by the node without a fabricated replacement.
- `asset.byteSize`, `pagination`, and `exportStats` make the context budget
  observable to an agent instead of hiding omitted data.

The host-specific escape hatch is `hostData`. It is for useful information that
does not yet belong in the shared vocabulary; consumers should not depend on it
when a normalized field exists.

## Layout interpretation

An agent should translate layout evidence into the target platform's semantic
primitives:

| DesignIR evidence | Typical implementation choice |
| --- | --- |
| `layout.mode: "horizontal"` | CSS flex row, Flutter `Row`, SwiftUI `HStack`, Compose `Row` |
| `layout.mode: "vertical"` | CSS flex column, Flutter `Column`, SwiftUI `VStack`, Compose `Column` |
| child `sizingHorizontal: "fill"` | flex grow / `Expanded` / `frame(maxWidth: .infinity)` |
| `layout.gap` and `padding` | native spacing and container padding |
| `layoutPositioning: "absolute"` | an intentional overlay layer |
| `constraints` | resize/anchor behavior at other viewports |
| `viewport` and `screenDetails` | responsive breakpoint evidence, not a hard-coded framework API |

The values are evidence, not a promise that every host exposes identical
layout capabilities. When flow metadata is absent, use bounds to check visual
placement and ask the agent to choose a maintainable structure.

## Large exports

All context/export tools accept:

```json
{
  "maxNodes": 1000,
  "nodeOffset": 0,
  "includeAssets": true,
  "maxAssetBytes": 2000000,
  "includeTokens": true
}
```

The response reports `pagination` and `exportStats`. A caller should continue
with `pagination.nextOffset` while `hasMore` is true. Asset and token omission
is observable, so an agent can request a second pass instead of silently
assuming the first response was complete.

## Visual qualification

The host-rendered PNG is the visual reference. Render the implementation at the
same viewport, then run:

```bash
npm run visual:compare -- reference.png candidate.png --json
```

The result includes dimensions, mean absolute error, changed-pixel ratio,
similarity, and `changedBounds`. Use the metrics to select the next fix while
preserving the semantic layout model. The evaluator is deliberately local and
framework-agnostic; it does not generate code or mutate a design document.

## Host limitations

Figma exposes the richest token and component metadata in this adapter. XD
exposes the fields available through its UXP scenegraph and rendition APIs; it
does not expose every Figma component-state or creation concept. The XD plugin
reports unsupported writes and leaves unavailable state fields absent rather
than guessing.
