import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { callRootHelper, startRootHelper } from '../src/root-helper.js';
import { createProxyServer } from '../src/proxy-server.js';
import { RelayChannel } from '../src/relay-channel.js';

test('root-helper Unix socket manages start, poll, cancellation, without any network listener',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-root-test-'));
  const socket = path.join(root, 'helper.sock');
  const helper = await startRootHelper(socket, { requireRoot: false }); // fake-root test only
  try {
    const status = await callRootHelper(socket, { action: 'status' }) as { enabled: boolean };
    assert.equal(status.enabled, true);
    const started = await callRootHelper(socket, { action: 'start', argv: [process.execPath,
      '-e', 'process.stdout.write("root-test")'], cwd: root, timeoutMs: 2000 }) as { executionId: string };
    let result: { status: string; stdout: string } | undefined;
    for (let index = 0; index < 50; index++) {
      result = await callRootHelper(socket, { action: 'poll', executionId: started.executionId }) as typeof result;
      if (result?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(result?.status, 'completed');
    assert.equal(result.stdout, 'root-test');
    const long = await callRootHelper(socket, { action: 'start', argv: [process.execPath,
      '-e', 'setTimeout(() => {}, 30000)'], cwd: root, timeoutMs: 5000 }) as { executionId: string };
    const stopped = await callRootHelper(socket, { action: 'cancel', executionId: long.executionId }) as { status: string };
    assert.equal(stopped.status, 'cancelled');
    await assert.rejects(callRootHelper(socket, { action: 'poll', executionId: '00000000-0000-4000-8000-000000000000' }),
      /Unknown root execution/);
    await assert.rejects(callRootHelper(socket, { action: 'start', argv: [process.execPath], cwd: '.', timeoutMs: 2000 }),
      /absolute cwd/);
  } finally { await helper.close(); }
});

test('proxy root tools connect only to a configured Unix socket',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-root-proxy-'));
  const socketPath = path.join(root, 'helper.sock');
  const helper = await startRootHelper(socketPath, { requireRoot: false });
  const server = createProxyServer(new RelayChannel(), async () => ({}), socketPath);
  const client = new Client({ name: 'root-proxy-test', version: '0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const status = await client.callTool({ name: 'vps_root_status', arguments: {} });
    assert.equal(status.isError, undefined);
    assert.match(JSON.stringify(status.content), /enabled/);
    const execution = await client.callTool({ name: 'vps_root_exec', arguments: {
      argv: [process.execPath, '-e', 'process.stdout.write("proxy-root")'], cwd: root, timeoutMs: 3000,
    } });
    assert.equal(execution.isError, undefined);
    const text = execution.content[0];
    assert.equal(text?.type, 'text');
    const result = JSON.parse(text.text) as { data: { executionId: string } };
    assert.ok(result.data.executionId);
    let output = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await client.callTool({ name: 'vps_root_poll', arguments: { executionId: result.data.executionId } });
      const body = polled.content[0];
      assert.equal(body?.type, 'text');
      const state = JSON.parse(body.text) as { data: { status: string; stdout: string } };
      output = state.data.stdout;
      if (state.data.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(output, 'proxy-root');
  } finally {
    await client.close();
    await server.close();
    await helper.close();
  }
});

test('completed root jobs are evicted before history capacity blocks new commands',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-root-history-'));
  const socket = path.join(root, 'helper.sock');
  const helper = await startRootHelper(socket, { requireRoot: false });
  try {
    let firstExecutionId = '';
    for (let i = 0; i < 102; i++) {
      const started = await callRootHelper(socket, { action: 'start',
        argv: [process.execPath, '-e', ''], cwd: root, timeoutMs: 5000 }) as { executionId: string };
      if (i === 0) firstExecutionId = started.executionId;
      let result: { status: string } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await callRootHelper(socket, { action: 'poll', executionId: started.executionId }) as typeof result;
        if (result?.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(result?.status, 'completed', `command ${i + 1} should finish`);
    }
    const status = await callRootHelper(socket, { action: 'status' }) as { retainedJobs: number; retainedJobsLimit: number };
    assert.equal(status.retainedJobs, 100);
    assert.equal(status.retainedJobsLimit, 100);
    await assert.rejects(callRootHelper(socket, { action: 'poll', executionId: firstExecutionId }),
      /Unknown root execution/);
  } finally { await helper.close(); }
});
