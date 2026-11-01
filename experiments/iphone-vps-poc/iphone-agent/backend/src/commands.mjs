import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';

// Only safe, reversible iOS Shortcut actions are accepted here.
export const ACTIONS = Object.freeze({
  open_youtube: { label: 'Open YouTube', kind: 'open_app' },
  open_tiktok: { label: 'Open TikTok', kind: 'open_app' },
  open_spotify: { label: 'Open Spotify', kind: 'open_app' },
  open_starbridges: { label: 'Open Starbridges', kind: 'open_app' },
  media_play_pause: { label: 'Toggle media playback', kind: 'media' },
});

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export class CommandQueue {
  constructor({ now = () => Date.now(), ttlMs = 90_000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = null;
  }

  enqueue(action) {
    if (!Object.hasOwn(ACTIONS, action)) throw new Error('Unsupported action');
    if (this.pending && this.pending.expiresAt > this.now()) throw new Error('Previous command still pending');
    const command = { id: randomUUID(), action, expiresAt: this.now() + this.ttlMs };
    this.pending = command;
    return command;
  }

  take() {
    const command = this.pending;
    this.pending = null;
    if (!command || command.expiresAt <= this.now()) return null;
    return { id: command.id, action: command.action };
  }

  cancel(id) {
    if (this.pending?.id !== id) return false;
    this.pending = null;
    return true;
  }
}
