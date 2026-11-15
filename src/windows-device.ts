import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { configSchema } from './config.js';
import { DeviceState } from './device.js';
import { AgentError } from './errors.js';
import { PathPolicy } from './policy.js';

export const DEVICE_HEADER = 'x-remote-mcp-device';
export const WINDOWS_TOOLS = {
  fs_list: z.object({ path: z.string() }),
  fs_read: z.object({ path: z.string() }),
  fs_stat: z.object({ path: z.string() }),
  fs_search: z.object({ directory: z.string(), query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100).default(50) }),
  device_status: z.object({}),
  device_disconnect: z.object({}),
};

const enrollmentSchema = z.object({
  relayUrl: z.string().url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  allowedRoot: z.string(),
});

export function deviceFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function windowsAgentDirectory(): string {
  if (process.platform !== 'win32') throw new AgentError('UNSUPPORTED_PLATFORM', 'Run this command on Windows');
  return path.resolve(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'RemoteMcpArkan');
}

export function windowsDeviceState(directory: string): DeviceState {
  return new DeviceState(path.join(directory, 'state'));
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

async function windowsConfig(directory: string, allowedRoot: string) {
  const privateDirectory = await realpath(directory);
  const policy = await PathPolicy.create(configSchema.parse({ allowedRoots: [allowedRoot] }));
  const [root] = policy.listRoots();
  if (!root || root === path.parse(root).root ||
      contains(root, privateDirectory) || contains(privateDirectory, root)) {
    throw new AgentError('INVALID_ROOT', 'Choose a separate working folder outside the agent data folder');
  }
  return configSchema.parse({ allowedRoots: [root] });
}

export async function enrollWindowsDevice(directory: string, relayUrl: string, allowedRoot: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = await windowsConfig(directory, allowedRoot);
  const token = randomBytes(32).toString('hex');
  const enrollment = enrollmentSchema.parse({ relayUrl, token, allowedRoot: config.allowedRoots[0] });
  try {
    await writeFile(path.join(directory, 'enrollment.json'), JSON.stringify(enrollment) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new AgentError('ALREADY_EXISTS', 'Windows is already initialized. Run windows-fingerprint to show its fingerprint.');
    }
    throw error;
  }
  return deviceFingerprint(token);
}

async function readEnrollment(directory: string) {
  try {
    return enrollmentSchema.parse(JSON.parse(await readFile(path.join(directory, 'enrollment.json'), 'utf8')));
  } catch {
    throw new AgentError('INVALID_ENROLLMENT', 'Windows enrollment is missing or invalid. Run windows-init first.');
  }
}

export async function windowsFingerprint(directory: string): Promise<string> {
  return deviceFingerprint((await readEnrollment(directory)).token);
}

export async function loadWindowsDevice(directory: string) {
  const enrollment = await readEnrollment(directory);
  return { config: await windowsConfig(directory, enrollment.allowedRoot),
    device: windowsDeviceState(directory), url: enrollment.relayUrl, token: enrollment.token };
}
