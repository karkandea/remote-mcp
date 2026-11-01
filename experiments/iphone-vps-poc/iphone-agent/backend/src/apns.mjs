import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function jwt({ keyId, teamId, privateKey, now }) {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(now() / 1000) })).toString('base64url');
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${input}.${signature}`;
}

export class ApnsSender {
  constructor({ keyId, teamId, topic, keyPath, environment = 'sandbox', now = Date.now } = {}) {
    this.keyId = keyId;
    this.teamId = teamId;
    this.topic = topic;
    this.keyPath = keyPath;
    this.environment = environment;
    this.now = now;
  }

  get configured() {
    return Boolean(this.keyId && this.teamId && this.topic && this.keyPath);
  }

  async send(deviceToken) {
    if (!this.configured) throw new Error('APNs credentials not configured');
    if (!/^[a-fA-F0-9]{64,256}$/.test(deviceToken)) throw new Error('Invalid APNs device token');
    const key = await readFile(this.keyPath, 'utf8');
    const origin = this.environment === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const client = http2.connect(origin);
    const authorization = `bearer ${jwt({ keyId: this.keyId, teamId: this.teamId, privateKey: key, now: this.now })}`;
    const payload = JSON.stringify({ aps: { alert: { title: 'iPhone Agent', body: 'Perintah baru tersedia' }, sound: 'default' } });
    try {
      return await new Promise((resolve, reject) => {
        const request = client.request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`,
          authorization, 'apns-topic': this.topic,
          'apns-push-type': 'alert', 'apns-priority': '10',
          'content-type': 'application/json',
        });
        let status = 0;
        let responseBytes = 0;
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { responseBytes += chunk.length; });
        request.on('end', () => status === 200
          ? resolve({ sent: true })
          : reject(new Error(`APNs HTTP ${status}; response bytes ${responseBytes}`)));
        request.on('error', reject);
        request.end(payload);
      });
    } finally {
      client.close();
    }
  }
}
