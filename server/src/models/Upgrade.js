const mongoose = require('mongoose');

const upgradeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  telegramId: { type: String, required: true, index: true },

  // Upgrade levels (1–10)
  cpuLevel: { type: Number, default: 1, min: 1, max: 10 },
  efficiencyLevel: { type: Number, default: 1, min: 1, max: 10 },
  boostLevel: { type: Number, default: 1, min: 1, max: 10 },

  // Active boost
  boostActiveUntil: { type: Date, default: null },
  boostCooldownUntil: { type: Date, default: null },
}, {
  timestamps: true,
});

// Helpers
upgradeSchema.methods.isBoostActive = function () {
  return this.boostActiveUntil && new Date() < this.boostActiveUntil;
};

upgradeSchema.methods.isBoostOnCooldown = function () {
  return this.boostCooldownUntil && new Date() < this.boostCooldownUntil;
};

upgradeSchema.methods.getHashrateMultiplier = function () {
  // CPU level gives +10% per level
  return 1 + (this.cpuLevel - 1) * 0.1;
};

upgradeSchema.methods.getRewardMultiplier = function () {
  const boostMult = this.isBoostActive() ? 2.0 : 1.0;
  const boostLevelMult = 1 + (this.boostLevel - 1) * 0.05;
  return boostMult * boostLevelMult;
};

upgradeSchema.methods.getEfficiencyMultiplier = function () {
  return 1 + (this.efficiencyLevel - 1) * 0.08;
};

// Upgrade cost calculator
upgradeSchema.statics.getUpgradeCost = function (type, currentLevel) {
  const baseCosts = { cpu: 500, efficiency: 300, boost: 800 };
  const base = baseCosts[type] || 500;
  return Math.floor(base * Math.pow(1.6, currentLevel - 1));
};

const Upgrade = mongoose.model('Upgrade', upgradeSchema);
module.exports = Upgrade;
