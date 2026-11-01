import test from 'node:test';
import assert from 'node:assert/strict';
import { NtfySender } from '../src/ntfy.mjs';
import { createAgentServer } from '../src/server.mjs';

const topic = 'iphoneagent_' + 'x'.repeat(52);

test('ntfy sender validates topic, sends only safe action with no sensitive content', async () => {
  const sent = [];
  const sender = new NtfySender({ topic, fetchImpl: async (url, req) => {
    sent.push({ url, req });
    return { ok: true, status: 200 };
  } });
  assert.equal(sender.configured, true);
  await assert.rejects(sender.send(null, 'tap_coordinates'));
  await sender.send(null, 'open_tiktok');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.body, 'open_tiktok');
  assert.equal(sent[0].req.headers.Cache, 'no');
  assert.equal(new NtfySender({ topic: 'guessable' }).configured, false);
});

test('ntfy trigger-mode gateway requires admin, rate limits, rejects unsafe actions', async t => {
  let now = 10000;
  const sent = [];
  const server = await createAgentServer({
    stateStore: { load: async () => ({ deviceSecretHash: null, apnsToken: null }), save: async () => {} },
    apns: { triggerOnly: true, configured: true, send: async (_token, action) => sent.push(action) },
    adminToken: 'test-admin-token-with-32-random-characters', pairingCode: '11112222', now: () => now,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/admin/commands`;
  const post = async (action, auth) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify({ action }) });
    return { status: res.status, json: await res.json() };
  };
  const key = 'test-admin-token-with-32-random-characters';
  assert.equal((await post('open_tiktok', 'bad')).status, 401);
  assert.equal((await post('tap_coordinates', key)).status, 400);
  const first = await post('open_tiktok', key);
  assert.equal(first.status, 202);
  assert.equal(first.json.status, 'notification_sent_not_executed');
  assert.equal((await post('open_youtube', key)).status, 429);
  now += 3001;
  assert.equal((await post('open_youtube', key)).status, 202);
  assert.deepEqual(sent, ['open_tiktok', 'open_youtube']);
});
