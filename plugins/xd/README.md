# DesignPort Adobe XD plugin

This is a development-only Adobe XD UXP plugin for the local DesignPort
bridge. Load it through Adobe UXP Developer Tool; it is not a Marketplace
plugin.

## Load it locally

1. Start the DesignPort server from the repository root:

   ```bash
   npm start
   ```

2. Open Adobe UXP Developer Tool and add this `plugins/xd` folder.
3. Launch Adobe XD and load the **DesignPort** command or panel.

The plugin connects to `ws://127.0.0.1:5514` and registers as the `xd` host.
Read operations, including PNG visual rendering through XD renditions, are
available immediately. XD write requests are queued and must be applied from
the panel inside a user-initiated `application.editDocument()` call.

The read adapter preserves XD's available evidence: layout and render bounds,
transforms, fills/gradients/image fills, strokes, shadows/blur, corner radii,
text style ranges, responsive-resize/stack layout metadata, constraints,
symbol identity, prototype interactions, annotations, and accessibility
signals. It supports the same node/asset pagination controls as Figma. XD
tokens can be supplied through the root node's `designport/tokens` plugin data
as a JSON array when a project has a token source outside XD. If a project
stores portable style identifiers or variable aliases in XD plugin data,
`styleRefs` and `variableBindings` are preserved as well.

XD does not expose an API for creating a new component definition or
`SymbolInstance` directly. The adapter reports that capability as unsupported
instead of pretending that a plain group is a component.

XD does not expose every Figma component-state concept through its public UXP
surface. Unsupported component creation and unavailable state data are
reported as limitations; the adapter never substitutes a plain group or
guesses a missing state. XD's public interaction API also does not expose every
interaction category, including hover and component-state transitions; those
are reported only when the host provides them.

For the full setup, tool list, and examples, see the repository
[README](../../README.md) and [EXAMPLES.md](../../EXAMPLES.md).
