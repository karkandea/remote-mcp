import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, stat, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';
import { PathPolicy } from './policy.js';

function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

export class FileTools {
  constructor(private readonly policy: PathPolicy, private readonly config: AgentConfig) {}

  async list(input: string): Promise<unknown> {
    const target = await this.policy.readPath(input);
    const entries = await readdir(target, { withFileTypes: true });
    return { path: target, entries: entries.slice(0, 200).map(entry => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    })), truncated: entries.length > 200 };
  }

  async stat(input: string): Promise<unknown> {
    const target = await this.policy.readPath(input);
    const info = await stat(target);
    return { path: target, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size,
      modifiedAt: info.mtime.toISOString(), mode: info.mode & 0o777 };
  }

  async read(input: string): Promise<unknown> {
    const target = await this.policy.readPath(input);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new AgentError('NOT_FILE', 'Expected a regular file');
      if (info.size > Math.min(this.config.maxReadBytes, this.config.maxOutputBytes - 2048)) {
        throw new AgentError('FILE_TOO_LARGE', 'File exceeds response limit');
      }
      const value = await handle.readFile();
      if (value.includes(0)) throw new AgentError('BINARY_FILE', 'Binary files are not supported');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(value); }
      catch { throw new AgentError('INVALID_UTF8', 'Only valid UTF-8 text files are supported'); }
      return { path: target, content, sha256: sha256(value), bytes: value.byteLength };
    } finally { await handle.close(); }
  }

  async search(directory: string, query: string, limit = 50): Promise<unknown> {
    if (!query || query.length > 200) throw new AgentError('INVALID_QUERY', 'Query must be between 1 and 200 characters');
    const root = await this.policy.readPath(directory);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let visited = 0;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (stack.length && matches.length < limit && visited < 1000) {
      const item = stack.pop()!;
      if (item.depth > 8) continue;
      const children = await readdir(item.directory, { withFileTypes: true });
      for (const child of children) {
        if (matches.length >= limit || visited >= 1000) break;
        if (child.isSymbolicLink()) continue;
        const candidate = path.join(item.directory, child.name);
        let safePath: string;
        try { safePath = await this.policy.readPath(candidate); }
        catch { continue; }
        if (child.isDirectory()) { stack.push({ directory: safePath, depth: item.depth + 1 }); continue; }
        if (!child.isFile()) continue;
        visited++;
        const info = await lstat(safePath);
        if (info.size > this.config.maxReadBytes) continue;
        let content: string;
        try { content = (await this.read(safePath) as { content: string }).content; }
        catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (lines[i]!.includes(query)) matches.push({ path: safePath, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      }
    }
    return { query, matches, visitedFiles: visited, truncated: matches.length >= limit || visited >= 1000 };
  }

  async applyPatch(input: string, expectedText: string, replacementText: string, expectedSha256?: string): Promise<unknown> {
    if (!expectedText || expectedText === replacementText) throw new AgentError('INVALID_PATCH', 'Expected and replacement text must differ, and expectedText must be nonempty');
    const target = await this.policy.writePath(input);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let original: Buffer;
    let mode: number;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.config.maxReadBytes) throw new AgentError('FILE_TOO_LARGE', 'Target is not a supported regular file');
      mode = info.mode & 0o777;
      original = await handle.readFile();
    } finally { await handle.close(); }
    const initialHash = sha256(original);
    if (expectedSha256 && initialHash !== expectedSha256) throw new AgentError('CONFLICT', 'File hash differs from expectedSha256');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(original); }
    catch { throw new AgentError('INVALID_UTF8', 'Only valid UTF-8 text files can be patched'); }
    const start = content.indexOf(expectedText);
    if (start === -1 || content.indexOf(expectedText, start + expectedText.length) !== -1) {
      throw new AgentError('CONFLICT', 'Expected text must occur exactly once');
    }
    const changed = content.slice(0, start) + replacementText + content.slice(start + expectedText.length);
    if (Buffer.byteLength(changed) > this.config.maxReadBytes) throw new AgentError('FILE_TOO_LARGE', 'Patched file exceeds maxReadBytes');
    const tmp = path.join(path.dirname(target), `.remote-mcp-${randomUUID()}.tmp`);
    try {
      const tempHandle = await open(tmp, 'wx', mode);
      try { await tempHandle.writeFile(changed, 'utf8'); await tempHandle.sync(); }
      finally { await tempHandle.close(); }
      // Best-effort concurrency detection; not a hardened transactional filesystem sandbox.
      const current = await this.policy.writePath(target);
      const verify = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (sha256(await verify.readFile()) !== initialHash) throw new AgentError('CONFLICT', 'File changed during patch'); }
      finally { await verify.close(); }
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    return { path: target, beforeSha256: initialHash, afterSha256: sha256(changed), bytes: Buffer.byteLength(changed) };
  }
}
