# Verification checkpoint — 2026-10-31

## Repository

- Public: https://github.com/karkandea/remote-mcp
- Branch: `main`
- License: MIT
- GitHub Actions: explicitly disabled at repository settings (`enabled=false` verified using GitHub API). No `.github/workflows` tracked.
- `main` branch protection now rejects force-push and deletion and requires linear commit history. No GitHub-hosted or GitHub-managed checks were added.

## MacBook Air Arkan

- Device: macOS 26.6.2, arm64, Node.js 22.20.0.
- Source clone: `/Users/arkan/Projects/remote-mcp` (new directory).
- Dependency installation: `npm ci --ignore-scripts --no-audit --no-fund` successful.
- Verification: `npm run check` exit code 0, **17/17 tests passed**, TypeScript typecheck passed, build passed against GitHub `main` commit `56012be` at that checkpoint.
- Test set includes: policy denial, path traversal, symlink escape, mandatory protected names, bounded directory listing and MCP response, oversized patch denial, write opt-in, guarded patch and conflict, fixed process execution and cancellation, persisted disconnect, in-memory MCP client and real stdio MCP subprocess.
- All test data used synthetic temporary directories. No existing project source files were modified.

## Ubuntu VPS

- Ubuntu connected as a non-root ops user.
- Node.js 22.23.3 and Docker CLI available; the non-root `arkan-ops` account has no permission to use the Docker daemon.
- Root filesystem usage approximately 87% at initial inspection; approximately **88%** (~7.7 GiB free) by deployment.
- Trusted `main` commit cloned to `/home/arkan-ops/remote-mcp-ci` under non-root ops account.
- Initial manual `bash scripts/ci.sh` **exit 0**, 17/17 tests passed, build/typecheck passed, `npm audit` found 0 vulnerabilities against GitHub `main` commit `56012be`.
- After owner approval for the **existing shared VPS**, installed rootless Podman and required Ubuntu packages, created non-sudo `ci-runner` (UID 1005, not in Docker group), and enabled its systemd user manager. No production application or database service was altered. No public-facing webhook or port was opened.
- Resource isolation verified: rootless Podman with read-only container filesystem, ephemeral writable tmpfs, pinned Node 22 image digest, per-job **1 GiB RAM / 96 processes**, and `user-1005.slice` **1 CPU / 1.5 GiB RAM / 192 tasks**. Rootless Podman does not have a delegated CPU controller on this Ubuntu 22.04 host, so the host's dedicated CI user slice enforces the CPU cap. Only one job runs at a time.
- Actual `remote-mcp-ci.service` systemd one-shot completed successfully for `main` SHA **`88f8e8b69e09ee33955ede5a8ad3c8a98b3466e9`** at 2026-10-31 15:13:59 UTC. In its isolated container: **17/17 tests passed**, typecheck and build passed, and `npm audit` found **0 vulnerabilities**. Rootless Podman had no remaining job containers after cleanup.
- `remote-mcp-ci.timer` **enabled and active**, polling `main` approximately every 10 minutes; next firing was scheduled for 2026-10-31 15:24:41 UTC when verified. The runner's last result and bounded logs are private under `/home/ci-runner/.local/state/remote-mcp-ci/`. No GitHub Actions runner or workflow is involved.

## Local development checkpoint

- Additional regression tests cover bounded directory listings, oversized patch input, and MCP response budget (including the 1 KiB minimum). A mandatory secret-name deny baseline is enforced even when a custom deny list is configured.
- The full local `npm run check` suite passed with the subprocess permissions required by the command/stdio integration tests; the same 17-test revision subsequently passed on the Mac and VPS. Initial runner configuration tests alone were not sufficient evidence; the separate live rootless Podman acceptance run is recorded above.

## Independent VPS CI deployment and remaining constraints

- The owner initially preferred a dedicated CI VPS but subsequently confirmed there was none and authorized safe use of the **existing shared VPS**. This approval is limited to owner-controlled `main`, not arbitrary public PR code.
- The independent polling runner, pinned-image validation, rootless container policy, systemd timer, and deployment checklist are published in this repository. The runner deployed on the VPS is installed separately from untrusted checkout files; it does not auto-update itself.
- Public PR checks are **disabled** on the shared host. Optional GitHub status reporting remains **unconfigured** because no fine-grained, repository-scoped commit-status token was supplied. A green private CI log must not be misrepresented as a GitHub branch-protection check.

## Not yet verified

- Actual ChatGPT custom MCP connection to the Mac over an authenticated private tunnel.
- Interactive owner approvals, device pairing, macOS launchd service, robust shell sandbox, remote revocation, and SaaS gateway.
- Safe public PR validation and GitHub commit-status reporting by the independent VPS worker.

This is an engineering checkpoint, not a claim that the full personal MVP is finished.
