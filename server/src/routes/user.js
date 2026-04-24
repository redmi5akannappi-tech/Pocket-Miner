const express = require('express');
const router = express.Router();
const { User, Session, Upgrade, Transaction } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');

/**
 * GET /api/user/stats
 * Returns full user stats including upgrades and recent sessions
 */
router.get('/stats', validateTelegramAuth, async (req, res) => {
  try {
    const { telegramId, username, firstName } = req.telegramUser;

    // Find or create user
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId, username: username || firstName || 'Miner', firstName });
      user.updateStreak();
      await user.save();

      // Create default upgrades
      await new Upgrade({ userId: user._id, telegramId }).save();
    }

    const [upgrade, activeSession, recentTransactions] = await Promise.all([
      Upgrade.findOne({ userId: user._id }),
      Session.findOne({ telegramId, status: 'active' }),
      Transaction.find({ telegramId }).sort({ createdAt: -1 }).limit(10),
    ]);

    res.json({
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        totalPoints: user.totalPoints,
        pendingBalance: user.pendingBalance,
        totalEarned: user.totalEarned,
        totalValidShares: user.totalValidShares,
        totalMiningMinutes: user.totalMiningMinutes,
        totalSessions: user.totalSessions,
        streak: user.streak,
        longestStreak: user.longestStreak,
        missionsProgress: user.missionsProgress,
        createdAt: user.createdAt,
      },
      upgrade: upgrade ? {
        cpuLevel: upgrade.cpuLevel,
        efficiencyLevel: upgrade.efficiencyLevel,
        boostLevel: upgrade.boostLevel,
        boostActive: upgrade.isBoostActive(),
        boostCooldown: upgrade.isBoostOnCooldown(),
        boostActiveUntil: upgrade.boostActiveUntil,
        boostCooldownUntil: upgrade.boostCooldownUntil,
        hashrateMultiplier: upgrade.getHashrateMultiplier(),
        rewardMultiplier: upgrade.getRewardMultiplier(),
      } : null,
      activeSession: activeSession ? {
        sessionId: activeSession._id,
        mode: activeSession.mode,
        startTime: activeSession.startTime,
        validShares: activeSession.validShares,
      } : null,
      recentTransactions,
    });
  } catch (err) {
    console.error('[USER/STATS]', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;

