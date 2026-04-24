const express = require('express');
const router = express.Router();
const { User, Upgrade } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');

const UPGRADE_TYPES = ['cpu', 'efficiency', 'boost'];

/**
 * POST /api/upgrades/buy
 * Purchase an upgrade using points
 */
router.post('/buy', validateTelegramAuth, async (req, res) => {
  try {
    const { type } = req.body;
    const { telegramId } = req.telegramUser;

    if (!UPGRADE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid upgrade type. Must be: cpu, efficiency, or boost' });
    }

    const [user, upgrade] = await Promise.all([
      User.findOne({ telegramId }),
      Upgrade.findOne({ telegramId }),
    ]);

    if (!user || !upgrade) return res.status(404).json({ error: 'User not found' });

    // Get current level and map to schema field
    const levelField = `${type}Level`;
    const currentLevel = upgrade[levelField];

    if (currentLevel >= 10) {
      return res.status(400).json({ error: 'Upgrade already at max level (10)' });
    }

    // Calculate cost
    const cost = Upgrade.getUpgradeCost(type, currentLevel);

    if (user.totalPoints < cost) {
      return res.status(400).json({
        error: 'Insufficient points',
        required: cost,
        current: user.totalPoints,
      });
    }

    // Deduct points and upgrade
    user.totalPoints -= cost;
    upgrade[levelField] = currentLevel + 1;

    await Promise.all([user.save(), upgrade.save()]);

    const nextCost = upgrade[levelField] < 10
      ? Upgrade.getUpgradeCost(type, upgrade[levelField])
      : null;

    res.json({
      success: true,
      type,
      newLevel: upgrade[levelField],
      pointsSpent: cost,
      remainingPoints: user.totalPoints,
      nextUpgradeCost: nextCost,
      multipliers: {
        hashrate: upgrade.getHashrateMultiplier(),
        reward: upgrade.getRewardMultiplier(),
        efficiency: upgrade.getEfficiencyMultiplier(),
      },
    });
  } catch (err) {
    console.error('[UPGRADES/BUY]', err.message);
    res.status(500).json({ error: 'Failed to purchase upgrade' });
  }
});

/**
 * POST /api/upgrades/boost
 * Activate a temporary 2x boost
 */
router.post('/boost', validateTelegramAuth, async (req, res) => {
  try {
    const { telegramId } = req.telegramUser;
    const upgrade = await Upgrade.findOne({ telegramId });

    if (!upgrade) return res.status(404).json({ error: 'User not found' });

    if (upgrade.isBoostActive()) {
      return res.status(400).json({
        error: 'Boost already active',
        activeUntil: upgrade.boostActiveUntil,
      });
    }

    if (upgrade.isBoostOnCooldown()) {
      return res.status(400).json({
        error: 'Boost on cooldown',
        cooldownUntil: upgrade.boostCooldownUntil,
      });
    }

    // Boost duration scales with boost level (5–15 min)
    const durationMins = 5 + (upgrade.boostLevel - 1) * 1;
    const cooldownMins = 60; // 1 hour cooldown

    const now = new Date();
    upgrade.boostActiveUntil = new Date(now.getTime() + durationMins * 60 * 1000);
    upgrade.boostCooldownUntil = new Date(now.getTime() + cooldownMins * 60 * 1000);

    await upgrade.save();

    res.json({
      success: true,
      boostActiveUntil: upgrade.boostActiveUntil,
      durationMinutes: durationMins,
      multiplier: 2.0,
    });
  } catch (err) {
    console.error('[UPGRADES/BOOST]', err.message);
    res.status(500).json({ error: 'Failed to activate boost' });
  }
});

/**
 * GET /api/upgrades/costs
 * Returns upgrade costs for all types and levels
 */
router.get('/costs', validateTelegramAuth, async (req, res) => {
  try {
    const { telegramId } = req.telegramUser;
    const upgrade = await Upgrade.findOne({ telegramId });

    if (!upgrade) return res.status(404).json({ error: 'User not found' });

    const costs = {};
    UPGRADE_TYPES.forEach(type => {
      const levelField = `${type}Level`;
      const currentLevel = upgrade[levelField];
      costs[type] = {
        currentLevel,
        maxLevel: 10,
        nextCost: currentLevel < 10 ? Upgrade.getUpgradeCost(type, currentLevel) : null,
        isMaxed: currentLevel >= 10,
      };
    });

    res.json({ costs });
  } catch (err) {
    console.error('[UPGRADES/COSTS]', err.message);
    res.status(500).json({ error: 'Failed to get costs' });
  }
});

module.exports = router;

