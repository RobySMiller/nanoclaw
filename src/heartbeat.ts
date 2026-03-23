/**
 * Heartbeat system for hybrid local/Railway deployment.
 *
 * - Railway instance: listens for heartbeats on PORT, skips message
 *   processing when local is alive.
 * - Local instance: sends heartbeats to HEARTBEAT_TARGET_URL every 10s.
 */
import http from 'http';

import { logger } from './logger.js';

const HEARTBEAT_INTERVAL = 10_000; // 10 seconds
const HEARTBEAT_TIMEOUT = 30_000; // 30 seconds — local considered dead after this

let lastHeartbeat = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

// ── Receiver (Railway) ──────────────────────────────────────────────

export function startHeartbeatReceiver(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/heartbeat') {
      lastHeartbeat = Date.now();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          localAlive: isLocalAlive(),
          lastHeartbeat: lastHeartbeat || null,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Heartbeat receiver listening');
  });

  return server;
}

/** Returns true if the local instance sent a heartbeat recently. */
export function isLocalAlive(): boolean {
  return lastHeartbeat > 0 && Date.now() - lastHeartbeat < HEARTBEAT_TIMEOUT;
}

// ── Sender (local) ─────────────────────────────────────────────────

export function startHeartbeatSender(targetUrl: string): void {
  const send = async () => {
    try {
      const url = new URL('/heartbeat', targetUrl);
      await fetch(url.toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Silent fail — Railway might be down, that's fine
    }
  };

  heartbeatTimer = setInterval(send, HEARTBEAT_INTERVAL);
  send(); // immediate first beat
  logger.info({ targetUrl, intervalMs: HEARTBEAT_INTERVAL }, 'Heartbeat sender started');
}

export function stopHeartbeatSender(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
