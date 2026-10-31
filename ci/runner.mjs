#!/usr/bin/env node
// Independent, main-only VPS CI poller. Never runs code on the host: the
// fetched repository is mounted read-only into a rootless Podman container.
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPOSITORY = 'karkandea/remote-mcp';
const SOURCE_URL = `https://github.com/${REPOSITORY}.git`;
const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;
const STATUS_CONTEXT = 'remote-mcp/vps-ci';
const MAX_LOG_BYTES = 1024 * 1024;

export function requireSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('GitHub returned an invalid 40-character commit SHA');
  }
  return value;
}

export function requirePinnedImage(value) {
  if (typeof value !== 'string' || !/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('REMOTE_MCP_CI_IMAGE must be a pinned docker.io/library/node@sha256:<64 hex> image');
  }
  return value;
}

export function buildPodmanArgs({ checkout, image, containerName }) {
  if (!path.isAbsolute(checkout)) throw new Error('Checkout path must be absolute');
  requirePinnedImage(image);
  if (!/^remote-mcp-ci-[a-f0-9-]+$/.test(containerName)) throw new Error('Invalid container name');
  return [
    'run', '--rm', '--name', containerName, '--pull=never',
    '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
    '--network=slirp4netns:allow_host_loopback=false',
    '--pids-limit=128', '--memory=1536m', '--cpus=2',
    '--userns=keep-id',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--tmpfs=/work:rw,exec,nosuid,nodev,size=1024m,mode=1777',
    '--env=CI=true', '--env=HOME=/tmp', '--env=NPM_CONFIG_CACHE=/tmp/npm-cache',
    '--volume', `${checkout}:/input:ro`, '--workdir=/work', image,
    '/bin/bash', '-ec', 'cp -a /input/. /work/ && cd /work && bash scripts/ci.sh',
  ];
}

async function command(executable, args, timeout = 60_000) {
  return execFile(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: MAX_LOG_BYTES,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

async function apiRequest(url, { token, method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'remote-mcp-independent-vps-ci',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(url, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub API ${method} failed (HTTP ${response.status})`);
  return response.json();
}

async function notifyGitHub(sha, token, state, description) {
  if (!token) return;
  try {
    await apiRequest(`${API_BASE}/statuses/${sha}`, { token, method: 'POST', body: {
      state, description: description.slice(0, 140), context: STATUS_CONTEXT,
    } });
  } catch (error) {
    // An optional status-reporting failure cannot turn a passed test into a pass/fail claim.
    process.stderr.write(`GitHub status reporting failed: ${error.message}\n`);
  }
}

function safeError(error) {
  if (!(error instanceof Error)) return String(error).slice(0, 1000);
  const stdio = [error.stdout, error.stderr].filter(value => typeof value === 'string').join('\n');
  return `${error.message}\n${stdio}`.slice(0, MAX_LOG_BYTES);
}

async function writeState(stateDir, payload) {
  const temporary = path.join(stateDir, `.last-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(stateDir, 'last-run.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readLastSha(stateDir) {
  try {
    const last = JSON.parse(await readFile(path.join(stateDir, 'last-run.json'), 'utf8'));
    return typeof last.sha === 'string' ? last.sha : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function checkoutCommit(checkout, sha) {
  await command('git', ['init', '--quiet', checkout]);
  await command('git', ['-c', 'core.hooksPath=/dev/null', '-C', checkout,
    'fetch', '--quiet', '--no-tags', '--depth=1', SOURCE_URL, 'refs/heads/main'], 90_000);
  const { stdout } = await command('git', ['-C', checkout, 'rev-parse', 'FETCH_HEAD']);
  if (stdout.trim() !== sha) {
    throw new Error('main advanced during fetch; will retry the new SHA on the next poll');
  }
  await command('git', ['-c', 'core.hooksPath=/dev/null', '-C', checkout,
    'checkout', '--quiet', '--detach', sha]);
}

export async function runOnce() {
  const image = requirePinnedImage(process.env.REMOTE_MCP_CI_IMAGE);
  const stateDir = process.env.REMOTE_MCP_CI_STATE_DIR ?? path.join(homedir(), '.local', 'state', 'remote-mcp-ci');
  if (!path.isAbsolute(stateDir)) throw new Error('REMOTE_MCP_CI_STATE_DIR must be absolute');
  await mkdir(path.join(stateDir, 'runs'), { recursive: true, mode: 0o700 });
  const branch = await apiRequest(`${API_BASE}/branches/main`);
  const sha = requireSha(branch?.commit?.sha);
  if (await readLastSha(stateDir) === sha) {
    process.stdout.write(`No new main commit (${sha.slice(0, 12)}).\n`);
    return;
  }

  // Only the host-side poller sees this optional token. It is never copied or
  // bind-mounted into the container, nor passed via container environment.
  const tokenFile = process.env.REMOTE_MCP_CI_TOKEN_FILE;
  if (tokenFile && !path.isAbsolute(tokenFile)) throw new Error('Token file path must be absolute');
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : undefined;
  const checkout = await mkdtemp(path.join(stateDir, 'checkout-'));
  const containerName = `remote-mcp-ci-${sha.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
  let outcome = 'failure';
  let details = '';
  let testStarted = false;
  await notifyGitHub(sha, token, 'pending', 'VPS CI started');
  try {
    await checkoutCommit(checkout, sha);
    // Missing image/runtime is an infrastructure failure, not a failed test.
    // Keep the SHA retryable until the worker can actually launch a job.
    await command('podman', ['image', 'exists', image], 20_000);
    testStarted = true;
    const { stdout, stderr } = await command('podman',
      buildPodmanArgs({ checkout, image, containerName }), 360_000);
    outcome = 'success';
    details = `${stdout}\n${stderr}`;
  } catch (error) {
    // Podman reserves 125-127 for launch/runtime failures. Do not mark a SHA
    // complete when the sandbox itself was never started successfully.
    if (testStarted && [125, 126, 127, 'ENOENT'].includes(error?.code)) testStarted = false;
    details = safeError(error);
  } finally {
    // A killed or timed-out Podman CLI may leave the container running.
    await command('podman', ['rm', '--force', '--ignore', containerName], 20_000).catch(() => {});
    await rm(checkout, { recursive: true, force: true });
  }

  const timestamp = new Date().toISOString();
  const logName = `${timestamp.replace(/[:.]/g, '-')}-${sha.slice(0, 12)}.log`;
  await writeFile(path.join(stateDir, 'runs', logName), details.slice(0, MAX_LOG_BYTES),
    { mode: 0o600, flag: 'wx' });
  // Infrastructure failures should retry. Test failures are recorded once per SHA
  // to prevent an untrusted commit from consuming the machine every five minutes.
  if (testStarted) await writeState(stateDir, { sha, outcome, timestamp, logName });
  await notifyGitHub(sha, token, outcome === 'success' ? 'success' : 'failure',
    outcome === 'success' ? 'Independent VPS CI passed' : 'Independent VPS CI failed');
  process.stdout.write(`${sha.slice(0, 12)}: ${outcome}; log=${logName}\n`);
  if (outcome !== 'success') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOnce().catch(error => { process.stderr.write(`VPS CI poller error: ${safeError(error)}\n`); process.exitCode = 1; });
}
