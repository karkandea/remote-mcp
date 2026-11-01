import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CommandQueue, safeEqual } from './commands.mjs';
import { SealedState } from './state.mjs';
import { ApnsSender } from './apns.mjs';

const MAX_BODY = 4096;
const respond = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const digest = value => createHash('sha256').update(value).digest('hex');

export async function createAgentServer({
  stateStore, apns, adminToken, pairingCode, pairingTtlMs = 10 * 60_000,
  now = () => Date.now(), manualMode = false,
} = {}) {
  if (!stateStore || !apns || typeof adminToken !== 'string' || adminToken.length < 32
    || !/^[0-9]{8}$/.test(pairingCode ?? '')) throw new Error('Invalid iPhone Agent server configuration');
  const state = await stateStore.load();
  const queue = new CommandQueue({ now });
  const pairingExpiry = now() + pairingTtlMs;
  let pairingFailures = 0;
  let writeLock = Promise.resolve();
  const persist = () => {
    writeLock = writeLock.then(() => stateStore.save(state));
    return writeLock;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/health/live') return respond(res, 200, { ok: true, service: 'iphone-agent', version: 1 });

      if (req.method === 'POST' && route === '/v1/enroll') {
        if (state.deviceSecretHash) return respond(res, 409, { ok: false, error: 'Device already paired' });
        if (now() > pairingExpiry || pairingFailures >= 5) return respond(res, 403, { ok: false, error: 'Pairing window expired or locked' });
        const body = await readJson(req);
        if (!safeEqual(body?.code, pairingCode)) {
          pairingFailures++;
          return respond(res, 403, { ok: false, error: 'Invalid pairing code' });
        }
        const secret = randomBytes(32).toString('base64url');
        state.deviceSecretHash = digest(secret);
        await persist();
        return respond(res, 201, { ok: true, deviceSecret: secret });
      }

      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (route.startsWith('/v1/device/')) {
        if (!state.deviceSecretHash || !safeEqual(digest(bearer), state.deviceSecretHash)) return respond(res, 401, { ok: false, error: 'Unauthorized device' });
        if (req.method === 'POST' && route === '/v1/device/push-token') {
          const body = await readJson(req);
          if (!/^[a-f0-9]{64,256}$/i.test(body?.token ?? '')) return respond(res, 400, { ok: false, error: 'Invalid push token' });
          state.apnsToken = body.token.toLowerCase();
          await persist();
          return respond(res, 200, { ok: true, registered: true });
        }
        if (req.method === 'POST' && route === '/v1/device/next') {
          return respond(res, 200, { ok: true, command: queue.take() });
        }
        if (req.method === 'GET' && route === '/v1/device/status') {
          return respond(res, 200, { ok: true, pushRegistered: Boolean(state.apnsToken), pushConfigured: apns.configured });
        }
      }

      if (route.startsWith('/v1/admin/')) {
        if (!safeEqual(bearer, adminToken)) return respond(res, 401, { ok: false, error: 'Unauthorized admin' });
        if (req.method === 'POST' && route === '/v1/admin/commands') {
          const body = await readJson(req);
          if (!state.deviceSecretHash) return respond(res, 409, { ok: false, error: 'No paired iPhone' });
          if (!apns.configured && !manualMode) return respond(res, 503, { ok: false, error: 'APNs not configured' });
          if (apns.configured && !state.apnsToken) return respond(res, 409, { ok: false, error: 'No APNs device token registered' });
          let command;
          try { command = queue.enqueue(body?.action); }
          catch (error) { return respond(res, 400, { ok: false, error: error.message }); }
          if (apns.configured) {
            try { await apns.send(state.apnsToken); }
            catch {
              queue.cancel(command.id);
              return respond(res, 502, { ok: false, error: 'APNs delivery failed; command discarded' });
            }
          }
          return respond(res, 202, { ok: true, commandId: command.id,
            notificationSent: Boolean(apns.configured),
            status: 'queued_not_executed' });
        }
      }
      return respond(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      return respond(res, Number.isInteger(error.status) ? error.status : 500, { ok: false, error: error.status ? error.message : 'Internal error' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const config = {
    stateStore: new SealedState(env.IPHONE_AGENT_STATE_FILE, env.IPHONE_AGENT_STATE_KEY),
    apns: new ApnsSender({ keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID,
      topic: env.APNS_TOPIC, keyPath: env.APNS_KEY_PATH, environment: env.APNS_ENVIRONMENT }),
    adminToken: env.IPHONE_AGENT_ADMIN_TOKEN,
    pairingCode: env.IPHONE_AGENT_PAIR_CODE,
    manualMode: env.IPHONE_AGENT_MANUAL_MODE === '1',
  };
  const server = await createAgentServer(config);
  const port = Number(env.IPHONE_AGENT_PORT ?? '4877');
  server.listen(port, '127.0.0.1', () => console.log(`iPhone Agent PoC listening on 127.0.0.1:${port}`));
}
