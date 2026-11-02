import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createManifest, verifyManifest } from '../scripts/release-manifest.mjs';

const commit = 'a'.repeat(40);

async function sampleRelease(directory) {
  await mkdir(path.join(directory, 'dist'));
  for (const filename of ['cli.js', 'proxy-server.js', 'relay-server.js']) {
    await writeFile(path.join(directory, 'dist', filename), `// ${filename}\n`);
  }
  await writeFile(path.join(directory, 'dist', 'root-helper.js'),
    '// retainedJobsLimit\n// no completed jobs can be evicted\n');
}

test('release manifest pins all compiled files and exact commit, rejecting stale/tampered artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-release-'));
  try {
    await sampleRelease(directory);
    const created = await createManifest(directory, commit);
    assert.equal(created.files.length, 4);
    assert.deepEqual(await verifyManifest(directory, commit), { commit, files: 4 });
    await assert.rejects(verifyManifest(directory, 'b'.repeat(40)), /commit does not match/);
    await assert.rejects(createManifest(directory, commit), /EEXIST/);
    await writeFile(path.join(directory, 'dist', 'unexpected.js'), '// suspicious extra file\n');
    await assert.rejects(verifyManifest(directory, commit), /inventory or SHA-256/);
    await rm(path.join(directory, 'dist', 'unexpected.js'));
    await writeFile(path.join(directory, 'dist', 'cli.js'), '// tampered\n');
    await assert.rejects(verifyManifest(directory, commit), /inventory or SHA-256/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('release gate rejects old root helper and symlinked compiled code', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-release-old-'));
  const linkedDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-release-linked-'));
  try {
    await sampleRelease(directory);
    await writeFile(path.join(directory, 'dist', 'root-helper.js'), '// old helper\n');
    await assert.rejects(createManifest(directory, commit), /missing the root job-retention fix/);
    await writeFile(path.join(directory, 'dist', 'root-helper.js'),
      '// retainedJobsLimit\n// no completed jobs can be evicted\n');
    await symlink(path.join(directory, 'dist', 'cli.js'), path.join(directory, 'dist', 'link.js'));
    await assert.rejects(createManifest(directory, commit), /Symlink forbidden/);
    await symlink(path.join(directory, 'dist'), path.join(linkedDirectory, 'dist'));
    await assert.rejects(createManifest(linkedDirectory, commit), /real directory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(linkedDirectory, { recursive: true, force: true });
  }
});
