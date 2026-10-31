import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { CommandTools } from './commands.js';
import { DeviceState } from './device.js';
import { AgentError, toResult } from './errors.js';
import { FileTools } from './files.js';
import { IphoneTools } from './iphone.js';
import { PathPolicy } from './policy.js';
import { ProcessTools } from './processes.js';
import { SystemTools } from './system.js';

export type AgentContext = {
  config: AgentConfig;
  policy: PathPolicy;
  device: DeviceState;
  files: FileTools;
  commands: CommandTools;
  processes: ProcessTools;
  system: SystemTools;
  iphone: IphoneTools;
};

export async function createContext(config: AgentConfig, device = new DeviceState()): Promise<AgentContext> {
  const policy = await PathPolicy.create(config);
  return { config, policy, device, files: new FileTools(policy, config), commands: new CommandTools(policy, config),
    processes: new ProcessTools(config), system: new SystemTools(config), iphone: new IphoneTools(config.iphoneControl) };
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
  server.registerTool('process_list', { description: 'List up to 100 processes owned by the Mac user; no command-line arguments',
    inputSchema: z.object({ filter: z.string().min(1).max(100).optional() }) },
    wrap('process_list', ({ filter }: { filter?: string }) => ctx.processes.list(filter)));
  server.registerTool('process_info', { description: 'Inspect a current-user process by PID',
    inputSchema: z.object({ pid: z.number().int().positive() }) },
    wrap('process_info', ({ pid }: { pid: number }) => ctx.processes.info(pid)));
  server.registerTool('process_stop', { description: 'Request SIGTERM for an explicitly allowlisted user process; requires matching start time from process_list',
    inputSchema: z.object({ pid: z.number().int().positive(), expectedStartedAt: z.string().min(10).max(100) }) },
    wrap('process_stop', ({ pid, expectedStartedAt }: { pid: number; expectedStartedAt: string }) =>
      ctx.processes.stop(pid, expectedStartedAt)));
  server.registerTool('system_status', { description: 'Read bounded macOS uptime, memory, CPU and approved-root disk metrics',
    inputSchema: z.object({}) }, wrap('system_status', () => ctx.system.status()));
  server.registerTool('system_app_open', { description: 'Open an exact locally allowlisted macOS application bundle, without shell commands',
    inputSchema: z.object({ profile: z.string() }) },
    wrap('system_app_open', ({ profile }: { profile: string }) => ctx.system.openApp(profile)));
  server.registerTool('system_service_status', { description: 'Inspect a locally allowlisted current-user launchd service',
    inputSchema: z.object({ label: z.string() }) },
    wrap('system_service_status', ({ label }: { label: string }) => ctx.system.serviceStatus(label)));
  server.registerTool('system_service_restart', { description: 'Restart a locally allowlisted current-user launchd service (never the MCP agent)',
    inputSchema: z.object({ label: z.string() }) },
    wrap('system_service_restart', ({ label }: { label: string }) => ctx.system.serviceRestart(label)));
  for (const action of ['status', 'diff', 'log'] as const) {
    server.registerTool(`git_${action}`, { description: `Run a read-only git ${action} in an approved directory`,
      inputSchema: z.object({ directory: z.string() }) },
      wrap(`git_${action}`, ({ directory }: { directory: string }) => ctx.commands.git(directory, action)));
  }
  server.registerTool('terminal_start', { description: 'Execute a preconfigured exact command profile, without a shell',
    inputSchema: z.object({ profile: z.string() }) },
    wrap('terminal_start', ({ profile }: { profile: string }) => ctx.commands.start(profile)));
  server.registerTool('mac_user_exec', { description: 'Run an arbitrary argv as the Mac login user, only after persistent local owner opt-in; no sudo or root elevation is provided',
    inputSchema: z.object({ argv: z.array(z.string().max(4000)).min(1).max(64), cwd: z.string().min(1).max(4096),
      timeoutMs: z.number().int().min(100).max(300_000).default(30_000) }) },
    wrap('mac_user_exec', ({ argv, cwd, timeoutMs }: { argv: string[]; cwd: string; timeoutMs: number }) =>
      ctx.commands.startAsUser(argv, cwd, timeoutMs)));
  server.registerTool('terminal_poll', { description: 'Get bounded process output and status for an execution ID',
    inputSchema: z.object({ executionId: z.string().uuid() }) },
    wrap('terminal_poll', ({ executionId }: { executionId: string }) => ctx.commands.poll(executionId)));
  server.registerTool('terminal_cancel', { description: 'Terminate an authorized process execution',
    inputSchema: z.object({ executionId: z.string().uuid() }) },
    wrap('terminal_cancel', ({ executionId }: { executionId: string }) => ctx.commands.cancel(executionId)));
  server.registerTool('iphone_status', { description: 'Check the locally opted-in Appium service and iPhone session state',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, wrap('iphone_status', () => ctx.iphone.status()));
  server.registerTool('iphone_appium_server_start', { description: 'Start only the exact Appium binary approved in local Mac configuration, bound to 127.0.0.1; no shell',
    inputSchema: z.object({}) }, wrap('iphone_appium_server_start', () => ctx.iphone.startServer()));
  server.registerTool('iphone_appium_server_stop', { description: 'Stop only an Appium process launched by this Mac agent; never kills unrelated services',
    inputSchema: z.object({}) }, wrap('iphone_appium_server_stop', () => ctx.iphone.stopServer()));
  server.registerTool('iphone_session_start', { description: 'Start an iPhone XCUITest session asynchronously using only Mac-owner-configured capabilities; poll iphone_status until ready',
    inputSchema: z.object({}) }, wrap('iphone_session_start', () => ctx.iphone.start()));
  server.registerTool('iphone_session_stop', { description: 'End the active Appium iPhone session',
    inputSchema: z.object({}) }, wrap('iphone_session_stop', () => ctx.iphone.stop()));
  server.registerTool('iphone_ui_tree', { description: 'Read a bounded iPhone accessibility/UI hierarchy; may include private on-screen text',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ maxCharacters: z.number().int().min(100).max(35_000).default(12_000) }) },
    wrap('iphone_ui_tree', ({ maxCharacters }: { maxCharacters: number }) => ctx.iphone.uiTree(maxCharacters)));
  server.registerTool('iphone_tap', { description: 'Tap an iPhone screen point using W3C touch actions; coordinates in display points',
    inputSchema: z.object({ x: z.number().int().min(0).max(4096), y: z.number().int().min(0).max(4096) }) },
    wrap('iphone_tap', ({ x, y }: { x: number; y: number }) => ctx.iphone.tap(x, y)));
  server.registerTool('iphone_swipe', { description: 'Swipe between two iPhone screen points using W3C touch actions',
    inputSchema: z.object({ fromX: z.number().int().min(0).max(4096), fromY: z.number().int().min(0).max(4096),
      toX: z.number().int().min(0).max(4096), toY: z.number().int().min(0).max(4096),
      durationMs: z.number().int().min(100).max(3000).default(450) }) },
    wrap('iphone_swipe', ({ fromX, fromY, toX, toY, durationMs }: {
      fromX: number; fromY: number; toX: number; toY: number; durationMs: number;
    }) => ctx.iphone.swipe(fromX, fromY, toX, toY, durationMs)));
  server.registerTool('iphone_app_open', { description: 'Activate a Mac-owner-allowlisted iPhone app by bundle ID',
    inputSchema: z.object({ bundleId: z.string().min(3).max(150) }) },
    wrap('iphone_app_open', ({ bundleId }: { bundleId: string }) => ctx.iphone.openApp(bundleId)));
  server.registerTool('iphone_screenshot', { description: 'Read a bounded, optionally downscaled iPhone screenshot as an image; may show private content',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
      try {
        await ctx.device.assertConnected();
        const screenshot = await ctx.iphone.screenshot();
        await ctx.device.audit('iphone_screenshot', 'ok').catch(() => {});
        return { content: [{ type: 'image' as const, mimeType: screenshot.mimeType, data: screenshot.data }] };
      } catch (error) {
        const safe = toResult(error);
        await ctx.device.audit('iphone_screenshot', 'error', safe.code).catch(() => {});
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: safe }) }] };
      }
    });
  server.registerTool('device_info', { description: 'Show local agent device and operating system information',
    inputSchema: z.object({}) }, wrap('device_info', () => ctx.device.status(), true));
  server.registerTool('device_status', { description: 'Show connection state and configured authorized roots',
    inputSchema: z.object({}) }, wrap('device_status', async () => ({ ...(await ctx.device.status() as object),
      allowedRoots: ctx.policy.listRoots(), writesEnabled: ctx.config.allowWrites,
      fullUserModeEnabled: ctx.config.fullUserMode.enabled,
      commandProfiles: Object.keys(ctx.config.commandProfiles),
      processStopAllowlist: ctx.config.processStopAllowlist,
      appLaunchProfiles: Object.keys(ctx.config.appLaunchProfiles),
      iphoneEnabled: ctx.config.iphoneControl.enabled,
      iphoneAllowedBundleIds: ctx.config.iphoneControl.allowedBundleIds,
      serviceRestartAllowlist: ctx.config.serviceRestartAllowlist }), true));
  server.registerTool('device_disconnect', { description: 'Persistently revoke agent tool execution until owner locally resumes',
    inputSchema: z.object({}) }, wrap('device_disconnect', async () => {
      await ctx.device.disconnect();
      ctx.commands.cancelAll();
      if (ctx.config.iphoneControl.enabled) await ctx.iphone.stop().catch(() => {});
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
