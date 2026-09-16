# Security policy

DesignPort is a local development tool. It connects design applications to an
MCP process on the same machine, so its security model depends on the local
machine and the MCP clients that are allowed to launch it.

## Security boundaries

- The bridge listens on `127.0.0.1` by default.
- Host plugins must complete a protocol-v2 pairing-token handshake before the
  bridge registers a session. Set `DESIGNPORT_PAIRING_TOKEN` to a local secret
  and update the development plugin constant when using a non-default token.
- MCP transport is local stdio; the bridge remains loopback-only and does not
  provide remote or cloud transport.
- A connected plugin can send selected or document design context to the
  local bridge.
- `design.create_screen`, `design.create_component`, and
  `design.update_selection` can change an active design document when the host
  supports the operation.
- The event log is in memory, bounded, and metadata-only; it is not a
  compliance or audit system.

Do not bind DesignPort to `0.0.0.0`, a LAN address, or a public interface until
the transport has authentication, authorization, and a documented threat
model. Treat an MCP client configured to launch DesignPort as trusted code.

## Supported code

Before the first stable release, the latest `main` branch is the actively
maintained development line. The project does not promise a release SLA yet.

## Reporting a vulnerability

Please use [GitHub Security Advisories](https://github.com/MarlonJD/figma-design-mcp-plugin/security/advisories/new)
for a private report when the repository enables that feature. Include:

- a concise description of the issue;
- the affected commit, version, or plugin;
- reproducible steps or a minimal proof of concept;
- the impact and any suggested mitigation.

Do not include credentials, private design files, personal data, or a complete
exploit in a public issue. If private reporting is unavailable, open a public
issue with only the words “private security contact requested” and wait for a
maintainer response before sharing details.

## Operational guidance

- Keep the bridge on loopback.
- Use a scratch design file when testing write tools.
- Do not commit `.env` files, tokens, exported private designs, or local logs.
- Review dependency changes and run `npm audit` before releasing a package or
  distributing a plugin bundle.
- Keep Figma and Adobe XD updated according to your organization's patching
  policy.
