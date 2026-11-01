import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import WebSocket from 'ws';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';
import { MAX_FRAME_BYTES, toolUnavailable, type RelayCall, type RelayReply } from './relay-channel.js';
import { createContext, createServer } from './server.js';
import { monitorWebSocketHeartbeat } from './websocket-heartbeat.js';

export type AgentConnectionOptions = { url: string; token: string; signal?: AbortSignal; onConnect?: () => void };

export function validateAgentConnection(options: AgentConnectionOptions): void {
  const url = new URL(options.url);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopback)) {
    throw new AgentError('INVALID_CONFIG', 'Agent relay requires wss:// (ws:// only allowed on localhost)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/agent/ws') {
    throw new AgentError('INVALID_CONFIG', 'Relay WebSocket URL must end at /agent/ws without credentials or query');
  }
  if (Buffer.byteLength(options.token) < 32 || /[\r\n]/.test(options.token)) {
    throw new AgentError('INVALID_CONFIG', 'RELAY_DEVICE_TOKEN must be a 32+ byte random secret');
  }
}

/** Runs on the Mac. Makes outgoing connections only; the relay cannot run arbitrary code. */
export async function runRemoteAgent(config: AgentConfig, options: AgentConnectionOptions): Promise<void> {
  validateAgentConnection(options);
  if (process.platform !== 'darwin' && process.env.REMOTE_MCP_ALLOW_NON_MAC !== '1') {
    throw new AgentError('UNSUPPORTED_PLATFORM', 'The remote agent targets macOS');
  }
  const ctx = await createContext(config);
  await ctx.device.assertConnected();
  const local = createServer(ctx);
  const client = new Client({ name: 'remote-mcp-agent-relay', version: '0.1.0-alpha.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([local.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const allowed = new Set((await client.listTools()).tools.map(tool => tool.name));
    while (!options.signal?.aborted) {
      await new Promise<void>(resolve => {
        const ws = new WebSocket(options.url, { headers: { Authorization: `Bearer ${options.token}` },
          maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 10_000 });
        let active = 0;
        const abort = () => ws.terminate();
        options.signal?.addEventListener('abort', abort, { once: true });
        ws.on('open', () => {
          monitorWebSocketHeartbeat(ws);
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
        ws.on('error', () => { /* Reconnect after close, without logging credentials. */ });
        ws.once('close', () => {
          options.signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      if (!options.signal?.aborted) await delay(2_000, undefined, { signal: options.signal }).catch(() => {});
    }
  } finally {
    await client.close();
    await local.close();
  }
}
