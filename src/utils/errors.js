/**
 * Application error with an HTTP status and a stable machine-readable
 * `code`. Only `message` codes designed for users ever leave the API —
 * internal/database errors are masked by the error handler.
 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, code = 'BAD_REQUEST', details) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'You are not allowed to perform this action', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }
  static conflict(message, code = 'CONFLICT', details) {
    return new ApiError(409, code, message, details);
  }
  static unprocessable(message, code = 'UNPROCESSABLE', details) {
    return new ApiError(422, code, message, details);
  }
  static internal(message = 'Something went wrong. Please try again later.', code = 'INTERNAL_ERROR') {
    return new ApiError(500, code, message);
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Translate known Postgres/Supabase failures into safe ApiErrors. */
export function mapDatabaseError(error, fallbackMessage = 'Database operation failed') {
  if (!error) return null;
  const msg = String(error.message || '');

  if (msg.includes('PAYMENT_NOT_FOUND')) {
    return ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  }
  if (msg.includes('PAYMENT_ALREADY_REVIEWED')) {
    return ApiError.conflict('This payment has already been reviewed', 'PAYMENT_ALREADY_REVIEWED');
  }
  if (msg.includes('REJECTION_REASON_REQUIRED')) {
    return ApiError.badRequest('A rejection reason is required', 'REJECTION_REASON_REQUIRED');
  }
  if (msg.includes('FORBIDDEN')) {
    return ApiError.forbidden('You are not allowed to perform this action', 'FORBIDDEN');
  }
  if (msg.includes('uq_transaction_reference') || msg.includes('duplicate key') && msg.includes('transaction_reference')) {
    return ApiError.conflict(
      'This transaction reference has already been submitted',
      'DUPLICATE_TRANSACTION_REFERENCE'
    );
  }
  if (msg.includes('uq_pending_payment_per_course')) {
    return ApiError.conflict(
      'You already have a payment for this course awaiting verification',
      'PAYMENT_ALREADY_PENDING'
    );
  }
  if (msg.includes('uq_enrollment_student_course')) {
    return ApiError.conflict('You are already enrolled in this course', 'ALREADY_ENROLLED');
  }
  if (msg.includes('duplicate key')) {
    return ApiError.conflict('A record with these details already exists', 'DUPLICATE_RECORD');
  }

  return ApiError.internal(fallbackMessage);
}
