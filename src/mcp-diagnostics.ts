import { statfs } from 'node:fs/promises';

/**
 * A deliberately unprivileged relay self-check. It does not contact the root
 * helper, execute commands, read Mac files, or probe other applications.
 */
export async function collectMcpDiagnostics(macAgentConnected: boolean, rootHelperConfigured: boolean) {
  const disk = await statfs('/');
  const totalBytes = disk.blocks * disk.bsize;
  const availableBytes = disk.bavail * disk.bsize;
  const usedBytes = (disk.blocks - disk.bfree) * disk.bsize;
  const usedPercent = totalBytes ? Math.round(1000 * usedBytes / totalBytes) / 10 : 0;

  return {
    checkedAt: new Date().toISOString(),
    relay: { reachable: true, uptimeSeconds: Math.floor(process.uptime()) },
    mac: {
      agentConnected: macAgentConnected,
      nextStep: macAgentConnected ? null : 'Mac agent is offline; check its local state on the Mac. Do not alter network settings.',
    },
    vpsDisk: {
      usedPercent, availableBytes,
      level: usedPercent >= 90 || availableBytes < 2_000_000_000 ? 'critical' :
        usedPercent >= 85 ? 'warning' : 'normal',
      note: 'Disk capacity is independent of ChatGPT tool safety decisions.',
    },
    rootExecutor: {
      configured: rootHelperConfigured,
      healthProbed: false,
      note: 'This unprivileged check does not contact or authorize the root helper.',
    },
    toolGuide: {
      relayAndMacConnectivity: 'mcp_diagnostics',
      vpsDiskDetails: 'vps_storage_audit',
      macStatus: 'device_status (only when the Mac agent is online)',
      macFiles: 'fs_list / fs_read / fs_stat / fs_search (approved roots only)',
      macCommands: 'terminal_start (exact locally configured profile only)',
      privilegedExecution: 'vps_root_exec and mac_user_exec are high risk; do not use for simple status checks',
    },
    hostSafety: 'If ChatGPT blocks a call before MCP receives it, this relay cannot approve or override the block. Do not retry the denied action through another tool.',
    readOnly: true as const,
  };
}
