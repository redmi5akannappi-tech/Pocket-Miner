/**
 * Reward Engine
 * Calculates real crypto and point rewards from session data
 */

const POOL_REWARD_RATE = parseFloat(process.env.POOL_REWARD_RATE || '0.0001');
const POINTS_PER_SHARE = parseInt(process.env.POINTS_PER_SHARE || '10');
const SESSION_BONUS = parseFloat(process.env.SESSION_BONUS_MULTIPLIER || '1.5');

// Mode multipliers for points
const MODE_MULTIPLIERS = {
  eco: 0.5,
  balanced: 1.0,
  turbo: 1.8,
};

/**
 * Calculate points and crypto from a completed session
 * @param {Object} session - Mongoose Session document
 * @returns {{ points: number, crypto: number }}
 */
function calculateSessionPoints(session) {
  const { validShares, mode, multiplierApplied, durationSeconds } = session;

  if (validShares <= 0) return { points: 0, crypto: 0 };

  const modeMultiplier = MODE_MULTIPLIERS[mode] || 1.0;
  const sessionBonus = durationSeconds >= 300 ? SESSION_BONUS : 1.0; // Bonus for 5+ min sessions

  // Points formula: shares * base_rate * mode * session_bonus * upgrade_multiplier
  const points = Math.floor(
    validShares * POINTS_PER_SHARE * modeMultiplier * sessionBonus * (multiplierApplied || 1.0)
  );

  // Crypto formula: proportional to valid shares and session duration
  // In production: user_reward = (user_valid_shares / total_valid_shares) * pool_rewards
  // MVP: simplified per-share rate
  const crypto = parseFloat(
    (validShares * POOL_REWARD_RATE * (multiplierApplied || 1.0)).toFixed(8)
  );

  return { points, crypto };
}

/**
 * Get estimated earnings per minute for a given mode and upgrade level
 * Used for UI display only — not for actual reward calculation
 */
function estimateEarningsPerMinute(mode, cpuLevel = 1, rewardMultiplier = 1.0) {
  const baseSharesPerMin = {
    eco: 2,
    balanced: 5,
    turbo: 10,
  };

  const shares = (baseSharesPerMin[mode] || 5) * (1 + (cpuLevel - 1) * 0.1);
  const estimatedPoints = Math.floor(shares * POINTS_PER_SHARE * rewardMultiplier);
  const estimatedCrypto = parseFloat((shares * POOL_REWARD_RATE * rewardMultiplier).toFixed(8));

  return { estimatedPoints, estimatedCrypto, sharesPerMin: Math.round(shares) };
}

module.exports = { calculateSessionPoints, estimateEarningsPerMinute };
