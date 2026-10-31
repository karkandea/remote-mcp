import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';
import { PathPolicy } from './policy.js';

const execFileAsync = promisify(execFile);

type Running = {
  id: string;
  profile: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  startedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  pid?: number;
  cancel: () => void;
};

export class CommandTools {
  private readonly jobs = new Map<string, Running>();

  constructor(private readonly policy: PathPolicy, private readonly config: AgentConfig) {}

  async git(directory: string, action: 'status' | 'diff' | 'log'): Promise<unknown> {
    const cwd = await this.policy.readPath(directory);
    const options = { cwd, timeout: 10_000, maxBuffer: this.config.maxOutputBytes, env: {
      ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    } };
    const base = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'pager.diff=cat'];
    const args = action === 'status' ? ['status', '--short', '--branch'] :
      action === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--'] :
        ['log', '-10', '--format=%h %cs %s'];
    const { stdout: repository } = await execFileAsync('git', [...base, 'rev-parse', '--show-toplevel'], options);
    await this.policy.readPath(repository.trim());
    const { stdout } = await execFileAsync('git', [...base, ...args], options);
    return { repository: repository.trim(), action, output: stdout };
  }

  async start(profileName: string): Promise<unknown> {
    const profile = this.config.commandProfiles[profileName];
    if (!profile) throw new AgentError('COMMAND_DENIED', 'Unknown or unauthorized command profile');
    const cwd = await this.policy.readPath(profile.cwd);
    if (this.jobs.size >= 30) throw new AgentError('TOO_MANY_JOBS', 'Restart the agent to clear completed job history');
    if ([...this.jobs.values()].filter(job => job.status === 'running').length >= 3) {
      throw new AgentError('BUSY', 'At most three commands may run concurrently');
    }
    const id = randomUUID();
    const child = spawn(profile.executable, profile.args, {
      cwd, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    let timer: NodeJS.Timeout;
    const job: Running = { id, profile: profileName, status: 'running', startedAt: new Date().toISOString(),
      exitCode: null, stdout: '', stderr: '', truncated: false, pid: child.pid,
      cancel: () => {
        if (job.status !== 'running') return;
        job.status = 'cancelled';
        // Signal the process group to clean up test runner child processes on POSIX.
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch { child.kill('SIGTERM'); }
        setTimeout(() => {
          if (child.exitCode === null) {
            try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL'); } catch { /* exited */ }
          }
        }, 1500).unref();
      },
    };
    const append = (key: 'stdout' | 'stderr', chunk: Buffer): void => {
      const available = this.config.maxOutputBytes - Buffer.byteLength(job.stdout) - Buffer.byteLength(job.stderr);
      if (available <= 0) { job.truncated = true; return; }
      const slice = chunk.subarray(0, available);
      job[key] += slice.toString('utf8');
      if (slice.byteLength < chunk.byteLength) job.truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      job.status = 'failed'; job.stderr += `Process could not start: ${error.message}`;
      clearTimeout(timer);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
      job.exitCode = code;
      if (signal) job.stderr += `\nTerminated by signal: ${signal}`;
    });
    timer = setTimeout(() => { if (job.status === 'running') { job.cancel(); job.status = 'timeout'; } }, profile.timeoutMs);
    timer.unref();
    this.jobs.set(id, job);
    return { executionId: id, status: job.status, profile: profileName };
  }

  poll(id: string): unknown {
    const job = this.jobs.get(id);
    if (!job) throw new AgentError('NOT_FOUND', 'Unknown execution ID');
    return { executionId: job.id, profile: job.profile, status: job.status, startedAt: job.startedAt,
      exitCode: job.exitCode, stdout: job.stdout, stderr: job.stderr, truncated: job.truncated };
  }

  cancel(id: string): unknown {
    const job = this.jobs.get(id);
    if (!job) throw new AgentError('NOT_FOUND', 'Unknown execution ID');
    job.cancel();
    return { executionId: id, status: job.status };
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.cancel();
  }
}
