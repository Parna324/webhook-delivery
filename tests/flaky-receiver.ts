import http from 'node:http';

export interface FlakyReceiverOptions {
  port?: number; // 0 for dynamic OS assigned port
  failureRate: number; // e.g. 0.30 for 30% failure rate
  minDelayMs?: number;
  maxDelayMs?: number;
}

export async function startFlakyReceiver(options: FlakyReceiverOptions): Promise<{
  server: http.Server;
  port: number;
  stats: {
    totalReceived: number;
    succeeded: number;
    failed: number;
  };
}> {
  const stats = { totalReceived: 0, succeeded: 0, failed: 0 };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      stats.totalReceived++;

      const min = options.minDelayMs ?? 5;
      const max = options.maxDelayMs ?? 20;
      const delay = Math.floor(Math.random() * (max - min) + min);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }

      const shouldFail = Math.random() < options.failureRate;

      if (shouldFail) {
        stats.failed++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Receiver Server Error (Simulated Flakiness)' }));
      } else {
        stats.succeeded++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'received_ok' }));
      }
    });
  });

  const assignedPort = await new Promise<number>((resolve) => {
    server.listen(options.port ?? 0, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(p);
    });
  });

  return { server, port: assignedPort, stats };
}
