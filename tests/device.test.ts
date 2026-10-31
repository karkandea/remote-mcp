import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeviceState } from '../src/device.js';

test('disconnect is persistent until an explicit local resume', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-mcp-device-'));
  const first = new DeviceState(directory);
  await first.assertConnected();
  await first.disconnect();
  const restarted = new DeviceState(directory);
  await assert.rejects(restarted.assertConnected(), /revoked locally/);
  await restarted.resumeLocally();
  await restarted.assertConnected();
});
