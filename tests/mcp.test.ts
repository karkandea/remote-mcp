import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configSchema } from '../src/config.js';
import { DeviceState } from '../src/device.js';
import { createContext, createServer } from '../src/server.js';

test('real MCP client discovers tools, reads a real file, and obeys device revocation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-integration-'));
  const file = path.join(root, 'real-file.txt');
  await writeFile(file, 'actual data from disk');
  const config = configSchema.parse({ allowedRoots: [root] });
  const server = createServer(await createContext(config, new DeviceState(path.join(root, 'state'))));
  const client = new Client({ name: 'integration-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'fs_read'));
    assert.ok(tools.tools.some(tool => tool.name === 'terminal_start'));
    const result = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /actual data from disk/);
    const disconnected = await client.callTool({ name: 'device_disconnect', arguments: {} });
    assert.equal(disconnected.isError, undefined);
    const blocked = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked.content), /DEVICE_DISCONNECTED/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP limits serialized output without refusing short reads at minimum output budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-response-test-'));
  const small = path.join(root, 'small.txt');
  const large = path.join(root, 'large.txt');
  await writeFile(small, 'short content');
  await writeFile(large, 'x'.repeat(2048));
  const config = configSchema.parse({ allowedRoots: [root], maxOutputBytes: 1024 });
  const server = createServer(await createContext(config, new DeviceState(path.join(root, 'state'))));
  const client = new Client({ name: 'output-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const shortResult = await client.callTool({ name: 'fs_read', arguments: { path: small } });
    assert.equal(shortResult.isError, undefined);
    assert.match(JSON.stringify(shortResult.content), /short content/);
    const longResult = await client.callTool({ name: 'fs_read', arguments: { path: large } });
    assert.equal(longResult.isError, true);
    assert.match(JSON.stringify(longResult.content), /OUTPUT_TOO_LARGE/);
  } finally {
    await client.close();
    await server.close();
  }
});
