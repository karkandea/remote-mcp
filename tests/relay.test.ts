import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import WebSocket from 'ws';
import { configSchema } from '../src/config.js';
import { runRemoteAgent, validateAgentConnection } from '../src/remote-agent.js';
import { RelayChannel, safeTokenEqual } from '../src/relay-channel.js';
import { createProxyServer } from '../src/proxy-server.js';
import { listVpsIterations, recordVpsIteration } from '../src/vps-storage.js';
import { startRelayServer, validateRelayConfig, type RelayConfig } from '../src/relay-server.js';

const secret = 'test-0123456789-0123456789-0123456789';
const relayConfig: RelayConfig = {
  publicOrigin: 'https://mcp.example.test', authIssuer: 'https://auth.example.test',
  jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
  ownerSubject: 'owner-test', deviceToken: secret, bind: '127.0.0.1', port: 0,
};

test('relay configuration fails closed and compares device credentials safely', () => {
  assert.doesNotThrow(() => validateRelayConfig(relayConfig));
  assert.throws(() => validateRelayConfig({ ...relayConfig, bind: '0.0.0.0' }), /loopback/);
  assert.throws(() => validateRelayConfig({ ...relayConfig, publicOrigin: 'http://mcp.example.test' }), /HTTPS/);
  assert.throws(() => validateRelayConfig({ ...relayConfig, jwksUrl: 'https://evil.test/keys' }), /issuer origin/);
  assert.throws(() => validateRelayConfig({ ...relayConfig, deviceToken: 'weak' }), /32/);
  assert.throws(() => validateRelayConfig({ ...relayConfig, rootHelperSocket: '/tmp/evil.sock' }), /ROOT_HELPER_SOCKET/);
  assert.throws(() => validateAgentConnection({ url: 'ws://public.example.test/agent/ws', token: secret }), /wss/);
  assert.throws(() => validateAgentConnection({ url: 'wss://example.test/agent/ws?token=secret', token: secret }), /without credentials/);
  assert.equal(safeTokenEqual(`Bearer ${secret}`, secret), true);
  assert.equal(safeTokenEqual(`Bearer ${secret}x`, secret), false);
  assert.equal(safeTokenEqual('Bearer wrong', secret), false);
});

test('OAuth gate blocks anonymous callers; MCP request crosses VPS channel and respects local policy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-relay-'));
  const file = path.join(root, 'example.txt');
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'remote-mcp-outside-'));
  const outside = path.join(outsideRoot, 'not-authorized.txt');
  await writeFile(file, 'actual Mac document through relay');
  await writeFile(outside, 'must not leak');
  const relay = await startRelayServer(relayConfig, async token => token === 'authorized-test-token',
    async () => ({ host: 'test-vps', readOnly: true, rootDisk: { availableBytes: 123456 } }));
  const base = `http://127.0.0.1:${relay.port}`;
  const previousMacFlag = process.env.REMOTE_MCP_ALLOW_NON_MAC;
  const previousConfig = process.env.REMOTE_MCP_CONFIG;
  process.env.REMOTE_MCP_ALLOW_NON_MAC = '1';
  process.env.REMOTE_MCP_CONFIG = path.join(root, 'config.json');
  const abort = new AbortController();
  let agentPromise: Promise<void> | undefined;
  const client = new Client({ name: 'http-relay-test', version: '0.1.0' });
  try {
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json() as { authorization_servers: string[] }).authorization_servers,
      [relayConfig.authIssuer]);
    const initiallyOffline = await fetch(`${base}/readyz`);
    assert.equal(initiallyOffline.status, 503);
    assert.deepEqual(await initiallyOffline.json(), { ok: false, agentConnected: false });
    const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);
    const badToken = await fetch(`${base}/mcp`, { method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
    assert.equal(badToken.status, 401);
    const forbiddenUpgrade = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/agent/ws`, {
        headers: { authorization: 'Bearer invalid-device-credential' },
      });
      ws.once('unexpected-response', (_, response) => {
        const code = response.statusCode ?? 0;
        response.resume();
        resolve(code);
      });
      ws.once('open', () => reject(new Error('Unauthorized device WebSocket was accepted')));
      ws.once('error', error => reject(error));
    });
    assert.equal(forbiddenUpgrade, 403);

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
      { authProvider: { token: async () => 'authorized-test-token' } });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 41);
    assert.ok(listed.tools.some(tool => tool.name === 'batch_read'));
    assert.ok(listed.tools.some(tool => tool.name === 'vps_host_status'));
    assert.equal(listed.tools.find(tool => tool.name === 'batch_read')?.annotations?.readOnlyHint, true);
    assert.ok(listed.tools.some(tool => tool.name === 'vps_storage_audit'));
    assert.ok(listed.tools.some(tool => tool.name === 'iphone_screenshot'));
    assert.ok(listed.tools.some(tool => tool.name === 'mac_user_exec'));
    assert.ok(listed.tools.some(tool => tool.name === 'vps_root_exec'));
    const audit = await client.callTool({ name: 'vps_storage_audit', arguments: {} });
    assert.equal(audit.isError, undefined);
    assert.match(JSON.stringify(audit.content), /test-vps/);
    const rootDenied = await client.callTool({ name: 'vps_root_exec', arguments: {
      argv: ['/usr/bin/id'], cwd: '/tmp', timeoutMs: 1000,
    } });
    assert.equal(rootDenied.isError, true);
    assert.match(JSON.stringify(rootDenied.content), /not enabled/);
    const anonymousRoot = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vps_root_exec',
        arguments: { argv: ['/usr/bin/id'], cwd: '/', timeoutMs: 1000 } } }),
    });
    assert.equal(anonymousRoot.status, 401);
    const offline = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(offline.isError, true);
    assert.match(JSON.stringify(offline.content), /offline/);
    const offlineBatch = await client.callTool({ name: 'batch_read', arguments: {
      mode: 'parallel', operations: [
        { tool: 'vps_storage_audit' },
        { tool: 'fs_read', args: { path: file } },
        { tool: 'vps_root_status' },
      ],
    } });
    assert.equal(offlineBatch.isError, undefined);
    const offlineBody = offlineBatch.content[0];
    assert.equal(offlineBody?.type, 'text');
    const offlineResults = JSON.parse(offlineBody.text) as { data: {
      succeeded: number; results: Array<{ ok: boolean; tool: string }> } };
    assert.equal(offlineResults.data.succeeded, 1);
    assert.deepEqual(offlineResults.data.results.map(item => item.tool),
      ['vps_storage_audit', 'fs_read', 'vps_root_status']);
    assert.deepEqual(offlineResults.data.results.map(item => item.ok), [true, false, false]);
    const forbiddenBatch = await client.callTool({ name: 'batch_read', arguments: {
      operations: [{ tool: 'fs_apply_patch', args: { path: file } }],
    } });
    assert.equal(forbiddenBatch.isError, true);

    let ready!: () => void;
    const connected = new Promise<void>(resolve => { ready = resolve; });
    let readyAgain!: () => void;
    const reconnected = new Promise<void>(resolve => { readyAgain = resolve; });
    let connectionCount = 0;
    const disconnectEvents: Array<{ closeCode: number; retryInMs: number }> = [];
    agentPromise = runRemoteAgent(configSchema.parse({ allowedRoots: [root] }), {
      url: `ws://127.0.0.1:${relay.port}/agent/ws`, token: secret, signal: abort.signal,
      onConnect: () => { if (++connectionCount === 1) ready(); else readyAgain(); },
      onDisconnect: event => disconnectEvents.push(event),
    });
    await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('Agent connection timeout')), 5000))]);
    assert.equal(relay.channel.connected, true);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const read = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read.content), /actual Mac document through relay/);
    const onlineBatch = await client.callTool({ name: 'batch_read', arguments: {
      mode: 'parallel', operations: [
        { tool: 'fs_read', args: { path: file } },
        { tool: 'fs_stat', args: { path: file } },
        { tool: 'device_status' },
        { tool: 'vps_storage_audit' },
      ],
    } });
    assert.equal(onlineBatch.isError, undefined);
    const onlineBody = onlineBatch.content[0];
    assert.equal(onlineBody?.type, 'text');
    const onlineData = JSON.parse(onlineBody.text) as { data: { succeeded: number; results: unknown[] } };
    assert.equal(onlineData.data.succeeded, 4);
    assert.equal(onlineData.data.results.length, 4);
    const blocked = await client.callTool({ name: 'fs_read', arguments: { path: outside } });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked.content), /PATH_DENIED/);
    const writes = await client.callTool({ name: 'fs_apply_patch', arguments: {
      path: file, expectedText: 'actual', replacementText: 'changed',
    } });
    assert.equal(writes.isError, true);
    // A healthy Mac agent must reconnect after the VPS closes its socket.
    relay.channel.close();
    await Promise.race([reconnected,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Agent reconnect timeout')), 5000))]);
    assert.equal(relay.channel.connected, true);
    assert.ok(disconnectEvents.length >= 1);
    assert.equal(disconnectEvents[0]?.retryInMs, 2_000);
    const afterReconnect = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(afterReconnect.isError, undefined);
    abort.abort();
    await agentPromise;
    for (let attempt = 0; attempt < 100 && relay.channel.connected; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(relay.channel.connected, false);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    const offlineAudit = await client.callTool({ name: 'vps_storage_audit', arguments: {} });
    assert.equal(offlineAudit.isError, undefined);
    assert.match(JSON.stringify(offlineAudit.content), /test-vps/);
    const afterDisconnect = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(afterDisconnect.isError, true);
    assert.match(JSON.stringify(afterDisconnect.content), /offline/);
  } finally {
    abort.abort();
    if (agentPromise) await agentPromise;
    await client.close();
    await relay.close();
    if (previousMacFlag === undefined) delete process.env.REMOTE_MCP_ALLOW_NON_MAC;
    else process.env.REMOTE_MCP_ALLOW_NON_MAC = previousMacFlag;
    if (previousConfig === undefined) delete process.env.REMOTE_MCP_CONFIG;
    else process.env.REMOTE_MCP_CONFIG = previousConfig;
  }
});

test('VPS improvement notes are persistent, private, bounded and reject common credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-iteration-'));
  const journal = path.join(root, 'iterations.jsonl');
  await assert.rejects(recordVpsIteration({
    category: 'observation', title: 'unsafe secret', finding: 'Bearer abc123xyz',
    outcome: 'Should never persist',
  }, journal), /credentials/);
  // Serialized simultaneous writes must not lose entries, and eviction never affects active commands.
  await Promise.all(Array.from({ length: 205 }, (_, index) => recordVpsIteration({
    category: index % 2 ? 'improvement' : 'decision',
    title: 'iteration-' + index, finding: 'Observed a deterministic state',
    outcome: 'Recorded safe summary', nextAction: 'Verify next iteration',
  }, journal)));
  const data = await listVpsIterations(50, undefined, journal) as {
    total: number; maxRetained: number; entries: Array<{ title: string }>;
  };
  assert.equal(data.total, 200);
  assert.equal(data.maxRetained, 200);
  assert.equal(data.entries.length, 50);
  assert.equal(data.entries[0]?.title, 'iteration-204');
  assert.equal(data.entries[49]?.title, 'iteration-155');
  const filtered = await listVpsIterations(10, 'improvement', journal) as { entries: Array<{
    category: string;
  }> };
  assert.ok(filtered.entries.every(entry => entry.category === 'improvement'));
  const info = await stat(journal);
  assert.equal(info.mode & 0o777, 0o600);
});

test('hybrid batch limits concurrency to four, keeps item ordering and supports sequential mode', async () => {
  let active = 0;
  let peak = 0;
  const server = createProxyServer(new RelayChannel(), async () => {
    active++;
    peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    return { from: 'bounded-vps-read' };
  });
  const client = new Client({ name: 'batch-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const operations = Array.from({ length: 8 }, () => ({ tool: 'vps_storage_audit' }));
    const parallel = await client.callTool({ name: 'batch_read', arguments: { mode: 'parallel', operations } });
    assert.equal(parallel.isError, undefined);
    const parallelText = parallel.content[0];
    assert.equal(parallelText?.type, 'text');
    const parallelReport = JSON.parse((parallelText as { text: string }).text) as {
      data: { succeeded: number; results: Array<{ index: number; ok: boolean }> };
    };
    assert.equal(parallelReport.data.succeeded, 8);
    assert.deepEqual(parallelReport.data.results.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(peak, 4);
    peak = 0;
    const sequential = await client.callTool({ name: 'batch_read', arguments: { mode: 'sequential', operations } });
    assert.equal(sequential.isError, undefined);
    assert.equal(peak, 1);
    const blockedArguments = await client.callTool({ name: 'batch_read', arguments: {
      operations: [{ tool: 'fs_read', args: { path: '/tmp/not-allowed', command: 'delete' } }],
    } });
    const invalidText = blockedArguments.content[0];
    assert.equal(invalidText?.type, 'text');
    const rejected = JSON.parse((invalidText as { text: string }).text) as {
      data: { results: Array<{ ok: boolean }> };
    };
    assert.equal(rejected.data.results[0]?.ok, false);
  } finally {
    await client.close();
    await server.close();
  }
});
