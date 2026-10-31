# Independent CI worker on a dedicated VPS

**No GitHub Actions. No GitHub self-hosted Actions runner. No webhook listener.**

This is a **main-branch-only** CI worker: a systemd user timer polls the public GitHub branch every ~5 minutes. For each new immutable SHA, it fetches a fresh checkout, verifies the SHA, and runs `scripts/ci.sh` inside a short-lived rootless Podman container. Its GitHub API calls and optional status credential remain outside the job sandbox.

The implementation is checked into this repository but **has not been deployed to a dedicated VPS**. The previous Ubuntu VPS remains untouched by automation; it was used only for manual verification. Do not activate a timer on a shared production host.

## Dedicated host requirements

- Dedicated Ubuntu VPS/VM (24.04 LTS recommended), starting around 2 vCPU, 4 GiB RAM, and 40 GiB storage, with a dedicated unprivileged `ci-runner` account.
- Git, Node.js 20+ for the host poller, rootless Podman, `uidmap`, `slirp4netns`, and `flock`. A working cgroup v2 user delegation is required for the memory, CPU, and process limits.
- No production data, application secrets, database access, Docker socket, or privileged mounts. Inbound access only for operator SSH; no HTTP inbound port required.
- Egress only as needed for GitHub, container image registry, npm registry, and npm audit. Tighten the VPS firewall and hosting-provider controls; treat all CI job output as untrusted.
- A **pinned digest** for the official `docker.io/library/node` Node 22 image. Moving image tags are intentionally rejected by the runner.

The checked-out repository is mounted read-only at `/input`; its files are copied into an ephemeral writable `/work` tmpfs within the container. The container has no extra Linux capabilities, no new privileges, separate user and network namespaces, CPU/RAM/PID limits, and a 6-minute job timeout. It has network access for `npm ci` and `npm audit`, so this is a first isolation layer, not a guarantee that hostile code cannot exploit a kernel/runtime vulnerability. Keep the VPS dedicated and patched.

## Manual deployment checklist (after VPS provision)

1. Harden the fresh VPS: SSH keys and firewall, system/security updates, automatic security patching, disk alerts. Create a non-sudo `ci-runner` user; enable systemd user lingering for that account. Do **not** add it to the `docker` group or give it access to `/var/run/docker.sock`.
2. Install Podman and its rootless dependencies, plus Git, Node.js, and `flock`. As `ci-runner`, confirm `podman info` reports rootless mode, user namespaces and cgroups work, and the CPU/RAM/PID-limited smoke test runs successfully. Stop if any resource limit cannot be enforced.
3. Pull the Node 22 slim image using Podman and inspect its immutable **RepoDigest**. Record it in the environment file as `REMOTE_MCP_CI_IMAGE=docker.io/library/node@sha256:...` with the actual 64-hex digest. Keep the image explicitly pulled on the host, as the runner uses `--pull=never`.
4. Copy **reviewed** `ci/runner.mjs` to `/home/ci-runner/.local/share/remote-mcp-ci/runner.mjs` with mode 0755. Do not auto-update this trusted runner from the untrusted checkout.
5. Install `ci/systemd/remote-mcp-ci.service` and `.timer` into `/home/ci-runner/.config/systemd/user/`. Create `/home/ci-runner/.config/remote-mcp-ci/env` with mode 0600 and the pinned image setting. Optionally set an absolute `REMOTE_MCP_CI_STATE_DIR` for logs/state.
6. Run a **one-shot test** as the unprivileged user: `node /home/ci-runner/.local/share/remote-mcp-ci/runner.mjs`. Verify the checkout SHA, passing tests, local log, container cleanup, memory/PID limits, and safe failure handling.
7. After review, run `systemctl --user daemon-reload` and `systemctl --user enable --now remote-mcp-ci.timer`. Inspect `systemctl --user list-timers`, `journalctl --user -u remote-mcp-ci.service`, and the private `~/.local/state/remote-mcp-ci/last-run.json` file.

Logs are stored in the private `runs/` directory under the state directory. A completed SHA is attempted once to prevent repeated resource exhaustion; detected infrastructure setup and Podman launch failures are retried. To retest a SHA, an operator must inspect state and manually initiate a controlled retry. Never publish raw logs blindly: contributor-supplied code may print secrets or hostile terminal sequences.

## Optional GitHub commit status

Create a fine-grained token restricted to this repository with only **Commit statuses: read/write** (plus mandatory repository metadata read). Save the token in a 0600 owner-only file outside the repository, then set `REMOTE_MCP_CI_TOKEN_FILE` to its absolute path in the service environment file. The host runner posts `pending`, `success`, or `failure` to status context `remote-mcp/vps-ci`. The token is never mounted into the test container. Do not set a general-purpose repository-write token.

Without this token, local CI still works; GitHub cannot display its result. Do not require the status in branch protection until the dedicated runner and status publishing have been proven reliable.

## PR policy

This first worker checks **owner-controlled `main` only**. Public PRs remain untrusted and are **not executed** yet. PR validation needs a separate queue, resource quotas, careful source/merge commit verification, egress restrictions, fork abuse controls, and stronger review of container breakout threats before activation. GitHub Actions remain forbidden in every phase.

## Recovery

- If the timer fails: `systemctl --user stop remote-mcp-ci.timer`; inspect status and private logs.
- If Podman reports a stuck job: inspect the named `remote-mcp-ci-*` container and stop **only that identified CI container**.
- If the image digest needs updating, manually pull and verify the new digest before changing the config. Changes to the trusted runner require review and a new one-shot test.
- If the optional token leaks, revoke it immediately and rotate it; inspect host and GitHub status logs.
