import { execFile } from 'node:child_process';
import { stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';

const execFileAsync = promisify(execFile);
const SELF_LABEL = 'com.dualangka.remote-mcp-agent';

export class SystemTools {
  constructor(private readonly config: AgentConfig) {}

  async status(): Promise<unknown> {
    const root = this.config.allowedRoots[0];
    const disk = root ? await statfs(root) : undefined;
    return {
      platform: process.platform,
      hostname: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCount: os.availableParallelism(),
      loadAverage: os.loadavg(),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      disk: disk ? { root, totalBytes: disk.blocks * disk.bsize,
        availableBytes: disk.bavail * disk.bsize } : null,
    };
  }

  async openApp(profile: string): Promise<unknown> {
    const app = this.config.appLaunchProfiles[profile];
    if (!app) throw new AgentError('APP_DENIED', 'Unknown or unauthorized application profile');
    if (process.platform !== 'darwin') throw new AgentError('UNSUPPORTED_PLATFORM', 'App launch is macOS-only');
    const info = await stat(app);
    if (!info.isDirectory()) throw new AgentError('INVALID_APP', 'Configured application is not a bundle');
    try {
      await execFileAsync('/usr/bin/open', ['-a', app], { timeout: 8_000, maxBuffer: 4096 });
    } catch { throw new AgentError('APP_FAILED', 'Approved application could not be opened'); }
    return { profile, opened: true };
  }

  async serviceStatus(label: string): Promise<unknown> {
    this.assertAllowedService(label);
    try {
      const { stdout } = await execFileAsync('/bin/launchctl', ['print', `gui/${this.uid()}/${label}`],
        { timeout: 5_000, maxBuffer: 131_072 });
      const state = /^\s*state = ([a-z]+)$/m.exec(stdout)?.[1] ?? 'unknown';
      const pid = /^\s*pid = (\d+)$/m.exec(stdout)?.[1];
      return { label, loaded: true, state, pid: pid ? Number(pid) : null };
    } catch { return { label, loaded: false, state: 'unknown', pid: null }; }
  }

  async serviceRestart(label: string): Promise<unknown> {
    this.assertAllowedService(label);
    if (label === SELF_LABEL) throw new AgentError('SERVICE_DENIED', 'The remote MCP agent cannot restart itself');
    try {
      await execFileAsync('/bin/launchctl', ['kickstart', '-k', `gui/${this.uid()}/${label}`],
        { timeout: 8_000, maxBuffer: 4096 });
    } catch { throw new AgentError('SERVICE_FAILED', 'Approved user service could not be restarted'); }
    return { label, restartRequested: true };
  }

  private uid(): number {
    const uid = process.getuid?.();
    if (process.platform !== 'darwin' || uid === undefined) {
      throw new AgentError('UNSUPPORTED_PLATFORM', 'User service controls are macOS-only');
    }
    return uid;
  }

  private assertAllowedService(label: string): void {
    if (!this.config.serviceRestartAllowlist.includes(label)) {
      throw new AgentError('SERVICE_DENIED', 'Service is not in the locally configured allowlist');
    }
  }
}
