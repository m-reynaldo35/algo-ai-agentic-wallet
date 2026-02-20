#!/bin/sh
set -e

if [ "$SERVICE_TYPE" = "guardian" ]; then
  echo "Starting wallet-guardian..."
  exec npx tsx scripts/wallet-guardian.ts
else
  echo "Starting API server..."
  exec node dist/index.js
fi
