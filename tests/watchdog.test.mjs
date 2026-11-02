import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateHealth, probeRootSocket, runOnce, watchdogConfig } from '../ops/watchdog.mjs';

test('watchdog refuses public relay targets and arbitrary root sockets', () => {
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_RELAY_URL: 'http://example.test/healthz' }), /local HTTP/);
  assert.throws(() => watchdogConfig({ MCP_WATCHDOG_RELAY_URL: 'http://127.0.0.1:3417/healthz?token=x' }), /local HTTP/);
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
});

test('watchdog reports service degradation and recovery without sending notifications', async () => {
  const env = { MCP_WATCHDOG_EXPECT_MAC: '1' };
  let agentConnected = false;
  let notifications = 0;
  const probes = {
    relay: async () => ({ ok: true, agentConnected }),
    disk: async () => ({ ok: true, usedPercent: 87.8, availableBytes: 5.5 * 1024 ** 3 }),
    notify: async () => { notifications++; },
  };
  const degraded = await runOnce(env, probes);
  assert.deepEqual(degraded.issues.map(x => x.code), ['DISK_WARNING', 'MAC_OFFLINE']);
  agentConnected = true;
  const restored = await runOnce(env, probes);
  assert.deepEqual(restored.issues.map(x => x.code), ['DISK_WARNING']);
  assert.equal(notifications, 0);
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
