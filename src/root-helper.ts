import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

/** Root commands deliberately have full host privileges. The Unix socket is the trust boundary. */
const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('start'), argv: z.array(z.string().max(4000)).min(1).max(64),
    cwd: z.string().min(1).max(4096), timeoutMs: z.number().int().min(100).max(300_000) }).strict(),
  z.object({ action: z.literal('poll'), executionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), executionId: z.string().uuid() }).strict(),
]);

export type RootOperation = z.infer<typeof operation>;
type JobState = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
type RootJob = {
  executionId: string;
  startedAt: string;
  status: JobState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  child: ChildProcess;
  timer: NodeJS.Timeout;
};

const MAX_WIRE_BYTES = 131_072;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_RETAINED_JOBS = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown helper error';
}

function sendAudit(action: string, details: Record<string, unknown>): void {
  // Never log arguments, working directories, environment values, or command output.
  process.stderr.write(JSON.stringify({ event: 'root-helper', time: new Date().toISOString(), action, ...details }) + '\n');
}

function terminate(job: RootJob, status: 'cancelled' | 'timeout'): void {
  if (job.status !== 'running') return;
  job.status = status;
  clearTimeout(job.timer);
  const pid = job.child.pid;
  try { if (pid) process.kill(-pid, 'SIGTERM'); else job.child.kill('SIGTERM'); }
  catch { job.child.kill('SIGTERM'); }
  setTimeout(() => {
    if (job.child.exitCode === null) {
      try { if (pid) process.kill(-pid, 'SIGKILL'); else job.child.kill('SIGKILL'); }
      catch { /* Already exited */ }
    }
  }, 1500).unref();
  sendAudit(status, { executionId: job.executionId });
}

export async function startRootHelper(socketPath: string, options: { requireRoot?: boolean } = {}):
  Promise<{ close: () => Promise<void> }> {
  if (process.platform !== 'linux') throw new Error('Root helper requires Linux');
  if (options.requireRoot !== false && process.getuid?.() !== 0) throw new Error('Root helper requires root UID');
  if (!path.isAbsolute(socketPath)) throw new Error('Root socket path must be absolute');
  const jobs = new Map<string, RootJob>();

  function pruneFinishedJobs(): void {
    // Retain recent results for polling, but never let historical commands
    // permanently prevent new executions on a long-running helper.
    if (jobs.size < MAX_RETAINED_JOBS) return;
    for (const [id, job] of jobs) {
      if (job.status !== 'running') jobs.delete(id);
      if (jobs.size < MAX_RETAINED_JOBS) return;
    }
  }

  function handle(request: RootOperation): unknown {
    if (request.action === 'status') return { enabled: true, privileged: process.getuid?.() === 0,
      activeJobs: [...jobs.values()].filter(job => job.status === 'running').length,
      retainedJobs: jobs.size, retainedJobsLimit: MAX_RETAINED_JOBS };
    if (request.action === 'poll' || request.action === 'cancel') {
      const job = jobs.get(request.executionId);
      if (!job) throw new Error('Unknown root execution ID');
      if (request.action === 'cancel') terminate(job, 'cancelled');
      return { executionId: job.executionId, startedAt: job.startedAt,
        status: job.status, exitCode: job.exitCode, stdout: job.stdout,
        stderr: job.stderr, truncated: job.truncated };
    }
    pruneFinishedJobs();
    if (jobs.size >= MAX_RETAINED_JOBS) throw new Error('Root job history full; no completed jobs can be evicted');
    if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) {
      throw new Error('At most two root commands may run concurrently');
    }
    if (!path.isAbsolute(request.cwd) || request.argv.some(arg => arg.includes('\0'))) {
      throw new Error('Root command requires absolute cwd and argv without NUL bytes');
    }
    const id = randomUUID();
    const child = spawn(request.argv[0]!, request.argv.slice(1), {
      cwd: request.cwd, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      // Deliberately do not inherit the relay OAuth token or systemd service credentials.
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
    });
    const job: RootJob = { executionId: id, startedAt: new Date().toISOString(), status: 'running',
      exitCode: null, stdout: '', stderr: '', truncated: false, child, timer: setTimeout(() => {}, 0) };
    const append = (key: 'stdout' | 'stderr', chunk: Buffer): void => {
      const available = MAX_OUTPUT_BYTES - Buffer.byteLength(job.stdout) - Buffer.byteLength(job.stderr);
      if (available <= 0) { job.truncated = true; return; }
      const part = chunk.subarray(0, available);
      job[key] += part.toString('utf8');
      if (part.byteLength < chunk.byteLength) job.truncated = true;
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', error => {
      if (job.status === 'running') job.status = 'failed';
      append('stderr', Buffer.from(`Process start failed: ${error.message}`));
      clearTimeout(job.timer);
      sendAudit('failure', { executionId: id });
    });
    child.once('close', code => {
      clearTimeout(job.timer);
      if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
      job.exitCode = code;
      sendAudit('exit', { executionId: id, status: job.status, exitCode: code });
    });
    clearTimeout(job.timer);
    job.timer = setTimeout(() => terminate(job, 'timeout'), request.timeoutMs);
    job.timer.unref();
    jobs.set(id, job);
    sendAudit('start', { executionId: id });
    return { executionId: id, status: job.status };
  }

  const server: Server = createServer(socket => {
    let input = '';
    socket.setTimeout(7_000, () => socket.destroy());
    socket.on('error', () => { /* Clients may disconnect. */ });
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > MAX_WIRE_BYTES) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end === -1) return;
      socket.pause();
      let response: unknown;
      try { response = { ok: true, data: handle(operation.parse(JSON.parse(input.slice(0, end)))) }; }
      catch (error) { response = { ok: false, error: errorMessage(error) }; }
      socket.end(JSON.stringify(response) + '\n');
    });
  });

  // Refuse to take over an existing socket, including one from a live helper.
  // systemd's private RuntimeDirectory is removed automatically on service stop.
  try {
    lstatSync(socketPath);
    throw new Error(`Refusing to replace existing socket path: ${socketPath}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(socketPath, 0o660);
  sendAudit('ready', { socket: socketPath });
  return { async close() {
    for (const job of jobs.values()) terminate(job, 'cancelled');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  } };
}

export async function callRootHelper(socketPath: string, request: RootOperation): Promise<unknown> {
  if (!path.isAbsolute(socketPath)) throw new Error('Root helper socket must be absolute');
  const payload = JSON.stringify(operation.parse(request)) + '\n';
  if (Buffer.byteLength(payload) > MAX_WIRE_BYTES) throw new Error('Root request exceeds size limit');
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    let settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(7_000, () => finish(new Error('Root helper response timeout')));
    socket.on('connect', () => socket.write(payload));
    socket.on('error', error => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('Root helper closed before response')); });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response) > MAX_WIRE_BYTES) { finish(new Error('Root helper response too large')); return; }
      const lineEnd = response.indexOf('\n');
      if (lineEnd === -1) return;
      try {
        const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() })
          .parse(JSON.parse(response.slice(0, lineEnd)));
        if (!parsed.ok) finish(new Error(parsed.error ?? 'Root helper rejected request'));
        else finish(undefined, parsed.data);
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid helper response')); }
    });
  });
}
