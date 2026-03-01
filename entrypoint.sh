#!/bin/sh
set -e

if [ "$SERVICE_TYPE" = "guardian" ]; then
  echo "Starting wallet-guardian..."
  exec ./node_modules/.bin/tsx scripts/wallet-guardian.ts
elif [ "$SERVICE_TYPE" = "signing" ]; then
  echo "Starting rocca-signing-service..."
  exec node dist/signing-service/server.js
elif [ "$SERVICE_TYPE" = "worker" ]; then
  echo "Starting settlement worker..."
  exec node dist/scripts/run-worker.js
else
  echo "Starting API server..."
  exec node dist/index.js
fi
