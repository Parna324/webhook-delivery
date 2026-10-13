import { redis } from '../lib/redis.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export class RateLimiterService {
  /**
   * Sliding window rate limiter for Ingest API (per-customer).
   * Default: 100 requests per 10-second rolling window.
   */
  static async checkIngestRateLimit(
    customerId: string,
    limit = 100,
    windowSeconds = 10
  ): Promise<RateLimitResult> {
    const key = `ratelimit:ingest:${customerId}`;
    const now = Date.now();
    const clearBefore = now - windowSeconds * 1000;

    // Use Redis atomic transaction: ZADD timestamp, ZREMRANGEBYSCORE old, ZCARD count, EXPIRE
    const multi = redis.multi();
    multi.zremrangebyscore(key, 0, clearBefore);
    multi.zadd(key, now, `${now}-${Math.random()}`);
    multi.zcard(key);
    multi.expire(key, windowSeconds);

    const results = await multi.exec();
    const currentCount = (results?.[2]?.[1] as number) || 1;

    const allowed = currentCount <= limit;
    const remaining = Math.max(0, limit - currentCount);

    return {
      allowed,
      limit,
      remaining,
      resetSeconds: windowSeconds,
    };
  }

  /**
   * Token bucket check for endpoint delivery rate limit (per-second).
   */
  static async checkEndpointDeliveryRateLimit(
    endpointId: string,
    limitPerSecond = 50
  ): Promise<boolean> {
    const key = `ratelimit:delivery:${endpointId}:${Math.floor(Date.now() / 1000)}`;
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, 2);
    }
    return current <= limitPerSecond;
  }
}
