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

XD does not expose an API for creating a new component definition or
`SymbolInstance` directly. The adapter reports that capability as unsupported
instead of pretending that a plain group is a component.

For the full setup, tool list, and examples, see the repository
[README](../../README.md) and [EXAMPLES.md](../../EXAMPLES.md).
