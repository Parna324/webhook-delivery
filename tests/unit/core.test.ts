import { describe, it, expect, beforeEach } from 'vitest';
import { generateEndpointSecret, signWebhookPayload, verifyWebhookSignature } from '../../src/lib/signature.js';
import { calculateBackoffWithJitter } from '../../src/lib/backoff.js';
import { isPrivateIP, validateWebhookUrl } from '../../src/lib/ssrf.js';
import { CircuitBreakerService } from '../../src/services/circuit-breaker.service.js';
import { redis } from '../../src/lib/redis.js';

describe('Unit Tests: Webhook Core Systems', () => {

  describe('1. Webhook Signature & Replay Protection', () => {
    it('should generate valid v1 signature matching Svix/Stripe format', () => {
      const secret = generateEndpointSecret();
      const payload = { event: 'payment.succeeded', amount: 5000 };
      const timestamp = Math.floor(Date.now() / 1000);

      const { headerValue } = signWebhookPayload(secret, timestamp, payload);
      expect(headerValue).toMatch(/^v1=[a-f0-9]{64}$/);

      // Verify authentic payload
      const verification = verifyWebhookSignature(secret, timestamp, headerValue, payload);
      expect(verification.isValid).toBe(true);
    });

    it('should reject tampered payload', () => {
      const secret = generateEndpointSecret();
      const payload = { account: 'acc_123', balance: 100 };
      const timestamp = Math.floor(Date.now() / 1000);

      const { headerValue } = signWebhookPayload(secret, timestamp, payload);

      // Tampered payload
      const tampered = { account: 'acc_123', balance: 999999 };
      const verification = verifyWebhookSignature(secret, timestamp, headerValue, tampered);
      expect(verification.isValid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });

    it('should reject expired timestamp to prevent replay attacks', () => {
      const secret = generateEndpointSecret();
      const payload = { action: 'delete_user' };
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes old

      const { headerValue } = signWebhookPayload(secret, oldTimestamp, payload);
      const verification = verifyWebhookSignature(secret, oldTimestamp, headerValue, payload, 300);
      expect(verification.isValid).toBe(false);
      expect(verification.reason).toContain('replay attack protection');
    });
  });

  describe('2. Exponential Backoff with Full Jitter', () => {
    it('should calculate delay within [200, min(max, base * 2^attempt)]', () => {
      const base = 1000;
      const max = 30000;

      for (let attempt = 1; attempt <= 6; attempt++) {
        const delay = calculateBackoffWithJitter(attempt, { baseDelayMs: base, maxDelayMs: max });
        const maxExpectedCap = Math.min(max, base * Math.pow(2, attempt));

        expect(delay).toBeGreaterThanOrEqual(200);
        expect(delay).toBeLessThanOrEqual(maxExpectedCap);
      }
    });

    it('should introduce randomness (jitter) across multiple calls of same attempt', () => {
      const samples = new Set();
      for (let i = 0; i < 20; i++) {
        samples.add(calculateBackoffWithJitter(3, { baseDelayMs: 1000, maxDelayMs: 60000 }));
      }
      // With 20 samples between 0 and 8000, we should have multiple distinct values
      expect(samples.size).toBeGreaterThan(5);
    });
  });

  describe('3. SSRF Protection', () => {
    it('should flag internal and private IP ranges', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('10.0.0.5')).toBe(true);
      expect(isPrivateIP('192.168.1.100')).toBe(true);
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('169.254.169.254')).toBe(true); // AWS metadata service
      expect(isPrivateIP('::1')).toBe(true);
      expect(isPrivateIP('fe80::1')).toBe(true);
    });

    it('should recognize public Internet IPs', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
    });

    it('should block non-HTTP protocols and localhost URLs', async () => {
      const ftpCheck = await validateWebhookUrl('ftp://example.com/webhook');
      expect(ftpCheck.valid).toBe(false);

      const fileCheck = await validateWebhookUrl('file:///etc/passwd');
      expect(fileCheck.valid).toBe(false);

      const localCheck = await validateWebhookUrl('http://127.0.0.1:8080/hook');
      expect(localCheck.valid).toBe(false);
    });
  });

  describe('4. Circuit Breaker State Transitions', () => {
    const testEndpointId = 'test-endpoint-' + Math.random().toString(36).substring(2, 8);

    beforeEach(async () => {
      await redis.del(`circuit:${testEndpointId}:state`);
      await redis.del(`circuit:${testEndpointId}:failures`);
      await redis.del(`circuit:${testEndpointId}:opened_at`);
    });

    it('should start in CLOSED state and allow execution', async () => {
      const check = await CircuitBreakerService.canExecute(testEndpointId);
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('CLOSED');
    });

    it('should trip to OPEN after 5 consecutive failures', async () => {
      for (let i = 1; i <= 4; i++) {
        const state = await CircuitBreakerService.recordFailure(testEndpointId);
        expect(state).toBe('CLOSED');
      }

      // 5th failure trips the circuit
      const trippedState = await CircuitBreakerService.recordFailure(testEndpointId);
      expect(trippedState).toBe('OPEN');

      const check = await CircuitBreakerService.canExecute(testEndpointId);
      expect(check.allowed).toBe(false);
      expect(check.state).toBe('OPEN');
    });

    it('should reset back to CLOSED upon recorded success', async () => {
      // Force OPEN
      await redis.set(`circuit:${testEndpointId}:state`, 'OPEN');

      // Record success
      await CircuitBreakerService.recordSuccess(testEndpointId);

      const check = await CircuitBreakerService.canExecute(testEndpointId);
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('CLOSED');
    });
  });
});
