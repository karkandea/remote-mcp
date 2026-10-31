import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AgentError, toResult } from './errors.js';
import type { RelayChannel } from './relay-channel.js';
import { auditVpsStorage } from './vps-storage.js';
import { callRootHelper, type RootOperation } from './root-helper.js';

/** Mac tool requests cross the agent channel; VPS inventory is read locally by the relay. */
export function createProxyServer(channel: RelayChannel, storageAudit: () => Promise<unknown> = auditVpsStorage,
  rootHelperSocket?: string): McpServer {
  const server = new McpServer({ name: 'remote-mcp-relay', version: '0.1.0-alpha.1' });
  const auth = { _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp:tools'] }] } };
  server.registerTool('vps_storage_audit', { ...auth,
    description: 'Read-only disk-space inventory on the always-on Linux VPS relay: fixed directories, Docker summary and journal usage. No delete or arbitrary commands.',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: await storageAudit() }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const,
          text: JSON.stringify({ ok: false, error: toResult(error) }) }] };
      }
    });
  async function rootCall(operation: RootOperation) {
    try {
      if (!rootHelperSocket) throw new AgentError('ROOT_DISABLED', 'VPS root mode is not enabled on the relay');
      return { content: [{ type: 'text' as const,
        text: JSON.stringify({ ok: true, data: await callRootHelper(rootHelperSocket, operation) }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: JSON.stringify({ ok: false, error: toResult(error) }) }] };
    }
  }
  server.registerTool('vps_root_status', { ...auth,
    description: 'Check whether the owner-enabled, high-risk VPS root executor is available (no elevated action)',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, () => rootCall({ action: 'status' }));
  server.registerTool('vps_root_exec', { ...auth,
    description: 'HIGH RISK: execute arbitrary argv as root on the VPS, with full filesystem and OS control. Use vps_root_poll for output. Only works when the separate root helper has been intentionally enabled.',
    annotations: { destructiveHint: true }, inputSchema: z.object({
      argv: z.array(z.string().max(4000)).min(1).max(64), cwd: z.string().min(1).max(4096),
      timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    }) }, ({ argv, cwd, timeoutMs }) => rootCall({ action: 'start', argv, cwd, timeoutMs }));
  server.registerTool('vps_root_poll', { ...auth,
    description: 'Read bounded output and exit status from a previously started VPS root command',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ executionId: z.string().uuid() }) },
    ({ executionId }) => rootCall({ action: 'poll', executionId }));
  server.registerTool('vps_root_cancel', { ...auth,
    description: 'Terminate one VPS root execution and its process group',
    annotations: { destructiveHint: true }, inputSchema: z.object({ executionId: z.string().uuid() }) },
    ({ executionId }) => rootCall({ action: 'cancel', executionId }));
  server.registerTool('fs_list', { ...auth, description: 'List an approved directory on the connected Mac',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ path: z.string() }) },
    args => channel.call('fs_list', args));
  server.registerTool('fs_read', { ...auth, description: 'Read a bounded UTF-8 file in an approved Mac directory',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ path: z.string() }) },
    args => channel.call('fs_read', args));
  server.registerTool('fs_stat', { ...auth, description: 'Inspect an approved Mac file or directory',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ path: z.string() }) },
    args => channel.call('fs_stat', args));
  server.registerTool('fs_search', { ...auth, description: 'Search literal text in authorized Mac files',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ directory: z.string(), query: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) }) },
    args => channel.call('fs_search', args));
  server.registerTool('fs_apply_patch', { ...auth, description: 'Replace one expected text occurrence (requires locally enabled writes)',
    annotations: { destructiveHint: true }, inputSchema: z.object({ path: z.string(), expectedText: z.string().min(1), replacementText: z.string(), expectedSha256: z.string().length(64).optional() }) },
    args => channel.call('fs_apply_patch', args));
  server.registerTool('process_list', { ...auth, description: 'List up to 100 current-user Mac processes without command-line arguments',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ filter: z.string().min(1).max(100).optional() }) },
    args => channel.call('process_list', args));
  server.registerTool('process_info', { ...auth, description: 'Inspect a current-user Mac process by PID',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ pid: z.number().int().positive() }) },
    args => channel.call('process_info', args));
  server.registerTool('process_stop', { ...auth, description: 'Gracefully stop a locally allowlisted user process with start-time confirmation',
    annotations: { destructiveHint: true }, inputSchema: z.object({ pid: z.number().int().positive(), expectedStartedAt: z.string().min(10).max(100) }) },
    args => channel.call('process_stop', args));
  server.registerTool('system_status', { ...auth, description: 'Inspect Mac uptime, memory, CPU load and approved-root disk capacity',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) },
    args => channel.call('system_status', args));
  server.registerTool('system_app_open', { ...auth, description: 'Open a locally allowlisted macOS app; does not expose a shell',
    inputSchema: z.object({ profile: z.string() }) }, args => channel.call('system_app_open', args));
  server.registerTool('system_service_status', { ...auth, description: 'Inspect an allowlisted current-user launchd service',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ label: z.string() }) },
    args => channel.call('system_service_status', args));
  server.registerTool('system_service_restart', { ...auth, description: 'Restart an allowlisted user launchd service (agent itself excluded)',
    annotations: { destructiveHint: true }, inputSchema: z.object({ label: z.string() }) },
    args => channel.call('system_service_restart', args));
  for (const action of ['status', 'diff', 'log'] as const) {
    server.registerTool(`git_${action}`, { ...auth, description: `Read-only git ${action} in an approved Mac directory`,
      annotations: { readOnlyHint: true }, inputSchema: z.object({ directory: z.string() }) },
      args => channel.call(`git_${action}`, args));
  }
  server.registerTool('terminal_start', { ...auth, description: 'Run a locally approved exact command profile (no shell)',
    inputSchema: z.object({ profile: z.string() }) }, args => channel.call('terminal_start', args));
  server.registerTool('mac_user_exec', { ...auth, description: 'Execute arbitrary argv with Mac login-user privileges after the owner locally enables fullUserMode; use terminal_poll for output',
    annotations: { destructiveHint: true }, inputSchema: z.object({ argv: z.array(z.string().max(4000)).min(1).max(64), cwd: z.string().min(1).max(4096),
      timeoutMs: z.number().int().min(100).max(300_000).default(30_000) }) }, args => channel.call('mac_user_exec', args));
  server.registerTool('terminal_poll', { ...auth, description: 'Read bounded output for a local execution',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ executionId: z.string().uuid() }) },
    args => channel.call('terminal_poll', args));
  server.registerTool('terminal_cancel', { ...auth, description: 'Stop one approved local execution',
    inputSchema: z.object({ executionId: z.string().uuid() }) }, args => channel.call('terminal_cancel', args));
  server.registerTool('iphone_status', { ...auth, description: 'Read Mac Appium service and iPhone session status (requires local owner opt-in)',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('iphone_status', args));
  server.registerTool('iphone_appium_server_start', { ...auth, description: 'Start the locally allowlisted Mac Appium executable bound to loopback, without a shell',
    inputSchema: z.object({}) }, args => channel.call('iphone_appium_server_start', args));
  server.registerTool('iphone_appium_server_stop', { ...auth, description: 'Stop only the Appium process started by the Mac agent',
    inputSchema: z.object({}) }, args => channel.call('iphone_appium_server_stop', args));
  server.registerTool('iphone_session_start', { ...auth, description: 'Start a locally configured iPhone XCUITest session; call iphone_status to poll progress',
    inputSchema: z.object({}) }, args => channel.call('iphone_session_start', args));
  server.registerTool('iphone_session_stop', { ...auth, description: 'End the active Appium iPhone session',
    inputSchema: z.object({}) }, args => channel.call('iphone_session_stop', args));
  server.registerTool('iphone_ui_tree', { ...auth, description: 'Read bounded iPhone UI hierarchy, potentially containing private on-screen text',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ maxCharacters: z.number().int().min(100).max(35_000).default(12_000) }) },
    args => channel.call('iphone_ui_tree', args));
  server.registerTool('iphone_tap', { ...auth, description: 'Tap a coordinate on the currently connected iPhone',
    inputSchema: z.object({ x: z.number().int().min(0).max(4096), y: z.number().int().min(0).max(4096) }) },
    args => channel.call('iphone_tap', args));
  server.registerTool('iphone_swipe', { ...auth, description: 'Perform a bounded touch swipe on the currently connected iPhone',
    inputSchema: z.object({ fromX: z.number().int().min(0).max(4096), fromY: z.number().int().min(0).max(4096),
      toX: z.number().int().min(0).max(4096), toY: z.number().int().min(0).max(4096),
      durationMs: z.number().int().min(100).max(3000).default(450) }) },
    args => channel.call('iphone_swipe', args));
  server.registerTool('iphone_app_open', { ...auth, description: 'Activate only an iPhone app that the Mac owner allowlisted',
    inputSchema: z.object({ bundleId: z.string().min(3).max(150) }) }, args => channel.call('iphone_app_open', args));
  server.registerTool('iphone_screenshot', { ...auth, description: 'Return an iPhone screenshot as an image; may expose private screen content',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('iphone_screenshot', args));
  server.registerTool('device_info', { ...auth, description: 'Connected Mac device information',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('device_info', args));
  server.registerTool('device_status', { ...auth, description: 'Connected Mac access and permissions',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('device_status', args));
  server.registerTool('device_disconnect', { ...auth, description: 'Revoke local access until manually resumed on the Mac',
    inputSchema: z.object({}) }, args => channel.call('device_disconnect', args));
  return server;
}
