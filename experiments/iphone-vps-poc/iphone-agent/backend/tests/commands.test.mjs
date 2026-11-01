import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, CommandQueue, safeEqual } from '../src/commands.mjs';

test('rejects arbitrary UI instructions and consequential attendance', () => {
  const queue = new CommandQueue();
  assert.throws(() => queue.enqueue('tap'), /Unsupported/);
  assert.throws(() => queue.enqueue('attendance_clock_in'), /Unsupported/);
  assert.ok(Object.hasOwn(ACTIONS, 'open_starbridges'));
});

test('single-use queue, idempotent cancel, expiration', () => {
  let t = 1000;
  const q = new CommandQueue({ now: () => t, ttlMs: 500 });
  const first = q.enqueue('open_youtube');
  assert.throws(() => q.enqueue('open_spotify'), /pending/);
  assert.deepEqual(q.take(), { id: first.id, action: 'open_youtube' });
  assert.equal(q.take(), null);
  const second = q.enqueue('open_spotify');
  assert.equal(q.cancel(first.id), false);
  assert.equal(q.cancel(second.id), true);
  q.enqueue('media_play_pause');
  t += 501;
  assert.equal(q.take(), null);
});

test('constant-time hash comparison contract', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'other'), false);
  assert.equal(safeEqual('', null), false);
});
