const express = require('express');
const router = express.Router();
const { User, Transaction } = require('../models');
const { validateTelegramAuth } = require('../middleware/auth');

const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '0.001');

/**
 * POST /api/withdraw
 * Requests a withdrawal of pending balance
 */
router.post('/', validateTelegramAuth, async (req, res) => {
  try {
    const { amount, walletAddress } = req.body;
    const { telegramId } = req.telegramUser;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!walletAddress || typeof walletAddress !== 'string' || walletAddress.trim().length < 10) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    if (amount < MIN_WITHDRAWAL) {
      return res.status(400).json({
        error: `Minimum withdrawal is ${MIN_WITHDRAWAL}`,
        minimum: MIN_WITHDRAWAL,
      });
    }

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.pendingBalance < amount) {
      return res.status(400).json({
        error: 'Insufficient balance',
        available: user.pendingBalance,
        requested: amount,
      });
    }

    // Check for pending withdrawal
    const pendingWithdrawal = await Transaction.findOne({
      telegramId,
      type: 'withdrawal',
      status: 'pending',
    });

    if (pendingWithdrawal) {
      return res.status(400).json({
        error: 'You already have a pending withdrawal',
        pendingId: pendingWithdrawal._id,
      });
    }

    // Deduct and create transaction
    user.pendingBalance -= amount;

    const tx = new Transaction({
      userId: user._id,
      telegramId,
      amount,
      type: 'withdrawal',
      status: 'pending',
      walletAddress: walletAddress.trim(),
    });

    await Promise.all([user.save(), tx.save()]);

    res.json({
      success: true,
      message: 'Withdrawal request submitted. Manual approval in progress.',
      transactionId: tx._id,
      amount,
      walletAddress: walletAddress.trim(),
      remainingBalance: user.pendingBalance,
    });
  } catch (err) {
    console.error('[WITHDRAW]', err.message);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

/**
 * GET /api/withdraw/history
 */
router.get('/history', validateTelegramAuth, async (req, res) => {
  try {
    const { telegramId } = req.telegramUser;
    const transactions = await Transaction.find({ telegramId, type: 'withdrawal' })
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ transactions });
  } catch (err) {
    console.error('[WITHDRAW/HISTORY]', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

module.exports = router;

