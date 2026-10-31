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
- Verification: `npm run check` exit code 0, **11/11 tests passed**, TypeScript typecheck passed, build passed.
- Test set includes: policy denial, path traversal, symlink escape, protected names, write opt-in, guarded patch and conflict, fixed process execution and cancellation, persisted disconnect, in-memory MCP client and real stdio MCP subprocess.
- All test data used synthetic temporary directories. No existing project source files were modified.

## Ubuntu VPS

- Ubuntu connected as a non-root ops user.
- Node.js 22.23.3 and Docker CLI available; the non-root `arkan-ops` account has no permission to use the Docker daemon.
- Root filesystem usage approximately 87% (53 GiB of 64 GiB used; approximately 8.3 GiB free at inspection).
- Trusted `main` commit cloned to `/home/arkan-ops/remote-mcp-ci` under non-root ops account.
- Manual `bash scripts/ci.sh` **exit 0**, 11/11 tests passed, build/typecheck passed, `npm audit` found 0 vulnerabilities.
- **No automated runner, webhook listener, background service, production application deployment, or system-wide dependencies were installed**. Node packages were installed only inside the separate CI checkout. Isolated automation remains blocked pending host/resource safety review.

## Local development checkpoint

- Additional regression tests cover bounded directory listings, oversized patch input, and MCP response budget (including the 1 KiB minimum). A mandatory secret-name deny baseline is enforced even when a custom deny list is configured.
- The full local `npm run check` suite passed with the subprocess permissions required by the command/stdio integration tests. Mac and VPS results above refer to the earlier 11-test revision; their next synced run will verify the added cases.

## Not yet verified

- Actual ChatGPT custom MCP connection to the Mac over an authenticated private tunnel.
- Interactive owner approvals, device pairing, macOS launchd service, robust shell sandbox, remote revocation, and SaaS gateway.
- GitHub PR status reporting by the future VPS-only CI worker.

This is an engineering checkpoint, not a claim that the full personal MVP is finished.
