const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  telegramId: { type: String, required: true, index: true },

  amount: { type: Number, required: true },
  type: {
    type: String,
    enum: ['mining', 'withdrawal', 'bonus', 'points_purchase'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed'],
    default: 'pending',
  },

  // For withdrawals
  walletAddress: { type: String, default: null },
  txHash: { type: String, default: null },
  notes: { type: String, default: '' },

  // For mining rewards - link to session
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    default: null,
  },

  createdAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
