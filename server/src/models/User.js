const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  username: {
    type: String,
    default: 'Miner',
    trim: true,
  },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },

  // Crypto balance (real earnings)
  pendingBalance: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0, min: 0 },

  // Gamification
  totalPoints: { type: Number, default: 0, min: 0 },

  // Streak system
  streak: { type: Number, default: 0 },
  lastLoginDate: { type: Date, default: null },
  longestStreak: { type: Number, default: 0 },

  // Session tracking
  totalSessions: { type: Number, default: 0 },
  totalMiningMinutes: { type: Number, default: 0 },
  totalValidShares: { type: Number, default: 0 },

  // Missions reset
  missionsLastReset: { type: Date, default: null },
  missionsProgress: {
    mineMins: { type: Number, default: 0 },
    turboUsed: { type: Boolean, default: false },
    pointsEarned: { type: Number, default: 0 },
    missionsClaimed: { type: Boolean, default: false },
  },

  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
});

userSchema.methods.updateStreak = function () {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!this.lastLoginDate) {
    this.streak = 1;
  } else {
    const lastDate = new Date(this.lastLoginDate);
    const lastDay = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
    const diffDays = Math.floor((today - lastDay) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // Same day — no streak change
      return this;
    } else if (diffDays === 1) {
      this.streak += 1;
    } else {
      this.streak = 1;
    }
  }

  if (this.streak > this.longestStreak) {
    this.longestStreak = this.streak;
  }

  this.lastLoginDate = now;
  return this;
};

userSchema.methods.getStreakMultiplier = function () {
  if (this.streak >= 30) return 2.0;
  if (this.streak >= 14) return 1.75;
  if (this.streak >= 7) return 1.5;
  if (this.streak >= 3) return 1.25;
  return 1.0;
};

const User = mongoose.model('User', userSchema);
module.exports = User;
