const rateLimit = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: (req) => req.headers['x-telegram-id'] || req.ip,
});

// Stricter limit for share submission
const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 70, // slightly above MAX_SHARES_PER_MINUTE for flexibility
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Share submission rate limit exceeded.' },
  keyGenerator: (req) => req.headers['x-telegram-id'] || req.ip,
});

// Withdrawal rate limit — one per 24h effectively enforced by DB check
const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many withdrawal requests.' },
  keyGenerator: (req) => req.headers['x-telegram-id'] || req.ip,
});

module.exports = { apiLimiter, shareLimiter, withdrawLimiter };
