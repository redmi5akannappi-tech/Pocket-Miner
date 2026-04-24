/**
 * Anti-Cheat Service
 * Validates share submissions and detects suspicious activity
 */

const MAX_HASHRATE_MH = parseFloat(process.env.MAX_HASHRATE_MH || '10') * 1_000_000; // 10 MH/s
const MAX_SHARES_PER_MINUTE = parseInt(process.env.MAX_SHARES_PER_MINUTE || '60');

// In-memory rate limiting (use Redis in production)
const shareTimestamps = new Map(); // telegramId -> [timestamps]

function recordShare(telegramId) {
  const now = Date.now();
  const window = 60_000; // 1 minute

  if (!shareTimestamps.has(telegramId)) {
    shareTimestamps.set(telegramId, []);
  }

  const timestamps = shareTimestamps.get(telegramId);
  // Prune old entries
  const recent = timestamps.filter(t => now - t < window);
  recent.push(now);
  shareTimestamps.set(telegramId, recent);

  return recent.length;
}

/**
 * Validate a share submission
 * @param {{ shareData, hashrate, session, telegramId }} params
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateShare({ shareData, hashrate, session, telegramId }) {
  // 1. Basic data check
  if (!shareData || typeof shareData !== 'object') {
    return { valid: false, reason: 'missing_share_data' };
  }

  // 2. Hashrate sanity check — reject superhuman rates
  if (hashrate && hashrate > MAX_HASHRATE_MH) {
    return { valid: false, reason: 'hashrate_too_high', hashrate };
  }

  // 3. Ensure session hasn't been running too long (30 min max)
  const sessionAge = (Date.now() - new Date(session.startTime).getTime()) / 1000;
  if (sessionAge > 30 * 60) {
    return { valid: false, reason: 'session_expired' };
  }

  // 4. Rate limiting per user
  const sharesInWindow = recordShare(telegramId);
  if (sharesInWindow > MAX_SHARES_PER_MINUTE) {
    return { valid: false, reason: 'rate_limit_exceeded', count: sharesInWindow };
  }

  // 5. Invalid share ratio check — if too many invalids, flag
  if (session.sharesSubmitted > 10) {
    const invalidRatio = session.invalidShares / session.sharesSubmitted;
    if (invalidRatio > 0.5) {
      return { valid: false, reason: 'high_invalid_ratio', ratio: invalidRatio };
    }
  }

  // 6. Validate nonce/hash if provided (basic PoW check)
  if (shareData.nonce !== undefined && shareData.hash) {
    if (!isValidHash(shareData)) {
      return { valid: false, reason: 'invalid_hash' };
    }
  }

  return { valid: true };
}

/**
 * Simple PoW hash validation
 * In production, replace with actual algorithm validation
 */
function isValidHash({ hash, difficulty = 3 }) {
  if (typeof hash !== 'string') return false;
  const prefix = '0'.repeat(difficulty);
  return hash.startsWith(prefix);
}

module.exports = { validateShare };
