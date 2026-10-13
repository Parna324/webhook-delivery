import { pinoHttp } from 'pino-http';
import { logger } from '../../lib/logger.js';
import { Request } from 'express';

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => {
    const expressReq = req as unknown as Request;
    return expressReq.id || (req.headers['x-request-id'] as string) || 'unknown';
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});
