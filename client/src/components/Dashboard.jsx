import React, { useState, useCallback } from 'react';
import { useUser } from '../context/UserContext';
import { useMiner } from '../hooks/useMiner';
import { useWebSocket } from '../hooks/useWebSocket';
import MinerTerminal from './MinerTerminal';
import { makeLog } from './MinerTerminal';

const MODE_INFO = {
  eco:      { label: 'Eco',      icon: '🌿', desc: '10–20% CPU', color: 'eco' },
  balanced: { label: 'Balanced', icon: '⚡', desc: '30–50% CPU', color: 'balanced' },
  turbo:    { label: 'Turbo',    icon: '🚀', desc: '60–80% CPU', color: 'turbo' },
};

function formatHashrate(h) {
  if (h >= 1_000_000) return `${(h / 1_000_000).toFixed(2)} MH/s`;
  if (h >= 1_000)     return `${(h / 1_000).toFixed(1)} KH/s`;
  return `${h} H/s`;
}

function formatBalance(n) {
  return (n || 0).toFixed(8);
}

export default function Dashboard() {
  const { user, upgrade, loading } = useUser();
  const {
    isMining, mode, hashrate, cpuPercent, sessionShares,
    sessionId, error, logs, wasmLoaded,
    startMining, stopMining, changeMode, receiveNewJob,
  } = useMiner();

  const [showWarning, setShowWarning]   = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [wsLogs, setWsLogs]            = useState([]);

  // Merge worker logs + WS logs into one stream
  const allLogs = [...logs, ...wsLogs].sort((a, b) => (a.ts > b.ts ? 1 : -1));

  const handleWsLog = useCallback((tag, msg) => {
    setWsLogs(prev => {
      const next = [...prev, makeLog(tag, msg)];
      return next.length > 80 ? next.slice(-80) : next;
    });
  }, []);

  const { status: wsStatus } = useWebSocket({
    telegramId: user?.telegramId,
    sessionId: sessionId || 'pending',
    onJob: receiveNewJob,
    onLog: handleWsLog,
    enabled: isMining,
  });

  const handleMineToggle = useCallback(async () => {
    if (isMining) {
      await stopMining();
    } else {
      if (mode === 'turbo' && !showWarning) {
        setShowWarning(true);
        return;
      }
      setShowWarning(false);
      setWsLogs([]);
      await startMining(mode);
    }
  }, [isMining, mode, showWarning, startMining, stopMining]);

  const handleModeChange = (m) => {
    if (!isMining) { changeMode(m); setShowWarning(false); }
  };

  const estPointsPerMin = upgrade ? Math.floor(
    { eco: 2, balanced: 5, turbo: 10 }[mode] * 10 * (upgrade.rewardMultiplier || 1)
  ) : 0;

  if (loading) {
    return (
      <div className="page-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" />
          <p className="text-muted" style={{ marginTop: 12 }}>Loading your rig...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content animate-fade-in">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">⛏️ Pocket Miner</h1>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
            GM, <span style={{ color: 'var(--neon-green)', fontWeight: 800 }}>{user?.username || user?.firstName || 'Miner'}</span>
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${isMining ? 'badge-red' : 'badge-green'}`}>
            {isMining ? '🔴 Mining' : '🟢 Ready'}
          </span>
          {isMining && (
            <div style={{ fontSize: '0.65rem', marginTop: 4 }}>
              <span style={{ color: wasmLoaded ? 'var(--neon-green)' : 'var(--neon-orange)' }}>
                {wasmLoaded ? '⚡ WASM · Real Hash' : '⚙️ JS Stub · Demo'}
              </span>
            </div>
          )}
          {wsStatus === 'connected' && (
            <div style={{ fontSize: '0.65rem', color: 'var(--neon-blue)', marginTop: 2 }}>⚡ Pool Live</div>
          )}
        </div>
      </div>

      {/* ── Mining Rig Visual ── */}
      <div className="rig-visual mb-16">
        <span className={`rig-emoji ${isMining ? 'mining-anim' : ''}`}>
          {isMining ? '⚙️' : '🖥️'}
        </span>
        {isMining && (
          <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--neon-orange)', fontWeight: 700 }}>
            ≋ Hashing on verushash...
          </div>
        )}
      </div>

      {/* ── Big Mine Button ── */}
      <div className="mine-btn-wrap">
        <button
          className={`mine-btn ${isMining ? 'mining' : 'idle'}`}
          onClick={handleMineToggle}
        >
          <span className="mine-btn-icon">{isMining ? '⏹' : '▶'}</span>
          <span className="mine-btn-label">{isMining ? 'STOP' : 'MINE'}</span>
        </button>
      </div>

      {/* ── Turbo Warning ── */}
      {showWarning && !isMining && (
        <div className="card mb-16" style={{ border: '1px solid rgba(255,68,102,0.4)', background: 'rgba(255,68,102,0.07)', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>🌡️</div>
          <p style={{ fontWeight: 800, color: 'var(--neon-red)', marginBottom: 6 }}>Turbo Mode Warning</p>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 14 }}>60–80% CPU — may heat device. Use responsibly.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline btn-full btn-sm" onClick={() => setShowWarning(false)}>Cancel</button>
            <button className="btn btn-red btn-full btn-sm" onClick={() => { setShowWarning(false); startMining('turbo'); }}>Proceed</button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="card mb-16" style={{ border: '1px solid rgba(255,68,102,0.3)' }}>
          <p style={{ color: 'var(--neon-red)', fontSize: '0.85rem', textAlign: 'center' }}>⚠️ {error}</p>
        </div>
      )}

      {/* ── Mode Selector ── */}
      <div className="section-label">Mining Mode</div>
      <div className="mode-selector mb-16">
        {Object.entries(MODE_INFO).map(([m, info]) => (
          <button
            key={m}
            className={`mode-btn ${mode === m ? `active ${info.color}` : ''}`}
            onClick={() => handleModeChange(m)}
            disabled={isMining}
          >
            <span className="mode-btn-icon">{info.icon}</span>
            <span className="mode-btn-name">{info.label}</span>
            <span className="mode-btn-desc">{info.desc}</span>
          </button>
        ))}
      </div>

      {/* ── Live Stats ── */}
      <div className="section-label">Live Stats</div>
      <div className="stats-grid mb-16">
        <div className="stat-card green">
          <span className="stat-icon">⚡</span>
          <span className="stat-value">{formatHashrate(hashrate)}</span>
          <span className="stat-label">Hash Rate</span>
        </div>
        <div className="stat-card blue">
          <span className="stat-icon">🖥️</span>
          <span className="stat-value">{isMining ? `${cpuPercent}%` : '—'}</span>
          <span className="stat-label">CPU Usage</span>
        </div>
        <div className="stat-card gold">
          <span className="stat-icon">💎</span>
          <span className="stat-value">{sessionShares}</span>
          <span className="stat-label">Shares</span>
        </div>
        <div className="stat-card purple">
          <span className="stat-icon">🏆</span>
          <span className="stat-value">{(user?.totalPoints || 0).toLocaleString()}</span>
          <span className="stat-label">Points</span>
        </div>
      </div>

      {/* ── Mining Terminal ── */}
      <div className="section-label">Mining Terminal</div>
      <MinerTerminal
        logs={allLogs}
        isOpen={terminalOpen}
        onToggle={() => setTerminalOpen(v => !v)}
      />

      {/* ── Balance Card ── */}
      <div className="section-label">Balance</div>
      <div className="card card-gold mb-16">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Pending Balance</span>
          <span className="badge badge-gold animate-coin">💰</span>
        </div>
        <span className="balance-big">{formatBalance(user?.pendingBalance)}</span>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
          Total earned: {formatBalance(user?.totalEarned)}
        </p>
        {isMining && (
          <div style={{ marginTop: 12, padding: '8px 14px', background: 'rgba(57,255,20,0.08)', borderRadius: 10, textAlign: 'center' }}>
            <span style={{ color: 'var(--neon-green)', fontSize: '0.8rem', fontWeight: 700 }}>
              +~{estPointsPerMin} pts/min est.
            </span>
          </div>
        )}
      </div>

      {/* ── Transparency ── */}
      <div className="section-label">Transparency</div>
      <div className="card mb-16" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        {[
          { label: 'Mining is opt-in',  value: 'You control start/stop', icon: '✅' },
          { label: 'CPU Usage',          value: isMining ? `~${cpuPercent}%` : 'Idle', icon: '🖥️' },
          { label: 'Algorithm',          value: 'verushash (VerusCoin)', icon: '⛓️' },
          { label: 'Pool',               value: 'ap.luckpool.net:3956', icon: '🌐' },
        ].map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ fontSize: '1.1rem' }}>{item.icon}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{item.label}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{item.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Streak ── */}
      {user?.streak > 0 && (
        <div className="streak-display mb-16">
          <span className="streak-flame">🔥</span>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--neon-orange)' }}>
              {user.streak} Day Streak!
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Longest: {user.longestStreak} days
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
