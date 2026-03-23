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

# Clean up any corrupted DB from failed prior deploys
if [ -f store/messages.db ]; then
  node -e "
    try {
      const Database = require('better-sqlite3');
      const db = new Database('store/messages.db');
      const cols = db.pragma('table_info(registered_groups)').map(c => c.name);
      if (cols.length > 0 && !cols.includes('added_at')) {
        console.log('Dropping corrupted registered_groups table');
        db.exec('DROP TABLE registered_groups');
      }
      db.close();
    } catch(e) {}
  " 2>/dev/null || true
fi

# Auto-register Slack channel if not already in DB
if [ -n "$SLACK_CHANNEL_JID" ]; then
  mkdir -p store

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

# Register additional Slack DM channel if set
if [ -n "$SLACK_DM_JID" ]; then
  mkdir -p store
  NEEDS_DM="yes"
  if [ -f store/messages.db ]; then
    EXISTING=$(node -e "
      try {
        const Database = require('better-sqlite3');
        const db = new Database('store/messages.db');
        const row = db.prepare('SELECT jid FROM registered_groups WHERE jid = ?').get(process.env.SLACK_DM_JID);
        console.log(row ? 'no' : 'yes');
        db.close();
      } catch(e) { console.log('yes'); }
    " 2>/dev/null || echo "yes")
    NEEDS_DM="$EXISTING"
  fi

  if [ "$NEEDS_DM" = "yes" ]; then
    echo "Auto-registering Slack DM: $SLACK_DM_JID"
    node -e "const { initDatabase } = require('./dist/db.js'); initDatabase();" 2>/dev/null || true
    npx tsx setup/index.ts --step register -- \
      --jid "$SLACK_DM_JID" \
      --name "${SLACK_DM_NAME:-roby-dm}" \
      --folder "${SLACK_DM_FOLDER:-slack_dm}" \
      --trigger "@${ASSISTANT_NAME:-Andy}" \
      --channel slack \
      --no-trigger-required \
      --is-main
  fi
fi

# Pre-configure Claude CLI for the node user (skip first-run wizard)
mkdir -p /home/node/.claude
echo '{"theme":"dark","hasCompletedOnboarding":true,"hasAcknowledgedDisclaimer":true}' > /home/node/.claude/user_settings.json

# Own all runtime directories by non-root user
# Include persistent volume (symlink targets) so node user can write
chown -R node:node /app/persistent /home/node/.claude 2>/dev/null || true

# Drop to non-root user for the main process.
# Claude Code refuses --dangerously-skip-permissions when running as root.
exec gosu node node dist/index.js
