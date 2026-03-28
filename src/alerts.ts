/**
 * System alerts — sends operational notifications to the owner via Slack DM.
 * Uses the Slack Web API directly (no dependency on the channel system)
 * so alerts work even during failover when channels may be disconnected.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let slackBotToken: string | undefined;
let ownerDmChannel: string | undefined;

/** Initialize the alerting system. Call once at startup. */
export function initAlerts(): void {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_DM_JID']);
  slackBotToken = env.SLACK_BOT_TOKEN;

  // Resolve DM channel from env (format: slack:DXXXXXXX -> DXXXXXXX)
  if (env.SLACK_DM_JID) {
    ownerDmChannel = env.SLACK_DM_JID.replace('slack:', '');
  }

  if (!slackBotToken) {
    logger.warn('Alerts disabled: no SLACK_BOT_TOKEN');
  }
}

/** Set the owner DM channel at runtime (called when first DM is seen). */
export function setAlertChannel(jid: string): void {
  if (!ownerDmChannel) {
    ownerDmChannel = jid.replace('slack:', '');
    logger.info({ ownerDmChannel }, 'Alert DM channel set');
  }
}

/** Send an alert message to the owner. Fire-and-forget — never throws. */
export async function sendAlert(text: string): Promise<void> {
  try {
    if (!ownerDmChannel || !slackBotToken) {
      logger.warn({ text }, 'Alert not sent (no DM channel or token)');
      return;
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: ownerDmChannel, text }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      logger.error({ error: data.error, text }, 'Alert send failed');
    }
  } catch (err) {
    logger.error({ err }, 'Alert send error');
  }
}
