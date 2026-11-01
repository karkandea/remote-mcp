import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess } from '../src/preflight.mjs';

const ready = { platform: 'linux', nodeMajor: 22, tun: true, usbmuxd: true,
  appium: true, pairedRecords: 1, privateTunnel: true, diskFreeGiB: 5, diskUsedPct: 80 };

test('reports a complete but not yet verified host as prerequisites-present', () => {
  assert.equal(assess(ready).status, 'prerequisites-present');
  assert.match(assess(ready).note, /does not establish/);
});

test('fails closed if pairing and private transport are absent', () => {
  const result = assess({ ...ready, pairedRecords: 0, privateTunnel: false });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.checks.filter(item => !item.ok).map(item => item.id), ['paired', 'privateTunnel']);
});

test('warns about disk pressure without modifying the server', () => {
  const result = assess({ ...ready, diskFreeGiB: 2.5, diskUsedPct: 91 });
  assert.equal(result.warnings.length, 2);
});
