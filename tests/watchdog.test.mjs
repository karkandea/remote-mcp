import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateHealth, probeRootSocket, runOnce, shouldNotify, watchdogConfig } from '../ops/watchdog.mjs';

test('watchdog refuses public relay targets, non-HTTPS alert sinks and arbitrary root sockets', () => {
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_RELAY_URL: 'http://example.test/healthz' }), /local HTTP/);
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_RELAY_URL: 'http://127.0.0.1:3417/healthz?token=x' }), /local HTTP/);
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_WEBHOOK_URL: 'http://alerts.test/' }), /HTTPS/);
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_ROOT_SOCKET: '/tmp/unknown.sock' }), /fixed/);
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_DISK_WARN_PERCENT: '95',
    MCP_WATCHDOG_DISK_CRITICAL_PERCENT: '90' }), /thresholds/);
});

test('disk and service severity is independently classified', () => {
  const config = watchdogConfig({ MCP_WATCHDOG_EXPECT_MAC: 'true',
    MCP_WATCHDOG_ROOT_SOCKET: '/run/remote-mcp-root/exec.sock' });
  const snapshot = { relay: { ok: true, agentConnected: false }, root: { ok: true, activeJobs: 0 },
    disk: { ok: true, usedPercent: 87.8, availableBytes: 5.5 * 1024 ** 3 } };
  const result = evaluateHealth(snapshot, config);
  assert.deepEqual(result.issues.map(x => x.code), ['DISK_WARNING', 'MAC_OFFLINE']);
  assert.equal(result.severity, 'warning');
  const critical = evaluateHealth({ ...snapshot, root: { ok: false },
    disk: { ok: true, usedPercent: 91, availableBytes: 1024 ** 3 } }, config);
  assert.equal(critical.severity, 'critical');
  assert.deepEqual(critical.issues.map(x => x.code), ['DISK_CRITICAL', 'MAC_OFFLINE', 'ROOT_HELPER_DOWN']);
  assert.equal(shouldNotify({ notifiedFingerprint: 'DISK_WARNING', lastAlertAt: 100 }, result, 200), true);
  assert.equal(shouldNotify({ notifiedFingerprint: 'DISK_WARNING,MAC_OFFLINE', lastAlertAt: 100 }, result, 200), false);
  assert.equal(shouldNotify({ notifiedFingerprint: 'DISK_WARNING,MAC_OFFLINE', lastAlertAt: 100 }, result, 3600101), true);
});

test('watchdog deduplicates alerts, reports recovery and retries a failed webhook', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'mcp-watchdog-'));
  const env = { MCP_WATCHDOG_STATE_DIR: stateDir, MCP_WATCHDOG_WEBHOOK_URL: 'https://alerts.example.test/hook',
    MCP_WATCHDOG_EXPECT_MAC: '1' };
  let agentConnected = false;
  let delivered = 0;
  let failNext = true;
  const probes = {
    relay: async () => ({ ok: true, agentConnected }),
    disk: async () => ({ ok: true, usedPercent: 87.8, availableBytes: 5.5 * 1024 ** 3 }),
    notify: async () => { if (failNext) { failNext = false; throw new Error('synthetic outage'); } delivered++; },
  };
  try {
    await runOnce(env, probes);
    assert.equal(delivered, 0);
    await runOnce(env, probes);
    assert.equal(delivered, 1);
    await runOnce(env, probes);
    assert.equal(delivered, 1);
    agentConnected = true;
    await runOnce(env, probes);
    assert.equal(delivered, 2);
    const state = JSON.parse(await readFile(path.join(stateDir, 'last-check.json'), 'utf8'));
    assert.equal(state.notifiedFingerprint, 'DISK_WARNING');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('root helper probe accepts only a well-formed read-only status', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-root-status-'));
  const socketPath = path.join(directory, 'status.sock');
  const server = createServer(socket => {
    socket.once('data', chunk => {
      assert.equal(chunk.toString(), '{"action":"status"}\n');
      socket.end('{"ok":true,"data":{"enabled":true,"privileged":true,"activeJobs":0,"retainedJobs":58}}\n');
    });
  });
  try {
    await new Promise(resolve => server.listen(socketPath, resolve));
    assert.deepEqual(await probeRootSocket(socketPath), { ok: true, activeJobs: 0, retainedJobs: 58 });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
