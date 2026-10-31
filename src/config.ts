import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentError } from './errors.js';

const commandProfileSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
});

const iphoneControlSchema = z.object({
  // Explicit owner opt-in. The HTTP client can only reach 127.0.0.1 on the Mac.
  enabled: z.boolean().default(false),
  appiumPort: z.number().int().min(1024).max(65535).default(4723),
  // Local-only exact executable and working paths for the optional Appium launcher.
  appiumExecutable: z.string().optional(),
  appiumHome: z.string().optional(),
  appiumCwd: z.string().optional(),
  udid: z.string().regex(/^[A-Za-z0-9-]{8,80}$/).optional(),
  allowedBundleIds: z.array(z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/)).max(30).default([]),
  startupBundleId: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/).optional(),
  xcodeOrgId: z.string().regex(/^[A-Za-z0-9]{5,20}$/).optional(),
  updatedWDABundleId: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/).optional(),
  wdaLocalPort: z.number().int().min(1024).max(65535).default(8100),
}).default({ enabled: false, appiumPort: 4723, allowedBundleIds: [], wdaLocalPort: 8100 });

export const configSchema = z.object({
  allowedRoots: z.array(z.string()).default([]),
  deniedNames: z.array(z.string()).default([]),
  allowWrites: z.boolean().default(false),
  // A remote caller can only stop processes explicitly opted in by the Mac owner.
  processStopAllowlist: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)).max(50).default([]),
  // Profiles map a public alias to an exact local .app bundle path.
  appLaunchProfiles: z.record(z.string(), z.string()).default({}),
  // Only user-owned launchd labels explicitly named here may be restarted.
  serviceRestartAllowlist: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,120}$/)).max(50).default([]),
  maxReadBytes: z.number().int().min(1).max(10_485_760).default(262_144),
  maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
  commandProfiles: z.record(z.string(), commandProfileSchema).default({}),
  iphoneControl: iphoneControlSchema,
});

export type AgentConfig = z.infer<typeof configSchema>;
export const defaultConfig: AgentConfig = configSchema.parse({});

export function configPath(): string {
  const configured = process.env.REMOTE_MCP_CONFIG;
  if (configured && !path.isAbsolute(configured)) {
    throw new AgentError('INVALID_CONFIG', 'REMOTE_MCP_CONFIG must be an absolute path');
  }
  return configured || path.join(homedir(), '.config', 'remote-mcp', 'config.json');
}

export function stateDir(): string {
  return path.join(path.dirname(configPath()), 'state');
}

export async function loadConfig(filePath = configPath()): Promise<AgentConfig> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AgentError('CONFIG_NOT_FOUND', `Config missing at ${filePath}. Run remote-mcp init.`);
    }
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(contents); }
  catch { throw new AgentError('INVALID_CONFIG', 'Config file is not valid JSON'); }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentError('INVALID_CONFIG', `Invalid config: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  for (const root of result.data.allowedRoots) {
    if (!path.isAbsolute(root)) throw new AgentError('INVALID_CONFIG', `Allowed root must be absolute: ${root}`);
  }
  for (const [name, profile] of Object.entries(result.data.commandProfiles)) {
    if (!path.isAbsolute(profile.executable) || !path.isAbsolute(profile.cwd)) {
      throw new AgentError('INVALID_CONFIG', `Command profile ${name} needs absolute executable and cwd`);
    }
  }
  const iphone = result.data.iphoneControl;
  if (iphone.startupBundleId && !iphone.allowedBundleIds.includes(iphone.startupBundleId)) {
    throw new AgentError('INVALID_CONFIG', 'iPhone startupBundleId must be in allowedBundleIds');
  }
  if (iphone.enabled && !iphone.udid) {
    throw new AgentError('INVALID_CONFIG', 'Enabled iPhone control requires a local device UDID');
  }
  for (const key of ['appiumExecutable', 'appiumHome', 'appiumCwd'] as const) {
    const value = iphone[key];
    if (value && !path.isAbsolute(value)) {
      throw new AgentError('INVALID_CONFIG', `iPhone ${key} must be an absolute path`);
    }
  }
  for (const [name, appPath] of Object.entries(result.data.appLaunchProfiles)) {
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(name) || !path.isAbsolute(appPath) || !appPath.endsWith('.app')) {
      throw new AgentError('INVALID_CONFIG', `Application profile ${name} needs an absolute .app bundle path`);
    }
  }
  return result.data;
}

export async function initConfig(filePath = configPath()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, JSON.stringify(defaultConfig, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new AgentError('ALREADY_EXISTS', 'Config exists; refusing to overwrite it');
    }
    throw error;
  }
}
