import { redis } from '../lib/redis.js';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { CircuitStatus } from '@prisma/client';

export interface CircuitBreakerConfig {
  failureThreshold?: number; // Consecutive failures before tripping (default 5)
  resetTimeoutMs?: number;   // Cooldown period before trying HALF_OPEN (default 30,000ms = 30s)
}

export class CircuitBreakerService {
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly RESET_TIMEOUT_MS = 30000;

  /**
   * Evaluates if a delivery attempt to the endpoint is permitted.
   * Returns:
   *   - allowed: true/false
   *   - state: CLOSED | OPEN | HALF_OPEN
   *   - reason: explanation if blocked
   */
  static async canExecute(endpointId: string): Promise<{
    allowed: boolean;
    state: CircuitStatus;
    reason?: string;
  }> {
    const key = `circuit:${endpointId}`;
    const [stateRaw, openedAtRaw] = await Promise.all([
      redis.get(`${key}:state`),
      redis.get(`${key}:opened_at`),
    ]);

    const state = (stateRaw as CircuitStatus) || CircuitStatus.CLOSED;

    if (state === CircuitStatus.CLOSED) {
      return { allowed: true, state: CircuitStatus.CLOSED };
    }

    if (state === CircuitStatus.OPEN) {
      const openedAt = openedAtRaw ? parseInt(openedAtRaw, 10) : 0;
      const elapsed = Date.now() - openedAt;

      // Check if cooldown timer expired -> transition to HALF_OPEN
      if (elapsed >= this.RESET_TIMEOUT_MS) {
        // Try to atomically claim probe execution
        const transitioned = await redis.set(`${key}:state`, CircuitStatus.HALF_OPEN, 'XX');
        if (transitioned || !stateRaw) {
          logger.info({ endpointId }, '⚡ Circuit breaker transitioning from OPEN to HALF_OPEN (probing)');
          await prisma.endpoint.update({
            where: { id: endpointId },
            data: { circuitStatus: CircuitStatus.HALF_OPEN },
          }).catch(() => {});
          return { allowed: true, state: CircuitStatus.HALF_OPEN };
        }
      }

      return {
        allowed: false,
        state: CircuitStatus.OPEN,
        reason: `Circuit breaker is OPEN. Endpoint failed repeatedly. Cooldown active for ${Math.ceil((this.RESET_TIMEOUT_MS - elapsed) / 1000)}s.`,
      };
    }

    if (state === CircuitStatus.HALF_OPEN) {
      // In HALF_OPEN, we allow the probe request
      return { allowed: true, state: CircuitStatus.HALF_OPEN };
    }

    return { allowed: true, state: CircuitStatus.CLOSED };
  }

  /**
   * Called upon successful delivery: resets failure count and closes circuit if open.
   */
  static async recordSuccess(endpointId: string): Promise<void> {
    const key = `circuit:${endpointId}`;
    const previousState = await redis.get(`${key}:state`);

    await redis.pipeline()
      .set(`${key}:state`, CircuitStatus.CLOSED)
      .del(`${key}:failures`)
      .del(`${key}:opened_at`)
      .exec();

    if (previousState && previousState !== CircuitStatus.CLOSED) {
      logger.info({ endpointId, previousState }, '🟢 Circuit breaker recovered and transitioned to CLOSED');
      try {
        await prisma.endpoint.update({
          where: { id: endpointId },
          data: {
            circuitStatus: CircuitStatus.CLOSED,
            failureCount: 0,
            circuitOpenedAt: null,
          },
        });
      } catch {
        // Safe to ignore if synthetic ID or deleted endpoint
      }
    }
  }

  /**
   * Called upon failed delivery: increments failure count and trips to OPEN if threshold reached.
   */
  static async recordFailure(endpointId: string): Promise<CircuitStatus> {
    const key = `circuit:${endpointId}`;
    const failures = await redis.incr(`${key}:failures`);
    const currentState = (await redis.get(`${key}:state`)) as CircuitStatus || CircuitStatus.CLOSED;

    // If already in HALF_OPEN or failures reach threshold -> trip to OPEN
    if (currentState === CircuitStatus.HALF_OPEN || failures >= this.FAILURE_THRESHOLD) {
      const now = Date.now();
      await redis.pipeline()
        .set(`${key}:state`, CircuitStatus.OPEN)
        .set(`${key}:opened_at`, now.toString())
        .set(`${key}:failures`, failures)
        .exec();

      logger.warn(
        { endpointId, failures, threshold: this.FAILURE_THRESHOLD },
        '🔴 Circuit breaker TRIPPED to OPEN. Pausing deliveries to destination.'
      );

      try {
        await prisma.endpoint.update({
          where: { id: endpointId },
          data: {
            circuitStatus: CircuitStatus.OPEN,
            failureCount: failures,
            circuitOpenedAt: new Date(now),
          },
        });
      } catch {
        // Safe to ignore if synthetic ID or deleted endpoint
      }

      return CircuitStatus.OPEN;
    }

    return currentState;
  }
}
