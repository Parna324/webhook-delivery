import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generates an HMAC secret for an endpoint.
 * Example: whsec_5b9d7e...
 */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * Signs a payload with an HMAC-SHA256 signature using the Svix/Stripe specification.
 * Signature message format: `${timestamp}.${rawPayload}`
 */
export function signWebhookPayload(
  secret: string,
  timestamp: number,
  payload: string | object
): { signature: string; headerValue: string } {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const toSign = `${timestamp}.${serialized}`;

  const cleanSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const signature = createHmac('sha256', cleanSecret).update(toSign).digest('hex');

  return {
    signature,
    headerValue: `v1=${signature}`,
  };
}

/**
 * Verifies that an incoming webhook signature is authentic and within time tolerance.
 * Protects receivers against payload tampering and replay attacks.
 */
export function verifyWebhookSignature(
  secret: string,
  timestampHeader: string | number,
  signatureHeader: string,
  rawPayload: string | object,
  toleranceSeconds = 300 // 5-minute replay window
): { isValid: boolean; reason?: string } {
  const timestamp = typeof timestampHeader === 'string' ? parseInt(timestampHeader, 10) : timestampHeader;

  if (isNaN(timestamp)) {
    return { isValid: false, reason: 'Invalid or missing webhook-timestamp header' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { isValid: false, reason: 'Webhook timestamp expired or out of tolerance window (replay attack protection)' };
  }

  // Parse signature header (e.g. "v1=abc12345...")
  const parts = signatureHeader.split(',');
  const v1Signatures = parts
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3));

  if (v1Signatures.length === 0) {
    return { isValid: false, reason: 'No v1 signature found in webhook-signature header' };
  }

  const { signature: expectedSignature } = signWebhookPayload(secret, timestamp, rawPayload);
  const expectedBuf = Buffer.from(expectedSignature, 'hex');

  // Verify using timing-safe comparison
  for (const sig of v1Signatures) {
    const candidateBuf = Buffer.from(sig, 'hex');
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { isValid: true };
    }
  }

  return { isValid: false, reason: 'Signature mismatch' };
}
