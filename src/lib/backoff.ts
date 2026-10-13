export interface BackoffConfig {
  baseDelayMs?: number; // Default 1000ms (1s)
  maxDelayMs?: number;  // Default 86400000ms (24h) or 3600000 (1h)
  factor?: number;      // Default 2 (binary exponential)
}

/**
 * Calculates exponential backoff with Full Jitter.
 * 
 * Formula:
 *   cap = min(maxDelay, base * factor^attempt)
 *   sleep = random_between(0, cap)
 * 
 * Why Full Jitter?
 * It eliminates the "Thundering Herd" problem where hundreds of retries
 * hit an already-struggling receiver server at the exact same second.
 */
export function calculateBackoffWithJitter(
  attemptNumber: number,
  config: BackoffConfig = {}
): number {
  const base = config.baseDelayMs ?? 1000;
  const max = config.maxDelayMs ?? 3600000; // Cap at 1 hour
  const factor = config.factor ?? 2;

  // Safe exponentiation cap to avoid integer overflow
  const exponent = Math.min(attemptNumber, 15);
  const exponentialCap = Math.min(max, base * Math.pow(factor, exponent));

  // Full jitter: random uniform distribution between 0 and exponentialCap
  const sleepMs = Math.floor(Math.random() * exponentialCap);

  // Enforce a sensible minimum sleep so retries don't fire instantly (at least 200ms)
  return Math.max(200, sleepMs);
}
