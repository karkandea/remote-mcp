# Remote MCP (alpha)

An owner-controlled, local MCP server for authorized file operations, read-only Git inspection, and **preconfigured** process execution. Designed for an Apple Silicon Mac and a later secure relay, without pretending that directory restrictions constitute a shell sandbox.

**Status:** pre-release local prototype under the MIT License. MCP tool calls have been tested with a real MCP client in an isolated test directory. ChatGPT remote access, macOS lifecycle, and SaaS are **not yet verified or shipped**.

## Quick start (macOS, Node.js 22+)

```bash
git clone https://github.com/karkandea/remote-mcp.git
cd remote-mcp
npm ci
npm run check
npm run build
node dist/cli.js init
node dist/cli.js doctor
```

Public source: [karkandea/remote-mcp](https://github.com/karkandea/remote-mcp). When using a local source archive, extract it and start at `npm ci`.

Edit `~/.config/remote-mcp/config.json` with a small test directory first. See [`config.example.json`](config.example.json). The default configuration authorizes **no directory**, **no writes**, and **no commands**.

```bash
node dist/cli.js start
```

`start` speaks MCP over **stdio**, so run it from an MCP host or compatible client. It does not run an HTTP server or open a public port. It must not write regular logs to stdout while serving MCP.

Local lifecycle commands:

| Command | Behavior |
| --- | --- |
| `init` | Create a private, deny-by-default config (never overwrite it) |
| `start` | Launch MCP stdio server in the foreground |
| `doctor` | Print local configuration and environment diagnostics |
| `config` | Show non-secret configuration |
| `status` | Show locally persisted connection status |
| `stop` | Persistently reject new tools; separately stop the MCP host process |
| `resume` | Locally re-enable access after a stop/disconnect |

The `stop` command does not independently kill a host-owned stdio process; the host still controls its lifecycle. `doctor` reports **localAccessEnabled**, not whether ChatGPT or a remote client is connected. A launchd service, menu-bar UI, and automatic reconnection have not been implemented yet.

## Capabilities

| Tools | Permission |
| --- | --- |
| `fs_list`, `fs_stat`, `fs_read`, `fs_search` | Approved roots, restricted names, size/depth caps |
| `fs_apply_patch` | Explicit `allowWrites: true`; single expected occurrence, optional SHA-256 check |
| `git_status`, `git_diff`, `git_log` | Read-only operations in approved repositories |
| `terminal_start`, `terminal_poll`, `terminal_cancel` | Only exact owner-configured command profiles; no arbitrary shell strings |
| `device_info`, `device_status`, `device_disconnect` | Local status, persisted disconnect marker |

The terminal tool takes a **profile name**, not a shell script. For example, the `sample-tests` profile in the configuration invokes exactly `/usr/bin/true` in the sample directory. To allow project tests, a user must consciously add a command profile with an executable, fixed arguments, and an authorized working directory. Those commands are still capable of reading or writing outside approved roots when the operating system permits it. Never configure a broad shell profile, unreviewed scripts, or production credentials.

## Connect with MCP clients

For local clients that support stdio servers, point the client to the absolute Node executable and the absolute path to `dist/cli.js` with argument `start` (or use a client configuration that invokes `node` via `PATH`). Set the child's current account to the **non-root** Mac user who owns the config. The client must not be configured to auto-approve dangerous tools.

Remote ChatGPT integration is a separate milestone: evaluate [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) only where the owner's workspace and Platform organization have the required permissions. Do not expose a raw stdio-to-HTTP proxy or a terminal endpoint to the internet without authentication and authorization.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use synthetic temporary directories, not personal repositories. The MCP tests cover in-memory tool discovery, real disk reads, post-disconnect denial, and a separate real stdio subprocess handshake. Process tests execute a fixed Node test command.

## Docs

- [Architecture and future relay](docs/architecture.md)
- [Security model](SECURITY.md)
- [Roadmap and acceptance criteria](docs/roadmap.md)
- [VPS-only CI policy](docs/vps-ci.md)
- [Mac verification checkpoint](docs/verification-2026-10-31.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)

## Important limitations

- The local prototype runs under the privileges of the user launching it. It is **not a filesystem or process sandbox**.
- No interactive trusted owner-approval UI exists yet; therefore, only preauthorized command profiles are exposed. High-risk arbitrary commands are not supported.
- Symlink checks and atomic file replacement reduce common errors but cannot eliminate all filesystem race conditions.
- No remote authentication, device pairing, outbound relay, token storage, launchd integration, or SaaS tenancy exists in this release.
- GitHub Actions are prohibited for this project. Build/test/audit uses the `scripts/ci.sh` entry point on an isolated VPS worker; automated webhook CI is not implemented yet.
- macOS installation and full ChatGPT-to-Mac end-to-end demonstration remain outstanding.

Do not use this alpha on a privileged, company-managed, or production workstation.
