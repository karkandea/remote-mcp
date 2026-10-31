import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { CommandTools } from './commands.js';
import { DeviceState } from './device.js';
import { AgentError, toResult } from './errors.js';
import { FileTools } from './files.js';
import { PathPolicy } from './policy.js';

export type AgentContext = {
  config: AgentConfig;
  policy: PathPolicy;
  device: DeviceState;
  files: FileTools;
  commands: CommandTools;
};

export async function createContext(config: AgentConfig, device = new DeviceState()): Promise<AgentContext> {
  const policy = await PathPolicy.create(config);
  return { config, policy, device, files: new FileTools(policy, config), commands: new CommandTools(policy, config) };
}

export function createServer(ctx: AgentContext): McpServer {
  const server = new McpServer({ name: 'remote-mcp', version: '0.1.0-alpha.1' });
  const wrap = <T>(name: string, action: (args: T) => Promise<unknown> | unknown, allowDisconnected = false) =>
    async (args: T) => {
      try {
        if (!allowDisconnected) await ctx.device.assertConnected();
        const data = await action(args);
        const response = JSON.stringify({ ok: true, data });
        if (Buffer.byteLength(response) > ctx.config.maxOutputBytes) {
          throw new AgentError('OUTPUT_TOO_LARGE', 'Response exceeds configured maxOutputBytes');
        }
        await ctx.device.audit(name, 'ok').catch(() => {});
        return { content: [{ type: 'text' as const, text: response }] };
      } catch (error) {
        const safe = toResult(error);
        await ctx.device.audit(name, 'error', safe.code).catch(() => {});
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: safe }) }] };
      }
    };

  server.registerTool('fs_list', { description: 'List up to 200 entries in an approved directory',
    inputSchema: z.object({ path: z.string() }) }, wrap('fs_list', ({ path }: { path: string }) => ctx.files.list(path)));
  server.registerTool('fs_read', { description: 'Read a small UTF-8 file in an approved directory',
    inputSchema: z.object({ path: z.string() }) }, wrap('fs_read', ({ path }: { path: string }) => ctx.files.read(path)));
  server.registerTool('fs_stat', { description: 'Show metadata for an approved file or directory',
    inputSchema: z.object({ path: z.string() }) }, wrap('fs_stat', ({ path }: { path: string }) => ctx.files.stat(path)));
  server.registerTool('fs_search', { description: 'Search literal text in authorized files, depth and results bounded',
    inputSchema: z.object({ directory: z.string(), query: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) }) },
    wrap('fs_search', ({ directory, query, limit }: { directory: string; query: string; limit: number }) => ctx.files.search(directory, query, limit)));
  server.registerTool('fs_apply_patch', { description: 'Replace exactly one expected text occurrence; requires local write enablement',
    inputSchema: z.object({ path: z.string(), expectedText: z.string().min(1), replacementText: z.string(), expectedSha256: z.string().length(64).optional() }) },
    wrap('fs_apply_patch', ({ path, expectedText, replacementText, expectedSha256 }: {
      path: string; expectedText: string; replacementText: string; expectedSha256?: string;
    }) => ctx.files.applyPatch(path, expectedText, replacementText, expectedSha256)));
  for (const action of ['status', 'diff', 'log'] as const) {
    server.registerTool(`git_${action}`, { description: `Run a read-only git ${action} in an approved directory`,
      inputSchema: z.object({ directory: z.string() }) },
      wrap(`git_${action}`, ({ directory }: { directory: string }) => ctx.commands.git(directory, action)));
  }
  server.registerTool('terminal_start', { description: 'Execute a preconfigured exact command profile, without a shell',
    inputSchema: z.object({ profile: z.string() }) },
    wrap('terminal_start', ({ profile }: { profile: string }) => ctx.commands.start(profile)));
  server.registerTool('terminal_poll', { description: 'Get bounded process output and status for an execution ID',
    inputSchema: z.object({ executionId: z.string().uuid() }) },
    wrap('terminal_poll', ({ executionId }: { executionId: string }) => ctx.commands.poll(executionId)));
  server.registerTool('terminal_cancel', { description: 'Terminate an authorized process execution',
    inputSchema: z.object({ executionId: z.string().uuid() }) },
    wrap('terminal_cancel', ({ executionId }: { executionId: string }) => ctx.commands.cancel(executionId)));
  server.registerTool('device_info', { description: 'Show local agent device and operating system information',
    inputSchema: z.object({}) }, wrap('device_info', () => ctx.device.status(), true));
  server.registerTool('device_status', { description: 'Show connection state and configured authorized roots',
    inputSchema: z.object({}) }, wrap('device_status', async () => ({ ...(await ctx.device.status() as object),
      allowedRoots: ctx.policy.listRoots(), writesEnabled: ctx.config.allowWrites,
      commandProfiles: Object.keys(ctx.config.commandProfiles) }), true));
  server.registerTool('device_disconnect', { description: 'Persistently revoke agent tool execution until owner locally resumes',
    inputSchema: z.object({}) }, wrap('device_disconnect', async () => {
      await ctx.device.disconnect();
      ctx.commands.cancelAll();
      return { localAccessEnabled: false, resume: 'remote-mcp resume (local-only)' };
    }));
  return server;
}

export async function runStdio(config: AgentConfig): Promise<void> {
  const ctx = await createContext(config);
  await ctx.device.assertConnected();
  if (process.platform !== 'darwin' && process.env.REMOTE_MCP_ALLOW_NON_MAC !== '1') {
    throw new AgentError('UNSUPPORTED_PLATFORM', 'The agent targets macOS; non-Mac use is for testing only');
  }
  await serveStdio(() => createServer(ctx));
}
