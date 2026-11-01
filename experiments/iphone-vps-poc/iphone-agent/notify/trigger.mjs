import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Stateless MVP: no server, daemon, stored APNs credential, or iOS private API.
// Only innocuous notifications may be sent over a public high-entropy topic.
export const ACTIONS = Object.freeze([
  'open_youtube', 'open_tiktok', 'open_spotify',
  'open_starbridges', 'media_play_pause',
]);

// curl respects the VPS's configured outbound proxy. Keep the private topic
// out of process argv (visible through `ps`) by passing curl's config on stdin.
async function curlPublish(url, request) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/curl', [
      '--config', '-', '--silent', '--show-error', '--max-time', '10',
      '--output', '/dev/null', '--write-out', '%{http_code}',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk.toString().slice(0, 64); });
    child.stderr.on('data', chunk => { diagnostic += chunk.toString().slice(0, 200); });
    child.on('error', reject);
    child.on('close', code => {
      const status = Number(output.trim());
      if (code !== 0 || !Number.isInteger(status)) return reject(new Error(`curl notification failed (${code}): ${diagnostic.slice(0, 120)}`));
      resolve({ ok: status >= 200 && status < 300, status });
    });
    child.stdin.end([
      `url = "${url}"`,
      'request = "POST"',
      'header = "Title: iPhone Agent"',
      'header = "Priority: default"',
      'header = "Cache: no"',
      `data = "${request.body}"`,
    ].join('\n'));
  });
}

export async function trigger(action, { topic, fetchImpl = curlPublish } = {}) {
  if (!ACTIONS.includes(action)) throw new Error('Unsupported action');
  if (typeof topic !== 'string' || !/^iphoneagent_[a-f0-9]{48,52}$/.test(topic)) {
    throw new Error('Invalid private notification topic');
  }
  const response = await fetchImpl(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: { Title: 'iPhone Agent', Priority: 'default', Cache: 'no', 'Content-Type': 'text/plain; charset=utf-8' },
    body: action,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Notification provider returned HTTP ${response.status}`);
  return { ok: true, action, notificationSent: true, status: 'notification_sent_not_executed' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const action = process.argv[2];
    // Topic is stored outside source control and never printed.
    const topic = (await readFile('/home/arkan-ops/iphone-agent-notify/topic', 'utf8')).trim();
    const result = await trigger(action, { topic });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
