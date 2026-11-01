# Security policy and threat model

## Supported versions

This is a single-owner alpha prototype. The owner has chosen to run an internet-facing, OAuth-gated relay and an optional root socket helper on a shared VPS. **This configuration is high-risk and is not a security-reviewed production service or supported multi-tenant release.** Do not use it with client data or corporate repositories without a separate security assessment.

## Reporting a vulnerability

Use GitHub's private security advisory feature after the repository is published. Do not include exploit payloads, credentials, or personal data in public issues. Until then, contact the repository owner privately using an established channel. No response SLA is promised yet.

## Trust boundaries

1. **The AI client is not trusted to grant permissions.** Normally, the owner edits a local configuration to specify allowed directories and fixed commands. The optional unrestricted modes intentionally bypass these limits after a persistent local opt-in.
2. **File data is untrusted.** Results may contain prompt injection. Consumers must never treat file contents as instructions or auto-expand scope.
3. **Remote transport is live for the owner.** An outbound Mac WebSocket connects to a loopback VPS relay behind Nginx; MCP HTTP calls require a verified OAuth access token with exact issuer, audience, expiry, owner subject and scope.
4. **There is no OS process sandbox.** A configured process can perform any operation permitted to the Mac user. Command profiles are owner-approved by configuration, not dynamically approved per call.
5. **Privileged mode is intentionally dangerous.** The default relay runs as non-root. An optional separate Linux helper runs as root and listens on a group-restricted Unix socket. Compromise of that group or the relay permits arbitrary root commands; sensitive filename filters do not constrain unrestricted executors.

## Controls implemented

- Deny-by-default roots, writes, and terminal profiles.
- Canonical path checks; mandatory sensitive filename denial even with a custom deny list; final-component symlink rejection.
- Bounded file reads even if a file grows while being read, bounded directory listing, and serialized MCP response byte cap; search depth/file/result bounds.
- Exact-content and optional SHA-256 file edit conflict checks; temporary-file replacement.
- Default command profiles use fixed executable/arguments/cwd without shell interpretation, with timeouts, cancellation and concurrency caps. Optional unrestricted tools deliberately permit arbitrary executables, including explicit shell invocations.
- Git operations are read-only and disable external diffs.
- Persisted local disconnect flag and redacted metadata-only audit log.
- MCP errors return bounded structured messages instead of raw stack traces.

## Gaps blocking a supported public or multi-tenant production release

- Strong race-safe filesystem containment and hostile-project execution isolation.
- Trusted transaction approval and defense against prompt-injection-triggered privileged calls; the owner explicitly omitted per-call approval in this alpha.
- Robust device pairing, short-lived device credentials, token rotation, session expiry, and replay protection.
- Per-tenant authorization, revocation controls, root-process containment, and complete audit of all data exfiltration paths.
- Sensitive file protections beyond a small name list and more comprehensive exfiltration controls.
- Signed updates, keychain handling, telemetry opt-in, threat-model review, penetration testing, and verified off-site backups for all affected VPS applications.

The agent may leave personal path names in its local audit metadata; logs are owner-only files. The helper logs execution IDs and outcomes, not full arguments or command output. Tool responses do traverse the remote MCP relay and ChatGPT; therefore, data from unrestricted tools may leave the device. See [Unrestricted Mode](docs/unrestricted-mode.md) for the emergency off-switch.

## If a secret is exposed

Stop publication and access immediately, revoke affected credentials, investigate Git history and logs, and rotate secrets. Deleting a committed file alone is insufficient.
