# Complete Avia screen prototype

## Outcome and authorization

The user authorized committing and pushing DesignPort, then creating all current Avia pages in Figma and connecting them into a prototype. Native authoring was committed and pushed as `3b6525d` on the existing `main` branch. Continue on that branch without branch operations.

Create an editable screen atlas covering maintained route contracts, canonical extra routes, and the major modal/state transitions required by the current workflows. Retired routes are excluded. Preserve the earlier three-screen experiment and use a separate page in the existing Figma draft. All records are synthetic. Keep product role boundaries, report approval order, CAP acceptance versus closure, and exact organization scope accurate.

## Workstreams

The existing Luna/max/priority implementation thread is the sole DesignPort source writer while active. It implements bounded native prototype authoring (and the minimal local component-instance support needed for repeated controls), tests it, and documents the public contract. It must not automate Figma, commit, push, or modify Avia. The coordinator reads Avia source, prepares a reusable screen specification outside the repository, operates the actual Figma draft, verifies output, and owns the explicitly authorized commits/pushes.

## Native authoring increment

- Add a bounded public MCP operation for click-to-navigate reactions between explicit native source/destination IDs and named flow starting points. Instant transitions are sufficient; do not add arbitrary JavaScript or broad interaction emulation.
- Preserve fresh complete capture, native capture session, document/page, source scope, and current destination identity checks. Support cross-screen links on the same page while a complete source-screen capture stays small. Destinations must exist on that same page; reject missing, wrong-type, cross-page, cross-document, and same-screen/self-link targets before mutation. Preserve or roll back existing reactions on failure.
- Support local instances in the bounded node tree if needed for reusable native controls. Reference an existing local component explicitly; never clone arbitrary external documents. Provide a narrow, validated way to set exposed instance text, keeping default control sizing intact. Report created descendant IDs if they are newly created.
- Keep capabilities truthful; unsupported XD operations must reject clearly. Do not widen localhost access or change the configured bridge port.
- Add focused public MCP/bridge/native tests, schema and failure-path coverage. Run npm tests, typecheck/build, native JS syntax checks, and diff check once the increment is complete.

### Implemented native contract

The implementation is complete locally at package/plugin version `0.6.0`.
The public operation is `design.set_prototype`. Its public selector/session
contract follows `design.update_selection`: `sessionId` selects the live bridge
connection, while the required `captureSessionId` is mapped to the native
`sessionId` field and must equal `snapshot.identity.sessionId` for the fresh
`expectedSnapshotId`.

The bounded request shape is:

```json
{
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
```

`mode: "set"` appends an instant `ON_CLICK` `NODE` action with Figma's
`setReactionsAsync`. `mode: "clear"` requires an explicit `clearScope`:
`matching` removes only matching on-click navigation actions and preserves
unrelated actions/interactions; `all` explicitly clears all reactions on that
source. Flow starting points use the native page `flowStartingPoints` values;
`mode: "clear"` removes only the named node's start entry. The response is:

```json
{
  "status": "applied",
  "affectedNodeIds": ["SOURCE_CONTROL_ID", "DESTINATION_FRAME_ID"],
  "linksSet": 1,
  "linksCleared": 1,
  "flowsSet": 1,
  "flowsCleared": 0
}
```

The complete batch is validated before mutation. Sources must be in the
complete expected capture and on the current page. Link destinations and flow
starting points must be existing top-level `FRAME` nodes in the same native
page/document; a destination may be outside a source-screen capture. For a
`mode: "set"` link, the destination must also be a different top-level frame
from the source's containing frame; same-screen navigation self-links reject
before any setter. Missing, wrong-type, cross-page, cross-document,
duplicate-flow, stale snapshot, session, document, and page mismatches reject
before mutation. Native reaction
and flow values are saved and restored when a setter fails. Figma advertises
`set_prototype` and `supports.setPrototype: true`; XD omits the operation,
reports `setPrototype: false`, and rejects a direct request with
`XD_PROTOTYPE_AUTHORING_UNSUPPORTED`.

`create_node_tree` now also supports a bounded local instance node:

```json
{
  "ref": "primary-action",
  "kind": "instance",
  "name": "Open planning",
  "componentId": "LOCAL_COMPONENT_ID_IN_THIS_DOCUMENT",
  "width": 220,
  "height": 52,
  "textOverrides": { "Label#0:0": "Open planning" }
}
```

The component must be local and in the connected document. Only up to eight
exposed `TEXT` properties can be overridden; no remote import, variant system,
arbitrary JavaScript, or arbitrary component mutation is supported. Native
editable text/auto-layout behavior is preserved. Instance results include the
created instance, its reference-map entry, and descendant IDs; task-created
nodes are removed on failure.

The native calls were checked against the current official Figma references for
[`setReactionsAsync`](https://developers.figma.com/docs/plugins/api/properties/nodes-reactions/),
[`PageNode.flowStartingPoints`](https://developers.figma.com/docs/plugins/api/properties/PageNode-flowstartingpoints/),
[`ComponentNode.createInstance`](https://developers.figma.com/docs/plugins/api/ComponentNode/),
and [exposed text component properties](https://developers.figma.com/docs/plugins/working-with-component-properties/).

### Reproducible fixture invocation

The checked-in three-screen fixture remains a structural authoring check and
is not expanded into the full Avia inventory in this repository. Its runner
starts its own bridge and waits for a Figma host; the normal ephemeral-port
path is:

```bash
npm run fixture:avia -- --port 0 --host-timeout-ms 120000
```

For the coordinator-owned native run only, after any other bridge using 5514
has stopped and the development plugin is pointed at that bridge, the exact
fixed-port invocation is:

```bash
npm run fixture:avia -- --port 5514 --host-timeout-ms 120000
```

Both paths refuse an arbitrary first host and require the exact scratch file
name `Avia · DesignPort wireframe experiment`. The runner applies screen
coordinates to each root, checks fixed card/detail heights, verifies editable
text and layout updates with fresh captures, and reports returned IDs. The
full-screen generator, prototype graph, Figma reload, screenshots, and Present
mode remain coordinator-owned and are not run by this implementation thread.

The confirmed attempt-1 fixture defects are covered by the already verified
baseline fixture changes and regression test: `authoredNodes` transfers each
declared screen `x`/`y` to its root; host selection requires the exact scratch
document name; detail and summary cards have explicit fixed vertical sizing so
copy/actions are not clipped; risk begins in an assessed elevated state;
Finance navigation is limited to its Finance Review workspace; Planning uses
`Planning draft · Awaiting submission`; and the text-update demonstration uses
natural product copy. The attempt-1 native PNG/log remain evidence of the
earlier failure only; no new real-host pass is claimed here.

## Full-screen fixture and Figma execution

- Read maintained route contracts, router extras, navigation definitions, product screen specifications, and master workflow. Record the coverage manifest with source references.
- Reuse the existing visual language, native Auto Layout, readable text, and reusable controls. Show meaningful route-specific content instead of repeating one generic card screen.
- Cover role home/list/detail/form/review/report/configuration screens; represent major CAP, Evidence, report approval, Planning return/release, checklist execution, and risk assessment states.
- Create a prototype launchpad that explains synthetic sample navigation and provides role/workflow entry points. Role handoffs in the walkthrough are explicit, not hidden product role switching. Every visible action must navigate to an appropriate state or be visibly disabled with a reason.
- Build incrementally in bounded native batches. Keep complete snapshots small by capturing the source screen, not an ever-growing document. Track every root/control ID and each expected link outside Figma.
- Verify route coverage, editable text, layout, screen bounds, all destination IDs, named starting points, and graph reachability. Export and inspect native screenshots across roles and test the core prototype flow in Figma Present mode.
- Record final counts, screenshots, limitations, local checks, and exact commit/push results. Do not claim server-backed execution: this deliverable is a Figma prototype.

## Current status

- Baseline authoring: committed and pushed, verified in actual Figma with 27 local tests.
- Native prototype increment: implemented locally in `0.6.0`; public MCP, bridge registry, Figma plugin, XD capability rejection, rollback, local instance support, and preflight same-screen self-link rejection are covered by 28 local tests.
- Current route/state inventory, native screen creation, prototype navigation, screenshot verification, and Present-mode walkthrough: verified in the actual Figma desktop host. Commit/push results are recorded in the coordinator delivery ledger.

### Local verification record

The following checks are required before handoff and are recorded here with
their results:

- `npm test` — pass, 28 tests.
- `npm run typecheck` — pass.
- `npm run build` — pass.
- `node --check plugins/figma/code.js` — pass.
- `node --check plugins/xd/main.js` — pass.
- `git diff --check` — pass.
- `npm run fixture:avia -- --port 0 --host-timeout-ms 1000` — candidate-only
  no-host path; expected to fail after the 1 second wait when no Figma plugin is
  attached, and not used as native-host evidence.

The coordinator's first full native prototype attempt created 149 frames and
local control instances, then rejected a batch because a source instance inside
its destination frame attempted a same-screen `NAVIGATE`; native rollback
succeeded and no prototype batch was recorded. This patch rejects that batch
during complete preflight, before any reaction or flow setter. No new real
Figma operation, screenshot, or Present-mode result is claimed by this thread.
The coordinator reloaded the development plugin and verified the new preflight
error against an actual nested source: the entire batch was rejected with
`PROTOTYPE_SELF_LINK` and existing reactions were unchanged.

### Completed native-host verification

The coordinator created a separate full-product prototype page in the existing
scratch file, preserving the original three-screen experiment. The coverage
manifest accounts for 77 maintained route contracts, two additional canonical
router paths, 62 workflow states, eight role indexes, and six sign-in/session/
connection states: 155 native screen frames in total. The root redirect contract
is represented by a clearly labeled prototype role explorer. Retired routes are
excluded.

The full prototype contains 9,786 native screen nodes, including 5,645 editable
text nodes and 1,701 local component instances. A local wireframe control kit
contains 426 component masters. All 1,652 native instant-click links have valid
destinations, every screen is reachable from the launchpad, and ten named
starting points are available in Figma Present mode. Current-screen navigation
items intentionally have no self-link.

All 155 screens were captured individually through DesignPort and exported as
native PNGs. Geometry checks found no node outside its 1440 × 1000 viewport or
text outside its immediate parent. Representative login, index, dashboard,
form, review, checklist, report, and configuration screens were visually
inspected. Initial transparent-container and Planning-step-label issues were
corrected and their screenshots refreshed. The original pilot's 109 nodes were
compared by ID, name, text, bounds, children, fills, and layout and were unchanged.

The Figma desktop Present walkthrough exercised 69 visible transitions,
including the complete Risk → Planning → Finance → GM → ED → inspection →
Preliminary Report → Finding → CAP → Evidence → Final Report → explicit Audit
closure path. It also exercised Finance return, expired-session recovery,
partial Evidence verification, role entry points, and return to the launchpad.
No real external message, approval, authentication, or backend mutation was
performed: these are linked synthetic sample states.

Reproducible task artifacts remain outside this public plugin repository:
`atlas-model.mjs`, `atlas-design.mjs`, `atlas-run.mjs`, `atlas-manifest.json`,
`atlas-state.json`, `atlas-verification.json`, `present-verification.json`,
`native-self-link-guard.json`, `pilot-preservation.json`, per-screen captures,
and 155 PNGs. The application inventory is not vendored into the plugin.

This is an editable designer skeleton and clickable prototype. It uses the
existing experiment's typography and product color tokens, fixed sample input
values, label-specific local control masters, and instant navigation. It does
not claim exact production typography, a published variable/variant library,
live form validation, external file upload, or server-backed workflow execution.
The temporary bridge and development plugin were stopped after verification;
the completed prototype remains open at its launchpad.
