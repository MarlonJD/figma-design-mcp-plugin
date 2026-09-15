# DesignPort XD plugin

This is a development-only Adobe XD UXP plugin. Load the folder through the
Adobe UXP Developer Tool, then open the **DesignPort** panel in XD.

The plugin connects to `ws://127.0.0.1:5514` and registers itself as the `xd`
host. Read operations are available immediately. XD write requests are queued
and must be applied from the panel so the edit occurs inside a user-initiated
`application.editDocument()` call.

XD does not expose an API for creating a new component definition or
`SymbolInstance` directly. The adapter reports that capability as unsupported
instead of representing a plain group as a component. A future operation can
clone an existing symbol when a source node is supplied.
