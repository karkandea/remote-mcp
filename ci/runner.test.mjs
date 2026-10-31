import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPodmanArgs, requirePinnedImage, requireSha } from './runner.mjs';

const sha = 'a'.repeat(40);
const image = `docker.io/library/node@sha256:${'b'.repeat(64)}`;

test('rejects malformed or user-injected commit SHA and unpinned images', () => {
  assert.equal(requireSha(sha), sha);
  assert.throws(() => requireSha('main; rm -rf /'), /invalid/);
  assert.throws(() => requireSha('A'.repeat(40)), /invalid/);
  assert.equal(requirePinnedImage(image), image);
  assert.throws(() => requirePinnedImage('docker.io/library/node:22-bookworm-slim'), /pinned/);
});

test('runner container has no privileged mounts and enforces resource caps', () => {
  const args = buildPodmanArgs({ checkout: '/tmp/ci-test-checkout', image,
    containerName: 'remote-mcp-ci-aaaa-1234' });
  const joined = args.join(' ');
  for (const flag of ['--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
    '--pids-limit=64', '--memory=1024m', '--pull=never',
    '--userns=keep-id', '--network=slirp4netns:allow_host_loopback=false']) {
    assert.ok(args.includes(flag), `Missing sandbox flag ${flag}`);
  }
  assert.ok(joined.includes('/tmp/ci-test-checkout:/input:ro'));
  assert.ok(!joined.includes('/var/run/docker.sock'));
  assert.ok(!joined.includes('--privileged'));
  assert.ok(!joined.includes('--network=host'));
  assert.ok(!joined.includes('--cpus='), 'CPU quota is enforced by the dedicated host user slice');
  assert.ok(!joined.includes('GITHUB_TOKEN'));
  assert.ok(joined.includes('cp -R --no-preserve=mode,ownership,timestamps'));
});
