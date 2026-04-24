const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');

/**
 * GET /api/leaderboard
 * Top miners by total points
 */
router.get('/', validateTelegramAuth, async (req, res) => {
  try {
    const { telegramId } = req.telegramUser;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const topMiners = await User.find({ isActive: true })
      .sort({ totalPoints: -1 })
      .limit(limit)
      .select('telegramId username firstName totalPoints totalValidShares streak totalMiningMinutes createdAt');

    // Find current user's rank
    const userRank = await User.countDocuments({
      isActive: true,
      totalPoints: { $gt: (await User.findOne({ telegramId }))?.totalPoints || 0 },
    });

    const rankedMiners = topMiners.map((miner, i) => ({
      rank: i + 1,
      telegramId: miner.telegramId,
      username: miner.username || miner.firstName || 'Miner',
      totalPoints: miner.totalPoints,
      totalValidShares: miner.totalValidShares,
      streak: miner.streak,
      totalMiningMinutes: miner.totalMiningMinutes,
      isCurrentUser: miner.telegramId === telegramId,
    }));

    res.json({
      leaderboard: rankedMiners,
      currentUserRank: userRank + 1,
      totalMiners: await User.countDocuments({ isActive: true }),
    });
  } catch (err) {
    console.error('[LEADERBOARD]', err.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;

