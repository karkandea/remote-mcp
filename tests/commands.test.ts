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

test('Mac full-user mode is denied by default even when caller supplies a safe argv', async () => {
  const commands = await commandFixture();
  await assert.rejects(commands.startAsUser([process.execPath, '-e', 'console.log("no")'], '/tmp', 1000),
    /not enabled/);
});

test('Mac full-user mode executes with the local account only after persistent local opt-in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-mcp-full-user-'));
  const config = configSchema.parse({ allowedRoots: [], fullUserMode: { enabled: true } });
  const commands = new CommandTools(await PathPolicy.create(config), config);
  const started = await commands.startAsUser([process.execPath, '-e', 'process.stdout.write(process.getuid().toString())'], root,
    5000) as { executionId: string };
  const completed = await waitForEnd(commands, started.executionId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.stdout, String(process.getuid()));
  await assert.rejects(commands.startAsUser([process.execPath], '.', 1000), /absolute/);
});

test('finished executions are bounded and never block the next command', async () => {
  const commands = await commandFixture();
  let oldestId = '';
  for (let index = 0; index < 65; index++) {
    const started = await commands.start('short') as { executionId: string };
    if (index === 0) oldestId = started.executionId;
    const finished = await waitForEnd(commands, started.executionId);
    assert.equal(finished.status, 'completed');
  }
  const health = commands.health();
  assert.equal(health.running, 0);
  assert.ok(health.completedRetained <= 60);
  assert.throws(() => commands.poll(oldestId), /Unknown execution ID/);
  const next = await commands.start('short') as { executionId: string };
  assert.equal((await waitForEnd(commands, next.executionId)).status, 'completed');
});

test('concurrent execution guard still protects the Mac', async () => {
  const commands = await commandFixture();
  const started = await Promise.all(Array.from({ length: 3 },
    () => commands.start('long') as Promise<{ executionId: string }>));
  try {
    await assert.rejects(commands.start('short'), /At most three commands/);
    assert.equal(commands.health().running, 3);
  } finally {
    for (const job of started) commands.cancel(job.executionId);
  }
});
