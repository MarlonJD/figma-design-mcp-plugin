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
- `asset` is a bounded descriptor (`artifactId`, media type, digest, size,
  source nodes, and capture ID). Retrieve its bytes with `design.get_asset`.
- `coverage`, `omissions`, `pagination`, and `exportStats` make every budget or
  host limitation observable instead of silently dropping evidence.
- `captureId` identifies the coherent observable capture. `snapshot` carries
  the complete normalized baseline identity and revisions. Incremental results
  use the discriminated `responseType`: `full`, `delta`, `not-modified`, or
  `resync-required`.

The host-specific escape hatch is `hostData`. It is for useful information that
does not yet belong in the shared vocabulary; consumers should not depend on it
when a normalized field exists.

## Bounded authoring

Figma exposes `design.create_node_tree` for a small native authoring slice:
frame, text, rectangle, and component nodes; explicit caller-local references;
current-page roots; nested parent relationships; solid fills; essential strokes
and corner radii; editable text and typography; and horizontal/vertical
Auto Layout. The operation returns every created host ID and its reference map.
It requires a complete `expectedSnapshotId`, is bounded to 256 nodes, depth 12,
20,000 characters per text node, and a 2 MB JSON payload, and cleans up only
task-created nodes if mutation fails.

`design.update_selection` is an explicit-ID update despite its historical tool
name. `targetIds` must belong to the complete expected capture scope, but the
current selection may change. Its public `sessionId` selects the bridge
connection from `design.list_hosts`; `captureSessionId` is the native session
from `snapshot.identity.sessionId` and is mapped into the native write guard.
Document/session/page scope and document revision checks remain mandatory.
Figma text updates load existing and requested fonts before changing characters
or typography. Font weight is expressed through the requested font style because
Figma exposes the numeric weight as read-only.
XD reports node-tree, typography, and Auto Layout authoring as unsupported; it
does not substitute a plain group or claim a write succeeded.

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
  "includeAssets": true,
  "maxAssetBytes": 2000000,
  "includeTokens": true,
  "detail": "full"
}
```

The response reports `pagination` and `exportStats`. A caller should continue
with the opaque `pagination.nextCursor` while `hasMore` is true. The cursor
addresses the stored capture and is independent from snapshot unchanged
checks. Asset, text, token, and response-byte omissions are explicit, so an
agent can request a bounded second pass instead of silently assuming the first
response was complete.

### Detail modes and incremental snapshots

Use `detail: "summary"` for hierarchy, bounds, and responsive layout signals;
`detail: "structure"` adds tokens/style bindings, component state, text
ranges, accessibility, and prototype links; `detail: "full"` also includes
visual styling and embedded assets. The host plugins keep snapshot IDs stable
for their current plugin session and include the export shape in the ID.

Send a previously returned `snapshot.id` as `knownSnapshotId` to ask whether
that exact baseline is still compatible. A not-modified response has no node
payload to merge. Send `changedOnly: true` with an older snapshot ID to receive
whole-node upserts and top-level `removedNodeIds`; merge those fields by ID and
retain the rest of the cached complete snapshot. Unknown, evicted, incomplete,
or incompatible baselines return `resync-required`. Host change events are
bounded invalidation hints only; both plugins rescan the requested structural
scope before computing a delta. XD also fingerprints the document at capture
time so external edits advance freshness even when no plugin write occurred.

## Semantic audit and graph

`design.audit_context` runs a deterministic check over the exported evidence.
It reports actionable diagnostics for flow/absolute conflicts, growth without a
flow parent, missing layout metadata, unlabeled interactive content, missing
visual alternatives, incomplete heading metadata, unresolved interactions,
component references, and token references. An audit over a paginated or
changed-only export is marked `partial`, so it is not a claim that the unseen
document is clean.

`design.get_graph` extracts reusable component/instance relationships,
variant/state values, screen viewports, and prototype interaction edges. It is a
compact companion to the node-level IR and is useful for building an agent's
component and navigation plan before implementation.

## Visual qualification

The host-rendered PNG is the visual reference. Render the implementation at the
same viewport, then run:

```bash
npm run visual:compare -- reference.png candidate.png --json
```

The result includes dimensions, mean absolute error, changed-pixel ratio,
similarity, `changedBounds`, and regional metrics. Use `--regions=8x8` to
partition the viewport, `--heatmap-output=...` to save a difference heatmap,
and `--overlay-output=...` to save a reference/candidate overlay. Use the
metrics to select the next fix while preserving the semantic layout model. The
evaluator is deliberately local and framework-agnostic; it does not generate
code or mutate a design document.

## Host limitations

Figma exposes the richest token and component metadata in this adapter. XD
exposes the fields available through its UXP scenegraph and rendition APIs; it
does not expose every Figma component-state or creation concept. The XD plugin
reports unsupported writes and leaves unavailable state fields absent rather
than guessing.
