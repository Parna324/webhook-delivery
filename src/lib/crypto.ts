import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Hashes a raw API key using HMAC-SHA256 with the system salt.
 * We store only this hash in PostgreSQL, never the raw key.
 */
export const hashApiKey = (rawKey: string): string => {
  return createHmac('sha256', env.API_KEY_SALT).update(rawKey.trim()).digest('hex');
};

/**
 * Generates a production-grade API key and its prefix.
 * Example: wh_live_9a8b7c6d5e4f...
 */
export const generateApiKey = (): { rawKey: string; keyPrefix: string; keyHash: string } => {
  const entropy = randomBytes(24).toString('base64url');
  const rawKey = `wh_live_${entropy}`;
  const keyPrefix = rawKey.substring(0, 14); // e.g. "wh_live_abc123"
  const keyHash = hashApiKey(rawKey);

  return { rawKey, keyPrefix, keyHash };
};
