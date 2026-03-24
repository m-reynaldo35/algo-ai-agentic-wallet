import "dotenv/config";
import { getRedis } from "../src/services/redis.js";

async function main() {
  const redis = getRedis();
  if (!redis) { console.error("No Redis"); process.exit(1); }

  const REGION = process.env.RAILWAY_REGION ?? "default";
  const failureKey = `x402:circuit:${REGION}:signer:failures`;
  const openKey    = `x402:circuit:${REGION}:signer:open`;

  const [f, o] = await Promise.all([redis.del(failureKey), redis.del(openKey)]);
  console.log(`Cleared circuit breaker (region=${REGION})`);
  console.log(`  ${failureKey}: deleted=${f}`);
  console.log(`  ${openKey}:    deleted=${o}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
