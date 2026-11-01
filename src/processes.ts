import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';

const execFileAsync = promisify(execFile);
const PS_ARGS = ['-axo', 'pid=,uid=,lstart=,comm='];
const START_PATTERN = /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

export type LocalProcess = {
  pid: number;
  name: string;
  executable: string;
  startedAt: string;
};

type ProcessRecord = LocalProcess & { uid: number };

function parseRecord(line: string): ProcessRecord | undefined {
  const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!row) return;
  const details = START_PATTERN.exec(row[3]!);
  if (!details) return;
  const executable = details[2]!.trim();
  return { pid: Number(row[1]), uid: Number(row[2]), executable,
    name: path.basename(executable), startedAt: details[1]!.replace(/\s+/g, ' ').trim() };
}

function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new AgentError('PROCESS_UNAVAILABLE', 'Process controls require a local user');
  return uid;
}

async function processes(args: string[]): Promise<ProcessRecord[]> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', args, { timeout: 5_000, maxBuffer: 2_097_152 });
    return stdout.split('\n').map(parseRecord).filter((item): item is ProcessRecord => Boolean(item));
  } catch {
    throw new AgentError('PROCESS_UNAVAILABLE', 'Unable to inspect local processes');
  }
}

export class ProcessTools {
  constructor(private readonly config: AgentConfig) {}

  async list(filter?: string): Promise<unknown> {
    if (filter !== undefined && (filter.length < 1 || filter.length > 100)) {
      throw new AgentError('INVALID_FILTER', 'Process name filter must be 1-100 characters');
    }
    const rows = (await processes(PS_ARGS))
      .filter(row => row.uid === ownerUid() && (!filter || row.name.toLowerCase().includes(filter.toLowerCase())));
    const selected = rows.slice(0, 100);
    return { processes: selected.map(({ uid: _uid, ...item }) => item),
      truncated: rows.length > selected.length, stopAllowlist: this.config.processStopAllowlist };
  }

  async info(pid: number): Promise<unknown> {
    const record = await this.ownerProcess(pid);
    const { uid: _uid, ...item } = record;
    return item;
  }

  async stop(pid: number, expectedStartedAt: string): Promise<unknown> {
    const record = await this.ownerProcess(pid);
    if (pid === process.pid || pid === process.ppid || pid <= 100) {
      throw new AgentError('PROCESS_DENIED', 'Agent and protected processes cannot be stopped');
    }
    if (!this.config.processStopAllowlist.includes(record.name)) {
      throw new AgentError('PROCESS_DENIED', 'This process is not in the locally configured stop allowlist');
    }
    if (record.startedAt !== expectedStartedAt) {
      throw new AgentError('PROCESS_CHANGED', 'Process identity changed; list processes again');
    }
    try { process.kill(pid, 'SIGTERM'); }
    catch { throw new AgentError('PROCESS_UNAVAILABLE', 'Process could not be signaled'); }
    return { pid, name: record.name, signal: 'SIGTERM', requested: true };
  }

  private async ownerProcess(pid: number): Promise<ProcessRecord> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new AgentError('INVALID_PID', 'Positive integer PID required');
    const [record] = await processes(['-p', String(pid), '-o', 'pid=,uid=,lstart=,comm=']);
    if (!record) throw new AgentError('PROCESS_NOT_FOUND', 'Process is no longer running');
    if (record.uid !== ownerUid()) throw new AgentError('PROCESS_DENIED', 'Only current-user processes are accessible');
    return record;
  }
}
