#!/usr/bin/env bash
set -euo pipefail

# Intended for a disposable, unprivileged VPS CI job workspace.
# Do not execute untrusted pull requests on a production host without isolation.

if [[ ! -f package-lock.json || ! -f package.json ]]; then
  echo 'Run this script from the repository root.' >&2
  exit 1
fi

node --version
npm --version
npm ci --ignore-scripts --no-fund
npm run check
npm audit --audit-level=high

echo 'Remote MCP verification passed.'
