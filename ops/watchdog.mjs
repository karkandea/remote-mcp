#!/usr/bin/env node
// Independent, read-only VPS watchdog. It does not execute root commands or restart services.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GIB = 1024 ** 3;
const DEFAULT_RELAY_URL = 'http://127.0.0.1:3417/healthz';

function bool(value) { return value === '1' || value === 'true'; }

export function watchdogConfig(env = process.env) {
  const relayUrl = new URL(env.MCP_WATCHDOG_RELAY_URL || DEFAULT_RELAY_URL);
  if (relayUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(relayUrl.hostname) ||
      relayUrl.pathname !== '/healthz' || relayUrl.search || relayUrl.hash ||
      relayUrl.username || relayUrl.password) throw new Error('Relay health URL must be local HTTP /healthz');
  const publicUrl = env.MCP_WATCHDOG_PUBLIC_URL ? new URL(env.MCP_WATCHDOG_PUBLIC_URL) : undefined;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/.well-known/oauth-protected-resource' ||
      publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash)) {
    throw new Error('Public check must be an HTTPS OAuth resource metadata URL');
  }
  const webhookUrl = env.MCP_WATCHDOG_WEBHOOK_URL ? new URL(env.MCP_WATCHDOG_WEBHOOK_URL) : undefined;
  if (webhookUrl && (webhookUrl.protocol !== 'https:' || webhookUrl.username || webhookUrl.password || webhookUrl.hash)) {
    throw new Error('Webhook must be an HTTPS URL without URL credentials or fragment');
  }
  const warnPercent = Number(env.MCP_WATCHDOG_DISK_WARN_PERCENT ?? 85);
  const criticalPercent = Number(env.MCP_WATCHDOG_DISK_CRITICAL_PERCENT ?? 90);
  if (!(warnPercent > 0 && warnPercent < criticalPercent && criticalPercent <= 100)) {
    throw new Error('Invalid disk warning/critical thresholds');
  }
  const rootSocket = env.MCP_WATCHDOG_ROOT_SOCKET || undefined;
  if (rootSocket && rootSocket !== '/run/remote-mcp-root/exec.sock') {
    throw new Error('Root socket must use the fixed deployment path');
  }
  const stateDir = env.MCP_WATCHDOG_STATE_DIR || '/var/lib/remote-mcp-watchdog';
  if (!path.isAbsolute(stateDir)) throw new Error('State directory must be absolute');
  return { relayUrl, publicUrl, webhookUrl, rootSocket, stateDir,
    expectMac: bool(env.MCP_WATCHDOG_EXPECT_MAC), warnPercent, criticalPercent };
}

async function probeHttp(url, parseHealth = false) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000) });
    if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status}` };
    if (!parseHealth) return { ok: true };
    const body = await response.json();
    if (body?.ok !== true || typeof body?.agentConnected !== 'boolean') {
      return { ok: false, reason: 'Invalid relay health response' };
    }
    return { ok: true, agentConnected: body.agentConnected };
  } catch { return { ok: false, reason: 'Health request failed or timed out' }; }
}

export async function probeRootSocket(socketPath) {
  return await new Promise(resolve => {
    const socket = createConnection(socketPath);
    let data = '';
    let settled = false;
    const finish = result => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
    socket.setTimeout(2500, () => finish({ ok: false, reason: 'Root helper timeout' }));
    socket.on('error', () => finish({ ok: false, reason: 'Root helper socket unavailable' }));
    socket.on('connect', () => socket.write('{"action":"status"}\n'));
    socket.on('end', () => finish({ ok: false, reason: 'Root helper closed connection' }));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 4096) return finish({ ok: false, reason: 'Root status exceeds size cap' });
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        const result = response?.data;
        if (response?.ok !== true || result?.enabled !== true || result?.privileged !== true ||
            !Number.isInteger(result.activeJobs) || result.activeJobs < 0) throw new Error('Invalid status');
        finish({ ok: true, activeJobs: result.activeJobs, retainedJobs: result.retainedJobs });
      } catch { finish({ ok: false, reason: 'Invalid root helper status response' }); }
    });
  });
}

async function probeDisk() {
  try {
    const disk = await statfs('/');
    const total = disk.blocks * disk.bsize;
    const free = disk.bavail * disk.bsize;
    const usedPercent = total ? (100 * (disk.blocks - disk.bfree) / disk.blocks) : 100;
    return { ok: total > 0, usedPercent, availableBytes: free };
  } catch { return { ok: false }; }
}

export function evaluateHealth(snapshot, config) {
  const issues = [];
  if (!snapshot.relay?.ok) issues.push({ code: 'RELAY_DOWN', severity: 'critical' });
  else if (config.expectMac && !snapshot.relay.agentConnected) {
    issues.push({ code: 'MAC_OFFLINE', severity: 'warning' });
  }
  if (config.rootSocket && !snapshot.root?.ok) issues.push({ code: 'ROOT_HELPER_DOWN', severity: 'critical' });
  if (config.publicUrl && !snapshot.public?.ok) issues.push({ code: 'PUBLIC_ENDPOINT_DOWN', severity: 'critical' });
  if (!snapshot.disk?.ok) issues.push({ code: 'DISK_CHECK_FAILED', severity: 'critical' });
  else if (snapshot.disk.usedPercent >= config.criticalPercent || snapshot.disk.availableBytes < 2 * GIB) {
    issues.push({ code: 'DISK_CRITICAL', severity: 'critical' });
  } else if (snapshot.disk.usedPercent >= config.warnPercent) {
    issues.push({ code: 'DISK_WARNING', severity: 'warning' });
  }
  const severity = issues.some(issue => issue.severity === 'critical') ? 'critical' :
    issues.length ? 'warning' : 'healthy';
  return { severity, issues: issues.sort((a, b) => a.code.localeCompare(b.code)),
    diskUsedPercent: snapshot.disk?.ok ? Number(snapshot.disk.usedPercent.toFixed(1)) : null,
    diskAvailableBytes: snapshot.disk?.ok ? snapshot.disk.availableBytes : null,
    rootActiveJobs: snapshot.root?.ok ? snapshot.root.activeJobs : null,
    agentConnected: snapshot.relay?.ok ? snapshot.relay.agentConnected : null };
}

export function shouldNotify(previous, current, nowMs) {
  const fingerprint = current.issues.map(issue => issue.code).join(',') || 'healthy';
  if (!previous && fingerprint === 'healthy') return false;
  if (previous?.notifiedFingerprint !== fingerprint) return true;
  return fingerprint !== 'healthy' && nowMs - (previous?.lastAlertAt ?? 0) >= 60 * 60 * 1000;
}

async function loadState(stateFile) {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function saveState(stateFile, payload) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, stateFile);
  } finally { await rm(temporary, { force: true }); }
}

async function sendWebhook(url, current, timestamp) {
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'remote-mcp-watchdog', timestamp, ...current }),
    signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Alert endpoint rejected notification');
}

export async function runOnce(env = process.env, probes = {}) {
  const config = watchdogConfig(env);
  const [relay, root, disk, publicEndpoint] = await Promise.all([
    (probes.relay ?? (() => probeHttp(config.relayUrl, true)))(),
    config.rootSocket ? (probes.root ?? (() => probeRootSocket(config.rootSocket)))() : undefined,
    (probes.disk ?? probeDisk)(),
    config.publicUrl ? (probes.public ?? (() => probeHttp(config.publicUrl)))() : undefined,
  ]);
  const current = evaluateHealth({ relay, root, disk, public: publicEndpoint }, config);
  const stateFile = path.join(config.stateDir, 'last-check.json');
  const previous = await loadState(stateFile);
  const timestamp = new Date().toISOString();
  const nowMs = Date.now();
  const fingerprint = current.issues.map(issue => issue.code).join(',') || 'healthy';
  let notifiedFingerprint = previous?.notifiedFingerprint ?? (current.severity === 'healthy' ? 'healthy' : null);
  let lastAlertAt = previous?.lastAlertAt ?? null;
  if (shouldNotify(previous, current, nowMs)) {
    try {
      if (config.webhookUrl) await (probes.notify ?? sendWebhook)(config.webhookUrl, current, timestamp);
      notifiedFingerprint = fingerprint;
      lastAlertAt = nowMs;
      process.stdout.write(JSON.stringify({ event: 'watchdog-alert', timestamp, ...current }) + '\n');
    } catch {
      process.stderr.write(JSON.stringify({ event: 'watchdog-alert-delivery-failed', timestamp,
        severity: current.severity, codes: current.issues.map(issue => issue.code) }) + '\n');
    }
  }
  await saveState(stateFile, { fingerprint, notifiedFingerprint, lastAlertAt, checkedAt: timestamp });
  process.stdout.write(JSON.stringify({ event: 'watchdog-check', timestamp, ...current }) + '\n');
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOnce().catch(() => {
    process.stderr.write(JSON.stringify({ event: 'watchdog-error', message: 'Watchdog could not complete checks' }) + '\n');
    process.exitCode = 1;
  });
}
