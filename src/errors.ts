export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export function toResult(error: unknown): { code: string; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const codes: Record<string, string> = {
      ENOENT: 'Path or command was not found',
      EACCES: 'Permission denied by the operating system',
      EPERM: 'Operation not permitted by the operating system',
      EISDIR: 'Expected a file but found a directory',
    };
    return { code: error.code, message: codes[error.code] ?? 'Operating system error' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Operation failed. Check local diagnostics.' };
}
