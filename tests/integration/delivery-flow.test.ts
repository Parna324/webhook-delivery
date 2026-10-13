import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../../src/api/app.js';
import { prisma } from '../../src/db/client.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { EndpointService } from '../../src/services/endpoint.service.js';
import { DeliveryWorkerManager } from '../../src/workers/delivery.worker.js';
import { verifyWebhookSignature } from '../../src/lib/signature.js';
import request from 'supertest';
import { redis } from '../../src/lib/redis.js';

describe('Integration Tests: End-to-End Ingest and Delivery Flow', () => {
  let app: ReturnType<typeof createApp>;
  let workerManager: DeliveryWorkerManager;
  let customerId: string;
  let rawApiKey: string;
  let endpointId: string;
  let endpointSecret: string;
  let receiverServer: http.Server;
  let receiverPort: number;

  const receivedRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];

  let shouldReceiverFail = false;

  beforeAll(async () => {
    // 1. Start mock receiver server
    receiverServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body });
        if (shouldReceiverFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Receiver internal crash' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'delivered_successfully' }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      receiverServer.listen(0, () => {
        const addr = receiverServer.address();
        receiverPort = typeof addr === 'object' && addr ? addr.port : 4123;
        resolve();
      });
    });

    // 2. Initialize API App and Worker
    app = createApp();
    workerManager = new DeliveryWorkerManager();
    workerManager.start();

    // 3. Create test customer and endpoint
    const cust = await CustomerService.createCustomer({
      name: 'Integration Test Customer',
      email: `int_test_${Date.now()}@example.com`,
    });
    customerId = cust.customer.id;
    rawApiKey = cust.apiKey.rawKey;

    // Allow local webhook URLs for integration tests
    process.env.ALLOW_LOCAL_WEBHOOKS = 'true';

    const ep = await EndpointService.createEndpoint(customerId, {
      url: `http://127.0.0.1:${receiverPort}/webhooks`,
      description: 'Mock Receiver',
      eventTypes: ['payment.succeeded'],
    });
    endpointId = ep.id;
    endpointSecret = ep.secret;
  });

  afterAll(async () => {
    await workerManager.close();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await redis.quit();
    await prisma.$disconnect();
  });

  it('1. should ingest event and deliver to endpoint with authentic HMAC signature', async () => {
    const payload = { orderId: 'ord_998877', amount: 15000, currency: 'usd' };
    const idempotencyKey = `idemp_flow_${Date.now()}`;

    // POST /v1/events
    const res = await request(app)
      .post('/v1/events')
      .set('x-api-key', rawApiKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        eventType: 'payment.succeeded',
        payload,
      });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.deliveryCount).toBe(1);

    // Wait for worker to pick up and process job
    let tries = 0;
    while (receivedRequests.length === 0 && tries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tries++;
    }

    expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
    const delivered = receivedRequests[0]!;

    // Verify delivery headers
    expect(delivered.headers['webhook-id']).toBeDefined();
    expect(delivered.headers['webhook-timestamp']).toBeDefined();
    expect(delivered.headers['webhook-signature']).toBeDefined();

    // Verify signature with receiver utility using raw received body
    const signatureHeader = delivered.headers['webhook-signature'] as string;
    const timestampHeader = delivered.headers['webhook-timestamp'] as string;
    const verified = verifyWebhookSignature(
      endpointSecret,
      timestampHeader,
      signatureHeader,
      delivered.body
    );

    expect(verified.isValid).toBe(true);

    // Verify DB delivery status is SUCCESS
    const dbDelivery = await prisma.delivery.findFirst({
      where: { customerId, endpointId },
      include: { attempts: true },
    });

    expect(dbDelivery?.status).toBe('SUCCESS');
    expect(dbDelivery?.attempts.length).toBeGreaterThanOrEqual(1);
    expect(dbDelivery?.attempts[0]?.statusCode).toBe(200);
    expect(dbDelivery?.attempts[0]?.success).toBe(true);
  });

  it('2. should enforce idempotency: same key returns cached 202 without duplicate deliveries', async () => {
    const currentReceivedCount = receivedRequests.length;
    const payload = { invoiceId: 'inv_443322', paid: true };
    const idempotencyKey = `idemp_unique_${Date.now()}`;

    // First request
    const res1 = await request(app)
      .post('/v1/events')
      .set('x-api-key', rawApiKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({ eventType: 'payment.succeeded', payload });

    expect(res1.status).toBe(202);

    // Wait for delivery 1
    let tries = 0;
    while (receivedRequests.length === currentReceivedCount && tries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tries++;
    }
    expect(receivedRequests.length).toBe(currentReceivedCount + 1);

    // Duplicate request with SAME Idempotency-Key
    const res2 = await request(app)
      .post('/v1/events')
      .set('x-api-key', rawApiKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({ eventType: 'payment.succeeded', payload });

    expect(res2.status).toBe(202);
    expect(res2.body.eventId).toBe(res1.body.eventId);

    // Wait 500ms to confirm NO extra deliveries occur
    await new Promise((r) => setTimeout(r, 500));
    expect(receivedRequests.length).toBe(currentReceivedCount + 1);
  });

  it('3. should handle receiver returning 500 by recording failed attempt and scheduling retry', async () => {
    shouldReceiverFail = true;

    const payload = { failTest: true };
    const idempotencyKey = `idemp_fail_${Date.now()}`;

    const res = await request(app)
      .post('/v1/events')
      .set('x-api-key', rawApiKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({ eventType: 'payment.succeeded', payload });

    expect(res.status).toBe(202);

    // Wait for worker attempt
    let tries = 0;
    let failedDelivery = null;
    while (tries < 30) {
      await new Promise((r) => setTimeout(r, 150));
      failedDelivery = await prisma.delivery.findFirst({
        where: { eventId: res.body.eventId },
        include: { attempts: true },
      });
      if (failedDelivery && failedDelivery.attempts.length > 0) break;
      tries++;
    }

    expect(failedDelivery).toBeDefined();
    expect(failedDelivery!.attempts.length).toBeGreaterThanOrEqual(1);
    expect(failedDelivery!.attempts[0]?.statusCode).toBe(500);
    expect(failedDelivery!.attempts[0]?.success).toBe(false);
    expect(failedDelivery!.status).toBe('PENDING'); // Scheduled for exponential retry
    expect(failedDelivery!.nextRetryAt).toBeDefined();
  });
});
