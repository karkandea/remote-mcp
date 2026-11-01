import { ACTIONS } from './commands.mjs';

// Public ntfy.sh topics are used ONLY for harmless app-opening/media triggers.
// Topic must be high-entropy; no credentials or personal data in notifications.
export class NtfySender {
  constructor({ topic, endpoint = 'https://ntfy.sh', fetchImpl = fetch } = {}) {
    if (endpoint !== 'https://ntfy.sh') throw new Error('PoC requires the official HTTPS ntfy.sh endpoint');
    this.topic = topic;
    this.fetchImpl = fetchImpl;
    this.triggerOnly = true;
  }

  get configured() {
    return typeof this.topic === 'string' && /^[a-zA-Z0-9_-]{40,128}$/.test(this.topic);
  }

  async send(_unusedDeviceToken, action) {
    if (!this.configured) throw new Error('A high-entropy ntfy topic is required');
    if (!Object.hasOwn(ACTIONS, action)) throw new Error('Unsupported notification action');
    const response = await this.fetchImpl(`https://ntfy.sh/${this.topic}`, {
      method: 'POST',
      headers: { Title: 'iPhone Agent', Priority: 'default', Cache: 'no', 'Content-Type': 'text/plain' },
      body: action,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Notification provider rejected request (HTTP ${response.status})`);
    return { sent: true };
  }
}
