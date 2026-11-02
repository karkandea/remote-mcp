# MCP Arkan operational hardening (review-only, not deployed)

This change adds two independent operational safeguards without changing the active MCP tool list, enabling GitHub Actions, or installing anything onto the live host.

## 1. Pinned release-manifest gate

Release only from a **reviewed, clean, pinned commit**, including the completed-job eviction fix from PR #24. The repository currently has stacked Draft PRs: #23 (relay) and #24 (root-helper retention). This change should be reviewed on top of #24; do not merge a branch into `main` or overwrite the VPS release without resolving the dependency and threat review.

1. In a disposable checkout of the pinned commit, run `npm ci --ignore-scripts`, `npm run check`, and any required security checks. No GitHub Actions; the shared VPS CI remains restricted to trusted `main`.
2. Build the source into a staging release directory **away from `/opt/remote-mcp`**. The staging directory must contain `dist/` from that build and the intended deployment files, never private relay environment files.
3. Use the exact reviewed 40-character Git commit SHA:

   ```bash
   node scripts/release-manifest.mjs create /ABSOLUTE/STAGED/RELEASE 0123456789abcdef0123456789abcdef01234567
   node scripts/release-manifest.mjs verify /ABSOLUTE/STAGED/RELEASE 0123456789abcdef0123456789abcdef01234567
   ```

4. The gate rejects a release with missing/extra/symlinked compiled artifacts, a mismatch against the complete SHA-256 inventory, an unexpected commit or a root helper lacking the #24 retention behavior. Keep the `release-manifest.json` alongside the release for post-install verification, and compare it again before starting services.
5. Before activation, independently verify an **off-host, restorable** backup, current versions, disk headroom, authorized service units, and a rollback path. Build, test, and deploy all applicable relay/root-helper modules from a single compatible commit. Preserve the previously working release; do not mix modules from unrelated commits.
6. Only after a separate deployment approval: activate the vetted release with a targeted service restart, confirm `/healthz`, OAuth 401 for unauthenticated MCP calls, root status/harmless exec/poll, and baseline responses of neighboring applications. Roll back only affected MCP services if these checks fail.

The manifest is an **integrity and operator error gate**, not a signature or proof that the compiler was trustworthy. It never restarts services or modifies `/opt` itself. A compromised operator can generate a new manifest, so review and commit provenance remain necessary.

## 2. On-demand errors and optional local diagnostic history

When an agent calls a root or Mac tool and it fails, MCP returns a bounded structured error containing `code`, `message`, and `nextStep`. Recognized conditions include `ROOT_HISTORY_FULL`, `ROOT_BUSY`, `ROOT_SOCKET_UNAVAILABLE`, `ROOT_EXECUTION_EXPIRED`, `ROOT_RESPONSE_TIMEOUT`, `MAC_OFFLINE`, `MAC_RESPONSE_TIMEOUT`, and `RELAY_BUSY`. The advice discourages blind retries of privileged or non-idempotent actions. Unknown internal errors are redacted; their stack traces, arguments and secret paths are not returned.

If the **entire relay service** is unreachable, MCP cannot return a structured tool result; the host/client reports a connection failure. Check the targeted service using an independent SSH or console path in that case.

### ChatGPT host-level refusals are separate from MCP failures

ChatGPT may require confirmation for a tool action or block a particularly risky action before the request reaches MCP, even if the Mac/VPS has enabled the executor. This is a **host decision**, not a VPS firewall or Unix-socket failure. No MCP or VPS setting can override it. See [OpenAI's custom MCP connection guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

Use genuinely narrower tools when they fit the task: `vps_root_status`, `vps_storage_audit`, `system_status`, `fs_read`, `process_info`, or an explicitly approved `terminal_start` profile. Arbitrary `vps_root_exec` and `mac_user_exec` remain honestly marked high risk. If a particular action is denied by ChatGPT, stop and request an authorized alternative or user guidance; never relabel, split, or disguise that same action to bypass the denial.

An MCP tool cannot report its own structured error if ChatGPT blocks invocation *before* it reaches the server. The host's refusal is the diagnostic in that case.

The optional `ops/watchdog.mjs` is an independent read-only local diagnostic probe. It produces JSON records in journald on a five-minute systemd timer if installed. It **does not notify Arkan** and has no webhook or Telegram integration. The history may help diagnose an issue after an agent reports failure.

The probe uses Node built-ins and does not depend on the relay process being healthy. It checks:

- Local `http://127.0.0.1:3417/healthz` (now includes `agentConnected`); the Nginx vhost must continue blocking public access to this local route.
- Root helper's **read-only** Unix-socket `status` operation, but only if explicitly configured.
- Root filesystem usage via `statfs('/')`. Warning at 85%, critical at 90% **or under 2 GiB free**. No deletion or cleanup.
- Optionally, public HTTPS OAuth resource discovery to detect Nginx/DNS/TLS outage.
- Optionally, Mac agent availability. Off by default because a laptop may intentionally sleep or be powered off.

It records bounded JSON status metadata locally without command arguments, OAuth tokens or file contents. It **never** executes root commands, restarts services, sends external notifications or deletes data. systemd's existing relay/helper restart policies remain the first crash-recovery mechanism.

### Review-only configuration example

Place the following settings in a new root-owned, mode-0600 `/etc/remote-mcp/watchdog.env` **only when deployment is approved**:

```ini
MCP_WATCHDOG_ROOT_SOCKET=/run/remote-mcp-root/exec.sock
MCP_WATCHDOG_PUBLIC_URL=https://mcp.dualangka.com/.well-known/oauth-protected-resource
MCP_WATCHDOG_DISK_WARN_PERCENT=85
MCP_WATCHDOG_DISK_CRITICAL_PERCENT=90
MCP_WATCHDOG_EXPECT_MAC=0
```

### Activation gates (do not execute until separately approved)

1. Build and stage the reviewed release and manifest. Confirm that the existing relay health route is still inaccessible publicly, and privately check local `/healthz` shape.
2. Ensure the `remote-mcp` service account has only its intended access to the root-helper socket; never grant additional sudo or root privileges.
3. Install `deploy/systemd/remote-mcp-watchdog.service` and `.timer` as root-owned units; install the new script from the same verified commit. Do not change existing relay or root-helper units.
4. Run a single read-only diagnostic one-shot, inspect `journalctl -u remote-mcp-watchdog.service`, then enable **only** its timer if local history is desired. Confirm the 85% disk warning remains local to journald.
5. Test relay-offline and Mac-offline scenarios on staging; inspect `systemctl list-timers`, and document operator disable/rollback commands for the watchdog timer.

### Known limits

- A local watchdog cannot report the **entire VPS or network being down** to an agent while the server is unreachable. There are deliberately no push notifications; the owner learns about failures when an agent invokes a tool or investigates separately.
- An active helper socket does not guarantee arbitrary root commands will succeed. The historical 100-job lockout is guarded by the release manifest, test suite, and live status probe; a separate synthetic root exec/poll smoke test remains part of each deployment acceptance check.
- This watchdog intentionally does **not** clean a crowded production disk, expose credentials, auto-restart the helper with active jobs, or alter business applications.
