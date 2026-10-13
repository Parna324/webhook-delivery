# Webhook Receiver Verification Guide

Every webhook event dispatched by our platform is cryptographically signed using an **HMAC-SHA256 signature** and includes a timestamp header. This prevents:
1. **Man-in-the-Middle tampering** (the payload cannot be modified in transit).
2. **Impersonation attacks** (only our platform holds your endpoint secret).
3. **Replay attacks** (attackers cannot capture an old webhook and re-send it).

---

## 1. HTTP Headers Sent with Every Webhook

| Header | Example | Description |
| :--- | :--- | :--- |
| `webhook-id` | `evt_12345678` | Unique identifier for the ingested event (use for idempotency). |
| `webhook-timestamp` | `1728800000` | Unix epoch time in seconds when the delivery was prepared. |
| `webhook-signature` | `v1=a3f8b9...` | HMAC-SHA256 signature of `${timestamp}.${rawPayload}`. |

---

## 2. Verification Algorithm

1. Extract the `webhook-timestamp` and `webhook-signature` headers.
2. Check timestamp drift: if `|currentTime - timestamp| > 300` seconds (5 minutes), reject the request to prevent replay attacks.
3. Compute expected signature:
   $$\text{expected} = \text{HMAC-SHA256}(\text{endpointSecret}, \text{timestamp} + "." + \text{rawPayload})$$
4. Compare the expected signature against the received `v1` signature using a **timing-safe comparison** to prevent timing attacks.

---

## 3. Node.js / TypeScript Example (Express)

```typescript
import express, { Request, Response } from 'express';
import crypto from 'node:crypto';

const app = express();
// CRITICAL: We need the raw body buffer to verify signatures accurately
app.use(express.raw({ type: 'application/json' }));

const ENDPOINT_SECRET = process.env.WEBHOOK_SECRET || 'whsec_your_secret_here';

function verifyWebhook(req: Request): boolean {
  const timestamp = req.headers['webhook-timestamp'] as string;
  const signatureHeader = req.headers['webhook-signature'] as string;
  const rawBody = req.body.toString('utf-8');

  if (!timestamp || !signatureHeader) return false;

  // 1. Replay attack check (5 minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return false;
  }

  // 2. Compute expected HMAC-SHA256
  const cleanSecret = ENDPOINT_SECRET.startsWith('whsec_') ? ENDPOINT_SECRET.slice(6) : ENDPOINT_SECRET;
  const payloadToSign = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', cleanSecret)
    .update(payloadToSign)
    .digest('hex');

  // 3. Timing-safe equality comparison
  const receivedSig = signatureHeader.replace('v1=', '');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const receivedBuf = Buffer.from(receivedSig, 'hex');

  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

app.post('/webhook', (req: Request, res: Response) => {
  if (!verifyWebhook(req)) {
    return res.status(401).json({ error: 'Invalid or expired webhook signature' });
  }

  const event = JSON.parse(req.body.toString('utf-8'));
  console.log('Received authentic event:', event);

  // Return HTTP 200 within 10 seconds to acknowledge receipt
  res.status(200).json({ received: true });
});

app.listen(4000, () => console.log('Receiver listening on port 4000'));
```

---

## 4. Python Example (FastAPI)

```python
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
ENDPOINT_SECRET = "whsec_your_secret_here"

@app.post("/webhook")
async def receive_webhook(request: Request):
    timestamp = request.headers.get("webhook-timestamp")
    signature = request.headers.get("webhook-signature")
    body = await request.body()
    raw_payload = body.decode("utf-8")

    if not timestamp or not signature:
        raise HTTPException(status_code=401, detail="Missing signature headers")

    # 1. Prevent replay attacks
    now = int(time.time())
    if abs(now - int(timestamp)) > 300:
        raise HTTPException(status_code=401, detail="Timestamp out of tolerance window")

    # 2. Compute expected HMAC
    clean_secret = ENDPOINT_SECRET[6:] if ENDPOINT_SECRET.startswith("whsec_") else ENDPOINT_SECRET
    to_sign = f"{timestamp}.{raw_payload}".encode("utf-8")
    expected = hmac.new(clean_secret.encode("utf-8"), to_sign, hashlib.sha256).hexdigest()

    # 3. Timing-safe compare
    received_v1 = signature.replace("v1=", "")
    if not hmac.compare_digest(expected, received_v1):
        raise HTTPException(status_code=401, detail="Signature mismatch")

    return {"received": True}
```
