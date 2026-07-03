import React, { useState, useCallback } from 'react';
import { Timer, Zap, Rocket, Coins, Flame, Gift, CircleCheck, Sprout, Crown, PartyPopper } from 'lucide-react';
import { useUser } from '../context/UserContext';
import { api } from '../context/UserContext';

const MISSIONS = [
  { id: 'mine_5_mins',    Icon: Timer,  title: 'Warm Up',        desc: 'Mine for 5 minutes',           field: 'mineMins',    target: 5,    reward: 150 },
  { id: 'mine_15_mins',   Icon: Zap,    title: 'Power Session',   desc: 'Mine for 15 minutes',          field: 'mineMins',    target: 15,   reward: 500 },
  { id: 'use_turbo',      Icon: Rocket, title: 'Turbo Time',      desc: 'Use Turbo mode once',          field: 'turboUsed',   target: 1,    reward: 200 },
  { id: 'earn_100_points',Icon: Coins,  title: 'Point Collector', desc: 'Earn 100 points today',        field: 'pointsEarned',target: 100,  reward: 300 },
];

const STREAK_ICONS = { 3: Sprout, 7: Zap, 14: Flame, 30: Crown };

export default function MissionsPage() {
  const { user, fetchStats } = useUser();
  const [claiming, setClaiming] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const progress = user?.missionsProgress || {};
  const missionsClaimed = progress.missionsClaimed || false;

  const getMissionProgress = (mission) => {
    if (mission.field === 'turboUsed') return progress.turboUsed ? 1 : 0;
    return progress[mission.field] || 0;
  };

  const completedCount = MISSIONS.filter(m => getMissionProgress(m) >= m.target).length;
  const totalReward = MISSIONS.filter(m => getMissionProgress(m) >= m.target).reduce((sum, m) => sum + m.reward, 0);

  const handleClaim = useCallback(async () => {
    if (missionsClaimed || completedCount === 0) return;
    setClaiming(true);
    try {
      const { data } = await api.post('/user/claim-missions');
      await fetchStats();
      showToast(`🎉 Claimed ${data.pointsAwarded.toLocaleString()} points!`);
    } catch (e) {
      showToast(`❌ ${e.response?.data?.error || e.message}`);
    } finally {
      setClaiming(false);
    }
  }, [missionsClaimed, completedCount, fetchStats, showToast]);

  return (
    <div className="page-content animate-fade-in">
      {toast && <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>}

      <div className="page-header">
        <h1 className="page-title page-title-gold">Missions</h1>
        <span className="badge badge-gold">{completedCount}/{MISSIONS.length} Done</span>
      </div>

      {/* Streak Display */}
      {user?.streak > 0 && (
        <div className="streak-display mb-16">
          <span className="streak-flame"><Flame size={26} /></span>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--neon-orange)' }}>
              {user.streak}-Day Streak
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Keep it going for bonus multipliers!
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', color: 'var(--neon-gold)' }}>
              {user.streak >= 30 ? '2x' : user.streak >= 14 ? '1.75x' : user.streak >= 7 ? '1.5x' : user.streak >= 3 ? '1.25x' : '1x'}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Bonus</div>
          </div>
        </div>
      )}

      {/* Claim Banner */}
      {completedCount > 0 && !missionsClaimed && (
        <div className="card card-green mb-16" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: 'var(--neon-green)' }}><PartyPopper size={26} /></div>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--neon-green)', marginBottom: 6, fontWeight: 800 }}>
            {completedCount} Mission{completedCount > 1 ? 's' : ''} Complete!
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: 14 }}>
            Claim your {totalReward.toLocaleString()} pts reward
          </p>
          <button className="btn btn-green btn-full" onClick={handleClaim} disabled={claiming}>
            {claiming ? 'Claiming...' : <><Gift size={17} /> Claim {totalReward.toLocaleString()} Points</>}
          </button>
        </div>
      )}

      {missionsClaimed && (
        <div className="card mb-16" style={{ border: 'var(--border-gold)', background: 'rgba(245,196,81,0.06)', textAlign: 'center' }}>
          <span style={{ fontFamily: 'var(--font-display)', color: 'var(--neon-gold)', fontSize: '1rem', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 800 }}>
            <CircleCheck size={18} /> Daily missions claimed! Come back tomorrow.
          </span>
        </div>
      )}

      {/* Mission List */}
      <div className="section-label mb-12">Daily Missions</div>
      {MISSIONS.map((mission) => {
        const current = getMissionProgress(mission);
        const pct = Math.min((current / mission.target) * 100, 100);
        const done = pct >= 100;

        return (
          <div key={mission.id} className={`mission-item ${done ? 'completed' : ''}`}>
            <div className="mission-header">
              <div className="mission-icon-wrap" style={done ? { background: 'rgba(47,224,160,0.14)', borderColor: 'rgba(47,224,160,0.35)', color: 'var(--neon-green)' } : undefined}>
                <mission.Icon size={20} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="mission-title">{mission.title}</div>
                <div className="mission-desc">{mission.desc}</div>
              </div>
              <div className="mission-reward">
                {done ? <CircleCheck size={20} style={{ color: 'var(--neon-green)' }} /> : `+${mission.reward}`}
                {!done && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block' }}>pts</span>}
              </div>
            </div>

            {/* Progress bar */}
            {!done && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {mission.field === 'turboUsed' ? (current ? 'Done!' : 'Not yet') : `${current} / ${mission.target} ${mission.field === 'mineMins' ? 'min' : 'pts'}`}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--neon-gold)', fontWeight: 700 }}>{Math.round(pct)}%</span>
                </div>
                <div className="progress-wrap">
                  <div className="progress-bar gold" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}

            {done && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <div style={{ flex: 1, height: 6, background: 'var(--grad-green)', borderRadius: 100, boxShadow: '0 0 8px rgba(57,255,20,0.5)' }} />
                <span style={{ fontSize: '0.72rem', color: 'var(--neon-green)', fontWeight: 800 }}>COMPLETE</span>
              </div>
            )}
          </div>
        );
      })}

      {/* Streak milestones */}
      <div className="section-label mt-16 mb-12">Streak Milestones</div>
      <div className="card" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { days: 3,  bonus: '1.25x', Icon: Sprout },
          { days: 7,  bonus: '1.5x',  Icon: Zap },
          { days: 14, bonus: '1.75x', Icon: Flame },
          { days: 30, bonus: '2x',    Icon: Crown },
        ].map((milestone, i) => {
          const reached = (user?.streak || 0) >= milestone.days;
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '12px 0',
              borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none',
              opacity: reached ? 1 : 0.5,
            }}>
              <span style={{ display: 'inline-flex', color: reached ? 'var(--neon-gold)' : 'var(--text-muted)' }}><milestone.Icon size={22} /></span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: '0.85rem' }}>{milestone.days}-Day Streak</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{milestone.bonus} reward multiplier</div>
              </div>
              {reached
                ? <span className="badge badge-green">Unlocked!</span>
                : <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{milestone.days - (user?.streak || 0)} days left</span>
              }
            </div>
          );
        })}
      </div>
    </div>
  );
}
