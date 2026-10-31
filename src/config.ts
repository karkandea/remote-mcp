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

export const configSchema = z.object({
  allowedRoots: z.array(z.string()).default([]),
  deniedNames: z.array(z.string()).default(['.ssh', '.aws', '.gnupg', '.env', 'id_rsa', 'id_ed25519']),
  allowWrites: z.boolean().default(false),
  maxReadBytes: z.number().int().min(1).max(10_485_760).default(262_144),
  maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
  commandProfiles: z.record(z.string(), commandProfileSchema).default({}),
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
