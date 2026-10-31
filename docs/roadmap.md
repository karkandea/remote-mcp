# Roadmap and verification gates

## M0 — Repository foundation

- [x] Local source, GitHub-ready docs/templates, and a VPS CI verification script.
- [x] Dependency lockfile and local build/test commands.
- [x] Create public `karkandea/remote-mcp` repository and publish source.
- [x] MIT open-source license approved by owner and added.
- [x] Implement and test a main-only independent VPS poller with rootless container isolation options; no GitHub Actions.
- [ ] Provision a dedicated CI VPS, verify rootless container limits, and activate the systemd timer and status reporting.
- [ ] Design and verify isolated, abuse-resistant public PR checks; main-only CI is not PR verification.
- [x] Protect `main` against force-push and deletion, with linear commit history.
- [ ] Add required CI status after the independently hosted VPS runner and GitHub status reporting are operational.

## M1 — Local execution agent

- [x] Read/list/stat/search and bounded controlled patch operations.
- [x] Read-only Git actions.
- [x] Narrow command profiles, process IDs, polling and cancellation.
- [x] Persisted local device disconnect.
- [x] Basic policy, errors, audit, and initial regression tests.
- [ ] Threat-model review, additional path-race hardening and sandbox strategy.
- [x] macOS 26.6.2 (Apple Silicon) test execution under non-root user `arkan`, 11/11 passed.
- [ ] Robust launchd lifecycle and process cleanup under sleep/restart.

## M2 — Personal remote ChatGPT integration

- [x] Register tools using official MCP TypeScript SDK v2.
- [x] Real MCP client discovery, file read, disconnect, and deny test via in-memory transport.
- [x] Real MCP stdio subprocess handshake, tool listing, and authorized file read in an automated test.
- [x] Verify a real stdio subprocess handshake and authorized file read on the owner's Mac.
- [ ] Verify Secure MCP Tunnel / ChatGPT developer-mode eligibility.
- [ ] Set up private authenticated connection, no public unauthenticated endpoints.
- [ ] Execute acceptance tests A–F with synthetic Mac files and real authorization.
- [ ] Review security, package an installable release, tag after owner approval.

## M3 — SaaS foundation (future, separate milestone)

- [ ] ASP.NET Core gateway with MCP Streamable HTTP.
- [ ] OAuth-compatible identity and scoped access.
- [ ] Device pairing, outbound relay, heartbeat, reconnect, cancellation.
- [ ] PostgreSQL schema with tenant isolation tests.
- [ ] React dashboard technical design.

## Real definition of done

Each item requires actual code or configuration, passing tests, review, and demonstrable behavior. A passing local unit test is **not** evidence that ChatGPT can reach the Mac. M2 only completes after an independent ChatGPT-to-Mac invocation with read, search, patch, process status, and subsequent denial on disconnect.
