import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configSchema, loadConfig } from '../src/config.js';
import { DeviceState } from '../src/device.js';
import { appiumLaunchPath } from '../src/iphone.js';
import { createContext, createServer } from '../src/server.js';

test('Appium launcher restores the actual Node directory when launchd omits it from PATH', () => {
  assert.equal(appiumLaunchPath('/usr/local/bin/node', '/usr/bin:/bin'), '/usr/local/bin:/usr/bin:/bin');
  assert.equal(appiumLaunchPath('/opt/homebrew/bin/node', '/opt/homebrew/bin:/usr/bin'),
    '/opt/homebrew/bin:/usr/bin');
});

test('Appium tools are local opt-in, use fixed W3C operations and restrict app activation', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
  const appium = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const body = raw ? JSON.parse(raw) as unknown : undefined;
    calls.push({ method: req.method ?? '', url: req.url ?? '', body });
    if (req.url === '/session' && req.method === 'POST') {
      // Xcode/WDA is usually much slower; proves the MCP tool does not block on startup.
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const value = req.url === '/status' ? { ready: true } :
      req.url === '/session' && req.method === 'POST' ? { sessionId: 'test123456', capabilities: {} } :
      req.url?.endsWith('/source') ? '<App>'.padEnd(300, 'x') + '</App>' :
      req.url?.endsWith('/screenshot') ? png : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value }));
  });
  await new Promise<void>(resolve => appium.listen(0, '127.0.0.1', resolve));
  const address = appium.address();
  assert.ok(address && typeof address === 'object');
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-iphone-test-'));
  const config = configSchema.parse({ allowedRoots: [root], iphoneControl: {
    enabled: true, appiumPort: address.port, udid: '00008110-test-udid',
    allowedBundleIds: ['com.example.starbridge'], startupBundleId: 'com.example.starbridge',
  } });
  const server = createServer(await createContext(config, new DeviceState(path.join(root, 'state'))));
  const client = new Client({ name: 'iphone-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 32); // 22 Mac tools + 10 iPhone tools
    const serverStart = await client.callTool({ name: 'iphone_appium_server_start', arguments: {} });
    assert.equal(serverStart.isError, true);
    assert.match(JSON.stringify(serverStart.content), /IPHONE_CONFIG/);
    const started = await client.callTool({ name: 'iphone_session_start', arguments: {} });
    assert.match(JSON.stringify(started.content), /starting/);
    let ready = false;
    let lastStatus = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await client.callTool({ name: 'iphone_status', arguments: {} });
      lastStatus = JSON.stringify(status.content);
      const body = status.content[0]?.type === 'text' ? JSON.parse(status.content[0].text) as {
        data?: { sessionState?: string };
      } : {};
      if (body.data?.sessionState === 'ready') { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ready, true, lastStatus);
    const newSession = calls.find(call => call.url === '/session');
    assert.ok(newSession);
    const always = (newSession.body as { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(always['appium:udid'], '00008110-test-udid');
    assert.equal(always['appium:noReset'], true);
    assert.equal(always['appium:fullReset'], false);
    assert.equal(always['appium:automationName'], 'XCUITest');

    const denied = await client.callTool({ name: 'iphone_app_open', arguments: { bundleId: 'com.apple.Preferences' } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /IPHONE_APP_DENIED/);
    const opened = await client.callTool({ name: 'iphone_app_open', arguments: { bundleId: 'com.example.starbridge' } });
    assert.equal(opened.isError, undefined);
    const tapped = await client.callTool({ name: 'iphone_tap', arguments: { x: 100, y: 200 } });
    assert.equal(tapped.isError, undefined);
    const swiped = await client.callTool({ name: 'iphone_swipe', arguments: {
      fromX: 100, fromY: 500, toX: 100, toY: 150, durationMs: 400,
    } });
    assert.equal(swiped.isError, undefined);
    const actions = calls.filter(call => call.url === '/session/test123456/actions' && call.method === 'POST');
    assert.equal(actions.length, 2);
    assert.equal((actions[0]!.body as { actions: Array<{ parameters: { pointerType: string } }> }).actions[0]!.parameters.pointerType, 'touch');
    const source = await client.callTool({ name: 'iphone_ui_tree', arguments: { maxCharacters: 100 } });
    assert.match(JSON.stringify(source.content), /truncated/);
    const screenshot = await client.callTool({ name: 'iphone_screenshot', arguments: {} });
    assert.equal(screenshot.isError, undefined);
    const block = screenshot.content[0];
    assert.equal(block?.type, 'image');
    if (block?.type === 'image') {
      assert.equal(block.mimeType, 'image/png');
      assert.equal(block.data, png);
    }
    const ended = await client.callTool({ name: 'iphone_session_stop', arguments: {} });
    assert.equal(ended.isError, undefined);
    assert.ok(calls.some(call => call.url === '/session/test123456' && call.method === 'DELETE'));
    const noSession = await client.callTool({ name: 'iphone_tap', arguments: { x: 1, y: 2 } });
    assert.equal(noSession.isError, true);
    assert.match(JSON.stringify(noSession.content), /IPHONE_NO_SESSION/);
  } finally {
    await client.close();
    await server.close();
    appium.closeAllConnections();
    await new Promise<void>(resolve => appium.close(() => resolve()));
  }
});

test('iPhone tools are denied until locally enabled and invalid owner config fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-iphone-disabled-'));
  const config = configSchema.parse({ allowedRoots: [root] });
  const server = createServer(await createContext(config, new DeviceState(path.join(root, 'state'))));
  const client = new Client({ name: 'iphone-denied', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const disabled = await client.callTool({ name: 'iphone_status', arguments: {} });
    assert.equal(disabled.isError, true);
    assert.match(JSON.stringify(disabled.content), /IPHONE_DISABLED/);
    const revoked = await client.callTool({ name: 'device_disconnect', arguments: {} });
    assert.equal(revoked.isError, undefined);
    const stillDenied = await client.callTool({ name: 'iphone_session_start', arguments: {} });
    assert.equal(stillDenied.isError, true);
    assert.match(JSON.stringify(stillDenied.content), /DEVICE_DISCONNECTED/);
  } finally {
    await client.close();
    await server.close();
  }
  const invalid = configSchema.parse({ iphoneControl: {
    enabled: true, udid: '00008110-test-udid', startupBundleId: 'com.example.unapproved',
  } });
  const cfgPath = path.join(root, 'invalid-config.json');
  await writeFile(cfgPath, JSON.stringify(invalid));
  await assert.rejects(loadConfig(cfgPath), /startupBundleId must be in allowedBundleIds/);
});

test('owner-run setup creates a backup and does not expand filesystem or terminal permissions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-iphone-setup-'));
  const project = path.join(root, 'iphone-project');
  await mkdir(path.join(project, 'node_modules', '.bin'), { recursive: true });
  await symlink('/usr/bin/true', path.join(project, 'node_modules', '.bin', 'appium'));
  await chmod(project, 0o700);
  await writeFile(path.join(project, 'session-request.json'), JSON.stringify({ capabilities: { alwaysMatch: {
    'appium:udid': '00008110-test-udid', 'appium:bundleId': 'com.example.Starbridge',
  } } }));
  const initial = { allowedRoots: ['/safe/previous'], allowWrites: false,
    commandProfiles: { 'other-owned-command': { executable: '/usr/bin/true', args: [], cwd: '/safe/previous' } } };
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(initial), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath,
    ['scripts/setup-iphone-appium.mjs', project],
    { cwd: process.cwd(), env: { ...process.env, REMOTE_MCP_CONFIG: configPath } });
  assert.match(stdout, /owner opt-in configured/);
  const updated = await loadConfig(configPath);
  assert.deepEqual(updated.allowedRoots, initial.allowedRoots);
  assert.deepEqual(Object.keys(updated.commandProfiles), ['other-owned-command']);
  assert.equal(updated.iphoneControl.enabled, true);
  assert.deepEqual(updated.iphoneControl.allowedBundleIds, ['com.example.Starbridge']);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(`${configPath}.before-iphone-control`, 'utf8'), JSON.stringify(initial));
});
