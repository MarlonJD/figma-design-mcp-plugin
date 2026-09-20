# Figma wireframe authoring

## Outcome

Enable DesignPort to create an editable, structured Figma wireframe from an agent-authored screen specification. Verify the result with a small synthetic Avia workflow and real Figma screenshots. The user authorized implementation in a separate Codex thread using GPT-5.6 Luna, max reasoning, and Fast/priority processing, followed by a small experiment.

## Boundaries

- Work in `/Users/marlonjd/Developer/monorepos/designport` on its current `main` branch. Do not create or switch branches, commit, push, publish, or change Avia repositories.
- The implementation thread is the sole writer of this repository after this plan is handed over. The coordinating thread prepares the Figma scratch file and runs the real-host experiment after implementation.
- Use existing dependencies. No arbitrary JavaScript execution tool, framework-specific generator, or new compatibility layer.
- Existing read/export, snapshot freshness, explicit targets, document/session identity, localhost pairing, and response-budget guarantees must remain intact.
- Do not claim mock or unit tests establish real Figma behavior. Keep local, real-host, and untested evidence distinct.

## Current evidence

Baseline: `fa95e4a02af0d7d1d998d0f79300222de900b99d`, package version 0.4.0.

`screenSpecSchema` creates an empty frame. `componentSpecSchema` creates one component with an optional label. Neither supports nested authoring. Figma reads Auto Layout and interactions but cannot write them. `designPatchSchema` accepts text and typography while the Figma adapter rejects both. Selection-only updates cannot manage a previously generated screen by stable node IDs.

## Implementation sequence

### 1. Bounded authoring contract

- Add a small, validated node-tree creation operation for frame, text, rectangle, and component nodes with explicit parent relationships and caller-local references. Support screen roots on the current page and nested children without depending on the current selection.
- Support names, positions/dimensions, solid fills, essential stroke/corner properties, text/typography, and horizontal/vertical Auto Layout with gap, padding, alignment, and fixed/hug/fill sizing.
- Bound node count, tree depth, text length, and payload size. Reject unsupported/unknown properties and invalid parent/layout combinations before mutation where possible.
- Return every created node ID and the caller-reference-to-Figma-ID mapping. Retain complete snapshot, document, and session checks. Recover task-created nodes after a failed creation without deleting existing user nodes.

### 2. Explicit node updates

- Add or refactor the update operation to address known IDs from the captured scope, independent of subsequent selection, while rejecting stale/cross-document/out-of-scope requests.
- Implement text and essential typography updates with correct existing/new font loading before mutation.
- Implement the layout/geometry/hierarchy updates needed to revise a generated wireframe. Preserve truthful per-host capability reporting; XD must explicitly reject unsupported authoring rather than pretending it succeeded.
- Keep implementation modular. Remove superseded paths if they become obsolete; do not add aliases solely for backward compatibility.

### 3. Small Avia fixture

- Provide a checked-in, reproducible example specification and runner using the public MCP operations. Use three 1440px desktop screens: (1) Department Manager organization/activity risk profile, (2) Planning draft, and (3) Finance budget review.
- Use fictional records, English product copy, primary blue `#2f6fd6`, navy navigation `#0b1f3a`, white panels, and readable 14–16px body text. Each screen shows role, status, current owner, next action, and a short scenario note.
- The first screen explains a synthetic risk recommendation and an explicit adoption action. Adoption creates only a Planning draft. The draft has dates, resources, and estimated budget; no exact checklist selection or named inspector assignment. Finance offers Approve Budget and Return for Revision; approval advances to General Manager review, not release or execution.
- Auto Layout, editable text, and nested native nodes are mandatory. Demonstrate a text/layout update through DesignPort after creation.
- If a small bounded prototype-link operation can be completed without delaying the core, connect the three screens and a return path. Otherwise document prototype authoring as deferred. Reusable instances/variants are a later increment, not a blocker for this static-wireframe experiment.
- Include a machine-readable structural check of parents, text, Auto Layout, and created IDs. Never use an HTML screenshot or another Figma authoring connector as proof that DesignPort created the nodes.

### 4. Verification and handoff

- Add meaningful schema, adapter, and plugin-entrypoint tests for nested creation, font/text updates, fixed/hug/fill ordering, invalid input, explicit target scope, stale snapshots, and failure cleanup as applicable.
- Run `npm test`, `npm run typecheck`, `npm run build`, `node --check plugins/figma/code.js`, `node --check plugins/xd/main.js`, and `git diff --check`.
- Update README, EXAMPLES, and host documentation so sample write calls include required snapshot/identity fields and accurately describe support.
- Review the final diff and update this plan with executed checks, limitations, exact example invocation, and changed files. Leave all changes uncommitted.
- Coordinator: connect the built local MCP bridge and the updated development plugin to a dedicated Figma scratch file, create the fixture through DesignPort, verify an update and exported structure, capture and inspect actual rendered PNGs, and show the user the result and file link when available. If real-host access is blocked, state the concrete blocker and do not substitute fabricated evidence.

## Product references (read-only)

- `/Users/marlonjd/Developer/monorepos/avia/apps/surveil/AGENTS.md` (read fully before other Surveil files).
- `/Users/marlonjd/Developer/monorepos/avia/apps/surveil/docs/product-specs/workflows/MASTER_WORKFLOW.md`.
- `/Users/marlonjd/Developer/monorepos/avia/apps/surveil/docs/product-specs/ux-plan/NAVIGATION_AND_INFORMATION_ARCHITECTURE.md`.
- `/Users/marlonjd/Developer/monorepos/avia/apps/surveil/docs/designs/next/department-manager/README.md` (dated visual reference only; current workflow wins).

## Progress and evidence

- Implementation is complete in the local worktree at package version `0.5.0`.
  Changes are intentionally uncommitted on the existing `main` branch.
- The coordinator subsequently verified the actual Figma experiment and all
  three rendered screenshots; see the real-host evidence below.
- Figma now exposes a bounded `create_node_tree` operation for frame, text,
  rectangle, and component nodes. The operation validates explicit references,
  parent relationships, bounds, styling, typography, Auto Layout, payload
  size, node count, root count, and depth before mutation. It returns all
  created IDs and a caller-reference map and removes only task-created nodes
  if creation fails.
- Figma explicit updates now target IDs from the complete expected snapshot
  scope rather than the live selection. They preserve document/session/page
  scope and document-revision checks, load existing and requested fonts before
  text mutation, and cover the bounded text, geometry, hierarchy, paint,
  corner, and Auto Layout patch fields.
- XD advertises `createNodeTree: false`, omits the operation from its
  capability list, and returns `XD_NODE_TREE_AUTHORING_UNSUPPORTED` for a raw
  request. Its supported queued writes remain explicit-ID updates.
- `examples/avia-wireframe/spec.json` contains three 1440×900 screens and
  109 native nodes, including 65 text nodes and nested Auto Layout. The public
  MCP runner checks returned IDs, parent/child links, text, Auto Layout,
  declared root coordinates, fixed card heights, viewport dimensions, and
  explicit text/layout updates.

### Exact local verification

The following checks were run against the final uncommitted worktree:

| Check | Evidence |
| --- | --- |
| `npm test` | verified locally — 27 passed, 0 failed |
| `npm run typecheck` | verified locally — passed |
| `npm run build` | verified locally — passed |
| `node --check plugins/figma/code.js` | verified locally — passed |
| `node --check plugins/xd/main.js` | verified locally — passed |
| `node --check examples/avia-wireframe/run.mjs` | verified locally — passed |
| `git diff --check` | verified locally — passed |
| `Avia fixture declaration test` | verified locally within `npm test` — 3 screens, 109 nodes, 65 text nodes, one root per screen; declared screen positions, fixed card heights, assessed risk state, Planning wording, and Finance-only navigation checked |
| `npm run fixture:avia -- --host-timeout-ms 1000` | candidate-only — started an ephemeral bridge, waited for a Figma host, and exited with the expected no-host message; no host was connected |

### Fixture invocation and handoff

The coordinator can run the complete real-host experiment with:

```bash
npm run fixture:avia -- --host-timeout-ms 120000
```

The script builds the bridge, binds an ephemeral port by default (`--port 0` is
the runner fallback), prints the WebSocket URL, waits for a Figma host, and
then uses the public MCP tools `design.export_ir`, `design.create_node_tree`,
and `design.update_selection`. It never falls back to coordinator-owned port
`5514`. The coordinator can use the existing allowed port after stopping its
temporary bridge with:

```bash
npm run fixture:avia -- --port 5514 --host-timeout-ms 120000
```

The default no-host path remains:

```bash
npm run fixture:avia -- --host-timeout-ms 1000
```

For either invocation, the coordinator must connect/reload the development
plugin's hidden UI connection to the runner's bridge before the timeout. The
ordinary development plugin default remains `ws://localhost:5514`. The public
update maps the bridge `sessionId` from `design.list_hosts` separately from the
native `captureSessionId` in `snapshot.identity.sessionId`.

The implementation worker's local checks do not establish real-host rendering.
The coordinator's separate successful run and PNG inspection are recorded below.

### Remaining limits

- Figma authoring is deliberately bounded to native frame, text, rectangle,
  and component nodes, solid fills, essential strokes/corners, editable text,
  font family/style typography, and horizontal/vertical Auto Layout.
- Figma numeric font weight is not accepted; callers choose the Figma font
  style. Prototype-link authoring and reusable component instances/variants
  remain deferred.
- XD does not author the node tree or typography/Auto Layout/reparent/stroke/
  corner fields; it rejects those requests explicitly.
- Production readiness and a published plugin release are not verified.

### Coordinator attempt-1 findings incorporated

The supplied coordinator artifacts were reviewed before this update:

- `/Users/marlonjd/Documents/Codex/2026-09-20/designport-wireframe-authoring/outputs/real-host-attempt-1.log` records `WRITE_SESSION_MISMATCH` on the
  first public `design.update_selection` call.
- `/Users/marlonjd/Documents/Codex/2026-09-20/designport-wireframe-authoring/outputs/attempt-1-document.json` records the prior 111-node/67-text export;
  roots `1:2`, `1:39`, and `1:75` all had absolute bounds at `(0, 0)`, and
  summary/detail child cards had default 100px heights.
- `/Users/marlonjd/Documents/Codex/2026-09-20/designport-wireframe-authoring/outputs/attempt-1-risk-visual-1.png` visibly confirms clipped detail-card
  copy and controls.

The fixes are now local and uncommitted: public MCP `sessionId` remains the
bridge connection selector while required `captureSessionId` maps the native
snapshot session into the existing plugin guard; the fixture refuses any Figma
document whose name is not exactly `Avia · DesignPort wireframe experiment`;
root `x`/`y` values are applied from each screen; summary/detail cards use
explicit 148px/360px heights and action frames use native hug sizing; and the
fixture copy/navigation/status semantics were corrected. The coordinator's
subsequent rerun is recorded below.

### Coordinator real-host verification — passed

On 2026-09-20, the coordinator reloaded the development plugin from this checkout
and ran `node examples/avia-wireframe/run.mjs --port 5514 --host-timeout-ms 120000`
against the dedicated [Figma draft](https://www.figma.com/design/pMOt4Iqb5ZPg7tPdqQ4bIN).
The runner exited successfully after creating three editable 1440×900 native
screens, 109 nodes, and 65 text nodes, then updating text and Auto Layout through
the public MCP operations. The first attempt's session mismatch was absent.

Root IDs are `1:113` (risk profile), `1:150` (Planning), and `1:186` (Finance).
Their x coordinates are 0, 1480, and 2960. A separate inspection of exported
native geometry found no overlapping screens or descendants clipped by their
ancestors. All 262 declared layout mode/sizing properties matched native export.
All three actual PNG exports were visually inspected and their copy and action
buttons were visible. PNG previews are 1024×640; the editable frames are 1440×900.

Evidence is under `/Users/marlonjd/Documents/Codex/2026-09-20/designport-wireframe-authoring/outputs/`:

- `real-host-attempt-2.json`: successful native creation and both updates.
- `final-document.json` and `final-native-geometry.json`: exported structure and independent geometry check.
- `final-risk-1.png`, `final-planning-1.png`, and `final-finance-1.png`: actual native Figma PNGs.
- `revision-result.md`: delegated implementation's final 27-test verification.

The coordinator stopped the development plugin and temporary bridge after
verification. The saved Figma draft remains open for the user. Prototype links,
instances, and variants remain deferred; this proves an editable static
wireframe workflow, not a complete interactive product prototype.

### Changed files

- Core contract and routing: `src/core/ir.ts`, `src/core/operations.ts`,
  `src/core/adapter.ts`, `src/mcp/server.ts`, `src/index.ts`,
  `package.json`, `package-lock.json`.
- Native adapters and capability docs: `plugins/figma/code.js`,
  `plugins/figma/README.md`, `plugins/xd/main.js`,
  `plugins/xd/manifest.json`, `plugins/xd/README.md`.
- Fixture: `examples/avia-wireframe/spec.json`,
  `examples/avia-wireframe/run.mjs`.
- Tests: `test/authoring.test.ts`, `test/mcp.test.ts`,
  `test/plugin-entrypoints.test.ts`, `test/bridge.test.ts`.
- Repository docs and this handoff: `README.md`, `EXAMPLES.md`,
  `DESIGN_IR.md`, `SECURITY.md`, and this plan.

### Native API references consulted

The implementation was checked against the current official Figma Plugin API
documentation for [font loading](https://developers.figma.com/docs/plugins/api/properties/figma-loadfontasync/),
[text nodes](https://developers.figma.com/docs/plugins/api/TextNode/),
[layout mode](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutmode/),
[horizontal sizing](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutsizinghorizontal/),
[vertical sizing](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutsizingvertical/),
[axis alignment](https://developers.figma.com/docs/plugins/api/properties/nodes-primaryaxisalignitems/),
[frame creation](https://developers.figma.com/docs/plugins/api/properties/figma-createframe/),
and [child insertion](https://developers.figma.com/docs/plugins/api/properties/nodes-appendchild/).
