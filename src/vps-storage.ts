import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

/** Fast, bounded VPS status. No shell, root privileges, caller-supplied commands or raw logs. */
export async function vpsHostStatus(): Promise<unknown> {
  if (process.platform !== 'linux') {
    throw new AgentError('UNSUPPORTED_PLATFORM', 'VPS host status requires Linux');
  }
  const [docker, journal] = await Promise.all([
    readCommand('/usr/bin/docker', ['ps', '--format', '{{.ID}}'], 2_000),
    readCommand('/usr/bin/journalctl', ['-u', 'remote-mcp-relay.service', '--since', '-15 min',
      '--no-pager', '--output=cat'], 2_000),
  ]);
  const events = journal?.split('\n').filter(line => line.includes('Remote MCP ')) ?? [];
  return {
    host: os.hostname(), collectedAt: new Date().toISOString(), uptimeSeconds: Math.round(os.uptime()),
    loadAverage: os.loadavg().map(value => Math.round(value * 100) / 100),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    docker: docker === undefined ? { status: 'unavailable' } : {
      status: 'ok', runningContainers: docker ? docker.split('\n').filter(Boolean).length : 0,
    },
    relayJournal: journal === undefined ? { status: 'unavailable' } : {
      status: 'ok', sampledEvents: events.length,
      recentWarnings: events.filter(line => /(?:warning|alert|heartbeat timeout|device_disconnected)/i.test(line)).length,
    },
    readOnly: true,
    note: 'Host memory and load are sampled; Docker/journal checks are optional and contain no raw log content.',
  };
}

export type VpsIteration = {
  id: string;
  recordedAt: string;
  category: 'observation' | 'improvement' | 'regression' | 'decision';
  title: string;
  finding: string;
  outcome: string;
  nextAction?: string;
};

export type VpsIterationInput = Pick<VpsIteration, 'category' | 'title' | 'finding' | 'outcome' | 'nextAction'>;

// Fixed state directory, provisioned by systemd StateDirectory=remote-mcp.
// Job stdout/argv never enter this file. It is separate from disposable execution IDs.
const ITERATIONS_PATH = '/var/lib/remote-mcp/agent-iterations.jsonl';
const MAX_ITERATIONS = 200;
const MAX_ITERATION_FILE_BYTES = 512_000;
let noteQueue: Promise<unknown> = Promise.resolve();

async function loadIterations(filePath = ITERATIONS_PATH): Promise<VpsIteration[]> {
  let body: string;
  try {
    const info = await stat(filePath);
    if (info.size > MAX_ITERATION_FILE_BYTES) {
      throw new AgentError('NOTES_TOO_LARGE', 'Iteration journal exceeded its fixed size budget');
    }
    body = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return body.trim() ? body.trim().split('\n').map(line => JSON.parse(line) as VpsIteration) : [];
}

export async function listVpsIterations(limit = 20, category?: VpsIteration['category'],
  filePath = ITERATIONS_PATH): Promise<unknown> {
  const items = await loadIterations(filePath);
  return { total: items.length, maxRetained: MAX_ITERATIONS,
    entries: items.filter(item => !category || item.category === category).slice(-limit).reverse(),
    storage: 'VPS persistent state; separate from terminal job history' };
}

export async function recordVpsIteration(input: VpsIterationInput,
  filePath = ITERATIONS_PATH): Promise<VpsIteration> {
  const fields = [input.title, input.finding, input.outcome, input.nextAction ?? ''];
  // Avoid credentials, copied command outputs and common bearer/API-token material in persistent notes.
  if (fields.some(value => /(?:Bearer\s+\S+|gh[ps]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN .*PRIVATE KEY-----)/i.test(value))) {
    throw new AgentError('SENSITIVE_CONTENT', 'Do not store credentials or command output in iteration notes');
  }
  const action = async (): Promise<VpsIteration> => {
    const previous = await loadIterations(filePath);
    const item: VpsIteration = { id: randomUUID(), recordedAt: new Date().toISOString(),
      category: input.category, title: input.title, finding: input.finding,
      outcome: input.outcome, ...(input.nextAction ? { nextAction: input.nextAction } : {}) };
    const lines = [...previous, item].slice(-MAX_ITERATIONS).map(entry => JSON.stringify(entry)).join('\n') + '\n';
    if (Buffer.byteLength(lines) > MAX_ITERATION_FILE_BYTES) {
      throw new AgentError('NOTES_TOO_LARGE', 'Iteration journal exceeds fixed size budget');
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = filePath + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tempPath, lines, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
    return item;
  };
  const pendingWrite = noteQueue.then(action, action);
  noteQueue = pendingWrite.then(() => undefined, () => undefined);
  return pendingWrite;
}
