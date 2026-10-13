import client from 'prom-client';

// Initialize Prometheus registry and standard Node.js runtime metrics
export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'webhook_' });

// 1. Events received counter
export const eventsReceivedTotal = new client.Counter({
  name: 'webhook_events_received_total',
  help: 'Total number of events ingested via POST /v1/events',
  labelNames: ['event_type', 'customer_id'],
  registers: [register],
});

// 2. Deliveries total counter (success, failed, dead_letter)
export const deliveriesTotal = new client.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total number of webhook deliveries attempted',
  labelNames: ['status', 'status_code', 'endpoint_id'],
  registers: [register],
});

// 3. Delivery latency histogram (p50, p95, p99 measurements)
export const deliveryLatencyHistogram = new client.Histogram({
  name: 'webhook_delivery_latency_seconds',
  help: 'HTTP delivery latency in seconds',
  labelNames: ['endpoint_id'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// 4. Retry counter
export const retriesTotal = new client.Counter({
  name: 'webhook_delivery_retries_total',
  help: 'Total number of delivery retries scheduled',
  labelNames: ['attempt'],
  registers: [register],
});

// 5. Circuit breaker status
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'webhook_circuit_breaker_state',
  help: 'Current state of endpoint circuit breaker (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['endpoint_id'],
  registers: [register],
});

// 6. Queue depth gauge
export const queueDepthGauge = new client.Gauge({
  name: 'webhook_queue_depth',
  help: 'Current depth of jobs waiting in BullMQ delivery queue',
  labelNames: ['queue_name', 'state'],
  registers: [register],
});
