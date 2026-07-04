/**
 * payoutService.js
 *
 * Proportional Split Payout — Method 2.
 *
 * How it works:
 *   1. Once a day (via cron), call runDailyPayout().
 *   2. Fetch today's unpaid balance from LuckPool + any payments received today.
 *   3. Calculate VRSC earned = (currentBalance - lastSnapshotBalance) + paymentsToday.
 *   4. Divide that VRSC proportionally among all users based on points earned today.
 *   5. Credit each user's balance, save the new snapshot for tomorrow.
 *
 * The payout state (last snapshot) is kept in memory (USE_MEMORY=true) or can
 * be persisted to MongoDB via an env var or a simple JSON file.
 */

const { getUnpaidBalance, getPaymentsSince } = require('./luckPoolService');

// ─── Snapshot state ───────────────────────────────────────────────────────────
// In production with MongoDB you'd persist this in a dedicated DB document.
// For now we keep it in memory; it resets on server restart (safe — worst case
// the day's payout is skipped and retried next cycle).
let _lastSnapshot = {
  balance:   null,   // VRSC float — unpaid balance at last snapshot time
  timestamp: null,   // ms — when the snapshot was taken
};

/**
 * Seed the snapshot on server start so we have a baseline before the first
 * daily run. Called once from index.js.
 */
async function initSnapshot() {
  const balance = await getUnpaidBalance();
  if (balance !== null) {
    _lastSnapshot = { balance, timestamp: Date.now() };
    console.log(`[PAYOUT] Snapshot initialised: ${balance} VRSC`);
  } else {
    console.warn('[PAYOUT] Could not initialise snapshot — LuckPool unreachable.');
  }
}

/**
 * Main daily payout runner.
 * @param {Object} models - { User } model reference (Mongoose or memoryStore)
 * @param {Object} sessions - The session store, to read today's point totals.
 *   Expects sessions to have a method: getTodayPointsByUser() → Map<telegramId, points>
 *   We implement a fallback aggregation below if that method is absent.
 */
async function runDailyPayout(models) {
  console.log('[PAYOUT] ──── Daily payout run starting ────');

  // 1. Fetch current LuckPool balance
  const currentBalance = await getUnpaidBalance();
  if (currentBalance === null) {
    console.error('[PAYOUT] Skipping — LuckPool API unavailable.');
    return { skipped: true, reason: 'luckpool_unavailable' };
  }

  // 2. Fetch payments received since last snapshot (handles the balance-reset case)
  const sinceMs = _lastSnapshot.timestamp ?? (Date.now() - 86_400_000);
  const paymentsToday = await getPaymentsSince(sinceMs);

  // 3. Calculate VRSC earned today
  const lastBalance = _lastSnapshot.balance ?? 0;
  const vrscEarned  = parseFloat(
    ((currentBalance - lastBalance) + paymentsToday).toFixed(8)
  );

  console.log(`[PAYOUT] Balance: ${lastBalance} → ${currentBalance} VRSC  |  Payments today: ${paymentsToday} VRSC  |  Earned: ${vrscEarned} VRSC`);

  if (vrscEarned <= 0) {
    console.log('[PAYOUT] No VRSC earned today — skipping distribution.');
    // Still update snapshot
    _lastSnapshot = { balance: currentBalance, timestamp: Date.now() };
    return { skipped: true, reason: 'no_vrsc_earned', vrscEarned };
  }

  // 4. Aggregate today's points per user
  // We pull all users and check their pointsToday field (you can replace with
  // a DB aggregation query for production).
  const { User } = models;
  let allUsers;
  try {
    allUsers = await User.find({});
  } catch (err) {
    console.error('[PAYOUT] Could not fetch users:', err.message);
    return { skipped: true, reason: 'db_error' };
  }

  // Build a map of telegramId → pointsEarnedToday
  // "pointsToday" is reset each day in the User model. If not present, skip user.
  const pointsMap = new Map();
  let totalPoints = 0;
  for (const user of allUsers) {
    const pts = user.pointsToday ?? 0;
    if (pts > 0) {
      pointsMap.set(user.telegramId, pts);
      totalPoints += pts;
    }
  }

  if (totalPoints === 0) {
    console.log('[PAYOUT] No points earned today — skipping distribution.');
    _lastSnapshot = { balance: currentBalance, timestamp: Date.now() };
    return { skipped: true, reason: 'no_points' };
  }

  // 5. Distribute VRSC proportionally + reset daily points
  let distributed = 0;
  const results = [];
  for (const user of allUsers) {
    const pts = pointsMap.get(user.telegramId) ?? 0;
    if (pts === 0) continue;

    const share = pts / totalPoints;
    const vrscShare = parseFloat((vrscEarned * share).toFixed(8));

    user.balance    = parseFloat(((user.balance ?? 0) + vrscShare).toFixed(8));
    user.pointsToday = 0;  // reset daily counter
    await user.save();

    distributed += vrscShare;
    results.push({ telegramId: user.telegramId, pts, share: (share * 100).toFixed(2) + '%', vrsc: vrscShare });
    console.log(`[PAYOUT]   ${user.telegramId}: ${pts}pts (${(share * 100).toFixed(1)}%) → +${vrscShare} VRSC`);
  }

  // 6. Save new snapshot for tomorrow
  _lastSnapshot = { balance: currentBalance, timestamp: Date.now() };

  console.log(`[PAYOUT] ──── Done. Distributed ${distributed.toFixed(8)} VRSC to ${results.length} users ────`);
  return {
    success: true,
    vrscEarned,
    distributed,
    users: results.length,
    totalPoints,
    newSnapshot: currentBalance,
  };
}

/**
 * Get the current snapshot state (for the admin API endpoint).
 */
function getSnapshotState() {
  return { ..._lastSnapshot };
}

module.exports = { initSnapshot, runDailyPayout, getSnapshotState };
