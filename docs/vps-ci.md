# VPS-only CI policy (no GitHub Actions)

**Never use GitHub Actions, including GitHub self-hosted Actions runners.** GitHub hosts the public source; the CI worker runs independently on an Ubuntu VPS.

## Delivered in repository

- `scripts/ci.sh`: lockfile installation, TypeScript checks, MCP integration tests, build, and npm audit. This script passed on the owner's Mac and Ubuntu VPS in a manually invoked trusted checkout.
- `ci/runner.mjs`: an independent **main-only** poller with strict SHA checks, a fresh checkout, a pinned Node container digest requirement, rootless Podman sandbox flags, bounded execution, private logs, and optional GitHub commit status reporting.
- `ci/systemd`: user-level oneshot service and a ~10-minute timer; no public webhook listener and no inbound CI port.
- `ci/runner.test.mjs`: safety regression tests for SHA/input validation, digest pinning, and container confinement flags.

The owner approved deployment of **main-only CI** onto the existing shared Ubuntu VPS, with a separate unprivileged user and strict resource caps. Public PR execution remains forbidden on that host. The previous checkpoint verified only a manual run; live container and timer status must be confirmed independently.

See [ci/README.md](../ci/README.md) for the deployment checklist and threat boundaries.

## Design limits and future work

- Only the repository's `main` branch is polled. Untrusted PR branches are **not** run, merged, or validated yet. PR CI requires a separately reviewed isolation and abuse-control design.
- Do not run arbitrary contributor code directly on the host, under an administrator, or in a container with host mounts, privileged flags, or a Docker socket.
- Rootless Podman is risk reduction, not an invulnerable VM. On a shared host the CI user must not access application credentials or data. Keep resource controls, egress policies, patching, and disk alerts active; move untrusted PR validation to a separate host.
- A GitHub token for status reporting is optional and restricted to commit status writes, held exclusively outside the sandbox. GitHub Actions remain disabled.
- Branch protection must not require the VPS CI status until actual status posting has been verified end to end.
