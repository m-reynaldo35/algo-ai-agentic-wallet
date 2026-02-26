#!/bin/sh
set -e

if [ "$SERVICE_TYPE" = "guardian" ]; then
  echo "Starting wallet-guardian..."
  exec npx tsx scripts/wallet-guardian.ts
elif [ "$SERVICE_TYPE" = "signing" ]; then
  echo "Starting rocca-signing-service..."
  exec node dist/signing-service/server.js
else
  echo "Starting API server..."
  exec node dist/index.js
fi
