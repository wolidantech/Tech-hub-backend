import { MulterError } from 'multer';
import { ApiError } from '../utils/errors.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'));
}

/**
 * Central error handler. NEVER leaks stack traces, SQL, connection
 * details or other server internals to clients.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let apiError = err;

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      apiError = ApiError.badRequest('File is too large', 'FILE_TOO_LARGE');
    } else {
      apiError = ApiError.badRequest('Invalid file upload', 'UPLOAD_ERROR');
    }
  }

  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    apiError = ApiError.badRequest('Invalid request payload', 'INVALID_PAYLOAD');
  }

  if (!(apiError instanceof ApiError)) {
    // Unknown/internal error — log details server-side only.
    console.error('[unhandled-error]', {
      method: req.method,
      path: req.path,
      error: apiError?.message,
      stack: apiError?.stack,
    });
    apiError = ApiError.internal();
  } else if (apiError.status >= 500) {
    console.error('[server-error]', {
      method: req.method,
      path: req.path,
      code: apiError.code,
      message: apiError.message,
    });
  }

  res.status(apiError.status).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details && !env.isProduction ? { details: apiError.details } : {}),
    },
  });
}
