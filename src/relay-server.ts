import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createProxyServer } from './proxy-server.js';
import { createAgentSocketServer, RelayChannel } from './relay-channel.js';

export type RelayConfig = {
  publicOrigin: string;
  authIssuer: string;
  jwksUrl: string;
  ownerSubject: string;
  deviceToken: string;
  bind: string;
  port: number;
};

export function relayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    publicOrigin: env.RELAY_PUBLIC_ORIGIN ?? '', authIssuer: env.RELAY_AUTH_ISSUER ?? '',
    jwksUrl: env.RELAY_JWKS_URL ?? '', ownerSubject: env.RELAY_OWNER_SUB ?? '',
    deviceToken: env.RELAY_DEVICE_TOKEN ?? '', bind: env.RELAY_BIND ?? '127.0.0.1',
    port: Number(env.RELAY_PORT ?? '3417'),
  };
}

function configUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

export function validateRelayConfig(config: RelayConfig): void {
  const origin = configUrl(config.publicOrigin, 'RELAY_PUBLIC_ORIGIN');
  if (origin.origin !== origin.href.replace(/\/$/, '') || origin.pathname !== '/') {
    throw new Error('RELAY_PUBLIC_ORIGIN must be only the HTTPS origin, without a path or trailing slash');
  }
  const issuer = configUrl(config.authIssuer, 'RELAY_AUTH_ISSUER');
  const jwks = configUrl(config.jwksUrl, 'RELAY_JWKS_URL');
  if (issuer.origin !== jwks.origin) throw new Error('JWKS must be hosted on the OAuth issuer origin');
  if (!config.ownerSubject || config.ownerSubject.length > 300) throw new Error('RELAY_OWNER_SUB required');
  if (Buffer.byteLength(config.deviceToken) < 32) throw new Error('RELAY_DEVICE_TOKEN must be at least 32 random bytes');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid RELAY_PORT');
  // Security default: Nginx reverse-proxies loopback. Never bind relay to a public interface.
  if (config.bind !== '127.0.0.1' && config.bind !== '::1') throw new Error('Relay must bind to loopback');
}

export function createOAuthTokenVerifier(config: RelayConfig): (token: string) => Promise<boolean> {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5_000 });
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.authIssuer, audience: config.publicOrigin, algorithms: ['RS256', 'ES256', 'PS256'],
        clockTolerance: 5,
      });
      if (typeof payload.exp !== 'number' || payload.sub !== config.ownerSubject) return false;
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) :
        Array.isArray(payload.scp) ? payload.scp : [];
      return scopes.includes('mcp:tools');
    } catch { return false; }
  };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function proxyResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
  else res.end();
}

export async function startRelayServer(config: RelayConfig,
  verifyToken: (token: string) => Promise<boolean> = createOAuthTokenVerifier(config)):
  Promise<{ port: number; channel: RelayChannel; close: () => Promise<void> }> {
  validateRelayConfig(config);
  const channel = new RelayChannel();
  const agentSockets = createAgentSocketServer(channel, config.deviceToken);
  const handler = createMcpHandler(() => createProxyServer(channel), { maxRequestBodySize: 1_048_576 });
  const metadataPath = '/.well-known/oauth-protected-resource';
  const metadataUrl = `${config.publicOrigin}${metadataPath}`;
  const http = createServer((req, res) => {
    (async () => {
      const pathname = new URL(req.url ?? '/', config.publicOrigin).pathname;
      if (req.method === 'GET' && pathname === metadataPath) {
        json(res, 200, { resource: config.publicOrigin,
          authorization_servers: [config.authIssuer], scopes_supported: ['mcp:tools'], bearer_methods_supported: ['header'] });
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') { json(res, 200, { ok: true }); return; }
      if (pathname !== '/mcp') { json(res, 404, { error: 'not_found' }); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
      if (req.headers.origin) { json(res, 403, { error: 'origin_not_allowed' }); return; }
      const authorization = req.headers.authorization;
      const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(authorization ?? '');
      if (!match || !(await verifyToken(match[1]!))) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="mcp:tools", error="invalid_token"`);
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      const request = new Request(`${config.publicOrigin}${req.url ?? '/mcp'}`, {
        method: 'POST', headers, body: Readable.toWeb(req) as unknown as RequestInit['body'], duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      await proxyResponse(res, await handler.fetch(request));
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  });
  http.on('upgrade', (req: IncomingMessage, socket, head) => agentSockets.upgrade(req, socket, head));
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.port, config.bind, () => { http.off('error', reject); resolve(); });
    });
  } catch (error) { await agentSockets.close(); await handler.close(); throw error; }
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return {
    port, channel,
    async close() {
      await agentSockets.close();
      await handler.close();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
}
