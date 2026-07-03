import React, { useState, useCallback } from 'react';
import { useUser } from '../context/UserContext';

const MIN_WITHDRAWAL = 0.001;

function formatBalance(n) {
  return (n || 0).toFixed(8);
}

export default function RewardsPage() {
  const { user, recentTransactions, requestWithdraw } = useUser();
  const [walletAddress, setWalletAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleWithdraw = useCallback(async () => {
    const amtNum = parseFloat(amount);
    if (!amtNum || amtNum < MIN_WITHDRAWAL) {
      showToast(`Minimum withdrawal: ${MIN_WITHDRAWAL}`);
      return;
    }
    if (!walletAddress.trim()) {
      showToast('Enter your wallet address');
      return;
    }

    setLoading(true);
    try {
      const result = await requestWithdraw(amtNum, walletAddress);
      showToast(`✅ Withdrawal request submitted!`);
      setShowWithdrawForm(false);
      setAmount('');
      setWalletAddress('');
    } catch (e) {
      showToast(`❌ ${e.response?.data?.error || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [amount, walletAddress, requestWithdraw, showToast]);

  const pendingBalance = user?.pendingBalance || 0;
  const totalEarned = user?.totalEarned || 0;
  const canWithdraw = pendingBalance >= MIN_WITHDRAWAL;

  const STATUS_COLOR = {
    pending:   { bg: 'rgba(255,140,0,0.12)', color: 'var(--neon-orange)', label: '⏳ Pending' },
    approved:  { bg: 'rgba(57,255,20,0.12)', color: 'var(--neon-green)', label: '✅ Approved' },
    rejected:  { bg: 'rgba(255,68,102,0.12)', color: 'var(--neon-red)', label: '❌ Rejected' },
    completed: { bg: 'rgba(0,212,255,0.12)', color: 'var(--neon-blue)', label: '💎 Completed' },
  };

  return (
    <div className="page-content animate-fade-in">
      {toast && <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>}

      <div className="page-header">
        <h1 className="page-title" style={{ background: 'var(--grad-gold)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', filter: 'drop-shadow(0 0 8px rgba(255,215,0,0.4))' }}>
          💰 Rewards
        </h1>
      </div>

      {/* Balance Cards */}
      <div className="card card-gold mb-16">
        <div className="text-center mb-8">
          <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', fontWeight: 800 }}>
            Pending Balance
          </span>
        </div>
        <span className="balance-big">{formatBalance(pendingBalance)}</span>
        <p className="text-center text-muted text-xs mb-16">≈ XMR (estimated)</p>

        {canWithdraw ? (
          <button className="btn btn-gold btn-full" onClick={() => setShowWithdrawForm(v => !v)}>
            {showWithdrawForm ? '✕ Cancel' : '💸 Withdraw Funds'}
          </button>
        ) : (
          <div style={{ textAlign: 'center', padding: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Minimum {MIN_WITHDRAWAL} required to withdraw
            </p>
            <div className="progress-wrap" style={{ marginTop: 10 }}>
              <div
                className="progress-bar gold"
                style={{ width: `${Math.min((pendingBalance / MIN_WITHDRAWAL) * 100, 100)}%` }}
              />
            </div>
            <p style={{ color: 'var(--neon-gold)', fontSize: '0.72rem', marginTop: 6 }}>
              {((pendingBalance / MIN_WITHDRAWAL) * 100).toFixed(1)}% of threshold
            </p>
          </div>
        )}
      </div>

      {/* Withdraw Form */}
      {showWithdrawForm && (
        <div className="card card-green mb-16 animate-fade-in">
          <p style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', marginBottom: 14, color: 'var(--neon-green)' }}>
            💸 Withdrawal Request
          </p>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, display: 'block', marginBottom: 6 }}>
              WALLET ADDRESS
            </label>
            <input
              type="text"
              value={walletAddress}
              onChange={e => setWalletAddress(e.target.value)}
              placeholder="Enter your wallet address..."
              style={{
                width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 12, padding: '12px 14px', color: 'var(--text-primary)', fontSize: '0.85rem',
                fontFamily: 'var(--font-body)', outline: 'none',
              }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, display: 'block', marginBottom: 6 }}>
              AMOUNT (max: {formatBalance(pendingBalance)})
            </label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder={`Min: ${MIN_WITHDRAWAL}`}
              min={MIN_WITHDRAWAL}
              max={pendingBalance}
              step="0.00000001"
              style={{
                width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 12, padding: '12px 14px', color: 'var(--text-primary)', fontSize: '0.85rem',
                fontFamily: 'var(--font-body)', outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline btn-full btn-sm" onClick={() => setAmount(formatBalance(pendingBalance))}>Max</button>
            <button className="btn btn-green btn-full" onClick={handleWithdraw} disabled={loading}>
              {loading ? '⏳ Submitting...' : '✅ Confirm'}
            </button>
          </div>
          <p style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            ⓘ Withdrawals are manually reviewed within 24–48 hours
          </p>
        </div>
      )}

      {/* Stats Row */}
      <div className="stats-grid mb-16">
        <div className="stat-card gold">
          <span className="stat-icon">📊</span>
          <span className="stat-value">{formatBalance(totalEarned)}</span>
          <span className="stat-label">Total Earned</span>
        </div>
        <div className="stat-card purple">
          <span className="stat-icon">🏆</span>
          <span className="stat-value">{(user?.totalPoints || 0).toLocaleString()}</span>
          <span className="stat-label">Total Points</span>
        </div>
        <div className="stat-card green">
          <span className="stat-icon">💎</span>
          <span className="stat-value">{user?.totalValidShares || 0}</span>
          <span className="stat-label">Valid Shares</span>
        </div>
        <div className="stat-card blue">
          <span className="stat-icon">⏱️</span>
          <span className="stat-value">{user?.totalMiningMinutes || 0}</span>
          <span className="stat-label">Mined (min)</span>
        </div>
      </div>

      {/* Transaction History */}
      <div className="section-label mb-12">Transaction History</div>
      {recentTransactions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>📭</div>
          <p style={{ fontSize: '0.85rem' }}>No transactions yet. Start mining!</p>
        </div>
      ) : (
        recentTransactions.map(tx => {
          const s = STATUS_COLOR[tx.status] || STATUS_COLOR.pending;
          return (
            <div key={tx._id} style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
              background: s.bg, borderRadius: 'var(--radius-md)', marginBottom: 10,
              border: `1px solid ${s.color}33`,
            }}>
              <span style={{ fontSize: '1.4rem' }}>
                {tx.type === 'withdrawal' ? '💸' : tx.type === 'mining' ? '⛏️' : '🎁'}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)', textTransform: 'capitalize' }}>{tx.type}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{new Date(tx.createdAt).toLocaleDateString()}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-display)', color: tx.type === 'withdrawal' ? 'var(--neon-red)' : 'var(--neon-green)', fontSize: '0.9rem' }}>
                  {tx.type === 'withdrawal' ? '-' : '+'}{tx.amount.toFixed(8)}
                </div>
                <div style={{ fontSize: '0.65rem', color: s.color }}>{s.label}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
