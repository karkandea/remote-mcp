# VPS-only CI design (no GitHub Actions)

**Policy:** Do not create `.github/workflows` or enable GitHub Actions, including self-hosted GitHub Actions runners. Source hosting remains on GitHub; build and security checks execute on an isolated VPS worker.

## Current runnable verification

From a disposable checkout with Node.js 22+:

```bash
bash scripts/ci.sh
```

The script installs the lockfile, type-checks, tests, builds, and runs `npm audit`. It is a **manual or externally scheduled verification entry point**, not an automated CI service. On 2026-10-31 it completed successfully on the owner's Ubuntu VPS against reviewed `main` (11/11 tests, 0 detected vulnerabilities). There are currently no running webhook receivers or VPS background services supplied by this repository.

## Proposed isolated automation

1. GitHub webhook receiver verifies the `X-Hub-Signature-256` HMAC over the raw payload, rejects replay/duplicates, and accepts only the configured repository.
2. A queue records an immutable commit SHA and event type (push or PR) with expiry and a bounded job ID.
3. A dedicated non-root worker launches a short-lived container/VM for each job. It checks out the exact SHA, has no production secrets, no host-network access, no privileged mounts, and no Docker socket access.
4. Apply CPU, RAM, output, network and execution-time limits. The worker runs `scripts/ci.sh`, collects bounded logs, and destroys the sandbox after completion.
5. A GitHub App or scoped token can optionally report commit status, without granting code write access to the worker. GitHub Actions remain disabled.

## Release-blocking requirements

- Never execute arbitrary public pull-request code directly on the production VPS or under an account that can reach application data, SSH keys, databases, or Docker daemon.
- No deployment to the existing owner's VPS until the isolated runner threat model and host separation are approved.
- Use a dedicated CI host when possible. If shared, use strongly separated user, VM/container, network, storage, and credentials.
- Keep webhook secrets outside Git, enforce TLS, rotate secrets, and rate-limit callbacks.
- Test invalid webhook signatures, spoofed repository names, duplicate deliveries, cancellation, timeouts, resource exhaustion, and malicious PRs.

This document defines the target. It does not claim the VPS receiver or runner is installed.
