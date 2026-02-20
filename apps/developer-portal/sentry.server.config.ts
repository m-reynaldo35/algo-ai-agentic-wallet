import * as Sentry from "@sentry/nextjs";

// ── Patterns (mirrored from wallet backend src/lib/sentry.ts) ──
const ERROR_CODE_RE =
  /\b(TEAL_RULE_\d+_\w+|POLICY_BREACH|SIGNATURE_REPLAY|INVALID_NONCE|RATE_LIMIT_EXCEEDED|SLIPPAGE_EXCEEDED|VALIDATION_FAILED|ORACLE_STALE)\b/;
const ALGO_TXID_RE = /\b([A-Z2-7]{52})\b/;
const MNEMONIC_RE = /\b(?:[a-z]+ ){24}[a-z]+\b/g;
const PRIVKEY_HEX_RE = /\b[0-9a-fA-F]{64,128}\b/g;
const AGENT_ID_RE = /\b((?:sdk|agent)-[A-Za-z0-9]{4})[A-Za-z0-9-]+\b/g;

function scrub(text: string): string {
  return text
    .replace(MNEMONIC_RE, "[MNEMONIC_REDACTED]")
    .replace(PRIVKEY_HEX_RE, "[KEY_REDACTED]")
    .replace(AGENT_ID_RE, "$1…");
}

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  beforeSend(event) {
    // Module 2: Transaction fingerprinting
    const message =
      event.exception?.values?.[0]?.value ?? event.message ?? "";
    const errorCode = ERROR_CODE_RE.exec(message)?.[1] ?? "UNCLASSIFIED_ERROR";
    const txidMatch = ALGO_TXID_RE.exec(message);
    const txidBucket = txidMatch ? txidMatch[1].slice(0, 8) : "NO_TXID";
    event.fingerprint = [errorCode, txidBucket];

    // Module 3: PII scrubber
    event.exception?.values?.forEach((ex) => {
      if (ex.value) ex.value = scrub(ex.value);
      ex.stacktrace?.frames?.forEach((frame) => {
        if (!frame.vars) return;
        for (const key of Object.keys(frame.vars)) {
          if (typeof frame.vars[key] === "string") {
            frame.vars[key] = scrub(frame.vars[key] as string);
          }
        }
      });
    });
    if (event.message) event.message = scrub(event.message);

    return event;
  },

  debug: false,
});
