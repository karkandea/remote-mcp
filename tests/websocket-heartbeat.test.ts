import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { monitorWebSocketHeartbeat } from '../src/websocket-heartbeat.js';

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  terminated = false;
  answerPings = false;

  ping(): void {
    this.pings++;
    if (this.answerPings) queueMicrotask(() => this.emit('pong'));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('heartbeat terminates a half-open WebSocket when pongs stop', async () => {
  const socket = new TestSocket();
  let timeoutCount = 0;
  const stop = monitorWebSocketHeartbeat(socket as unknown as WebSocket, 15, 20, () => timeoutCount++);
  try {
    await Promise.race([
      once(socket, 'close'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Heartbeat did not time out')), 500)),
    ]);
    assert.equal(socket.pings, 1);
    assert.equal(socket.terminated, true);
    assert.equal(timeoutCount, 1);
    assert.equal(socket.listenerCount('pong'), 0);
  } finally { stop(); }
});

test('heartbeat keeps healthy connections and cleans timers on close', async () => {
  const socket = new TestSocket();
  socket.answerPings = true;
  const stop = monitorWebSocketHeartbeat(socket as unknown as WebSocket, 15, 30);
  try {
    await new Promise(resolve => setTimeout(resolve, 95));
    assert.ok(socket.pings >= 2);
    assert.equal(socket.terminated, false);
    socket.emit('close');
    assert.equal(socket.listenerCount('pong'), 0);
    const previousPings = socket.pings;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(socket.pings, previousPings);
  } finally { stop(); }
});
