import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
import { configSchema } from '../src/config.js';
import { isLocalWindowsPath } from '../src/policy.js';
import { runRemoteAgent } from '../src/remote-agent.js';
import { startRelayServer, validateRelayConfig, type RelayConfig } from '../src/relay-server.js';
import { DEVICE_HEADER, deviceFingerprint, enrollWindowsDevice, loadWindowsDevice, setWindowsPackages, setWindowsWrites,
  windowsFingerprint } from '../src/windows-device.js';

const macToken = 'f'.repeat(64);
const relayConfig: RelayConfig = {
  publicOrigin: 'https://mcp.example.test', authIssuer: 'https://auth.example.test',
  jwksUrl: 'https://auth.example.test/keys', ownerSubject: 'owner-test',
  deviceToken: macToken, bind: '127.0.0.1', port: 0,
};

test('Windows local file paths exclude device, network, stream and alias syntax', () => {
  assert.equal(isLocalWindowsPath(String.raw`C:\Users\Ais\MCP Workspace\sample.txt`), true);
  assert.equal(isLocalWindowsPath('C:/Users/Ais/sample.txt'), true);
  for (const value of [String.raw`\\server\share\file`, String.raw`\\?\C:\file`, String.raw`\relative`,
    'C:relative', 'C:/folder/file.txt:stream', 'C:/folder/file. ', 'C:/NUL.txt', 'C:/PROGRA~1/file']) {
    assert.equal(isLocalWindowsPath(value), false, value);
  }
});

test('Windows enrollment is owner scoped and routes independently of the legacy Mac', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'remote-mcp-windows-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const oldFlag = process.env.REMOTE_MCP_ALLOW_NON_MAC;
  const oldConfig = process.env.REMOTE_MCP_CONFIG;
  process.env.REMOTE_MCP_ALLOW_NON_MAC = '1';
  process.env.REMOTE_MCP_CONFIG = path.join(scratch, 'mac-state', 'config.json');
  t.after(() => {
    if (oldFlag === undefined) delete process.env.REMOTE_MCP_ALLOW_NON_MAC;
    else process.env.REMOTE_MCP_ALLOW_NON_MAC = oldFlag;
    if (oldConfig === undefined) delete process.env.REMOTE_MCP_CONFIG;
    else process.env.REMOTE_MCP_CONFIG = oldConfig;
  });
  const windowsRoot = path.join(scratch, 'ais files');
  const macRoot = path.join(scratch, 'mac files');
  const privateDir = path.join(scratch, 'windows-state');
  await Promise.all([mkdir(windowsRoot), mkdir(macRoot)]);
  const windowsFile = path.join(windowsRoot, 'example.txt');
  const macFile = path.join(macRoot, 'example.txt');
  await Promise.all([writeFile(windowsFile, 'Windows fixture'), writeFile(macFile, 'Mac fixture')]);
  const relayUrl = 'ws://127.0.0.1:3417/agent/ws';
  await assert.rejects(enrollWindowsDevice(privateDir, relayUrl, scratch), /separate working folder/);
  const fingerprint = await enrollWindowsDevice(privateDir, relayUrl, windowsRoot);
  assert.equal(await windowsFingerprint(privateDir), fingerprint);
  await assert.rejects(enrollWindowsDevice(privateDir, relayUrl, windowsRoot), /already initialized/);
  const windows = await loadWindowsDevice(privateDir);
  assert.equal(windows.config.allowWrites, false);
  assert.deepEqual(windows.config.windowsPackages, []);
  await assert.rejects(setWindowsPackages(privateDir, ['--source']), /exact WinGet package IDs/);
  assert.equal(deviceFingerprint(windows.token), fingerprint);
  assert.notEqual(windows.token, fingerprint);
  assert.throws(() => validateRelayConfig({ ...relayConfig, windowsDeviceFingerprint: deviceFingerprint(macToken) }),
    /distinct from the Mac credential/);
  const relay = await startRelayServer({ ...relayConfig, windowsDeviceFingerprint: fingerprint },
    async token => token === 'test-owner');
  const client = new Client({ name: 'windows-routing-test', version: '1.0.0' });
  const macAbort = new AbortController();
  const windowsAbort = new AbortController();
  const windowsWriteAbort = new AbortController();
  const agents: Promise<void>[] = [];
  const ws = `ws://127.0.0.1:${relay.port}/agent/ws`;
  const endpoint = `http://127.0.0.1:${relay.port}/mcp`;
  const connect = async (config: typeof windows.config, token: string, signal: AbortSignal, isWindows = false) => {
    const ready = Promise.withResolvers<void>();
    const agent = runRemoteAgent(config, { url: ws, token, signal, onConnect: ready.resolve },
      isWindows ? { device: windows.device } : undefined);
    agents.push(agent);
    await Promise.race([ready.promise, agent, delay(5000, undefined, { ref: false }).then(() => {
      throw new Error('Timed out waiting for device connection');
    })]);
  };
  const forbidden = (token: string, header?: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(ws, { headers: { Authorization: `Bearer ${token}`,
      ...(header ? { [DEVICE_HEADER]: header } : {}) } });
    socket.once('error', reject);
    socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized socket connected')); });
    socket.once('unexpected-response', (_, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
  });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),
      { authProvider: { token: async () => 'test-owner' } }));
    const listed = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(listed.includes('windows_fs_read'));
    assert.ok(listed.includes('windows_fs_create'));
    assert.ok(listed.includes('windows_fs_apply_patch'));
    assert.ok(listed.includes('windows_fs_delete'));
    assert.ok(listed.includes('windows_package_install'));
    assert.ok(!listed.includes('windows_terminal_start'));
    assert.equal(await forbidden(macToken, 'windows'), 403);
    assert.equal(await forbidden(windows.token), 403);
    assert.equal(await forbidden(fingerprint, 'windows'), 403);
    assert.equal(await forbidden(windows.token, 'unknown'), 403);
    assert.match(JSON.stringify((await call('windows_device_status')).content), /Windows agent is offline/);
    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'windows_device_status' } }) });
    assert.equal(unauthorized.status, 401);
    const legacySocket = new WebSocket(ws, { headers: { Authorization: `Bearer ${windows.token}`,
      [DEVICE_HEADER]: 'windows' } });
    const legacyClosed = Promise.withResolvers<void>();
    legacySocket.once('close', legacyClosed.resolve);
    await new Promise<void>((resolve, reject) => {
      legacySocket.once('open', resolve);
      legacySocket.once('error', reject);
    });
    const createdFile = path.join(windowsRoot, 'new.txt');
    const createArgs = { path: createdFile, content: 'hello\n' };
    try {
      assert.match(JSON.stringify((await call('windows_fs_create', createArgs)).content), /AGENT_UPDATE_REQUIRED/);
      assert.match(JSON.stringify((await call('windows_package_catalog')).content), /AGENT_UPDATE_REQUIRED/);
    } finally {
      legacySocket.close();
      await legacyClosed.promise;
    }
    await connect(windows.config, windows.token, windowsAbort.signal, true);
    assert.match(JSON.stringify((await call('windows_fs_read', { path: windowsFile })).content), /Windows fixture/);
    assert.match(JSON.stringify((await call('windows_fs_search', { directory: windowsRoot, query: 'fixture' })).content),
      /example.txt/);
    assert.match(JSON.stringify((await call('windows_fs_create', createArgs)).content), /WRITE_DISABLED/);
    assert.match(JSON.stringify((await call('windows_package_install', { id: 'CodeBlocks.CodeBlocks.MinGW' })).content),
      /PACKAGE_DENIED/);
    assert.match(JSON.stringify((await call('fs_read', { path: macFile })).content), /Mac agent is offline/);
    assert.equal(await forbidden(windows.token, 'windows'), 403);
    await connect(configSchema.parse({ allowedRoots: [macRoot] }), macToken, macAbort.signal);
    assert.match(JSON.stringify((await call('fs_read', { path: macFile })).content), /Mac fixture/);
    assert.match(JSON.stringify((await call('windows_fs_read', { path: macFile })).content), /PATH_DENIED/);
    assert.match(JSON.stringify((await call('windows_fs_read', { path: path.join(privateDir, 'enrollment.json') })).content),
      /PATH_DENIED/);
    assert.match(JSON.stringify((await call('windows_device_disconnect')).content), /windows-resume/);
    assert.match(JSON.stringify((await call('windows_fs_read', { path: windowsFile })).content), /DEVICE_DISCONNECTED/);
    assert.match(JSON.stringify((await call('fs_read', { path: macFile })).content), /Mac fixture/);
    await windows.device.resumeLocally();
    assert.match(JSON.stringify((await call('windows_fs_read', { path: windowsFile })).content), /Windows fixture/);

    windowsAbort.abort();
    await agents[0];
    for (let tries = 0; tries < 100; tries++) {
      if (JSON.stringify((await call('windows_device_status')).content).includes('Windows agent is offline')) break;
      await delay(10);
    }
    await setWindowsWrites(privateDir, true);
    await setWindowsPackages(privateDir, ['CodeBlocks.CodeBlocks.MinGW']);
    const writable = await loadWindowsDevice(privateDir);
    assert.equal(writable.token, windows.token);
    await connect(writable.config, writable.token, windowsWriteAbort.signal, true);
    const data = async (name: string, args: Record<string, unknown> = {}) => {
      const item = (await call(name, args)).content?.[0];
      assert.ok(item?.type === 'text');
      return JSON.parse(item.text);
    };
    assert.equal((await data('windows_device_status')).data.writesEnabled, true);
    assert.deepEqual((await data('windows_package_catalog')).data.approved, ['CodeBlocks.CodeBlocks.MinGW']);
    assert.equal((await data('windows_package_install', { id: 'ApacheFriends.Xampp.8.2' })).error.code, 'PACKAGE_DENIED');
    const created = await data('windows_fs_create', createArgs);
    assert.equal(created.ok, true);
    assert.equal(await readFile(createdFile, 'utf8'), createArgs.content);
    assert.equal((await data('windows_fs_create', { ...createArgs, content: 'different' })).error.code, 'EEXIST');
    const patch = { path: createdFile, expectedText: 'hello', replacementText: 'halo',
      expectedSha256: created.data.sha256 };
    const patched = await data('windows_fs_apply_patch', patch);
    assert.equal(patched.ok, true);
    assert.equal((await data('windows_fs_read', { path: createdFile })).data.content, 'halo\n');
    assert.equal((await data('windows_fs_apply_patch', patch)).error.code, 'CONFLICT');
    const deletion = { path: createdFile, expectedSha256: patched.data.afterSha256 };
    assert.equal((await data('windows_fs_delete', { ...deletion, expectedSha256: created.data.sha256 })).error.code, 'CONFLICT');
    assert.equal((await data('windows_fs_delete', deletion)).ok, true);
    await assert.rejects(readFile(createdFile), { code: 'ENOENT' });
    assert.equal((await data('windows_fs_create', { ...createArgs, path: path.join(macRoot, 'new.txt') })).error.code, 'PATH_DENIED');
    assert.equal((await data('windows_fs_create', { ...createArgs, path: path.join(windowsRoot, '.env') })).error.code, 'SENSITIVE_PATH');
    const junction = path.join(windowsRoot, 'outside');
    await symlink(macRoot, junction, 'junction');
    assert.equal((await data('windows_fs_create', { ...createArgs, path: path.join(junction, 'new.txt') })).error.code, 'PATH_DENIED');
    await setWindowsWrites(privateDir, false);
    await setWindowsWrites(privateDir, false);
    assert.equal((await loadWindowsDevice(privateDir)).config.allowWrites, false);
  } finally {
    macAbort.abort();
    windowsAbort.abort();
    windowsWriteAbort.abort();
    await Promise.allSettled(agents);
    await client.close();
    await relay.close();
  }
});
