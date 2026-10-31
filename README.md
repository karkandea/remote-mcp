# Remote MCP (alpha)

An owner-controlled Mac MCP server for authorized file operations, read-only Git inspection, and **preconfigured** process execution. Includes an experimental self-hosted relay that accepts outbound Mac connections, without pretending that directory restrictions constitute a shell sandbox.

**Status:** MIT-licensed alpha. Local stdio MCP and a loopback-only relay have automated end-to-end tests with a real MCP client. The relay is **not deployed** on the owner's VPS; production OAuth, ChatGPT account linking, background macOS lifecycle, and SaaS are **not yet verified or shipped**.

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

`deniedNames` only adds exclusions. Sensitive names including `.ssh`, `.aws`, `.env`, `.git`, `.npmrc`, `.netrc`, and `.kube` are always denied, even if the custom list is empty. This is a defense-in-depth filter, not a guarantee against every secret or filesystem race.

```bash
node dist/cli.js start
```

`start` speaks MCP over **stdio**, so run it from an MCP host or compatible client. It does not run an HTTP server or open a public port. It must not write regular logs to stdout while serving MCP.

Local lifecycle commands:

| Command | Behavior |
| --- | --- |
| `init` | Create a private, deny-by-default config (never overwrite it) |
| `start` | Launch MCP stdio server in the foreground |
| `agent` | Connect outward to the independent VPS relay using an authenticated WebSocket |
| `relay` | Run a loopback-only MCP HTTP gateway and WebSocket broker on the VPS |
| `doctor` | Print local configuration and environment diagnostics |
| `config` | Show non-secret configuration |
| `status` | Show locally persisted connection status |
| `stop` | Persistently reject new tools; separately stop the MCP host process |
| `resume` | Locally re-enable access after a stop/disconnect |

The `stop` command does not independently kill a host-owned stdio process; the host still controls its lifecycle. `doctor` reports **localAccessEnabled**, not whether ChatGPT or a remote client is connected. The remote agent reconnects after dropped connections; a launchd service and menu-bar UI have not been implemented yet.

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

For ChatGPT remote integration, the **self-hosted** alternative is documented in [Independent VPS relay setup](docs/remote-relay.md). It uses a standard public HTTPS MCP endpoint and OAuth 2.1; neither an OpenAI Platform API key nor an OpenAI Secure MCP Tunnel is required. **Do not expose** the HTTP gateway until the authorization provider, HTTPS reverse proxy, issuer/audience validation, and device pairing have all been verified.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use synthetic temporary directories, not personal repositories. The MCP tests cover in-memory tool discovery, real disk reads, post-disconnect denial, and a separate real stdio subprocess handshake. Process tests execute a fixed Node test command.

## Docs

- [Architecture and future relay](docs/architecture.md)
- [Independent VPS relay setup (not yet deployed)](docs/remote-relay.md)
- [Security model](SECURITY.md)
- [Roadmap and acceptance criteria](docs/roadmap.md)
- [VPS-only CI policy](docs/vps-ci.md)
- [Independent VPS CI runner deployment](ci/README.md)
- [Mac verification checkpoint](docs/verification-2026-10-31.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)

## Important limitations

- The local prototype runs under the privileges of the user launching it. It is **not a filesystem or process sandbox**.
- No interactive trusted owner-approval UI exists yet; therefore, only preauthorized command profiles are exposed. High-risk arbitrary commands are not supported.
- Symlink checks and atomic file replacement reduce common errors but cannot eliminate all filesystem race conditions.
- A basic outbound relay, device shared-secret authentication, OAuth JWT validation, and request correlation now exist in code. Token rotation, owner UI, formal pairing, consent per tool, launchd, SaaS tenancy and authenticated ChatGPT production verification are still outstanding.
- GitHub Actions are prohibited for this project. An independent, rootless Podman CI worker is **active on the owner's existing shared VPS**, checking new `main` commits approximately every 10 minutes. It runs as a separate non-sudo user with CPU, memory, and process caps. Public PRs are **not** executed on the shared host; without a fine-grained status token, results are available only in private VPS logs and are not shown as GitHub commit checks.
- The new relay works in an automated loopback integration test, but has **not** been deployed to the shared VPS or linked to ChatGPT with real OAuth. macOS background-service setup and a full live ChatGPT-to-Mac demonstration remain outstanding.

Do not use this alpha on a privileged, company-managed, or production workstation.
