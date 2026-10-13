import { Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { signWebhookPayload } from '../lib/signature.js';
import { validateWebhookUrl } from '../lib/ssrf.js';
import { calculateBackoffWithJitter } from '../lib/backoff.js';
import { CircuitBreakerService } from '../services/circuit-breaker.service.js';
import { RateLimiterService } from '../services/rate-limiter.service.js';
import { QueueService, DELIVERY_QUEUE_NAME, DeliveryJobData } from '../services/queue.service.js';
import { deliveriesTotal, deliveryLatencyHistogram, retriesTotal } from '../lib/metrics.js';
import { DeliveryStatus } from '@prisma/client';

export class DeliveryWorkerManager {
  private worker: Worker<DeliveryJobData> | null = null;

  public start(): Worker<DeliveryJobData> {
    logger.info(
      { concurrency: env.WORKER_CONCURRENCY, timeoutMs: env.DELIVERY_TIMEOUT_MS },
      '🚀 Starting BullMQ Delivery Worker instance'
    );

    this.worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      async (job: Job<DeliveryJobData>) => {
        await this.processDeliveryJob(job.data);
      },
      {
        connection: redis,
        concurrency: env.WORKER_CONCURRENCY,
      }
    );

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'Worker unhandled job execution failure');
    });

    this.worker.on('error', (err) => {
      logger.error({ err }, 'BullMQ Worker internal error');
    });

    return this.worker;
  }

  public async close(): Promise<void> {
    if (this.worker) {
      logger.info('Draining and closing BullMQ delivery worker...');
      await this.worker.close();
      this.worker = null;
      logger.info('Delivery worker successfully closed.');
    }
  }

  private async processDeliveryJob(data: DeliveryJobData): Promise<void> {
    const { deliveryId, attemptNumber } = data;

    // 1. Fetch full delivery context
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true, event: true },
    });

    if (!delivery) {
      logger.warn({ deliveryId }, 'Delivery record not found. Skipping job.');
      return;
    }

    // If delivery already reached terminal success, skip idempotent re-execution
    if (delivery.status === DeliveryStatus.SUCCESS) {
      logger.info({ deliveryId }, 'Delivery already marked SUCCESS. Skipping redundant processing.');
      return;
    }

    const { endpoint, event } = delivery;

    // Check if endpoint was disabled
    if (!endpoint.enabled) {
      logger.warn({ deliveryId, endpointId: endpoint.id }, 'Endpoint disabled. Marking delivery as FAILED.');
      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: DeliveryStatus.FAILED },
      });
      return;
    }

    // 2. Rate Limiting (per-endpoint delivery rate)
    const rateLimitOk = await RateLimiterService.checkEndpointDeliveryRateLimit(
      endpoint.id,
      endpoint.rateLimitPerSecond
    );
    if (!rateLimitOk) {
      logger.warn({ endpointId: endpoint.id }, 'Endpoint delivery rate limit reached. Re-queueing with 250ms backoff.');
      await QueueService.enqueueDelivery(data, 250);
      return;
    }

    // 3. Circuit Breaker Check
    const circuit = await CircuitBreakerService.canExecute(endpoint.id);
    if (!circuit.allowed) {
      logger.warn(
        { endpointId: endpoint.id, state: circuit.state, reason: circuit.reason },
        'Circuit breaker active. Postponing delivery.'
      );
      // Re-enqueue with 15s backoff to let circuit cool down
      await QueueService.enqueueDelivery(data, 15000);
      return;
    }

    // 4. SSRF Protection Check
    const ssrf = await validateWebhookUrl(endpoint.url, {
      allowLocal: env.NODE_ENV !== 'production' || process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
    });
    if (!ssrf.valid) {
      logger.error({ endpointId: endpoint.id, url: endpoint.url, reason: ssrf.reason }, 'SSRF violation detected! Aborting delivery.');
      await prisma.$transaction([
        prisma.delivery.update({
          where: { id: deliveryId },
          data: { status: DeliveryStatus.DEAD_LETTER },
        }),
        prisma.deliveryAttempt.create({
          data: {
            deliveryId,
            attemptNumber,
            latencyMs: 0,
            success: false,
            error: `SSRF_BLOCKED: ${ssrf.reason}`,
          },
        }),
      ]);
      return;
    }

    // 5. Update status to PROCESSING
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: DeliveryStatus.PROCESSING },
    });

    // 6. Sign payload with HMAC-SHA256
    const timestamp = Math.floor(Date.now() / 1000);
    const { headerValue: signatureHeader } = signWebhookPayload(
      endpoint.secret,
      timestamp,
      event.payload as object
    );

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'webhook-id': event.id,
      'webhook-timestamp': timestamp.toString(),
      'webhook-signature': signatureHeader,
      'user-agent': 'WebhookPlatform-Deliverer/1.0',
    };

    // 7. Dispatch HTTP POST request
    const startTime = performance.now();
    let isSuccess = false;
    let statusCode: number | null = null;
    let errorMessage: string | null = null;
    let responseSnippet: string | null = null;
    let responseHeadersObj: Record<string, string> | null = null;

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event.payload),
        signal: AbortSignal.timeout(env.DELIVERY_TIMEOUT_MS),
      });

      statusCode = response.status;
      const latencySec = (performance.now() - startTime) / 1000;
      deliveryLatencyHistogram.observe({ endpoint_id: endpoint.id }, latencySec);

      // Extract response body snippet (up to 1024 characters)
      try {
        const text = await response.text();
        responseSnippet = text.slice(0, 1024);
      } catch {
        responseSnippet = null;
      }

      // Convert response headers
      responseHeadersObj = {};
      response.headers.forEach((value, key) => {
        responseHeadersObj![key] = value;
      });

      if (response.status >= 200 && response.status < 300) {
        isSuccess = true;
      } else {
        errorMessage = `HTTP error status ${response.status}`;
      }
    } catch (err) {
      const latencySec = (performance.now() - startTime) / 1000;
      deliveryLatencyHistogram.observe({ endpoint_id: endpoint.id }, latencySec);

      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        errorMessage = `HTTP request timed out after ${env.DELIVERY_TIMEOUT_MS}ms`;
      } else {
        errorMessage = (err as Error).message;
      }
    }

    const latencyMs = Math.round(performance.now() - startTime);

    // 8. Handle Delivery Result
    if (isSuccess) {
      // Success path
      await CircuitBreakerService.recordSuccess(endpoint.id);
      deliveriesTotal.inc({
        status: 'success',
        status_code: (statusCode ?? 200).toString(),
        endpoint_id: endpoint.id,
      });

      await prisma.$transaction([
        prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            status: DeliveryStatus.SUCCESS,
            attemptCount: attemptNumber,
            nextRetryAt: null,
          },
        }),
        prisma.deliveryAttempt.create({
          data: {
            deliveryId,
            attemptNumber,
            statusCode,
            latencyMs,
            success: true,
            requestHeaders: headers,
            responseHeaders: responseHeadersObj ?? undefined,
            responseBodySnippet: responseSnippet,
          },
        }),
      ]);

      logger.info(
        { deliveryId, endpointId: endpoint.id, attemptNumber, statusCode, latencyMs },
        '✅ Webhook delivered successfully'
      );
    } else {
      // Failure path
      await CircuitBreakerService.recordFailure(endpoint.id);
      deliveriesTotal.inc({
        status: 'failed',
        status_code: (statusCode ?? 0).toString(),
        endpoint_id: endpoint.id,
      });

      // Record this attempt
      await prisma.deliveryAttempt.create({
        data: {
          deliveryId,
          attemptNumber,
          statusCode,
          latencyMs,
          success: false,
          error: errorMessage,
          requestHeaders: headers,
          responseHeaders: responseHeadersObj ?? undefined,
          responseBodySnippet: responseSnippet,
        },
      });

      // Evaluate Retries vs Dead-Letter
      if (attemptNumber < delivery.maxAttempts) {
        const backoffDelayMs = calculateBackoffWithJitter(attemptNumber);
        const nextRetryAt = new Date(Date.now() + backoffDelayMs);

        await prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            status: DeliveryStatus.PENDING,
            attemptCount: attemptNumber,
            nextRetryAt,
          },
        });

        await QueueService.enqueueDelivery(
          {
            deliveryId,
            endpointId: endpoint.id,
            eventId: event.id,
            attemptNumber: attemptNumber + 1,
          },
          backoffDelayMs
        );

        retriesTotal.inc({ attempt: attemptNumber.toString() });

        logger.warn(
          {
            deliveryId,
            endpointId: endpoint.id,
            attemptNumber,
            errorMessage,
            backoffDelayMs,
            nextRetryAt,
          },
          `⚠️ Webhook delivery failed. Scheduled retry #${attemptNumber + 1} with jittered backoff.`
        );
      } else {
        // Move to DEAD_LETTER
        await prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            status: DeliveryStatus.DEAD_LETTER,
            attemptCount: attemptNumber,
            nextRetryAt: null,
          },
        });

        deliveriesTotal.inc({
          status: 'dead_letter',
          status_code: (statusCode ?? 0).toString(),
          endpoint_id: endpoint.id,
        });

        logger.error(
          { deliveryId, endpointId: endpoint.id, totalAttempts: attemptNumber, errorMessage },
          '💀 Webhook delivery exceeded max retry attempts! Moved to DEAD_LETTER.'
        );
      }
    }
  }
}
