import WebSocket from 'ws';

const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * Detect half-open TCP/WebSocket connections after sleep, Wi-Fi loss or network changes.
 * ws automatically replies to incoming pings; each peer independently checks its pongs.
 */
export function monitorWebSocketHeartbeat(
  socket: WebSocket,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  pongTimeoutMs = PONG_TIMEOUT_MS,
  onTimeout?: () => void,
): () => void {
  let stopped = false;
  let awaitingPong = false;
  let deadline: NodeJS.Timeout | undefined;

  const onPong = () => {
    awaitingPong = false;
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (deadline) clearTimeout(deadline);
    socket.off('pong', onPong);
    socket.off('close', stop);
  };

  const interval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN || awaitingPong) return;
    awaitingPong = true;
    deadline = setTimeout(() => {
      if (!stopped && awaitingPong) { onTimeout?.(); socket.terminate(); }
    }, pongTimeoutMs);
    deadline.unref();
    try { socket.ping(); }
    catch { onTimeout?.(); socket.terminate(); }
  }, intervalMs);
  interval.unref();
  socket.on('pong', onPong);
  socket.once('close', stop);
  return stop;
}
