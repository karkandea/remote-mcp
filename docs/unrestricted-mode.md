# Remote MCP Arkan — Unrestricted Mode (draft; NOT enabled in production)

This is a **single-owner, high-risk** option, not a sandbox. The default remains disabled. It does **not** use SSH, per-command SSH 2FA, or a server-side approval prompt. ChatGPT or another MCP host may independently require a confirmation for dangerous tools; the relay cannot disable host-level UI.

## Mac: same privileges as the signed-in Mac user

1. On the Mac, back up `~/.config/remote-mcp/config.json`.
2. Add `"fullUserMode": { "enabled": true }` to that JSON; keep all existing settings.
3. Restart the Mac `remote-mcp agent` service to reload the local configuration.
4. After OAuth authentication at the VPS relay, `mac_user_exec` accepts an `argv` array, absolute `cwd`, and `timeoutMs`; use existing `terminal_poll`/`terminal_cancel` for results.

Any executable accessible to the Mac user can be launched, including `/bin/zsh` with `-c` if the owner explicitly chooses. File roots and command profiles do **not** constrain this new tool. `sudo` is **not** silently granted: the process runs with the Mac user's actual UID and OS/TCC privileges. macOS permissions such as Accessibility, Full Disk Access, or app automation may still require local consent.

## VPS: dedicated root executor over a local Unix socket

This option is **not installed or activated by this draft**. The existing `remote-mcp-relay` unit remains non-root, on loopback, behind Nginx and OAuth. A separate root process exposes **only** `/run/remote-mcp-root/exec.sock` to the trusted `remote-mcp` group, not an internet port. Anyone who controls the relay process or socket-authorized group can ask it to execute **any** command as root. This is not privilege isolation against compromise of the relay; it only avoids running the public-facing HTTP process directly as root.

After a staging test and a verified backup/rollback plan, an administrator can install `deploy/systemd/remote-mcp-root-helper.service` into `/etc/systemd/system/`. The unit starts `/usr/bin/node /opt/remote-mcp/dist/cli.js root-helper`, uses systemd's root-owned runtime directory, and requires that `remote-mcp` be the service group. To wire the non-root relay, set the exact opt-in environment variable `RELAY_ROOT_HELPER_SOCKET=/run/remote-mcp-root/exec.sock` in `/etc/remote-mcp/relay.env` and restart the relay. Without the variable, **all** `vps_root_*` tools fail closed. The socket helper itself also checks that it runs as UID 0.

`vps_root_exec` executes an argument array as UID 0 with `shell: false`; the caller can explicitly invoke a shell via `['/bin/sh','-c','...']`. Use `vps_root_poll` and `vps_root_cancel` to manage jobs. Jobs have a maximum 5-minute runtime, two concurrent commands and 64 KiB combined output; these are operational bounds, **not permission restrictions**. The Unix socket never accepts external network connections. The helper logs metadata to journald (start/exit/cancel and random execution ID) without command arguments or output.

## Minimum safety gate before any production activation

- Verify a restorable off-VPS backup of files, app secrets, databases, and critical config; record a rollback to the existing non-root relay service.
- Test the helper on staging with a fake, non-privileged command, test denial when the socket is absent, and test that OAuth rejects non-owner tokens on every MCP call.
- Restrict `remote-mcp` group membership to the relay account and verify socket mode `0660`, root-owned parent `0750`, and no external listener.
- Rotate the Auth0 client, relay device token, SSH credentials, and any root-reachable service secrets following suspected compromise.
- Keep audit logs and watch for unusual starts; host shutdown is only a *future-access* kill switch. Previously copied credentials, databases, or private files cannot be recovered by stopping the server.

**Severe residual risk:** Prompts, third-party tool output, compromised ChatGPT tokens, a compromised relay, malicious repo content, or an unexpected tool call could cause a root command that destroys/steals VPS data or replaces system services. An owner-only OAuth check is not a guarantee against prompt injection or stolen sessions. Because this VPS hosts other apps, a root compromise affects them too. If these risks are unacceptable, do not enable this mode.

This draft changes no deployed service, no Nginx config, and no GitHub Actions. Promotion to the shared VPS must separately verify staging tests, backups, and rollback.
