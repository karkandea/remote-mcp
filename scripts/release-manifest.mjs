#!/usr/bin/env node
// Generate and verify a pinned release artifact before any administrator activates it.
// No service management, copying into /opt, or rollback is performed here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'release-manifest.json';
const REQUIRED_FILES = ['cli.js', 'root-helper.js', 'relay-server.js', 'proxy-server.js'];

function validSha(sha) {
  assert.match(sha || '', /^[0-9a-f]{40}$/, 'Expected a pinned 40-character Git commit SHA');
}

async function distFiles(root, relative = '') {
  const base = path.join(root, 'dist', relative);
  const listing = await readdir(base, { withFileTypes: true });
  const all = [];
  for (const item of listing) {
    const rel = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Symlink forbidden in dist: ${rel}`);
    if (item.isDirectory()) all.push(...await distFiles(root, rel));
    else if (item.isFile()) all.push(rel);
    else throw new Error(`Unexpected non-file release artifact: ${rel}`);
  }
  return all.sort();
}

async function hashFiles(root, paths) {
  const files = [];
  for (const rel of paths) {
    const absolute = path.join(root, 'dist', rel);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid release file: ${rel}`);
    if (stat.size > 16 * 1024 * 1024) throw new Error(`Oversized release file: ${rel}`);
    const buffer = await readFile(absolute);
    files.push({ path: rel, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
  }
  return files;
}

async function inspectRelease(root) {
  const distStat = await lstat(path.join(root, 'dist'));
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
    throw new Error('Release dist must be a real directory, not a symlink');
  }
  const paths = await distFiles(root);
  for (const required of REQUIRED_FILES) {
    if (!paths.includes(required)) throw new Error(`Missing release module: ${required}`);
  }
  // Guard against accidentally reinstalling the pre-PR #24 helper that locks at 100 jobs.
  const helper = await readFile(path.join(root, 'dist', 'root-helper.js'), 'utf8');
  if (!helper.includes('no completed jobs can be evicted') || !helper.includes('retainedJobsLimit')) {
    throw new Error('Release is missing the root job-retention fix from PR #24');
  }
  return await hashFiles(root, paths);
}

export async function createManifest(root, commit) {
  validSha(commit);
  const files = await inspectRelease(root);
  const manifest = { schemaVersion: 1, commit, generatedAt: new Date().toISOString(), files };
  await writeFile(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return manifest;
}

export async function verifyManifest(root, expectedCommit) {
  validSha(expectedCommit);
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.commit !== expectedCommit || !Array.isArray(manifest.files)) {
    throw new Error('Manifest schema or pinned Git commit does not match');
  }
  const actual = await inspectRelease(root);
  // Compare the entire exact file inventory, not only files listed by a potentially stale manifest.
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Release artifact inventory or SHA-256 does not match manifest');
  }
  return { commit: manifest.commit, files: actual.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [action, root, commit] = process.argv.slice(2);
  if (!['create', 'verify'].includes(action) || !root || !path.isAbsolute(root) || !commit) {
    process.stderr.write('Usage: release-manifest.mjs create|verify ABSOLUTE_RELEASE_DIRECTORY 40_HEX_COMMIT\n');
    process.exitCode = 2;
  } else {
    (action === 'create' ? createManifest(root, commit) : verifyManifest(root, commit))
      .then(result => process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n'))
      .catch(error => { process.stderr.write(`Release gate failed: ${error.message}\n`); process.exitCode = 1; });
  }
}
