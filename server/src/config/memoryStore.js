/**
 * In-Memory Store — replaces MongoDB for local testing.
 * Set USE_MEMORY=true in .env to activate.
 *
 * Mimics the Mongoose model API used in routes so no route code changes needed.
 */

// ─── Simple ID generator ──────────────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── In-memory collections ────────────────────────────────────────────────────
const _users        = new Map(); // telegramId -> userDoc
const _sessions     = new Map(); // _id -> sessionDoc
const _upgrades     = new Map(); // telegramId -> upgradeDoc
const _transactions = new Map(); // _id -> txDoc

// ─── Streak/multiplier helpers (mirrored from User model) ─────────────────────
function updateStreak(user) {
  const now  = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!user.lastLoginDate) {
    user.streak = 1;
  } else {
    const lastDay = new Date(user.lastLoginDate);
    lastDay.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - lastDay) / 86400000);
    if      (diff === 0) { /* same day */ }
    else if (diff === 1) { user.streak += 1; }
    else                 { user.streak = 1; }
  }

  user.longestStreak  = Math.max(user.streak, user.longestStreak || 0);
  user.lastLoginDate  = now;
  return user;
}

function getStreakMultiplier(user) {
  const s = user.streak || 0;
  if (s >= 30) return 2.0;
  if (s >= 14) return 1.75;
  if (s >= 7)  return 1.5;
  if (s >= 3)  return 1.25;
  return 1.0;
}

function makeUserMethods(u) {
  u.updateStreak        = () => updateStreak(u);
  u.getStreakMultiplier = () => getStreakMultiplier(u);
  u.save                = async () => { _users.set(u.telegramId, u); return u; };
  return u;
}

// ─── Upgrade helpers ──────────────────────────────────────────────────────────
function makeUpgradeMethods(upg) {
  upg.isBoostActive     = () => upg.boostActiveUntil  && new Date() < new Date(upg.boostActiveUntil);
  upg.isBoostOnCooldown = () => upg.boostCooldownUntil && new Date() < new Date(upg.boostCooldownUntil);
  upg.getHashrateMultiplier  = () => 1 + (upg.cpuLevel - 1) * 0.1;
  upg.getRewardMultiplier    = () => (upg.isBoostActive() ? 2.0 : 1.0) * (1 + (upg.boostLevel - 1) * 0.05);
  upg.getEfficiencyMultiplier= () => 1 + (upg.efficiencyLevel - 1) * 0.08;
  upg.save = async () => { _upgrades.set(upg.telegramId, upg); return upg; };
  return upg;
}

// ─── Model factories ──────────────────────────────────────────────────────────

const User = {
  findOne: async (query) => {
    const doc = [..._users.values()].find(u =>
      Object.entries(query).every(([k, v]) => u[k] === v)
    );
    return doc ? makeUserMethods({ ...doc }) : null;
  },
  find: async (query = {}) => {
    return [..._users.values()].filter(u =>
      Object.entries(query).every(([k, v]) => {
        if (typeof v === 'object') return true; // skip complex queries
        return u[k] === v;
      })
    ).map(u => makeUserMethods({ ...u }));
  },
  countDocuments: async (query = {}) => {
    return [..._users.values()].filter(u =>
      Object.entries(query).every(([k, v]) => {
        if (typeof v === 'object') return true;
        return u[k] === v;
      })
    ).length;
  },

  // Constructor-style factory
  create: (data) => {
    const u = {
      _id: genId(),
      telegramId: data.telegramId,
      username: data.username || 'Miner',
      firstName: data.firstName || '',
      pendingBalance: 0,
      totalEarned: 0,
      totalPoints: 0,
      streak: 0,
      longestStreak: 0,
      lastLoginDate: null,
      totalSessions: 0,
      totalMiningMinutes: 0,
      totalValidShares: 0,
      isActive: true,
      missionsLastReset: null,
      missionsProgress: { mineMins: 0, turboUsed: false, pointsEarned: 0, missionsClaimed: false },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    _users.set(u.telegramId, u);
    return makeUserMethods(u);
  },
};

// Allow `new User(data)` syntax used in routes
function UserConstructor(data) { return User.create(data); }
Object.assign(UserConstructor, User);

const Session = {
  findOne: async (query) => {
    const matches = [..._sessions.values()].filter(s =>
      Object.entries(query).every(([k, v]) => s[k] === String(v) || s[k] === v)
    );
    const doc = matches[0] || null;
    if (!doc) return null;
    const proxy = { ...doc, save: async () => { _sessions.set(doc._id, doc); Object.assign(doc, proxy); return doc; } };
    return proxy;
  },
  find: async (query) => [..._sessions.values()].filter(s =>
    Object.entries(query).every(([k, v]) => s[k] === v)
  ),

  create: (data) => {
    const s = {
      _id: genId(),
      status: 'active',
      sharesSubmitted: 0,
      validShares: 0,
      invalidShares: 0,
      avgHashrate: 0,
      pointsEarned: 0,
      cryptoEarned: 0,
      multiplierApplied: 1,
      startTime: new Date(),
      endTime: null,
      durationSeconds: 0,
      ...data,
    };
    s.save = async () => { _sessions.set(s._id, s); return s; };
    _sessions.set(s._id, s);
    return s;
  },
};

function SessionConstructor(data) { return Session.create(data); }
Object.assign(SessionConstructor, Session);

const Upgrade = {
  findOne: async (query) => {
    const doc = [..._upgrades.values()].find(u =>
      Object.entries(query).every(([k, v]) => String(u[k]) === String(v))
    );
    return doc ? makeUpgradeMethods({ ...doc }) : null;
  },
  getUpgradeCost: (type, level) => {
    const base = { cpu: 500, efficiency: 300, boost: 800 };
    return Math.floor((base[type] || 500) * Math.pow(1.6, level - 1));
  },
  create: (data) => {
    const u = {
      _id: genId(),
      cpuLevel: 1, efficiencyLevel: 1, boostLevel: 1,
      boostActiveUntil: null, boostCooldownUntil: null,
      ...data,
    };
    _upgrades.set(u.telegramId, u);
    return makeUpgradeMethods(u);
  },
};

function UpgradeConstructor(data) { return Upgrade.create(data); }
Object.assign(UpgradeConstructor, Upgrade);

const Transaction = {
  findOne: async (query) => [..._transactions.values()].find(t =>
    Object.entries(query).every(([k, v]) => t[k] === v)
  ) || null,

  find: (query = {}) => {
    // Return a chainable query builder (mimics Mongoose)
    let results = [..._transactions.values()].filter(t =>
      Object.entries(query).every(([k, v]) => t[k] === v)
    );
    const builder = {
      sort: (fields) => {
        const [field, dir] = Object.entries(fields)[0] || ['createdAt', -1];
        results = results.sort((a, b) => {
          const av = a[field], bv = b[field];
          return dir === -1 ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
        });
        return builder;
      },
      limit: (n) => {
        results = results.slice(0, n);
        return builder;
      },
      // Make it thenable so `await Transaction.find(...).sort(...).limit(...)` works
      then: (resolve) => resolve(results),
    };
    return builder;
  },

  create: (data) => {
    const t = { _id: genId(), status: 'pending', createdAt: new Date(), ...data };
    t.save = async () => { _transactions.set(t._id, t); return t; };
    _transactions.set(t._id, t);
    return t;
  },
};

function TransactionConstructor(data) { return Transaction.create(data); }
Object.assign(TransactionConstructor, Transaction);

module.exports = { User: UserConstructor, Session: SessionConstructor, Upgrade: UpgradeConstructor, Transaction: TransactionConstructor };
