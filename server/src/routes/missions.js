const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');
const { getMissionsWithProgress, claimMissionRewards } = require('../services/gamification');

/**
 * GET /api/user/stats — see routes/user.js
 * This file adds supplemental mission-related endpoints
 */

/**
 * GET /api/user/missions
 */
router.get('/missions', validateTelegramAuth, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.telegramUser.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const missions = getMissionsWithProgress(user);
    res.json({ missions, streak: user.streak, missionsClaimed: user.missionsProgress?.missionsClaimed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch missions' });
  }
});

/**
 * POST /api/user/claim-missions
 */
router.post('/claim-missions', validateTelegramAuth, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.telegramUser.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = claimMissionRewards(user);

    if (result.alreadyClaimed) {
      return res.status(400).json({ error: 'Missions already claimed today', alreadyClaimed: true });
    }

    await user.save();

    res.json({
      success: true,
      pointsAwarded: result.pointsAwarded,
      totalPoints: user.totalPoints,
      missions: result.missions,
    });
  } catch (err) {
    console.error('[MISSIONS/CLAIM]', err.message);
    res.status(500).json({ error: 'Failed to claim missions' });
  }
});

module.exports = router;

