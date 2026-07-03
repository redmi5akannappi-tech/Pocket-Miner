import React, { useState, useCallback } from 'react';
import {
  Play, Square, Leaf, Zap, Rocket, Flame, Cpu, Gem, Trophy,
  Activity, Gauge, Coins, ShieldCheck, Link2, Globe,
} from 'lucide-react';
import { useUser } from '../context/UserContext';
import { useMiner } from '../hooks/useMiner';
import { useWebSocket } from '../hooks/useWebSocket';
import MinerTerminal from './MinerTerminal';
import { makeLog } from './MinerTerminal';

const MODE_INFO = {
  eco:      { label: 'Eco',      Icon: Leaf,   desc: '10–20% CPU', color: 'eco' },
  balanced: { label: 'Balanced', Icon: Zap,    desc: '30–50% CPU', color: 'balanced' },
  turbo:    { label: 'Turbo',    Icon: Rocket, desc: '60–80% CPU', color: 'turbo' },
  monster:  { label: 'Monster',  Icon: Flame,  desc: '100% CPU',   color: 'red' },
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
    sessionId, error, logs, wasmLoaded, setWsSendShare, threadCount,
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

  const { status: wsStatus, sendShare } = useWebSocket({
    telegramId: user?.telegramId,
    sessionId: sessionId || 'pending',
    onJob: receiveNewJob,
    onLog: handleWsLog,
    enabled: isMining,
  });

  // Wire WebSocket sendShare into useMiner so shares reach the pool
  React.useEffect(() => {
    setWsSendShare(sendShare);
  }, [sendShare, setWsSendShare]);

  const handleMineToggle = useCallback(async () => {
    if (isMining) {
      await stopMining();
    } else {
      if ((mode === 'turbo' || mode === 'monster') && !showWarning) {
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
    { eco: 2, balanced: 5, turbo: 10, monster: 20 }[mode] * 10 * (upgrade.rewardMultiplier || 1)
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
          <h1 className="page-title">Pocket Miner</h1>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
            GM, <span style={{ color: 'var(--neon-green)', fontWeight: 800 }}>{user?.username || user?.firstName || 'Miner'}</span>
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${isMining ? 'badge-red' : 'badge-green'}`}>
            <span className={`status-dot ${isMining ? 'live' : 'ready'}`} />
            {isMining ? 'Mining' : 'Ready'}
          </span>
          {isMining && (
            <div style={{ fontSize: '0.65rem', marginTop: 5, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ color: wasmLoaded ? 'var(--neon-green)' : 'var(--neon-orange)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Zap size={11} /> {wasmLoaded ? 'WASM' : 'JS Stub'}
              </span>
              <span style={{ color: 'var(--neon-purple)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Cpu size={11} /> {threadCount}t
              </span>
            </div>
          )}
          {wsStatus === 'connected' && (
            <div style={{ fontSize: '0.65rem', color: 'var(--neon-blue)', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Activity size={11} /> Pool Live
            </div>
          )}
        </div>
      </div>

      {/* ── Big Mine Button ── */}
      <div className="mine-btn-wrap">
        <button
          className={`mine-btn ${isMining ? 'mining' : 'idle'}`}
          onClick={handleMineToggle}
          aria-label={isMining ? 'Stop mining' : 'Start mining'}
        >
          <span className="mine-btn-ring" aria-hidden="true" />
          <span className="mine-btn-icon">
            {isMining ? <Square size={30} fill="currentColor" /> : <Play size={34} fill="currentColor" />}
          </span>
          <span className="mine-btn-label">{isMining ? 'STOP' : 'MINE'}</span>
          {isMining && <span className="mine-btn-sub">{formatHashrate(hashrate)}</span>}
        </button>
      </div>

      {/* ── Turbo Warning ── */}
      {showWarning && !isMining && (
        <div className="card mb-16" style={{ border: '1px solid rgba(255,92,114,0.4)', background: 'rgba(255,92,114,0.07)', textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: 'var(--neon-red)' }}><Flame size={26} /></div>
          <p style={{ fontWeight: 800, color: 'var(--neon-red)', marginBottom: 6 }}>Performance Warning</p>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 14 }}>{mode === 'monster' ? '100% CPU — will heat device. Use responsibly.' : '60–80% CPU — may heat device. Use responsibly.'}</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline btn-full btn-sm" onClick={() => setShowWarning(false)}>Cancel</button>
            <button className="btn btn-red btn-full btn-sm" onClick={() => { setShowWarning(false); startMining(mode); }}>Proceed</button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="card mb-16" style={{ border: '1px solid rgba(255,92,114,0.3)' }}>
          <p style={{ color: 'var(--neon-red)', fontSize: '0.85rem', textAlign: 'center' }}>⚠ {error}</p>
        </div>
      )}

      {/* ── Mode Selector ── */}
      <div className="section-label">Mining Mode</div>
      <div className="mode-selector mb-16">
        {Object.entries(MODE_INFO).map(([m, info]) => {
          const ModeIcon = info.Icon;
          return (
            <button
              key={m}
              className={`mode-btn ${mode === m ? `active ${info.color}` : ''}`}
              onClick={() => handleModeChange(m)}
              disabled={isMining}
            >
              <span className="mode-btn-icon"><ModeIcon size={20} /></span>
              <span className="mode-btn-name">{info.label}</span>
              <span className="mode-btn-desc">{info.desc}</span>
            </button>
          );
        })}
      </div>

      {/* ── Live Stats ── */}
      <div className="section-label">Live Stats</div>
      <div className="stats-grid mb-16">
        <div className="stat-card green">
          <span className="stat-icon"><Activity size={20} /></span>
          <span className="stat-value">{formatHashrate(hashrate)}</span>
          <span className="stat-label">Hash Rate</span>
        </div>
        <div className="stat-card blue">
          <span className="stat-icon"><Gauge size={20} /></span>
          <span className="stat-value">{isMining ? `${cpuPercent}%` : '—'}</span>
          <span className="stat-label">CPU Usage</span>
        </div>
        <div className="stat-card gold">
          <span className="stat-icon"><Gem size={20} /></span>
          <span className="stat-value">{sessionShares}</span>
          <span className="stat-label">Shares</span>
        </div>
        <div className="stat-card purple">
          <span className="stat-icon"><Trophy size={20} /></span>
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
          <span className="badge badge-gold"><Coins size={13} /></span>
        </div>
        <span className="balance-big">{formatBalance(user?.pendingBalance)}</span>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
          Total earned: {formatBalance(user?.totalEarned)}
        </p>
        {isMining && (
          <div style={{ marginTop: 12, padding: '8px 14px', background: 'rgba(47,224,160,0.08)', borderRadius: 10, textAlign: 'center' }}>
            <span style={{ color: 'var(--neon-green)', fontSize: '0.8rem', fontWeight: 700 }}>
              +~{estPointsPerMin} pts/min est.
            </span>
          </div>
        )}
      </div>

      {/* ── Transparency ── */}
      <div className="section-label">Transparency</div>
      <div className="card mb-16" style={{ border: 'var(--hairline)' }}>
        {[
          { label: 'Mining is opt-in',  value: 'You control start/stop', Icon: ShieldCheck },
          { label: 'CPU Usage',          value: isMining ? `~${cpuPercent}%` : 'Idle', Icon: Gauge },
          { label: 'Algorithm',          value: 'verushash (VerusCoin)', Icon: Link2 },
          { label: 'Pool',               value: 'ap.luckpool.net:3956', Icon: Globe },
        ].map((item, i, arr) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: i < arr.length - 1 ? 12 : 0 }}>
            <span style={{ color: 'var(--neon-green)', display: 'inline-flex', flexShrink: 0 }}><item.Icon size={18} /></span>
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
          <span className="streak-flame"><Flame size={26} /></span>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--neon-orange)', fontWeight: 800 }}>
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
