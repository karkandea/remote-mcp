import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SealedState } from '../src/state.mjs';

test('state encrypts sensitive APNs token at rest and survives restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'iphone-agent-state-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }); });
  const filename = join(dir, 'state.sealed');
  const key = randomBytes(32).toString('base64url');
  const state = new SealedState(filename, key);
  assert.deepEqual(await state.load(), { deviceSecretHash: null, apnsToken: null });
  await state.save({ deviceSecretHash: 'digest', apnsToken: 'sensitive-device-token' });
  const raw = await readFile(filename, 'utf8');
  assert.equal(raw.includes('sensitive-device-token'), false);
  assert.deepEqual(await new SealedState(filename, key).load(), { deviceSecretHash: 'digest', apnsToken: 'sensitive-device-token' });
  await assert.rejects(new SealedState(filename, randomBytes(32).toString('base64url')).load());
});
