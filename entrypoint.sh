#!/bin/bash
set -e

# Set up persistent storage (Railway single-volume → symlinks)
if [ -d /app/persistent ]; then
  for dir in store data groups; do
    mkdir -p /app/persistent/$dir
    rm -rf /app/$dir
    ln -s /app/persistent/$dir /app/$dir
  done
fi

# Auto-register Slack channel if not already in DB
if [ -n "$SLACK_CHANNEL_JID" ]; then
  mkdir -p store
  EXISTING=$(node -e "
    const Database = require('better-sqlite3');
    const db = new Database('store/messages.db');
    db.exec('CREATE TABLE IF NOT EXISTS registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, channel TEXT, is_main INTEGER, container_config TEXT)');
    const row = db.prepare('SELECT jid FROM registered_groups WHERE jid = ?').get(process.env.SLACK_CHANNEL_JID);
    console.log(row ? 'yes' : 'no');
    db.close();
  " 2>/dev/null || echo "no")

  if [ "$EXISTING" = "no" ]; then
    echo "Auto-registering Slack channel: $SLACK_CHANNEL_JID"
    npx tsx setup/index.ts --step register -- \
      --jid "$SLACK_CHANNEL_JID" \
      --name "${SLACK_CHANNEL_NAME:-nanoclaw}" \
      --folder "${SLACK_CHANNEL_FOLDER:-slack_main}" \
      --trigger "@${ASSISTANT_NAME:-Andy}" \
      --channel slack \
      --no-trigger-required \
      --is-main
  fi
fi

exec node dist/index.js
