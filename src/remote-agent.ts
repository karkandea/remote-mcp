import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import WebSocket from 'ws';
import type { AgentConfig } from './config.js';
import type { DeviceState } from './device.js';
import { AgentError } from './errors.js';
import { MAX_FRAME_BYTES, toolUnavailable, type RelayCall, type RelayReply } from './relay-channel.js';
import { createContext, createServer } from './server.js';
import { monitorWebSocketHeartbeat } from './websocket-heartbeat.js';
import { DEVICE_HEADER, WINDOWS_TOOLS } from './windows-device.js';

export type DisconnectEvent = {
  closeCode: number;
  errorCode?: string;
  connectedMs: number;
  retryInMs: number;
};

export type AgentConnectionOptions = {
  url: string;
  token: string;
  signal?: AbortSignal;
  onConnect?: () => void;
  onDisconnect?: (event: DisconnectEvent) => void;
};

type WindowsTarget = { device: DeviceState };

export function validateAgentUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AgentError('INVALID_CONFIG', 'A valid relay WebSocket URL is required'); }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopback)) {
    throw new AgentError('INVALID_CONFIG', 'Agent relay requires wss:// (ws:// only allowed on localhost)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/agent/ws') {
    throw new AgentError('INVALID_CONFIG', 'Relay WebSocket URL must end at /agent/ws without credentials or query');
  }
}

export function validateAgentConnection(options: AgentConnectionOptions): void {
  validateAgentUrl(options.url);
  if (Buffer.byteLength(options.token) < 32 || /[\r\n]/.test(options.token)) {
    throw new AgentError('INVALID_CONFIG', 'RELAY_DEVICE_TOKEN must be a 32+ byte random secret');
  }
}

/** Makes outgoing connections only. Windows exposes only its read-only file and device tools. */
export async function runRemoteAgent(config: AgentConfig, options: AgentConnectionOptions,
  windows?: WindowsTarget): Promise<void> {
  validateAgentConnection(options);
  const expectedPlatform = windows ? 'win32' : 'darwin';
  if (process.platform !== expectedPlatform && process.env.REMOTE_MCP_ALLOW_NON_MAC !== '1') {
    throw new AgentError('UNSUPPORTED_PLATFORM', `The remote agent requires ${windows ? 'Windows' : 'macOS'}`);
  }
  const ctx = await createContext(config, windows?.device);
  await ctx.device.assertConnected();
  const local = createServer(ctx, windows ? 'remote-mcp windows-resume' : undefined);
  const client = new Client({ name: 'remote-mcp-agent-relay', version: '0.1.0-alpha.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([local.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const allowed = new Set(windows ? Object.keys(WINDOWS_TOOLS) : (await client.listTools()).tools.map(tool => tool.name));
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
    if (windows) headers[DEVICE_HEADER] = 'windows';
    let retryAttempt = 0;
    while (!options.signal?.aborted) {
      let openedAt = 0;
      let closeCode = 1006;
      let errorCode: string | undefined;
      await new Promise<void>(resolve => {
        const ws = new WebSocket(options.url, { headers,
          maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 10_000 });
        let active = 0;
        const abort = () => ws.terminate();
        options.signal?.addEventListener('abort', abort, { once: true });
        ws.on('open', () => {
          openedAt = Date.now();
          monitorWebSocketHeartbeat(ws, undefined, undefined, () => { errorCode = 'HEARTBEAT_TIMEOUT'; });
          options.onConnect?.();
        });
        ws.on('message', async (data, isBinary) => {
          if (isBinary) { ws.close(1003, 'Text frames only'); return; }
          let call: RelayCall;
          try {
            call = JSON.parse(data.toString()) as RelayCall;
            if (call.type !== 'call' || typeof call.id !== 'string' || !/^[0-9a-f-]{36}$/.test(call.id) ||
                typeof call.name !== 'string' || !allowed.has(call.name) ||
                !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
              throw new Error('Invalid call');
            }
          } catch { ws.close(1003, 'Invalid call'); return; }
          if (active >= 16) { send({ type: 'reply', id: call.id, result: toolUnavailable('Agent is busy') }); return; }
          active++;
          try {
            const result = await client.callTool({ name: call.name, arguments: call.args });
            send({ type: 'reply', id: call.id, result });
          } catch {
            send({ type: 'reply', id: call.id, result: toolUnavailable('Local tool invocation failed') });
          } finally { active--; }
        });
        function send(message: RelayReply) {
          const json = JSON.stringify(message);
          if (Buffer.byteLength(json) > MAX_FRAME_BYTES) { ws.close(1009, 'Tool result too large'); return; }
          if (ws.readyState === WebSocket.OPEN) ws.send(json);
        }
        ws.on('error', (error: Error & { code?: string }) => {
          // Log only a safe error category; never URLs, headers or device credentials.
          errorCode = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'WEBSOCKET_ERROR';
        });
        ws.once('close', (code) => {
          closeCode = code;
          options.signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      if (!options.signal?.aborted) {
        const connectedMs = openedAt ? Date.now() - openedAt : 0;
        if (connectedMs >= 30_000) retryAttempt = 0;
        const retryInMs = Math.min(30_000, 2_000 * 2 ** Math.min(retryAttempt++, 4));
        options.onDisconnect?.({ closeCode, errorCode, connectedMs, retryInMs });
        await delay(retryInMs, undefined, { signal: options.signal }).catch(() => {});
      }
    }
  } finally {
    await client.close();
    await local.close();
  }
}
