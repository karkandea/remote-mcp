# Security policy and threat model

## Supported versions

This is an alpha prototype. No production or internet-facing version is supported. Do not use it with secrets, client data, or corporate repositories.

## Reporting a vulnerability

Use GitHub's private security advisory feature after the repository is published. Do not include exploit payloads, credentials, or personal data in public issues. Until then, contact the repository owner privately using an established channel. No response SLA is promised yet.

## Trust boundaries

1. **The AI client is not trusted to grant permissions.** A human edits a local configuration to specify allowed directories and fixed commands.
2. **File data is untrusted.** Results may contain prompt injection. Consumers must never treat file contents as instructions or auto-expand scope.
3. **Remote transport is not implemented.** The stdio interface is only safe when a trusted local MCP host launches it with appropriate tool consent and OS privileges.
4. **There is no OS process sandbox.** A configured process can perform any operation permitted to the Mac user. Command profiles are owner-approved by configuration, not dynamically approved per call.
5. **Do not run as root.** Sensitive paths are denied by default but are not a replacement for operating-system permissions.

## Controls implemented

- Deny-by-default roots, writes, and terminal profiles.
- Canonical path checks; sensitive filename denial; final-component symlink rejection.
- File and output byte limits; search depth/file/result bounds.
- Exact-content and optional SHA-256 file edit conflict checks; temporary-file replacement.
- Fixed executable/arguments/cwd process profiles, no shell interpretation, timeout and cancellation, concurrency cap.
- Git operations are read-only and disable external diffs.
- Persisted local disconnect flag and redacted metadata-only audit log.
- MCP errors return bounded structured messages instead of raw stack traces.

## Gaps blocking a remote production release

- Strong race-safe filesystem containment and hostile-project execution isolation.
- Real trusted approval channel for anything beyond a narrow preapproved profile.
- Mutual authentication, device pairing, short-lived scoped credentials, token rotation, and session expiry.
- Authenticated outbound relay with replay protection, request deduplication, and per-tenant authorization.
- Sensitive file protections beyond a small name list and more comprehensive exfiltration controls.
- Comprehensive macOS launchd lifecycle, update signing, keychain handling, telemetry opt-in, threat-model review, and penetration testing.

The agent may leave personal path names in its local audit metadata; logs are owner-only files. The audit log intentionally records **only tool name/outcome/error code**, not file contents or command output. No user content is sent to any hosted backend by this prototype.

## If a secret is exposed

Stop publication and access immediately, revoke affected credentials, investigate Git history and logs, and rotate secrets. Deleting a committed file alone is insufficient.
