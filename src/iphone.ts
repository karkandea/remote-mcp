import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';

const execFileAsync = promisify(execFile);
const MAX_APPIUM_RESPONSE_BYTES = 12 * 1024 * 1024;
// A base64 image plus the relay's JSON envelope must fit its 1 MiB frame.
const MAX_IMAGE_BYTES = 500_000;
const MAX_UI_CHARACTERS = 35_000;

type HttpVerb = 'GET' | 'POST' | 'DELETE';
type AppiumEnvelope = { value?: unknown; sessionId?: unknown };

/** A narrowly scoped Appium client on the Mac; the VPS cannot select endpoints or capabilities. */
export class IphoneTools {
  private sessionId?: string;
  private state: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private lastError?: string;
  private appiumChild?: ChildProcess;
  private appiumChildError?: string;

  constructor(private readonly config: AgentConfig['iphoneControl']) {}

  private assertEnabled(): void {
    if (!this.config.enabled) throw new AgentError('IPHONE_DISABLED', 'iPhone control is not enabled by the Mac owner');
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.config.appiumPort}`;
  }

  private async request(method: HttpVerb, endpoint: string, body?: unknown, timeoutMs = 22_000): Promise<AppiumEnvelope> {
    // All callers pass hard-coded routes or a session ID checked at creation; never a user URL.
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentError('APPIUM_UNAVAILABLE', 'Appium on Mac localhost did not respond; inspect its local service');
    }
    let size = 0;
    const chunks: Buffer[] = [];
    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_APPIUM_RESPONSE_BYTES) {
          await response.body.cancel().catch(() => {});
          throw new AgentError('APPIUM_TOO_LARGE', 'Appium response exceeded its safety limit');
        }
        chunks.push(buffer);
      }
    }
    let payload: AppiumEnvelope;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AppiumEnvelope; }
    catch { throw new AgentError('APPIUM_PROTOCOL', 'Appium returned invalid JSON'); }
    if (!response.ok || !payload || typeof payload !== 'object' ||
        (typeof payload.value === 'object' && payload.value !== null &&
          'error' in payload.value && typeof payload.value.error === 'string')) {
      // Appium error messages may contain paths, Xcode logs or device identifiers.
      throw new AgentError('APPIUM_ERROR', `Appium rejected ${method} ${endpoint.split('/')[1] || 'request'} (HTTP ${response.status}); inspect local logs`);
    }
    return payload;
  }

  async status(): Promise<unknown> {
    this.assertEnabled();
    let appiumOnline = false;
    let appiumReady = false;
    try {
      const response = await this.request('GET', '/status', undefined, 3_000);
      appiumOnline = true;
      appiumReady = !!(response.value && typeof response.value === 'object' &&
        'ready' in response.value && response.value.ready === true);
    } catch { /* A down Appium service must not mask the session state. */ }
    return { appiumOnline, appiumReady, sessionState: this.state, sessionActive: !!this.sessionId,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.appiumChildError ? { serverError: this.appiumChildError } : {}),
      allowedBundleIds: this.config.allowedBundleIds };
  }

  async startServer(): Promise<unknown> {
    this.assertEnabled();
    if (!this.config.appiumExecutable || !this.config.appiumHome || !this.config.appiumCwd) {
      throw new AgentError('IPHONE_CONFIG', 'The Mac owner must configure exact Appium executable, home and cwd');
    }
    if (this.appiumChild) return { serverState: 'starting-or-running', managedByAgent: true };
    const status = await this.status() as { appiumOnline: boolean };
    if (status.appiumOnline) return { serverState: 'already-running', managedByAgent: false };
    this.appiumChildError = undefined;
    let child: ChildProcess;
    try {
      // Use the agent's known Node runtime; macOS launchd often lacks npm's bin directory in PATH.
      child = spawn(process.execPath, [this.config.appiumExecutable, '--address', '127.0.0.1', '--port', String(this.config.appiumPort)], {
        cwd: this.config.appiumCwd, shell: false, stdio: 'ignore',
        env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin',
          APPIUM_HOME: this.config.appiumHome, LANG: 'en_US.UTF-8',
          ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) },
      });
    } catch {
      throw new AgentError('APPIUM_START_FAILED', 'Could not start the locally configured Appium executable');
    }
    this.appiumChild = child;
    child.on('error', () => {
      this.appiumChildError = 'Appium could not launch; inspect the local executable and directory';
      if (this.appiumChild === child) this.appiumChild = undefined;
    });
    child.on('exit', code => {
      this.appiumChildError = `Appium server exited (${code ?? 'signal'}); check local diagnostics`;
      if (this.appiumChild === child) this.appiumChild = undefined;
    });
    return { serverState: 'starting', managedByAgent: true, checkWith: 'iphone_status' };
  }

  stopServer(): unknown {
    this.assertEnabled();
    if (!this.appiumChild) {
      throw new AgentError('APPIUM_NOT_MANAGED', 'Appium was not started by this agent; stop it locally');
    }
    this.appiumChild.kill('SIGTERM');
    this.sessionId = undefined;
    this.state = 'idle';
    return { serverState: 'stopping' };
  }

  start(): unknown {
    this.assertEnabled();
    if (!this.config.udid) throw new AgentError('IPHONE_CONFIG', 'The owner must configure the iPhone UDID locally');
    if (this.state === 'starting') return { sessionState: this.state };
    if (this.sessionId) return { sessionState: 'ready', reused: true };
    this.state = 'starting';
    this.lastError = undefined;
    // Xcode/WebDriverAgent initialization can take minutes. Do not block the 30s VPS relay call.
    void this.createSession().catch(error => {
      this.state = 'error';
      this.lastError = error instanceof AgentError ? `${error.code}: ${error.message}` : 'Appium session failed; inspect local logs';
    });
    return { sessionState: 'starting', checkWith: 'iphone_status' };
  }

  private async createSession(): Promise<void> {
    const always = {
      platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': this.config.udid,
      'appium:noReset': true, 'appium:fullReset': false, 'appium:newCommandTimeout': 300,
      'appium:wdaLocalPort': this.config.wdaLocalPort,
      ...(this.config.xcodeOrgId ? { 'appium:xcodeOrgId': this.config.xcodeOrgId,
        'appium:xcodeSigningId': 'iPhone Developer' } : {}),
      ...(this.config.updatedWDABundleId ? { 'appium:updatedWDABundleId': this.config.updatedWDABundleId } : {}),
      ...(this.config.startupBundleId ? { 'appium:bundleId': this.config.startupBundleId } : {}),
    };
    const result = await this.request('POST', '/session', { capabilities: { alwaysMatch: always, firstMatch: [{}] } }, 240_000);
    const value = result.value && typeof result.value === 'object' ? result.value : {};
    const id = 'sessionId' in value ? value.sessionId : result.sessionId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new AgentError('APPIUM_PROTOCOL', 'Appium did not return a valid session ID');
    }
    this.sessionId = id;
    this.state = 'ready';
  }

  private activePath(suffix: string): string {
    this.assertEnabled();
    if (!this.sessionId) throw new AgentError('IPHONE_NO_SESSION', 'Start an iPhone session and wait for iphone_status: ready');
    return `/session/${this.sessionId}${suffix}`;
  }

  async stop(): Promise<unknown> {
    this.assertEnabled();
    if (this.state === 'starting') throw new AgentError('IPHONE_BUSY', 'Wait for session creation before stopping');
    if (!this.sessionId) { this.state = 'idle'; return { sessionState: 'idle' }; }
    await this.request('DELETE', this.activePath(''), undefined, 15_000);
    this.sessionId = undefined;
    this.state = 'idle';
    this.lastError = undefined;
    return { sessionState: 'idle' };
  }

  async uiTree(maxCharacters = 12_000): Promise<unknown> {
    const response = await this.request('GET', this.activePath('/source'));
    if (typeof response.value !== 'string') throw new AgentError('APPIUM_PROTOCOL', 'Missing UI source');
    const limit = Math.min(maxCharacters, MAX_UI_CHARACTERS);
    return { source: response.value.slice(0, limit), truncated: response.value.length > limit };
  }

  async tap(x: number, y: number): Promise<unknown> {
    await this.performTouch([
      { type: 'pointerMove', duration: 0, origin: 'viewport', x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerUp', button: 0 },
    ]);
    return { x, y, tapped: true };
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<unknown> {
    await this.performTouch([
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: fromX, y: fromY },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration: durationMs, origin: 'viewport', x: toX, y: toY },
      { type: 'pointerUp', button: 0 },
    ]);
    return { swiped: true, fromX, fromY, toX, toY };
  }

  private async performTouch(actions: unknown[]): Promise<void> {
    const path = this.activePath('/actions');
    try {
      await this.request('POST', path, { actions: [{ type: 'pointer', id: `finger-${randomUUID()}`,
        parameters: { pointerType: 'touch' }, actions }] });
    } finally {
      await this.request('DELETE', path, undefined, 3_000).catch(() => {});
    }
  }

  async openApp(bundleId: string): Promise<unknown> {
    this.assertEnabled();
    if (!this.config.allowedBundleIds.includes(bundleId)) {
      throw new AgentError('IPHONE_APP_DENIED', 'The Mac owner has not allowlisted this iPhone bundle ID');
    }
    await this.request('POST', this.activePath('/appium/device/activate_app'), { bundleId });
    return { bundleId, opened: true };
  }

  async screenshot(): Promise<{ mimeType: string; data: string }> {
    const response = await this.request('GET', this.activePath('/screenshot'), undefined, 25_000);
    if (typeof response.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.value)) {
      throw new AgentError('APPIUM_PROTOCOL', 'Missing base64 screenshot');
    }
    const png = Buffer.from(response.value, 'base64');
    if (png.length < 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new AgentError('APPIUM_PROTOCOL', 'Appium screenshot is not a PNG');
    }
    if (png.byteLength <= MAX_IMAGE_BYTES) return { mimeType: 'image/png', data: png.toString('base64') };
    if (process.platform !== 'darwin') throw new AgentError('IPHONE_IMAGE_TOO_LARGE', 'Large screenshots require macOS sips compression');
    const temp = await mkdtemp(path.join(tmpdir(), 'remote-mcp-iphone-'));
    try {
      const input = path.join(temp, 'screenshot.png');
      const output = path.join(temp, 'screenshot.jpg');
      await writeFile(input, png, { mode: 0o600 });
      await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '50',
        '--resampleHeightWidthMax', '900', input, '--out', output], { timeout: 10_000, maxBuffer: 32_768 });
      const jpg = await readFile(output);
      if (jpg.byteLength > MAX_IMAGE_BYTES) {
        throw new AgentError('IPHONE_IMAGE_TOO_LARGE', 'Compressed screenshot exceeds relay frame limit');
      }
      return { mimeType: 'image/jpeg', data: jpg.toString('base64') };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
