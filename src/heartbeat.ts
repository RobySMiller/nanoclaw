/**
 * Heartbeat system for hybrid local/Railway deployment.
 *
 * - Railway instance: listens for heartbeats on PORT. When local is alive,
 *   Railway disconnects from channels so only local processes messages.
 *   When heartbeats stop, Railway reconnects.
 * - Local instance: sends heartbeats to HEARTBEAT_TARGET_URL every 10s.
 *
 * Uses a 5-state machine for flap protection:
 *   UNKNOWN    → initial, never heard from local
 *   HEALTHY    → heartbeats arriving normally (local is alive)
 *   SUSPECT    → heartbeats missed, not yet failed over
 *   FAILED     → local is dead, Railway has taken over
 *   RECOVERING → heartbeats resumed, waiting for stability before yielding
 */
import http from 'http';

import { logger } from './logger.js';

const HEARTBEAT_INTERVAL = 10_000; // 10 seconds
const HEARTBEAT_TIMEOUT = 30_000; // 30 seconds — local considered dead after this
const HEARTBEAT_CHECK_INTERVAL = 5_000; // check state every 5s
const FAILOVER_THRESHOLD = 3; // consecutive misses before SUSPECT → FAILED
const RECOVERY_THRESHOLD = 6; // consecutive alive checks before RECOVERING → HEALTHY (~30s)
const SUSPECT_CLEAR_THRESHOLD = 2; // consecutive alive checks to exit SUSPECT → HEALTHY

// ── State Machine ───────────────────────────────────────────────────

type State = 'UNKNOWN' | 'HEALTHY' | 'SUSPECT' | 'FAILED' | 'RECOVERING';

let state: State = 'UNKNOWN';
let lastHeartbeat = 0;
let consecutiveMisses = 0;
let consecutiveAlive = 0;
let startedAt = 0;

let heartbeatTimer: NodeJS.Timeout | null = null;
let stateCheckTimer: NodeJS.Timeout | null = null;

function resetState(): void {
  state = 'UNKNOWN';
  lastHeartbeat = 0;
  consecutiveMisses = 0;
  consecutiveAlive = 0;
  startedAt = 0;
}

// ── Receiver (Railway) ──────────────────────────────────────────────

export function startHeartbeatReceiver(
  port: number,
  onLocalAlive: () => void,
  onLocalDead: () => void,
): http.Server {
  startedAt = Date.now();

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
          state,
          localAlive: state === 'HEALTHY' || state === 'RECOVERING',
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

  // Drive the state machine on a regular interval
  stateCheckTimer = setInterval(() => {
    const now = Date.now();
    const alive = lastHeartbeat > 0 && now - lastHeartbeat < HEARTBEAT_TIMEOUT;

    if (alive) {
      consecutiveAlive++;
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      consecutiveAlive = 0;
    }

    switch (state) {
      case 'UNKNOWN':
        if (alive) {
          state = 'HEALTHY';
          logger.info('Local instance came online');
          onLocalAlive();
        } else if (now - startedAt >= HEARTBEAT_TIMEOUT) {
          state = 'FAILED';
          logger.info('No local instance detected — taking over');
          onLocalDead();
        }
        break;

      case 'HEALTHY':
        if (!alive) {
          if (consecutiveMisses >= FAILOVER_THRESHOLD) {
            state = 'FAILED';
            logger.warn('Local instance went offline — taking over');
            onLocalDead();
          } else {
            state = 'SUSPECT';
            logger.info(
              { misses: consecutiveMisses, threshold: FAILOVER_THRESHOLD },
              'Heartbeat missed — entering SUSPECT',
            );
          }
        }
        break;

      case 'SUSPECT':
        if (alive && consecutiveAlive >= SUSPECT_CLEAR_THRESHOLD) {
          state = 'HEALTHY';
          logger.info('Heartbeat resumed — back to HEALTHY');
        } else if (!alive && consecutiveMisses >= FAILOVER_THRESHOLD) {
          state = 'FAILED';
          logger.warn('Local instance went offline — taking over');
          onLocalDead();
        }
        break;

      case 'FAILED':
        if (alive) {
          consecutiveAlive = 1;
          if (RECOVERY_THRESHOLD <= 1) {
            state = 'HEALTHY';
            logger.info('Local instance is back — yielding');
            onLocalAlive();
          } else {
            state = 'RECOVERING';
            logger.info(
              { needed: RECOVERY_THRESHOLD },
              'Local instance heartbeat detected — entering RECOVERING',
            );
          }
        }
        break;

      case 'RECOVERING':
        if (!alive) {
          state = 'FAILED';
          consecutiveAlive = 0;
          logger.warn('Heartbeat lost during recovery — back to FAILED');
        } else if (consecutiveAlive >= RECOVERY_THRESHOLD) {
          state = 'HEALTHY';
          logger.info('Local instance is stable — yielding');
          onLocalAlive();
        }
        break;
    }
  }, HEARTBEAT_CHECK_INTERVAL);

  return server;
}

/** Returns true if the local instance is considered alive (HEALTHY or RECOVERING). */
export function isLocalAlive(): boolean {
  return state === 'HEALTHY' || state === 'RECOVERING';
}

/** Returns the current state machine state. */
export function getHeartbeatState(): State {
  return state;
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
  logger.info(
    { targetUrl, intervalMs: HEARTBEAT_INTERVAL },
    'Heartbeat sender started',
  );
}

export function stopHeartbeatSender(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (stateCheckTimer) {
    clearInterval(stateCheckTimer);
    stateCheckTimer = null;
  }
  resetState();
}
