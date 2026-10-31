import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class PathPolicy {
  private constructor(private readonly config: AgentConfig, private readonly roots: string[]) {}

  static async create(config: AgentConfig): Promise<PathPolicy> {
    const roots = await Promise.all(config.allowedRoots.map(async root => {
      const resolved = await realpath(root);
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new AgentError('INVALID_ROOT', `Not a directory: ${root}`);
      return resolved;
    }));
    return new PathPolicy(config, roots);
  }

  listRoots(): string[] { return [...this.roots]; }

  private denySensitive(candidate: string): void {
    const forbidden = new Set(this.config.deniedNames.map(name => name.toLowerCase()));
    const segments = candidate.split(path.sep).filter(Boolean);
    if (segments.some(segment => forbidden.has(segment.toLowerCase()) || segment.toLowerCase().startsWith('.env.'))) {
      throw new AgentError('SENSITIVE_PATH', 'Access to protected paths is denied');
    }
  }

  private ensureAllowed(candidate: string): void {
    this.denySensitive(candidate);
    if (!this.roots.some(root => inside(candidate, root))) {
      throw new AgentError('PATH_DENIED', 'Path is outside configured allowedRoots');
    }
  }

  async readPath(input: string): Promise<string> {
    if (!path.isAbsolute(input)) throw new AgentError('INVALID_PATH', 'An absolute path is required');
    const normalized = path.resolve(input);
    this.denySensitive(normalized);
    const canonical = await realpath(normalized);
    this.ensureAllowed(canonical);
    // Reject a symlink at the final component. Parent symlinks are checked by canonical containment.
    const info = await lstat(normalized);
    if (info.isSymbolicLink()) throw new AgentError('SYMLINK_DENIED', 'Direct symlink access is not allowed');
    return canonical;
  }

  async writePath(input: string): Promise<string> {
    if (!this.config.allowWrites) throw new AgentError('WRITE_DISABLED', 'Write permission is disabled in config');
    if (!path.isAbsolute(input)) throw new AgentError('INVALID_PATH', 'An absolute path is required');
    const normalized = path.resolve(input);
    this.denySensitive(normalized);
    const parent = await realpath(path.dirname(normalized));
    const resolved = path.join(parent, path.basename(normalized));
    this.ensureAllowed(resolved);
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentError('INVALID_FILE', 'Only existing regular files may be modified');
    }
    return resolved;
  }
}
