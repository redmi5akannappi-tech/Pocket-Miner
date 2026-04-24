const express = require('express');
const router = express.Router();
const { Session } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');
const { validateShare } = require('../services/antiCheat');

/**
 * POST /api/shares/submit
 * Accepts a share submission from the client miner
 */
router.post('/submit', validateTelegramAuth, async (req, res) => {
  try {
    const { sessionId, shareData, hashrate } = req.body;
    const { telegramId } = req.telegramUser;

    const session = await Session.findOne({ _id: sessionId, telegramId, status: 'active' });
    if (!session) {
      return res.status(404).json({ error: 'Active session not found', valid: false });
    }

    // Anti-cheat validation
    const validation = validateShare({ shareData, hashrate, session, telegramId });

    session.sharesSubmitted += 1;

    if (validation.valid) {
      session.validShares += 1;
      // Update rolling average hashrate
      const alpha = 0.1;
      session.avgHashrate = session.avgHashrate
        ? session.avgHashrate * (1 - alpha) + hashrate * alpha
        : hashrate;
    } else {
      session.invalidShares += 1;
      console.warn(`[SHARES] Invalid share from ${telegramId}: ${validation.reason}`);
    }

    await session.save();

    res.json({
      valid: validation.valid,
      reason: validation.reason || null,
      validShares: session.validShares,
      totalShares: session.sharesSubmitted,
    });
  } catch (err) {
    console.error('[SHARES/SUBMIT]', err.message);
    res.status(500).json({ error: 'Failed to submit share' });
  }
});

module.exports = router;

