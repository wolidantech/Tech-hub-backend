import rateLimit from 'express-rate-limit';

const handler = (_req, res) => {
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again later.' },
  });
};

/** Strict limiter for credential endpoints (brute-force protection). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

/** Payment submission limiter (file uploads). */
export const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

/** General API limiter. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});
