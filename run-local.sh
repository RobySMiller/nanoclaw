#!/bin/bash
cd /Users/roby/nanoclaw
export NATIVE_MODE=true
export HEARTBEAT_TARGET_URL=https://nanoclaw-production-fd19.up.railway.app
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
exec /opt/homebrew/bin/node dist/index.js >> /Users/roby/nanoclaw/logs/nanoclaw.log 2>&1
