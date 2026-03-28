/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *             Token is auto-refreshed before expiry using the refresh token.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import fs from 'fs';
import path from 'path';

import { sendAlert } from './alerts.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ── OAuth Token Refresh ─────────────────────────────────────────────

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

interface OAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

let oauthState: OAuthState | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

async function refreshAccessToken(): Promise<void> {
  if (!oauthState) return;

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: oauthState.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES,
  });

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(
        { status: response.status, body: text },
        'OAuth token refresh failed',
      );
      sendAlert(`⚠️ OAuth token refresh failed (HTTP ${response.status}). May fall back to expired token.`);
      return;
    }

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      logger.error({ data }, 'OAuth refresh response missing access_token');
      sendAlert('⚠️ OAuth refresh response missing access_token.');
      return;
    }

    oauthState.accessToken = data.access_token;
    if (data.refresh_token) {
      oauthState.refreshToken = data.refresh_token;
    }
    if (data.expires_in) {
      oauthState.expiresAt = Date.now() + data.expires_in * 1000;
    }

    // Persist refreshed tokens to .env so restarts use the latest values
    persistOAuthTokens(oauthState);

    scheduleRefresh();

    logger.info(
      {
        expiresIn: data.expires_in
          ? `${Math.round(data.expires_in / 60)}m`
          : 'unknown',
      },
      'OAuth token refreshed',
    );
  } catch (err) {
    logger.error({ err }, 'OAuth token refresh error');
    sendAlert(`⚠️ OAuth token refresh error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function persistOAuthTokens(state: OAuthState): void {
  try {
    const envPath = path.join(process.cwd(), '.env');
    let content = fs.readFileSync(envPath, 'utf-8');

    const updates: Record<string, string> = {
      CLAUDE_CODE_OAUTH_TOKEN: state.accessToken,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: state.refreshToken,
      CLAUDE_CODE_OAUTH_EXPIRES_AT: String(state.expiresAt),
    };

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
      }
    }

    fs.writeFileSync(envPath, content);
    logger.info('OAuth tokens persisted to .env');
  } catch (err) {
    logger.error({ err }, 'Failed to persist OAuth tokens');
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!oauthState) return;

  const delay = Math.max(
    0,
    oauthState.expiresAt - Date.now() - REFRESH_MARGIN_MS,
  );
  refreshTimer = setTimeout(() => {
    refreshAccessToken();
  }, delay);

  const mins = Math.round(delay / 60_000);
  logger.info({ refreshInMinutes: mins }, 'OAuth refresh scheduled');
}

function initOAuthState(secrets: Record<string, string>): void {
  const accessToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const refreshToken = secrets.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;

  if (!accessToken || !refreshToken) return;

  const expiresAt = secrets.CLAUDE_CODE_OAUTH_EXPIRES_AT
    ? parseInt(secrets.CLAUDE_CODE_OAUTH_EXPIRES_AT, 10)
    : Date.now() + 3600 * 1000; // default 1h if unknown

  oauthState = { accessToken, refreshToken, expiresAt };

  // If already expired or expiring soon, refresh immediately
  if (Date.now() >= expiresAt - REFRESH_MARGIN_MS) {
    logger.info('OAuth token expired or expiring soon, refreshing now');
    refreshAccessToken();
  } else {
    scheduleRefresh();
  }
}

// ── Proxy Server ────────────────────────────────────────────────────

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_EXPIRES_AT',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  if (authMode === 'oauth') {
    initOAuthState(secrets);
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          const currentToken =
            oauthState?.accessToken ??
            secrets.CLAUDE_CODE_OAUTH_TOKEN ??
            secrets.ANTHROPIC_AUTH_TOKEN;
          if (headers['authorization']) {
            delete headers['authorization'];
            if (currentToken) {
              headers['authorization'] = `Bearer ${currentToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
