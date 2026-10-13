import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = req.id || 'unknown';

  // 1. Operational application errors (custom typed AppError)
  if (err instanceof AppError) {
    logger.warn({
      requestId,
      errorCode: err.errorCode,
      statusCode: err.statusCode,
      message: err.message,
      details: err.details,
    }, 'Operational error handled');

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details,
      },
      requestId,
    });
    return;
  }

  // 2. Schema validation errors (Zod)
  if (err instanceof ZodError) {
    const formattedErrors = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    logger.warn({
      requestId,
      errorCode: 'VALIDATION_ERROR',
      validationErrors: formattedErrors,
    }, 'Schema validation failed');

    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload or parameters',
        details: formattedErrors,
      },
      requestId,
    });
    return;
  }

  // 3. Body parser syntax errors (e.g. malformed JSON)
  if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({
      success: false,
      error: {
        code: 'MALFORMED_JSON',
        message: 'Invalid JSON payload received in request body',
      },
      requestId,
    });
    return;
  }

  // 4. Unexpected server bugs or unhandled errors (500)
  logger.error({
    requestId,
    err,
    stack: err.stack,
  }, 'Unhandled internal error occurred');

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: env.NODE_ENV === 'production' 
        ? 'An unexpected internal error occurred. Please contact support.' 
        : err.message,
    },
    requestId,
  });
};
