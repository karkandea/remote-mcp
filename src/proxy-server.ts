import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toResult } from './errors.js';
import type { RelayChannel } from './relay-channel.js';
import { auditVpsStorage } from './vps-storage.js';

/** Mac tool requests cross the agent channel; VPS inventory is read locally by the relay. */
export function createProxyServer(channel: RelayChannel, storageAudit: () => Promise<unknown> = auditVpsStorage): McpServer {
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
  server.registerTool('terminal_poll', { ...auth, description: 'Read bounded output for a local execution',
    annotations: { readOnlyHint: true }, inputSchema: z.object({ executionId: z.string().uuid() }) },
    args => channel.call('terminal_poll', args));
  server.registerTool('terminal_cancel', { ...auth, description: 'Stop one approved local execution',
    inputSchema: z.object({ executionId: z.string().uuid() }) }, args => channel.call('terminal_cancel', args));
  server.registerTool('device_info', { ...auth, description: 'Connected Mac device information',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('device_info', args));
  server.registerTool('device_status', { ...auth, description: 'Connected Mac access and permissions',
    annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, args => channel.call('device_status', args));
  server.registerTool('device_disconnect', { ...auth, description: 'Revoke local access until manually resumed on the Mac',
    inputSchema: z.object({}) }, args => channel.call('device_disconnect', args));
  return server;
}
