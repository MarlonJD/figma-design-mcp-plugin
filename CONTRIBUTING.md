# Contributing to DesignPort

Thank you for helping improve DesignPort. The project exists to make design
context useful to coding agents without forcing designers to leave Figma or
Adobe XD. Contributions that keep that boundary clear are especially useful.

## Before you start

- Read the [README](README.md) to understand the local bridge and plugin
  lifecycle.
- Read [SECURITY.md](SECURITY.md) before reporting a security issue.
- Check existing issues and pull requests so parallel work is visible.
- Keep changes focused. A protocol change, a host adapter change, and a large
  documentation rewrite are usually easier to review as separate changes.

## Local setup

```bash
git clone https://github.com/MarlonJD/figma-design-mcp-plugin.git
cd figma-design-mcp-plugin
npm install
```

The project uses TypeScript for the bridge and plain JavaScript for the host
plugins. Build and test the bridge with npm scripts; load plugins manually in
their host applications when a change touches a plugin runtime.

## Development principles

- Keep `DesignIR` host-neutral. Figma- or XD-only fields belong in
  `hostData` or in the adapter boundary.
- Validate public protocol and IR inputs with the existing Zod schemas.
- Prefer a small end-to-end slice over an abstraction that has no working
  caller.
- Report actual host capabilities. Do not advertise a write operation that a
  host cannot perform safely.
- Keep the default bridge local to the machine. Remote transport requires an
  explicit authentication and threat-model decision.
- Keep exported output deterministic and readable enough for a human to
  inspect.
- Update documentation and examples when a public tool, protocol message, or
  setup step changes.

## Checks before a pull request

Run the applicable checks from the repository root:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

When a screenshot fixture is available, also run:

```bash
npm run visual:compare -- reference.png candidate.png
```

For plugin changes, also run the host-specific syntax checks where available:

```bash
node --check plugins/figma/code.js
node --check plugins/xd/main.js
```

Then load the plugin in a scratch document. Avoid testing write operations in
someone else's production design file.

## Adding or changing an MCP tool

1. Define or update the input schema in `src/mcp/server.ts` and reuse the
   shared IR schemas where possible.
2. Route the operation through the bridge instead of bypassing host sessions.
3. Add a focused test for validation, routing, or error behavior.
4. Implement the operation in each host plugin that genuinely supports it.
5. Update the tool table in the README and add a copyable example to
   `EXAMPLES.md`.

If a host cannot support the operation, return a truthful capability or error;
do not silently emulate a different design concept.

## Commit and pull request guidance

Use a short Conventional Commit message, for example:

```text
feat: add XD screen export
fix: reject stale bridge sessions
docs: clarify Figma plugin setup
```

A pull request should explain:

- what user problem it solves;
- which host(s) and MCP tools it affects;
- how it was tested;
- any host-version limitation or follow-up work.

Do not include credentials, private design exports, `.env` files, `dist/`, or
`node_modules/` in a change.
