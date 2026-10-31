import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { FileTools } from '../src/files.js';
import { PathPolicy } from '../src/policy.js';

async function fixture(writes = false) {
  const base = await mkdtemp(path.join(tmpdir(), 'remote-mcp-test-'));
  const safe = path.join(base, 'safe');
  const outside = path.join(base, 'outside');
  await mkdir(safe); await mkdir(outside);
  const filename = path.join(safe, 'sample.txt');
  await writeFile(filename, 'hello\nTODO one\n');
  await writeFile(path.join(outside, 'secret.txt'), 'protected');
  const config = configSchema.parse({ allowedRoots: [safe], allowWrites: writes });
  const policy = await PathPolicy.create(config);
  return { base, safe, outside, filename, policy, files: new FileTools(policy, config) };
}

test('allowed file is readable and text search returns true line locations', async () => {
  const { safe, filename, files } = await fixture();
  const read = await files.read(filename) as { content: string; sha256: string };
  assert.equal(read.content, 'hello\nTODO one\n');
  assert.equal(read.sha256.length, 64);
  const result = await files.search(safe, 'TODO') as { matches: Array<{ line: number; path: string }> };
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.line, 2);
  assert.equal(result.matches[0]?.path, filename);
});

test('path traversal, outside files, and symlink escapes are rejected', async () => {
  const { safe, outside, policy } = await fixture();
  await assert.rejects(policy.readPath(path.join(safe, '..', 'outside', 'secret.txt')), /outside configured/);
  await assert.rejects(policy.readPath(path.join(outside, 'secret.txt')), /outside configured/);
  await symlink(path.join(outside, 'secret.txt'), path.join(safe, 'link.txt'));
  await assert.rejects(policy.readPath(path.join(safe, 'link.txt')), /outside configured/);
});

test('sensitive filenames remain denied even inside an allowed root', async () => {
  const { safe, policy } = await fixture();
  await writeFile(path.join(safe, '.env'), 'PASSWORD=do-not-read');
  await assert.rejects(policy.readPath(path.join(safe, '.env')), /protected paths/);
});

test('writes are off by default', async () => {
  const { files, filename } = await fixture();
  await assert.rejects(files.applyPatch(filename, 'hello', 'changed'), /Write permission is disabled/);
});

test('exact patch succeeds with hash; stale content and repeated matches fail closed', async () => {
  const { files, filename } = await fixture(true);
  const old = await files.read(filename) as { sha256: string };
  const result = await files.applyPatch(filename, 'hello', 'changed', old.sha256) as { afterSha256: string };
  assert.equal((await readFile(filename, 'utf8')).startsWith('changed'), true);
  assert.notEqual(result.afterSha256, old.sha256);
  await assert.rejects(files.applyPatch(filename, 'changed', 'x', old.sha256), /hash differs/);
  await assert.rejects(files.applyPatch(filename, 'e', 'z'), /exactly once/);
});
