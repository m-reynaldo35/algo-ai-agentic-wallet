/**
 * Deterministic Slippage Guardrail
 *
 * Computes the minimum acceptable output amount for a cross-chain
 * transfer given a slippage tolerance in basis points (bips).
 *
 * All arithmetic uses strict bigint to eliminate floating-point
 * rounding errors. This is critical for on-chain verification
 * where a single micro-unit discrepancy causes transaction failure.
 *
 * Formula:  M_out = E_out * (10000 - S_bips) / 10000
 *
 * Where:
 *   M_out  = minimum acceptable output amount
 *   E_out  = expected output amount
 *   S_bips = slippage tolerance in basis points (1 bip = 0.01%)
 */

/** 10,000 basis points = 100% */
const BIP_DENOMINATOR = 10_000n;

/** Maximum allowed slippage: 500 bips = 5% */
const MAX_SLIPPAGE_BIPS = 500;

/** Default slippage: 50 bips = 0.5% */
export const DEFAULT_SLIPPAGE_BIPS = 50;

/**
 * Validate that the slippage tolerance is within safe bounds.
 *
 * @param bips - Slippage tolerance in basis points
 * @throws Error if bips is out of range or not an integer
 */
function validateSlippageBips(bips: number): void {
  if (!Number.isInteger(bips)) {
    throw new Error(`Slippage bips must be an integer, got: ${bips}`);
  }
  if (bips < 0) {
    throw new Error(`Slippage bips cannot be negative, got: ${bips}`);
  }
  if (bips > MAX_SLIPPAGE_BIPS) {
    throw new Error(`Slippage bips exceeds maximum (${MAX_SLIPPAGE_BIPS}), got: ${bips}`);
  }
}

/**
 * Calculate the minimum acceptable output amount after applying
 * a slippage tolerance.
 *
 * Uses strict bigint arithmetic:
 *   minAmountOut = expectedAmount * (10000 - slippageBips) / 10000
 *
 * Examples (USDC, 6 decimals):
 *   calculateMinAmountOut(100_000n, 50)  →  99_500n   (0.5% slippage on $0.10)
 *   calculateMinAmountOut(100_000n, 100) →  99_000n   (1.0% slippage on $0.10)
 *   calculateMinAmountOut(1_000_000n, 50) → 995_000n  (0.5% slippage on $1.00)
 *
 * @param expectedAmount         - Expected output in micro-units (bigint)
 * @param slippageToleranceBips  - Tolerance in basis points (1 bip = 0.01%)
 * @returns Minimum acceptable output amount (bigint, rounded down)
 */
export function calculateMinAmountOut(
  expectedAmount: bigint,
  slippageToleranceBips: number,
): bigint {
  validateSlippageBips(slippageToleranceBips);

  if (expectedAmount <= 0n) {
    throw new Error(`Expected amount must be positive, got: ${expectedAmount}`);
  }

  const slippageBips = BigInt(slippageToleranceBips);
  const multiplier = BIP_DENOMINATOR - slippageBips;

  // Integer division truncates (floors), which is the safe direction
  // for a minimum output — we never promise more than we can deliver.
  const minAmountOut = (expectedAmount * multiplier) / BIP_DENOMINATOR;

  return minAmountOut;
}
