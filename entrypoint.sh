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

  # Check if already registered (skip if DB doesn't exist yet)
  NEEDS_REGISTER="yes"
  if [ -f store/messages.db ]; then
    EXISTING=$(node -e "
      try {
        const Database = require('better-sqlite3');
        const db = new Database('store/messages.db');
        const row = db.prepare('SELECT jid FROM registered_groups WHERE jid = ?').get(process.env.SLACK_CHANNEL_JID);
        console.log(row ? 'no' : 'yes');
        db.close();
      } catch(e) { console.log('yes'); }
    " 2>/dev/null || echo "yes")
    NEEDS_REGISTER="$EXISTING"
  fi

  if [ "$NEEDS_REGISTER" = "yes" ]; then
    echo "Auto-registering Slack channel: $SLACK_CHANNEL_JID"
    # Let NanoClaw initialize the DB with proper schema first
    node -e "const { initDatabase } = require('./dist/db.js'); initDatabase();" 2>/dev/null || true
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
