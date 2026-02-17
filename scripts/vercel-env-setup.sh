#!/bin/bash
# Inject Upstash credentials into Vercel production environment

URL="https://vast-kite-15876.upstash.io"
TOKEN="AT4EAAIncDIwZTY0Yzc3YTVkMTA0ZDBhOGVjNjQxNmUwODQzOTk1MXAyMTU4NzY"

printf '%s' "$URL" | npx vercel env add UPSTASH_REDIS_REST_URL production -y
printf '%s' "$TOKEN" | npx vercel env add UPSTASH_REDIS_REST_TOKEN production -y --sensitive

echo ""
echo "Done. Now run:  npm run build && npx vercel --prod"
