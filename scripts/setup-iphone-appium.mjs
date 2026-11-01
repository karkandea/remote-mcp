#!/usr/bin/env node
/** Owner-run setup: opt into narrow iPhone tools without granting arbitrary command profiles. */
import { access, chmod, copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const project = process.argv[2];
if (!project || !path.isAbsolute(project) || process.argv.length !== 3) {
  console.error('Usage: node scripts/setup-iphone-appium.mjs /absolute/path/to/iphone-control-poc');
  process.exitCode = 1;
} else {
  try {
    const folder = (await stat(project)).isDirectory();
    if (!folder) throw new Error('Project is not a directory');
    const executable = path.join(project, 'node_modules', '.bin', 'appium');
    await access(executable, constants.X_OK);
    const requestPath = path.join(project, 'session-request.json');
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    const capabilities = request?.capabilities?.alwaysMatch ?? request?.desiredCapabilities ?? {};
    const udid = capabilities['appium:udid'] ?? capabilities.udid;
    if (typeof udid !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(udid)) {
      throw new Error('session-request.json must contain a valid appium:udid or udid');
    }
    const bundleId = capabilities['appium:bundleId'] ?? capabilities.bundleId;
    if (bundleId !== undefined && (typeof bundleId !== 'string' ||
        !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId))) {
      throw new Error('Invalid appium:bundleId in session-request.json');
    }
    const localConfig = process.env.REMOTE_MCP_CONFIG ??
      path.join(homedir(), '.config', 'remote-mcp', 'config.json');
    if (!path.isAbsolute(localConfig)) throw new Error('REMOTE_MCP_CONFIG must be an absolute path');
    const config = JSON.parse(await readFile(localConfig, 'utf8'));
    const previous = config.iphoneControl ?? {};
    config.iphoneControl = {
      ...previous, enabled: true, appiumPort: previous.appiumPort ?? 4723,
      udid, appiumExecutable: executable, appiumHome: path.join(project, '.appium'), appiumCwd: project,
      allowedBundleIds: [...new Set([...(previous.allowedBundleIds ?? []), ...(bundleId ? [bundleId] : [])])],
      ...(bundleId ? { startupBundleId: bundleId } : {}),
      ...(typeof capabilities['appium:updatedWDABundleId'] === 'string'
        ? { updatedWDABundleId: capabilities['appium:updatedWDABundleId'] } : {}),
      ...(typeof capabilities['appium:xcodeOrgId'] === 'string'
        ? { xcodeOrgId: capabilities['appium:xcodeOrgId'] } : {}),
      ...(Number.isInteger(capabilities['appium:wdaLocalPort'])
        ? { wdaLocalPort: capabilities['appium:wdaLocalPort'] } : {}),
    };
    const backup = `${localConfig}.before-iphone-control`;
    try { await copyFile(localConfig, backup, constants.COPYFILE_EXCL); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const tempPath = `${localConfig}.iphone-setup-${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tempPath, localConfig);
    await chmod(localConfig, 0o600);
    console.log('iPhone Appium owner opt-in configured. Existing file roots and command profiles were not changed.');
    console.log(`Backup: ${backup}`);
    console.log(`Allowlisted iPhone apps: ${config.iphoneControl.allowedBundleIds.length}`);
    console.log('Restart the Mac Remote MCP Arkan agent, then refresh the plugin tools in ChatGPT.');
  } catch (error) {
    console.error(`Setup stopped without changing the MCP policy: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
