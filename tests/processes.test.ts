import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configSchema } from '../src/config.js';
import { ProcessTools } from '../src/processes.js';
import { SystemTools } from '../src/system.js';

test('process inventory is bounded and never includes command-line arguments', async () => {
  const processes = new ProcessTools(configSchema.parse({}));
  const self = await processes.info(process.pid) as { name: string };
  const inventory = await processes.list(self.name) as {
    processes: Array<{ pid: number; name: string; executable: string; startedAt: string }>;
  };
  assert.ok(inventory.processes.length <= 100);
  assert.ok(inventory.processes.some(item => item.pid === process.pid));
  assert.ok(inventory.processes.every(item =>
    !('args' in item) && Number.isInteger(item.pid) && item.startedAt.length > 12));
});

test('process termination is opt-in, matches PID and start time, and uses SIGTERM only', async () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const pid = child.pid!;
    const denied = new ProcessTools(configSchema.parse({}));
    const allowed = new ProcessTools(configSchema.parse({ processStopAllowlist: ['sleep'] }));
    const info = await allowed.info(pid) as { pid: number; name: string; startedAt: string };
    assert.equal(info.name, 'sleep');
    await assert.rejects(denied.stop(pid, info.startedAt), /not in the locally configured/);
    await assert.rejects(allowed.stop(pid, 'Mon Jan 1 00:00:00 2000'), /identity changed/);
    assert.equal(child.exitCode, null);
    const stopped = await allowed.stop(pid, info.startedAt) as { signal: string };
    assert.equal(stopped.signal, 'SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    assert.equal(child.signalCode, 'SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

test('remote MCP agent cannot stop its own process even when node is allowlisted', async () => {
  const processes = new ProcessTools(configSchema.parse({ processStopAllowlist: ['node'] }));
  const info = await processes.info(process.pid) as { startedAt: string };
  await assert.rejects(processes.stop(process.pid, info.startedAt), /Agent and protected processes/);
});

test('system metrics are read-only; app and user service control require local allowlists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-system-'));
  const system = new SystemTools(configSchema.parse({ allowedRoots: [root] }));
  const status = await system.status() as { uptimeSeconds: number; disk: { availableBytes: number } };
  assert.ok(status.uptimeSeconds >= 0);
  assert.ok(status.disk.availableBytes > 0);
  await assert.rejects(system.openApp('unknown'), /Unknown or unauthorized/);
  await assert.rejects(system.serviceRestart('com.some.service'), /not in the locally configured/);
  const withSelf = new SystemTools(configSchema.parse({
    serviceRestartAllowlist: ['com.dualangka.remote-mcp-agent'],
  }));
  await assert.rejects(withSelf.serviceRestart('com.dualangka.remote-mcp-agent'), /cannot restart itself/);
});
