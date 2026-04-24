const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  telegramId: { type: String, required: true, index: true },
  mode: {
    type: String,
    enum: ['eco', 'balanced', 'turbo'],
    default: 'balanced',
  },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },

  // Mining stats
  sharesSubmitted: { type: Number, default: 0 },
  validShares: { type: Number, default: 0 },
  invalidShares: { type: Number, default: 0 },
  avgHashrate: { type: Number, default: 0 }, // H/s

  // Rewards
  pointsEarned: { type: Number, default: 0 },
  cryptoEarned: { type: Number, default: 0 },
  multiplierApplied: { type: Number, default: 1.0 },

  // Status
  status: {
    type: String,
    enum: ['active', 'completed', 'abandoned'],
    default: 'active',
  },
}, {
  timestamps: true,
});

// Duration in minutes helper
sessionSchema.virtual('durationMinutes').get(function () {
  return this.durationSeconds / 60;
});

const Session = mongoose.model('Session', sessionSchema);
module.exports = Session;
