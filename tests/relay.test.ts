import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
import { configSchema } from '../src/config.js';
import { runRemoteAgent, validateAgentConnection } from '../src/remote-agent.js';
import { safeTokenEqual } from '../src/relay-channel.js';
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
    const healthBeforeAgent = await fetch(`${base}/healthz`);
    assert.equal(healthBeforeAgent.status, 200);
    assert.deepEqual(await healthBeforeAgent.json(), { ok: true, agentConnected: false });
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json() as { authorization_servers: string[] }).authorization_servers,
      [relayConfig.authIssuer]);
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
    assert.equal(listed.tools.length, 37);
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
    assert.match(JSON.stringify(rootDenied.content), /disabled/);
    assert.match(JSON.stringify(rootDenied.content), /ROOT_DISABLED/);
    const anonymousRoot = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vps_root_exec',
        arguments: { argv: ['/usr/bin/id'], cwd: '/', timeoutMs: 1000 } } }),
    });
    assert.equal(anonymousRoot.status, 401);
    const offline = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(offline.isError, true);
    assert.match(JSON.stringify(offline.content), /offline/);
    assert.match(JSON.stringify(offline.content), /MAC_OFFLINE/);

    let ready!: () => void;
    const connected = new Promise<void>(resolve => { ready = resolve; });
    let readyAgain!: () => void;
    const reconnected = new Promise<void>(resolve => { readyAgain = resolve; });
    let connectionCount = 0;
    agentPromise = runRemoteAgent(configSchema.parse({ allowedRoots: [root] }), {
      url: `ws://127.0.0.1:${relay.port}/agent/ws`, token: secret, signal: abort.signal,
      onConnect: () => { if (++connectionCount === 1) ready(); else readyAgain(); },
    });
    await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('Agent connection timeout')), 5000))]);
    assert.equal(relay.channel.connected, true);
    const healthWithAgent = await fetch(`${base}/healthz`);
    assert.deepEqual(await healthWithAgent.json(), { ok: true, agentConnected: true });
    const read = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read.content), /actual Mac document through relay/);
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
    const afterReconnect = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(afterReconnect.isError, undefined);
    abort.abort();
    await agentPromise;
    for (let attempt = 0; attempt < 100 && relay.channel.connected; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(relay.channel.connected, false);
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
