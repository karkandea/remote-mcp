import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentServer } from '../src/server.mjs';

const adminToken = 'admin-test-token-at-least-32-characters';
const code = '12345678';

test('pairing, auth, queue and single-use fetch work; no arbitrary tap', async t => {
  let saved = { deviceSecretHash: null, apnsToken: null };
  const stateStore = { load: async () => structuredClone(saved), save: async s => { saved = structuredClone(s); } };
  const server = await createAgentServer({ stateStore, apns: { configured: false }, adminToken, pairingCode: code, manualMode: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, value, token) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
    return { status: res.status, body: await res.json() };
  }
  assert.equal((await post('/v1/admin/commands', { action: 'open_youtube' }, 'bad')).status, 401);
  assert.equal((await post('/v1/enroll', { code: '00000000' })).status, 403);
  const paired = await post('/v1/enroll', { code });
  assert.equal(paired.status, 201);
  const token = paired.body.deviceSecret;
  assert.equal((await post('/v1/enroll', { code })).status, 409);
  assert.equal((await post('/v1/admin/commands', { action: 'tap' }, adminToken)).status, 400);
  const dispatch = await post('/v1/admin/commands', { action: 'open_youtube' }, adminToken);
  assert.equal(dispatch.status, 202);
  assert.equal(dispatch.body.notificationSent, false);
  assert.equal((await post('/v1/device/next', {}, 'bad')).status, 401);
  assert.equal((await post('/v1/device/next', {}, token)).body.command.action, 'open_youtube');
  assert.equal((await post('/v1/device/next', {}, token)).body.command, null);
});

test('APNs delivery failure discards command (no stale execute)', async t => {
  const stateStore = { load: async () => ({ deviceSecretHash: null, apnsToken: null }), save: async () => {} };
  const apns = { configured: true, send: async () => { throw new Error('transient'); } };
  const server = await createAgentServer({ stateStore, apns, adminToken, pairingCode: code });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, value, token) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
    return { status: res.status, body: await res.json() };
  };
  const paired = await post('/v1/enroll', { code });
  const token = paired.body.deviceSecret;
  await post('/v1/device/push-token', { token: 'a'.repeat(64) }, token);
  assert.equal((await post('/v1/admin/commands', { action: 'open_youtube' }, adminToken)).status, 502);
  assert.equal((await post('/v1/device/next', {}, token)).body.command, null);
});
