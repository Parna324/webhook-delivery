import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 20 },  // Ramp-up to 20 VUs
    { duration: '15s', target: 50 }, // Sustained load at 50 VUs
    { duration: '5s', target: 0 },   // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<150', 'p(99)<300'], // 95% under 150ms
    http_req_failed: ['rate<0.01'],                 // Under 1% failures
  },
};

const API_KEY = __ENV.API_KEY || 'wh_live_test';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const idempotencyKey = `idemp_${__VU}_${__ITER}_${Date.now()}`;

  const payload = JSON.stringify({
    eventType: 'payment.succeeded',
    payload: {
      orderId: `ord_${__VU}_${__ITER}`,
      amount: Math.floor(Math.random() * 10000) + 100,
      currency: 'usd',
      customer: `cus_${__VU}`,
      timestamp: Date.now(),
    },
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'Idempotency-Key': idempotencyKey,
    },
  };

  const res = http.post(`${BASE_URL}/v1/events`, payload, params);

  check(res, {
    'status is 202': (r) => r.status === 202,
    'has eventId': (r) => JSON.parse(r.body).eventId !== undefined,
  });

  sleep(0.05); // 50ms pacing
}
