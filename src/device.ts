import { mkdir, readFile, writeFile, unlink, appendFile } from 'node:fs/promises';
import { hostname, platform, arch, release } from 'node:os';
import path from 'node:path';
import { stateDir } from './config.js';
import { AgentError } from './errors.js';

export class DeviceState {
  constructor(private readonly directory = stateDir()) {}
  private get marker(): string { return path.join(this.directory, 'disconnected'); }
  async connected(): Promise<boolean> {
    try { await readFile(this.marker); return false; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
      throw error;
    }
  }
  async assertConnected(): Promise<void> {
    if (!(await this.connected())) throw new AgentError('DEVICE_DISCONNECTED', 'Device access was revoked locally');
  }
  async disconnect(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.marker, new Date().toISOString(), { mode: 0o600 });
  }
  async resumeLocally(): Promise<void> {
    try { await unlink(this.marker); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  async status(): Promise<unknown> {
    return { deviceName: hostname(), platform: platform(), architecture: arch(), osRelease: release(),
      nodeVersion: process.version, localAccessEnabled: await this.connected() };
  }
  async audit(tool: string, outcome: 'ok' | 'error', code?: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entry = { timestamp: new Date().toISOString(), tool, outcome, ...(code ? { code } : {}) };
    await appendFile(path.join(this.directory, 'audit.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}
