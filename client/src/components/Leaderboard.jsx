import React, { useState, useEffect } from 'react';
import { useUser } from '../context/UserContext';
import { api } from '../context/UserContext';

const MEDALS = ['🥇', '🥈', '🥉'];

export default function Leaderboard() {
  const { user } = useUser();
  const [leaderboard, setLeaderboard] = useState([]);
  const [currentUserRank, setCurrentUserRank] = useState(null);
  const [totalMiners, setTotalMiners] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        const { data } = await api.get('/leaderboard?limit=50');
        setLeaderboard(data.leaderboard);
        setCurrentUserRank(data.currentUserRank);
        setTotalMiners(data.totalMiners);
      } catch (e) {
        console.error('Leaderboard fetch failed:', e.message);
      } finally {
        setLoading(false);
      }
    };
    fetchLeaderboard();
  }, []);

  const getRankClass = (rank) => {
    if (rank === 1) return 'gold-rank';
    if (rank === 2) return 'silver-rank';
    if (rank === 3) return 'bronze-rank';
    return '';
  };

  const getInitial = (name) => (name || '?').charAt(0).toUpperCase();

  return (
    <div className="page-content animate-fade-in">
      <div className="page-header">
        <h1 className="page-title" style={{ background: 'linear-gradient(135deg, var(--neon-gold), var(--neon-orange))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', filter: 'drop-shadow(0 0 8px rgba(255,215,0,0.4))' }}>
          🏆 Leaderboard
        </h1>
        <div style={{ textAlign: 'right' }}>
          <span className="badge badge-blue">{totalMiners.toLocaleString()} Miners</span>
        </div>
      </div>

      {/* My Rank Banner */}
      {currentUserRank && (
        <div className="card mb-16" style={{ border: 'var(--border-green)', background: 'rgba(57,255,20,0.06)', textAlign: 'center' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Your Rank</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '2.5rem', color: 'var(--neon-green)', filter: 'drop-shadow(0 0 12px rgba(57,255,20,0.5))' }}>
            #{currentUserRank}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 4 }}>
            out of {totalMiners.toLocaleString()} miners
          </div>
          <div style={{ marginTop: 10 }}>
            <span className="badge badge-gold">💰 {(user?.totalPoints || 0).toLocaleString()} pts</span>
          </div>
        </div>
      )}

      {/* Top 3 Podium */}
      {leaderboard.length >= 3 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'flex-end', justifyContent: 'center' }}>
          {/* 2nd */}
          <div style={{ flex: 1, textAlign: 'center', marginBottom: 0 }}>
            <div style={{ background: 'rgba(192,192,192,0.1)', border: '1px solid rgba(192,192,192,0.35)', borderRadius: 'var(--radius-md)', padding: '14px 8px' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: 4 }}>🥈</div>
              <div className="leaderboard-avatar" style={{ margin: '0 auto 8px', background: 'linear-gradient(135deg, #b8b8b8, #888)' }}>
                {getInitial(leaderboard[1].username)}
              </div>
              <div style={{ fontWeight: 800, fontSize: '0.78rem', color: '#c0c0c0' }}>{leaderboard[1].username}</div>
              <div style={{ fontFamily: 'var(--font-display)', color: '#c0c0c0', fontSize: '0.85rem', marginTop: 4 }}>
                {leaderboard[1].totalPoints.toLocaleString()}
              </div>
            </div>
          </div>
          {/* 1st */}
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ background: 'rgba(255,215,0,0.1)', border: '1px solid rgba(255,215,0,0.4)', borderRadius: 'var(--radius-md)', padding: '18px 8px', boxShadow: 'var(--glow-gold)' }}>
              <div style={{ fontSize: '2.2rem', marginBottom: 6, animation: 'coinBounce 2s ease-in-out infinite' }}>👑</div>
              <div className="leaderboard-avatar" style={{ margin: '0 auto 8px', background: 'linear-gradient(135deg, #ffd700, #ff8c00)', width: 48, height: 48, fontSize: '1.2rem' }}>
                {getInitial(leaderboard[0].username)}
              </div>
              <div style={{ fontWeight: 800, fontSize: '0.82rem', color: 'var(--neon-gold)' }}>{leaderboard[0].username}</div>
              <div style={{ fontFamily: 'var(--font-display)', color: 'var(--neon-gold)', fontSize: '0.9rem', marginTop: 4 }}>
                {leaderboard[0].totalPoints.toLocaleString()}
              </div>
            </div>
          </div>
          {/* 3rd */}
          <div style={{ flex: 1, textAlign: 'center', marginBottom: 0 }}>
            <div style={{ background: 'rgba(205,127,50,0.1)', border: '1px solid rgba(205,127,50,0.35)', borderRadius: 'var(--radius-md)', padding: '14px 8px' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: 4 }}>🥉</div>
              <div className="leaderboard-avatar" style={{ margin: '0 auto 8px', background: 'linear-gradient(135deg, #cd7f32, #9b5e20)' }}>
                {getInitial(leaderboard[2].username)}
              </div>
              <div style={{ fontWeight: 800, fontSize: '0.78rem', color: '#cd7f32' }}>{leaderboard[2].username}</div>
              <div style={{ fontFamily: 'var(--font-display)', color: '#cd7f32', fontSize: '0.85rem', marginTop: 4 }}>
                {leaderboard[2].totalPoints.toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full List */}
      <div className="section-label mb-12">All Rankings</div>
      {loading ? (
        <div className="spinner" />
      ) : leaderboard.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>⛏️</div>
          <p>Be the first miner! Start mining to appear here.</p>
        </div>
      ) : (
        leaderboard.map((miner) => (
          <div
            key={miner.telegramId}
            className={`leaderboard-item ${miner.isCurrentUser ? 'you' : ''} ${getRankClass(miner.rank)}`}
          >
            <div className={`rank-badge rank-${miner.rank}`}>
              {miner.rank <= 3 ? MEDALS[miner.rank - 1] : `#${miner.rank}`}
            </div>
            <div
              className="leaderboard-avatar"
              style={miner.rank === 1 ? { background: 'linear-gradient(135deg, #ffd700, #ff8c00)' } : {}}
            >
              {getInitial(miner.username)}
            </div>
            <div style={{ flex: 1 }}>
              <div className="leaderboard-name">
                {miner.username}
                {miner.isCurrentUser && <span className="badge badge-green" style={{ marginLeft: 8, fontSize: '0.6rem' }}>You</span>}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', gap: 10, marginTop: 2 }}>
                <span>🔥 {miner.streak}d</span>
                <span>⏱️ {miner.totalMiningMinutes}min</span>
              </div>
            </div>
            <div className="leaderboard-points">
              {miner.totalPoints.toLocaleString()}
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'right' }}>pts</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
