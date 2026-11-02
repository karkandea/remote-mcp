import { AgentError, toResult } from './errors.js';

/** Map known root-helper failures to stable, safe diagnostics for the calling agent. */
export function toRootResult(error: unknown): { code: string; message: string; nextStep: string } {
  if (error instanceof AgentError && error.code === 'ROOT_DISABLED') {
    return { code: 'ROOT_DISABLED', message: 'The VPS root executor is disabled by the owner',
      nextStep: 'Do not bypass the disabled mode. Ask the owner to enable it through the documented setup if needed.' };
  }
  const message = error instanceof Error ? error.message : '';
  const osCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (/Root job history full/i.test(message)) {
    return { code: 'ROOT_HISTORY_FULL', message: 'The root helper cannot retain another execution result',
      nextStep: 'Check vps_root_status and helper version. The patched helper evicts finished jobs; do not restart while jobs are active.' };
  }
  if (/At most two root commands may run concurrently/.test(message)) {
    return { code: 'ROOT_BUSY', message: 'The root executor reached its concurrency limit',
      nextStep: 'Poll known execution IDs and retry only after capacity is available.' };
  }
  if (/Unknown root execution ID/.test(message)) {
    return { code: 'ROOT_EXECUTION_EXPIRED', message: 'The execution ID is no longer retained by the helper',
      nextStep: 'Do not assume the command failed. Inspect the target state before deciding whether a non-idempotent command is safe to repeat.' };
  }
  if (/Root helper response timeout|Root helper closed before response/.test(message)) {
    return { code: 'ROOT_RESPONSE_TIMEOUT', message: 'The root helper did not return a response in time',
      nextStep: 'Inspect vps_root_status and targeted helper logs. Verify command effects before retrying; avoid blind service restarts.' };
  }
  if (['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ECONNRESET', 'EPIPE'].includes(osCode)) {
    return { code: 'ROOT_SOCKET_UNAVAILABLE', message: 'The root helper socket is missing, inaccessible or disconnected',
      nextStep: 'Inspect the helper service state and Unix socket permissions. Do not change other services or credentials.' };
  }
  if (/Root command requires absolute cwd/.test(message)) {
    return { code: 'ROOT_INVALID_REQUEST', message: 'The root command requires an absolute working directory and valid arguments',
      nextStep: 'Correct the command parameters and retry only after validating the target.' };
  }
  const safe = toResult(error);
  return { code: safe.code, message: safe.message,
    nextStep: 'Check vps_root_status and the targeted root-helper service logs. Do not blindly repeat a privileged operation.' };
}
