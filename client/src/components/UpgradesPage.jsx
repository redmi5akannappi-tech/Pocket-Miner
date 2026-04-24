import React, { useState, useCallback } from 'react';
import { useUser } from '../context/UserContext';

const UPGRADES = [
  {
    type: 'cpu',
    name: 'CPU Processor',
    icon: '⚙️',
    description: 'Increases hash rate by 10% per level',
    color: 'green',
    effect: (lvl) => `+${(lvl - 1) * 10}% Hash Rate`,
    nextEffect: (lvl) => `+${lvl * 10}% Hash Rate`,
  },
  {
    type: 'efficiency',
    name: 'Cooling System',
    icon: '❄️',
    description: 'Reduces CPU heat penalty per level',
    color: 'blue',
    effect: (lvl) => `+${(lvl - 1) * 8}% Efficiency`,
    nextEffect: (lvl) => `+${lvl * 8}% Efficiency`,
  },
  {
    type: 'boost',
    name: 'Boost Core',
    icon: '🚀',
    description: 'Increases reward multiplier and boost duration',
    color: 'purple',
    effect: (lvl) => `${1 + (lvl - 1) * 0.05}x Multiplier`,
    nextEffect: (lvl) => `${1 + lvl * 0.05}x Multiplier`,
  },
];

const COLOR_MAP = {
  green:  { border: 'card-green',  badge: 'badge-green',  progress: 'green',  btn: 'btn-green' },
  blue:   { border: 'card-blue',   badge: 'badge-blue',   progress: 'blue',   btn: 'btn-purple' },
  purple: { border: 'card-purple', badge: 'badge-purple', progress: 'purple', btn: 'btn-purple' },
};

// Cost 500 * 1.6^(level-1)
function getUpgradeCost(type, currentLevel) {
  const base = { cpu: 500, efficiency: 300, boost: 800 };
  return Math.floor((base[type] || 500) * Math.pow(1.6, currentLevel - 1));
}

function LevelPips({ current, max = 10, color }) {
  return (
    <div className="level-pips">
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} className={`level-pip ${i < current ? 'filled' : ''}`}
          style={i < current ? { background: color === 'green' ? 'var(--grad-green)' : color === 'blue' ? 'linear-gradient(135deg, var(--neon-blue), var(--neon-purple))' : 'var(--grad-purple)' } : {}}
        />
      ))}
    </div>
  );
}

export default function UpgradesPage() {
  const { user, upgrade, buyUpgrade, activateBoost } = useUser();
  const [loading, setLoading] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleBuy = useCallback(async (type, cost) => {
    if (!user || user.totalPoints < cost) {
      showToast(`Need ${cost.toLocaleString()} pts! You have ${(user?.totalPoints || 0).toLocaleString()}`);
      return;
    }
    setLoading(l => ({ ...l, [type]: true }));
    try {
      const result = await buyUpgrade(type);
      showToast(`✅ ${type.toUpperCase()} upgraded to level ${result.newLevel}!`);
    } catch (e) {
      showToast(`❌ ${e.response?.data?.error || e.message}`);
    } finally {
      setLoading(l => ({ ...l, [type]: false }));
    }
  }, [user, buyUpgrade, showToast]);

  const handleBoost = useCallback(async () => {
    setLoading(l => ({ ...l, boost_activate: true }));
    try {
      const result = await activateBoost();
      showToast(`🚀 2x Boost active for ${result.durationMinutes} min!`);
    } catch (e) {
      showToast(`❌ ${e.response?.data?.error || e.message}`);
    } finally {
      setLoading(l => ({ ...l, boost_activate: false }));
    }
  }, [activateBoost, showToast]);

  const points = user?.totalPoints || 0;

  return (
    <div className="page-content animate-fade-in">
      {/* Toast */}
      {toast && <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>}

      {/* Header */}
      <div className="page-header">
        <h1 className="page-title" style={{ background: 'var(--grad-purple)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', filter: 'drop-shadow(0 0 8px rgba(191,90,242,0.4))' }}>
          🔧 Upgrades
        </h1>
        <div style={{ textAlign: 'right' }}>
          <span className="font-display" style={{ fontSize: '1.1rem', color: 'var(--neon-gold)' }}>
            💰 {points.toLocaleString()}
          </span>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Your Points</div>
        </div>
      </div>

      {/* Boost Activate Banner */}
      {upgrade && !upgrade.boostActive && !upgrade.boostCooldown && (
        <div className="card card-gold mb-16" style={{ textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--neon-gold)', marginBottom: 8 }}>
            ⚡ Activate 2x Boost
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 14 }}>
            Double your mining rewards for {5 + ((upgrade?.boostLevel || 1) - 1)} minutes!
          </p>
          <button
            className="btn btn-gold btn-full"
            onClick={handleBoost}
            disabled={loading.boost_activate}
          >
            {loading.boost_activate ? '⏳ Activating...' : '🚀 Activate Boost!'}
          </button>
        </div>
      )}

      {upgrade?.boostActive && (
        <div className="card mb-16" style={{ border: '1px solid rgba(255,215,0,0.5)', background: 'rgba(255,215,0,0.08)', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--neon-gold)' }}>
            🔥 2x Boost ACTIVE!
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 6 }}>
            Until: {new Date(upgrade.boostActiveUntil).toLocaleTimeString()}
          </div>
        </div>
      )}

      {/* Upgrade Cards */}
      {UPGRADES.map((upg) => {
        const levelField = `${upg.type}Level`;
        const currentLevel = upgrade?.[levelField] || 1;
        const isMaxed = currentLevel >= 10;
        const cost = isMaxed ? 0 : getUpgradeCost(upg.type, currentLevel);
        const canAfford = points >= cost;
        const colors = COLOR_MAP[upg.color];

        return (
          <div key={upg.type} className={`upgrade-card`} style={{ borderColor: upg.color === 'green' ? 'rgba(57,255,20,0.35)' : upg.color === 'blue' ? 'rgba(0,212,255,0.35)' : 'rgba(191,90,242,0.35)' }}>
            {/* Glow orb */}
            <div style={{
              position: 'absolute', top: -20, right: -20, width: 80, height: 80,
              borderRadius: '50%',
              background: upg.color === 'green' ? 'rgba(57,255,20,0.12)' : upg.color === 'blue' ? 'rgba(0,212,255,0.12)' : 'rgba(191,90,242,0.12)',
              filter: 'blur(16px)',
              pointerEvents: 'none'
            }} />

            <div className="upgrade-header">
              <div className="upgrade-info">
                <div className="upgrade-icon-wrap" style={{
                  background: upg.color === 'green' ? 'rgba(57,255,20,0.12)' : upg.color === 'blue' ? 'rgba(0,212,255,0.12)' : 'rgba(191,90,242,0.12)',
                  borderColor: upg.color === 'green' ? 'rgba(57,255,20,0.35)' : upg.color === 'blue' ? 'rgba(0,212,255,0.35)' : 'rgba(191,90,242,0.35)',
                }}>
                  {upg.icon}
                </div>
                <div>
                  <div className="upgrade-name">{upg.name}</div>
                  <div className="upgrade-level">{upg.description}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className={`badge ${colors.badge}`}>Lv {currentLevel}</span>
                {isMaxed && <div style={{ fontSize: '0.65rem', color: 'var(--neon-gold)', marginTop: 4 }}>MAX</div>}
              </div>
            </div>

            {/* Level pips */}
            <LevelPips current={currentLevel} max={10} color={upg.color} />

            {/* Current / Next effect */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '8px 12px' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Current</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{upg.effect(currentLevel)}</div>
              </div>
              {!isMaxed && (
                <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '8px 12px' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Next</div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9rem', color: upg.color === 'green' ? 'var(--neon-green)' : upg.color === 'blue' ? 'var(--neon-blue)' : 'var(--neon-purple)' }}>{upg.nextEffect(currentLevel)}</div>
                </div>
              )}
            </div>

            {/* Buy button */}
            {isMaxed ? (
              <div style={{ textAlign: 'center', padding: '12px', background: 'rgba(255,215,0,0.08)', borderRadius: 12, border: 'var(--border-gold)' }}>
                <span style={{ fontFamily: 'var(--font-display)', color: 'var(--neon-gold)' }}>👑 Fully Upgraded!</span>
              </div>
            ) : (
              <button
                className={`btn ${colors.btn} btn-full`}
                onClick={() => handleBuy(upg.type, cost)}
                disabled={loading[upg.type] || !canAfford}
              >
                {loading[upg.type] ? '⏳ Upgrading...' : (
                  canAfford ? `⬆️ Upgrade — ${cost.toLocaleString()} pts` : `🔒 Need ${cost.toLocaleString()} pts`
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
