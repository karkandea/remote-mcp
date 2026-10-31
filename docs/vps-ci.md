# VPS-only CI policy (no GitHub Actions)

**Never use GitHub Actions, including GitHub self-hosted Actions runners.** GitHub hosts the public source; the CI worker runs independently on a **dedicated** VPS.

## Delivered in repository

- `scripts/ci.sh`: lockfile installation, TypeScript checks, MCP integration tests, build, and npm audit. This script passed on the owner's Mac and Ubuntu VPS in a manually invoked trusted checkout.
- `ci/runner.mjs`: an independent **main-only** poller with strict SHA checks, a fresh checkout, a pinned Node container digest requirement, rootless Podman sandbox flags, bounded execution, private logs, and optional GitHub commit status reporting.
- `ci/systemd`: user-level oneshot service and a ~5-minute timer; no public webhook listener and no inbound CI port.
- `ci/runner.test.mjs`: safety regression tests for SHA/input validation, digest pinning, and container confinement flags.

The worker code and unit tests are delivered, but there is currently **no dedicated VPS attached or deployed**. No background CI service has been started on the owner's shared Ubuntu VPS. Provisioning and a real container smoke test remain outstanding.

See [ci/README.md](../ci/README.md) for the deployment checklist and threat boundaries.

## Design limits and future work

- Only the repository's `main` branch is polled. Untrusted PR branches are **not** run, merged, or validated yet. PR CI requires a separately reviewed isolation and abuse-control design.
- Do not run arbitrary contributor code directly on the host, under an administrator, or in a container with host mounts, privileged flags, or a Docker socket.
- Rootless Podman is risk reduction, not an invulnerable VM. Prefer no production credentials or data anywhere on the CI host. Keep resource controls, egress policies, patching, and disk alerts active.
- A GitHub token for status reporting is optional and restricted to commit status writes, held exclusively outside the sandbox. GitHub Actions remain disabled.
- Branch protection must not require the VPS CI status until actual status posting has been verified end to end.
