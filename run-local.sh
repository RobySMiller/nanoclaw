#!/bin/bash
exec > /Users/roby/nanoclaw/logs/nanoclaw.log 2>&1
echo "=== NanoClaw starting at $(date) ==="
echo "PATH=$PATH"
echo "PWD=$(pwd)"
echo "Node: $(which node) ($(node --version))"
cd /Users/roby/nanoclaw || { echo "Failed to cd"; exit 1; }
export NATIVE_MODE=true
export HEARTBEAT_TARGET_URL=https://nanoclaw-production-fd19.up.railway.app
exec node dist/index.js
