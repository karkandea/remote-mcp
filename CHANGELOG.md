# Changelog

## Unreleased — 0.1.0-alpha.1

- Add a review-only, read-only VPS watchdog with root-helper/socket, relay, Mac-availability, public endpoint and disk checks; deduplicate optional HTTPS webhook alerts.
- Add an immutable-commit release manifest tool that verifies every compiled artifact and refuses the pre-#24 root-helper build.
- Add independent systemd watchdog unit/timer templates and staging/recovery runbook. Neither is deployed or enabled by this source change.

- Initial local TypeScript MCP stdio prototype using SDK v2.
- Bounded filesystem read, list, stat, search, and guarded text patch.
- Read-only Git inspection and fixed command-profile execution.
- Persisted disconnect, local CLI, audit metadata, test suite, security documentation.
- VPS-only CI script and policy; GitHub Actions explicitly prohibited.
- Cross-platform Node.js 22 test runner and real stdio subprocess integration coverage.

Remote ChatGPT connectivity, a public repository, native Mac lifecycle, and SaaS remain unfinished.
