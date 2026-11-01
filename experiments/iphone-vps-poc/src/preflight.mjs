import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function executable(name) {
  try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

function pairedRecordCount() {
  try { return readdirSync('/var/lib/lockdown').filter(name => name.endsWith('.plist')).length; }
  catch { return 0; }
}

export function assess(snapshot) {
  const checks = [
    { id: 'linux', ok: snapshot.platform === 'linux', detail: 'Linux host' },
    { id: 'node22', ok: snapshot.nodeMajor >= 22, detail: 'Node.js >= 22' },
    { id: 'tun', ok: snapshot.tun, detail: '/dev/net/tun available' },
    { id: 'usbmuxd', ok: snapshot.usbmuxd, detail: 'usbmuxd installed' },
    { id: 'appium', ok: snapshot.appium, detail: 'isolated Appium binary installed' },
    { id: 'paired', ok: snapshot.pairedRecords > 0, detail: 'host has device trust record (contents not inspected)' },
    { id: 'privateTunnel', ok: snapshot.privateTunnel, detail: 'private tunnel available to device' },
  ];
  const warnings = [];
  if (snapshot.diskUsedPct >= 85) warnings.push(`shared VPS disk at ${snapshot.diskUsedPct}%`);
  if (snapshot.diskFreeGiB < 3) warnings.push('less than 3 GiB free for driver installation');
  return { status: checks.every(check => check.ok) ? 'prerequisites-present' : 'blocked',
    checks, warnings,
    note: 'Preflight only. This does not establish device reachability or prove UI control.' };
}

export function capture() {
  const root = process.env.IPHONE_POC_ROOT || '/opt/iphone-vps-poc';
  const fsInfo = statfsSync(root && existsSync(root) ? root : '/opt');
  const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
  const total = Number(fsInfo.blocks) * Number(fsInfo.bsize);
  const iface = os.networkInterfaces();
  return {
    platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]),
    tun: existsSync('/dev/net/tun'), usbmuxd: Boolean(executable('usbmuxd')),
    appium: existsSync(path.join(root, 'node_modules', '.bin', 'appium')),
    pairedRecords: pairedRecordCount(),
    privateTunnel: Object.keys(iface).some(name => /^(wg|tailscale|utun)/.test(name)),
    diskFreeGiB: Math.round(free / 2 ** 30 * 10) / 10,
    diskUsedPct: Math.round((1 - free / total) * 100),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const snapshot = capture();
  const result = assess(snapshot);
  process.stdout.write(JSON.stringify({ ...result, host: os.hostname(), diskFreeGiB: snapshot.diskFreeGiB }, null, 2) + '\n');
  if (result.status === 'blocked') process.exitCode = 2;
}
