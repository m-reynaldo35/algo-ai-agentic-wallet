import * as Sentry from "@sentry/node";

/**
 * Wallet Backend — Sentry Initialisation
 *
 * Module 2: Transaction Fingerprinting
 *   Groups issues by error_code + txid prefix so TEAL violations,
 *   replay attacks, and policy breaches never collapse into one bucket.
 *
 * Module 3: PII-Free Transparency
 *   beforeSend scrubs mnemonics, raw private-key hex, and full
 *   agent DIDs before any data leaves the server.
 */

// ── Error-code patterns emitted by the pipeline ──────────────
const ERROR_CODE_RE =
  /\b(TEAL_RULE_\d+_\w+|POLICY_BREACH|SIGNATURE_REPLAY|INVALID_NONCE|RATE_LIMIT_EXCEEDED|SLIPPAGE_EXCEEDED|VALIDATION_FAILED|ORACLE_STALE)\b/;

// Algorand txid — base32, exactly 52 uppercase chars
const ALGO_TXID_RE = /\b([A-Z2-7]{52})\b/;

// Algorand mnemonic — 25 lowercase BIP39 words separated by spaces
const MNEMONIC_RE = /\b(?:[a-z]+ ){24}[a-z]+\b/g;

// Raw private-key hex — 64 or 128 contiguous hex chars (32-byte or 64-byte)
const PRIVKEY_HEX_RE = /\b[0-9a-fA-F]{64,128}\b/g;

// Rocca DID / SDK agent prefix  e.g. "sdk-WYQ24WWZ" → keep "sdk-WYQ2"
const AGENT_ID_RE = /\b((?:sdk|agent)-[A-Za-z0-9]{4})[A-Za-z0-9-]+\b/g;

function scrub(text: string): string {
  return text
    .replace(MNEMONIC_RE, "[MNEMONIC_REDACTED]")
    .replace(PRIVKEY_HEX_RE, "[KEY_REDACTED]")
    .replace(AGENT_ID_RE, "$1…");
}

function scrubEvent(event: Sentry.Event): Sentry.Event {
  // Scrub exception messages and stack frame variables
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

  // Scrub top-level message
  if (event.message) event.message = scrub(event.message);

  return event;
}

function fingerprintEvent(event: Sentry.Event): Sentry.Event {
  const message =
    event.exception?.values?.[0]?.value ?? event.message ?? "";

  const errorCode = ERROR_CODE_RE.exec(message)?.[1] ?? "UNCLASSIFIED_ERROR";
  const txidMatch = ALGO_TXID_RE.exec(message);
  // Use first 8 chars of txid as a group prefix — specific enough to
  // distinguish transactions without creating one issue per txid.
  const txidBucket = txidMatch ? txidMatch[1].slice(0, 8) : "NO_TXID";

  event.fingerprint = [errorCode, txidBucket];

  return event;
}

export function initSentry(): void {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    beforeSend(event) {
      fingerprintEvent(event);
      scrubEvent(event);
      return event;
    },
  });
}

export { Sentry };
