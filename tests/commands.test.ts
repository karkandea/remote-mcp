import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { CommandTools } from '../src/commands.js';
import { PathPolicy } from '../src/policy.js';

async function commandFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-command-'));
  const config = configSchema.parse({ allowedRoots: [root], commandProfiles: {
    short: { executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'], cwd: root, timeoutMs: 1000 },
    long: { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: root, timeoutMs: 5000 },
  } });
  return new CommandTools(await PathPolicy.create(config), config);
}

async function waitForEnd(commands: CommandTools, id: string) {
  for (let i = 0; i < 40; i++) {
    const state = commands.poll(id) as { status: string; exitCode: number | null; stdout: string };
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Process did not finish within test timeout');
}

test('arbitrary commands are denied', async () => {
  const commands = await commandFixture();
  await assert.rejects(commands.start('shell-anything'), /Unknown or unauthorized/);
});

test('configured command yields real stdout and exit code', async () => {
  const commands = await commandFixture();
  const started = await commands.start('short') as { executionId: string };
  const state = await waitForEnd(commands, started.executionId);
  assert.equal(state.status, 'completed');
  assert.equal(state.exitCode, 0);
  assert.equal(state.stdout, 'ok');
});

test('configured long-running command can be cancelled', async () => {
  const commands = await commandFixture();
  const started = await commands.start('long') as { executionId: string };
  assert.equal((commands.cancel(started.executionId) as { status: string }).status, 'cancelled');
});
