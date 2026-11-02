import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError } from '../src/errors.js';
import { toRootResult } from '../src/root-errors.js';
import { toolUnavailable } from '../src/relay-channel.js';

test('root helper failures return safe actionable codes without stack traces or arbitrary paths', () => {
  const known: Array<[Error, string]> = [
    [new AgentError('ROOT_DISABLED', 'disabled'), 'ROOT_DISABLED'],
    [new Error('Root job history full; restart the helper to clear it'), 'ROOT_HISTORY_FULL'],
    [new Error('At most two root commands may run concurrently'), 'ROOT_BUSY'],
    [new Error('Unknown root execution ID'), 'ROOT_EXECUTION_EXPIRED'],
    [new Error('Root helper response timeout'), 'ROOT_RESPONSE_TIMEOUT'],
    [Object.assign(new Error('connect ECONNREFUSED /run/remote-mcp-root/exec.sock'),
      { code: 'ECONNREFUSED' }), 'ROOT_SOCKET_UNAVAILABLE'],
  ];
  for (const [error, code] of known) {
    const result = toRootResult(error);
    assert.equal(result.code, code);
    assert.ok(result.nextStep.length > 15);
    assert.doesNotMatch(JSON.stringify(result), /\/run\/remote-mcp-root/);
  }
  const unknown = toRootResult(new Error('SECRET=/example/path private stack trace'));
  assert.equal(unknown.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET|\/example\/path/);
});

test('offline or timed-out Mac tools tell the agent what to inspect next', () => {
  for (const [message, code] of [
    ['Mac agent is offline', 'MAC_OFFLINE'],
    ['Mac agent response timed out', 'MAC_RESPONSE_TIMEOUT'],
    ['Too many concurrent tool requests', 'RELAY_BUSY'],
  ]) {
    const result = toolUnavailable(message);
    assert.equal(result.isError, true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(body.error.code, code);
    assert.ok(body.error.nextStep);
  }
});
