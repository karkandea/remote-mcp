import { execFile } from 'node:child_process';
import { stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const DIRECTORIES = [
  '/var/cache/apt/archives',
  '/var/log',
  '/opt',
  '/srv',
  '/var/www',
] as const;

type DirectoryUsage = { path: string; sizeBytes: number | null; status: 'ok' | 'missing' | 'unavailable' };
type OptionalCheck = { status: 'ok' | 'unavailable'; output?: string };
type CleanupCandidate = { path: string; estimatedBytes: number; reason: string; action: 'review_only' };

export type VpsStorageReport = {
  host: string;
  platform: string;
  collectedAt: string;
  rootDisk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
  directories: DirectoryUsage[];
  docker: OptionalCheck;
  journal: OptionalCheck;
  cleanupCandidates: CleanupCandidate[];
  limitations: string[];
  readOnly: true;
};

let cached: { at: number; report: VpsStorageReport } | undefined;
let pending: Promise<VpsStorageReport> | undefined;

/** Fixed commands, fixed directories, no shell, no caller-provided paths or elevated privileges. */
async function readCommand(binary: string, args: string[], timeout: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout, maxBuffer: 16_384, windowsHide: true,
      // Do not pass RELAY_DEVICE_TOKEN or OAuth configuration into child processes.
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    return stdout.trim().slice(0, 8_192);
  } catch { return undefined; }
}

async function directoryUsage(directory: string): Promise<DirectoryUsage> {
  try {
    if (!(await stat(directory)).isDirectory()) {
      return { path: directory, sizeBytes: null, status: 'missing' };
    }
  } catch (error) {
    return { path: directory, sizeBytes: null,
      status: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
  // Stay on one filesystem, do not follow directory symlinks, cap each walk at 2 seconds.
  const output = await readCommand('/usr/bin/du', ['-s', '-x', '-B1', '--', directory], 2_000);
  const size = output ? Number(/^\s*(\d+)\s/.exec(output)?.[1]) : NaN;
  return { path: directory, sizeBytes: Number.isSafeInteger(size) ? size : null,
    status: Number.isSafeInteger(size) ? 'ok' : 'unavailable' };
}

async function optionalCheck(binary: string, args: string[]): Promise<OptionalCheck> {
  const output = await readCommand(binary, args, 3_000);
  return output === undefined ? { status: 'unavailable' } : { status: 'ok', output: output.slice(0, 1_000) };
}

async function collect(): Promise<VpsStorageReport> {
  if (process.platform !== 'linux') {
    throw new AgentError('UNSUPPORTED_PLATFORM', 'VPS storage audit only runs on the Linux relay host');
  }
  const disk = await statfs('/');
  const totalBytes = disk.blocks * disk.bsize;
  const availableBytes = disk.bavail * disk.bsize;
  const usedBytes = (disk.blocks - disk.bfree) * disk.bsize;
  const directories: DirectoryUsage[] = [];
  // Sequential probes avoid a burst of disk I/O on the shared production VPS.
  for (const directory of DIRECTORIES) directories.push(await directoryUsage(directory));
  const docker = await optionalCheck('/usr/bin/docker', ['system', 'df', '--format', '{{json .}}']);
  const journal = await optionalCheck('/usr/bin/journalctl', ['--disk-usage', '--no-pager']);
  const cleanupCandidates: CleanupCandidate[] = [];
  const apt = directories.find(item => item.path === '/var/cache/apt/archives');
  if (apt?.sizeBytes && apt.sizeBytes >= 50_000_000) {
    cleanupCandidates.push({ path: apt.path, estimatedBytes: apt.sizeBytes,
      reason: 'Downloaded APT package archive cache; review package-manager activity before cleaning.',
      action: 'review_only' });
  }
  return {
    host: os.hostname(), platform: process.platform, collectedAt: new Date().toISOString(),
    rootDisk: { totalBytes, usedBytes, availableBytes,
      usedPercent: totalBytes ? Math.round(1000 * usedBytes / totalBytes) / 10 : 0 },
    directories, docker, journal, cleanupCandidates,
    limitations: [
      'Runs as the dedicated non-root relay service, inside its systemd sandbox; some directories and Docker metrics may be unavailable.',
      'Only the listed fixed directories are sampled, with 2-second timeouts; this is not a complete filesystem inventory.',
      'No deletions, pruning, log rotation, arbitrary commands or privileged access are exposed.',
    ],
    readOnly: true,
  };
}

export async function auditVpsStorage(): Promise<VpsStorageReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (!pending) {
    pending = collect().then(report => {
      cached = { at: Date.now(), report };
      return report;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
