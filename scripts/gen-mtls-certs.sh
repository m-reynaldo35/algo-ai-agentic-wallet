#!/usr/bin/env bash
# gen-mtls-certs.sh — Generate mTLS certificates for the x402 signing service channel.
#
# Output:
#   certs/ca.crt / ca.key        — Private CA (3650-day; keep offline, never deploy)
#   certs/api.crt / api.key      — Main API client cert  (90-day)
#   certs/svc.crt / svc.key      — Signing Service server cert (90-day)
#
# After generation, paste the base64 values into Railway env vars:
#
#   Both services:   MTLS_CA_CERT     = base64(ca.crt)
#   Main API:        MTLS_CLIENT_CERT = base64(api.crt)
#                    MTLS_CLIENT_KEY  = base64(api.key)
#   Signing Service: MTLS_SERVER_CERT = base64(svc.crt)
#                    MTLS_SERVER_KEY  = base64(svc.key)
#
# Re-run with --renew to regenerate only the 90-day leaf certs (CA preserved).
#
# Usage:
#   ./scripts/gen-mtls-certs.sh           # first-time setup
#   ./scripts/gen-mtls-certs.sh --renew   # rotate leaf certs before 90-day expiry
#
# Requirements: openssl (any modern version), bash 4+

set -euo pipefail

CERT_DIR="$(dirname "$0")/../certs"
RENEW=false

for arg in "$@"; do
  case "$arg" in
    --renew) RENEW=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$CERT_DIR"

echo
echo "=== x402 mTLS Certificate Generator ==="
echo "Output directory: $CERT_DIR"
echo

# ── CA (long-lived; skip if --renew) ────────────────────────────────
if [ "$RENEW" = false ]; then
  echo "[1/3] Generating Private CA (3650-day)..."
  openssl req -x509 \
    -newkey rsa:4096 \
    -keyout  "$CERT_DIR/ca.key" \
    -out     "$CERT_DIR/ca.crt" \
    -days    3650 \
    -nodes \
    -subj    "/CN=x402-internal-ca/O=x402/OU=security"
  echo "      CA generated: $CERT_DIR/ca.crt"
else
  echo "[1/3] --renew: keeping existing CA at $CERT_DIR/ca.crt"
  if [ ! -f "$CERT_DIR/ca.crt" ] || [ ! -f "$CERT_DIR/ca.key" ]; then
    echo "ERROR: CA files not found in $CERT_DIR. Run without --renew first." >&2
    exit 1
  fi
fi

# ── Main API client cert (90-day) ────────────────────────────────────
echo "[2/3] Generating Main API client cert (90-day)..."
openssl req -newkey rsa:4096 \
  -keyout "$CERT_DIR/api.key" \
  -out    "$CERT_DIR/api.csr" \
  -nodes \
  -subj   "/CN=x402-main-api/O=x402/OU=main-api"

openssl x509 -req \
  -in       "$CERT_DIR/api.csr" \
  -CA       "$CERT_DIR/ca.crt" \
  -CAkey    "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out      "$CERT_DIR/api.crt" \
  -days     90 \
  -sha256

rm -f "$CERT_DIR/api.csr"
echo "      API client cert generated: $CERT_DIR/api.crt"

# ── Signing Service server cert (90-day) ─────────────────────────────
echo "[3/3] Generating Signing Service server cert (90-day)..."
openssl req -newkey rsa:4096 \
  -keyout "$CERT_DIR/svc.key" \
  -out    "$CERT_DIR/svc.csr" \
  -nodes \
  -subj   "/CN=x402-signing-service/O=x402/OU=signing-service"

openssl x509 -req \
  -in       "$CERT_DIR/svc.csr" \
  -CA       "$CERT_DIR/ca.crt" \
  -CAkey    "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out      "$CERT_DIR/svc.crt" \
  -days     90 \
  -sha256

rm -f "$CERT_DIR/svc.csr"
echo "      Signing Service server cert generated: $CERT_DIR/svc.crt"

# ── Print base64 env var values ────────────────────────────────────
echo
echo "========================================================"
echo " Paste these into Railway environment variables:        "
echo "========================================================"
echo
echo "# ── Both services ──────────────────────────────────────"
printf "MTLS_CA_CERT=%s\n" "$(base64 -w 0 "$CERT_DIR/ca.crt")"
echo
echo "# ── Main API service ──────────────────────────────────"
printf "MTLS_CLIENT_CERT=%s\n" "$(base64 -w 0 "$CERT_DIR/api.crt")"
printf "MTLS_CLIENT_KEY=%s\n"  "$(base64 -w 0 "$CERT_DIR/api.key")"
echo
echo "# ── Signing Service ────────────────────────────────────"
printf "MTLS_SERVER_CERT=%s\n" "$(base64 -w 0 "$CERT_DIR/svc.crt")"
printf "MTLS_SERVER_KEY=%s\n"  "$(base64 -w 0 "$CERT_DIR/svc.key")"
echo
echo "# ── Enable mTLS on both services ───────────────────────"
echo "MTLS_ENABLED=true"
echo
echo "========================================================"
echo " SECURITY NOTES:                                        "
echo "   - Keep ca.key OFFLINE after cert generation.         "
echo "   - Leaf certs expire in 90 days. Re-run with --renew  "
echo "     and update Railway env vars before expiry.         "
echo "   - Never commit certs/ to version control.            "
echo "========================================================"
echo
echo "Done."
