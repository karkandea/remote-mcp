#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { configPath, initConfig, loadConfig } from './config.js';
import { DeviceState } from './device.js';
import { runStdio } from './server.js';
import { toResult } from './errors.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const device = new DeviceState();
  switch (command) {
    case 'init':
      await initConfig();
      process.stdout.write(`Created disabled-by-default config at ${configPath()}\n`);
      return;
    case 'start':
      await runStdio(await loadConfig());
      return;
    case 'doctor': {
      const report: Record<string, unknown> = {
        platform: process.platform, node: process.version, configFile: configPath(),
        configExists: existsSync(configPath()), connected: await device.connected(),
      };
      if (report.configExists) {
        try {
          const config = await loadConfig();
          report.allowedRoots = config.allowedRoots;
          report.writesEnabled = config.allowWrites;
          report.commandProfiles = Object.keys(config.commandProfiles);
        } catch (error) { report.configError = toResult(error); }
      }
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    case 'config': {
      const config = await loadConfig();
      process.stdout.write(JSON.stringify({ path: configPath(), ...config }, null, 2) + '\n');
      return;
    }
    case 'status':
      process.stdout.write(JSON.stringify(await device.status(), null, 2) + '\n');
      return;
    case 'stop':
      await device.disconnect();
      process.stdout.write('Access disabled. Stop the MCP host process to close the stdio transport.\n');
      return;
    case 'resume':
      await device.resumeLocally();
      process.stdout.write('Local access re-enabled. Restart the MCP host connection.\n');
      return;
    default:
      process.stdout.write('Usage: remote-mcp <init|start|stop|resume|status|doctor|config>\n');
      if (command !== 'help') process.exitCode = 2;
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify(toResult(error)) + '\n');
  process.exitCode = 1;
});
