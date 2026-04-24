const express = require('express');
const router = express.Router();
const { User, Session, Upgrade } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');
const { calculateSessionPoints, calculateSessionCrypto } = require('../services/rewardEngine');
const { updateMissionProgress } = require('../services/gamification');

/**
 * POST /api/session/start
 * Starts a new mining session for a user
 */
router.post('/start', validateTelegramAuth, async (req, res) => {
  try {
    const { mode = 'balanced' } = req.body;
    const { telegramId, username, firstName } = req.telegramUser;

    if (!['eco', 'balanced', 'turbo'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mining mode' });
    }

    // Find or create user
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId, username: username || firstName || 'Miner', firstName });
      await user.save();
    }

    // Update streak
    user.updateStreak();

    // Check for already active session
    const existingSession = await Session.findOne({ telegramId, status: 'active' });
    if (existingSession) {
      // Auto-end the old session
      existingSession.status = 'abandoned';
      existingSession.endTime = new Date();
      await existingSession.save();
    }

    // Get user's upgrade level
    let upgrade = await Upgrade.findOne({ userId: user._id });
    if (!upgrade) {
      upgrade = new Upgrade({ userId: user._id, telegramId });
      await upgrade.save();
    }

    // Create new session
    const session = new Session({
      userId: user._id,
      telegramId,
      mode,
      multiplierApplied: upgrade.getRewardMultiplier() * user.getStreakMultiplier(),
    });

    user.totalSessions += 1;
    await Promise.all([session.save(), user.save()]);

    res.json({
      success: true,
      sessionId: session._id,
      mode,
      user: {
        username: user.username,
        totalPoints: user.totalPoints,
        pendingBalance: user.pendingBalance,
        streak: user.streak,
      },
      upgrade: {
        cpuLevel: upgrade.cpuLevel,
        efficiencyLevel: upgrade.efficiencyLevel,
        boostLevel: upgrade.boostLevel,
        hasrateMultiplier: upgrade.getHashrateMultiplier(),
        rewardMultiplier: upgrade.getRewardMultiplier(),
      },
    });
  } catch (err) {
    console.error('[SESSION/START]', err.message);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

/**
 * POST /api/session/end
 * Ends the active mining session and calculates final rewards
 */
router.post('/end', validateTelegramAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const { telegramId } = req.telegramUser;

    const session = await Session.findOne({ _id: sessionId, telegramId, status: 'active' });
    if (!session) {
      return res.status(404).json({ error: 'Active session not found' });
    }

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Finalize session
    session.endTime = new Date();
    session.durationSeconds = Math.floor((session.endTime - session.startTime) / 1000);
    session.status = 'completed';

    // Calculate final rewards based on validated shares
    const { points, crypto } = calculateSessionPoints(session);
    session.pointsEarned = points;
    session.cryptoEarned = crypto;

    // Update user totals
    user.totalPoints += points;
    user.pendingBalance += crypto;
    user.totalEarned += crypto;
    user.totalValidShares += session.validShares;
    user.totalMiningMinutes += Math.floor(session.durationSeconds / 60);

    // Update daily missions
    await updateMissionProgress(user, session);

    await Promise.all([session.save(), user.save()]);

    res.json({
      success: true,
      session: {
        durationSeconds: session.durationSeconds,
        validShares: session.validShares,
        pointsEarned: points,
        cryptoEarned: crypto,
        avgHashrate: session.avgHashrate,
      },
      totals: {
        totalPoints: user.totalPoints,
        pendingBalance: user.pendingBalance,
      },
    });
  } catch (err) {
    console.error('[SESSION/END]', err.message);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

module.exports = router;

