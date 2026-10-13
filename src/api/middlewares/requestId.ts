import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

// Extend Express Request interface to include id
declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const incomingId = req.header('x-request-id');
  const reqId = (Array.isArray(incomingId) ? incomingId[0] : incomingId) || randomUUID();
  req.id = reqId;
  res.setHeader('x-request-id', reqId);
  next();
};
