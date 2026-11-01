import test from 'node:test';
import assert from 'node:assert/strict';
import { trigger } from './trigger.mjs';

const topic = 'iphoneagent_' + 'f'.repeat(52);

test('safe command generates a one-shot ntfy notification without publishing secrets', async () => {
  let request;
  const result = await trigger('open_youtube', { topic, fetchImpl: async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200 };
  } });
  assert.equal(result.notificationSent, true);
  assert.equal(result.status, 'notification_sent_not_executed');
  assert.equal(request.init.body, 'open_youtube');
  assert.equal(request.init.headers.Cache, 'no');
});

test('rejects arbitrary taps, attendance and guessable topics before HTTP', async () => {
  const deny = async () => { throw new Error('fetch should never be called'); };
  await assert.rejects(trigger('tap_300_400', { topic, fetchImpl: deny }), /Unsupported/);
  await assert.rejects(trigger('clock_in', { topic, fetchImpl: deny }), /Unsupported/);
  await assert.rejects(trigger('open_tiktok', { topic: 'iphoneagent_public', fetchImpl: deny }), /Invalid private/);
});

test('failed remote push is not reported as success', async () => {
  await assert.rejects(trigger('open_spotify', {
    topic, fetchImpl: async () => ({ ok: false, status: 429 }),
  }), /HTTP 429/);
});
