import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RelayChannel } from './relay-channel.js';

/** Mirror the local tool names and argument schemas; actual authorization stays on the Mac. */
export function createProxyServer(channel: RelayChannel): McpServer {
  const server = new McpServer({ name: 'remote-mcp-relay', version: '0.1.0-alpha.1' });
  const auth = { _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp:tools'] }] } };
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
