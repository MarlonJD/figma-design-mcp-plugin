# DesignPort Figma plugin

Create a Figma development plugin first so Figma assigns a plugin ID, replace
the `id` value in `manifest.json`, and then import the manifest after starting
the DesignPort server. The plugin uses a hidden UI iframe for the localhost
WebSocket connection and runs document operations in Figma's plugin sandbox.

The manifest puts the local bridge in Figma's development-only
`devAllowedDomains` list and connects through `ws://localhost:5514`.

This plugin uses the same protocol and `DesignIR` shape as the Adobe XD
adapter. Figma writes are applied immediately while XD writes are queued for
an explicit Apply action in the XD panel.
