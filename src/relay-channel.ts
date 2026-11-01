import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { CallToolResult } from '@modelcontextprotocol/server';
import WebSocket, { WebSocketServer } from 'ws';
import { monitorWebSocketHeartbeat } from './websocket-heartbeat.js';

export const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING = 16;
const CALL_TIMEOUT_MS = 30_000;

export type RelayCall = { type: 'call'; id: string; name: string; args: Record<string, unknown> };
export type RelayReply = { type: 'reply'; id: string; result: CallToolResult };

export function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || !actual.startsWith('Bearer ')) return false;
  const provided = Buffer.from(actual.slice(7));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function toolUnavailable(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'RELAY_UNAVAILABLE', message } }) }] };
}

/** The VPS never sees local paths or executes commands except as bounded MCP tool arguments. */
export class RelayChannel {
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: CallToolResult) => void; timer: NodeJS.Timeout }>();

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  attach(socket: WebSocket): boolean {
    if (this.connected) return false;
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary) { socket.close(1003, 'Text frames only'); return; }
      let reply: RelayReply;
      try {
        reply = JSON.parse(data.toString()) as RelayReply;
        if (reply.type !== 'reply' || typeof reply.id !== 'string' ||
            !reply.result || typeof reply.result !== 'object' || !Array.isArray(reply.result.content)) {
          throw new Error('Invalid reply');
        }
      } catch { socket.close(1003, 'Invalid reply'); return; }
      const item = this.pending.get(reply.id);
      if (!item) { socket.close(1003, 'Unknown reply ID'); return; }
      clearTimeout(item.timer);
      this.pending.delete(reply.id);
      item.resolve(reply.result);
    });
    socket.on('close', () => this.detach(socket));
    socket.on('error', () => this.detach(socket));
    monitorWebSocketHeartbeat(socket);
    return true;
  }

  private detach(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve(toolUnavailable('Mac agent disconnected'));
    }
    this.pending.clear();
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return toolUnavailable('Mac agent is offline');
    if (this.pending.size >= MAX_PENDING) return toolUnavailable('Too many concurrent tool requests');
    const id = randomUUID();
    const payload = JSON.stringify({ type: 'call', id, name, args } satisfies RelayCall);
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return toolUnavailable('Request exceeds relay limit');
    return await new Promise<CallToolResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(toolUnavailable('Mac agent response timed out'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      socket.send(payload, error => {
        if (error) {
          const item = this.pending.get(id);
          if (item) { clearTimeout(item.timer); this.pending.delete(id); resolve(toolUnavailable('Agent transport error')); }
        }
      });
    });
  }

  close(): void { if (this.socket) this.socket.close(1001, 'Relay stopping'); }
}

export function createAgentSocketServer(channel: RelayChannel, secret: string): {
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => Promise<void>;
} {
  if (Buffer.byteLength(secret) < 32) throw new Error('RELAY_DEVICE_TOKEN must be at least 32 random bytes');
  const server = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: MAX_FRAME_BYTES });
  return {
    upgrade(req, socket, head) {
      let pathname: string;
      try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
      catch { socket.destroy(); return; }
      if (pathname !== '/agent/ws' || req.headers.origin ||
          !safeTokenEqual(req.headers.authorization, secret) || channel.connected) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      server.handleUpgrade(req, socket, head, ws => {
        if (!channel.attach(ws)) ws.close(1008, 'Device already online');
      });
    },
    async close() {
      channel.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
