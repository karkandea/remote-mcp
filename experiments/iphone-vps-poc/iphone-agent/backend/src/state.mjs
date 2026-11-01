import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class SealedState {
  constructor(filename, keyBase64) {
    this.filename = filename;
    this.key = Buffer.from(keyBase64 ?? '', 'base64url');
    if (this.key.length !== 32) throw new Error('State encryption key must contain 32 random bytes (base64url)');
  }

  async load() {
    let raw;
    try { raw = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { deviceSecretHash: null, apnsToken: null };
      throw error;
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64url'));
    const data = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64url')), decipher.final()]);
    return JSON.parse(data.toString('utf8'));
  }

  async save(state) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const envelope = JSON.stringify({
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: encrypted.toString('base64url'),
    });
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temp = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temp, envelope, { mode: 0o600, flag: 'wx' });
    await rename(temp, this.filename);
  }
}
