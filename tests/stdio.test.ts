import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP stdio subprocess discovers tools and reads an actual authorized file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-stdio-'));
  const file = path.join(root, 'stdio-sample.txt');
  const config = path.join(root, 'config.json');
  await writeFile(file, 'real stdio connection');
  await writeFile(config, JSON.stringify({ allowedRoots: [root], deniedNames: ['.env'], allowWrites: false }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', 'start'],
    cwd: process.cwd(),
    env: { ...process.env, REMOTE_MCP_CONFIG: config, REMOTE_MCP_ALLOW_NON_MAC: '1' } as Record<string, string>,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) < 2048) stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'stdio-integration-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'fs_read'));
    const result = await client.callTool({ name: 'fs_read', arguments: { path: file } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /real stdio connection/);
  } catch (error) {
    throw new Error(`MCP stdio test failed: ${error instanceof Error ? error.message : String(error)}; child stderr: ${stderr.slice(0, 2048)}`, { cause: error });
  } finally {
    await client.close();
  }
});
