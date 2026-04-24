/**
 * Gamification Engine
 * Manages daily missions, streak bonuses, and mission tracking
 */

// Daily mission definitions
const DAILY_MISSIONS = [
  {
    id: 'mine_5_mins',
    title: 'Warm Up',
    description: 'Mine for 5 minutes',
    icon: '⏱️',
    target: 5,
    unit: 'minutes',
    reward: 150,
    field: 'mineMins',
  },
  {
    id: 'mine_15_mins',
    title: 'Power Session',
    description: 'Mine for 15 minutes',
    icon: '⚡',
    target: 15,
    unit: 'minutes',
    reward: 500,
    field: 'mineMins',
  },
  {
    id: 'use_turbo',
    title: 'Turbo Time',
    description: 'Use Turbo mode at least once',
    icon: '🚀',
    target: 1,
    unit: 'times',
    reward: 200,
    field: 'turboUsed',
  },
  {
    id: 'earn_100_points',
    title: 'Point Collector',
    description: 'Earn 100 points in a day',
    icon: '💰',
    target: 100,
    unit: 'points',
    reward: 300,
    field: 'pointsEarned',
  },
];

/**
 * Check if missions need to be reset (new day)
 * @param {Object} user - User document
 */
function checkMissionReset(user) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!user.missionsLastReset || new Date(user.missionsLastReset) < today) {
    user.missionsLastReset = now;
    user.missionsProgress = {
      mineMins: 0,
      turboUsed: false,
      pointsEarned: 0,
      missionsClaimed: false,
    };
  }
}

/**
 * Update mission progress after a session
 * @param {Object} user - User document (mutated in place)
 * @param {Object} session - Completed session document
 */
async function updateMissionProgress(user, session) {
  checkMissionReset(user);

  const durationMins = Math.floor(session.durationSeconds / 60);
  user.missionsProgress.mineMins = (user.missionsProgress.mineMins || 0) + durationMins;

  if (session.mode === 'turbo') {
    user.missionsProgress.turboUsed = true;
  }

  user.missionsProgress.pointsEarned = (user.missionsProgress.pointsEarned || 0) + session.pointsEarned;

  await user.save();
}

/**
 * Get missions with current progress
 * @param {Object} user - User document
 */
function getMissionsWithProgress(user) {
  checkMissionReset(user);
  const progress = user.missionsProgress || {};

  return DAILY_MISSIONS.map(mission => {
    let current;
    if (mission.field === 'turboUsed') {
      current = progress.turboUsed ? 1 : 0;
    } else {
      current = progress[mission.field] || 0;
    }

    const completed = current >= mission.target;

    return {
      ...mission,
      current,
      completed,
      claimable: completed && !progress.missionsClaimed,
    };
  });
}

/**
 * Claim daily mission rewards
 * @param {Object} user - User document
 * @returns {{ pointsAwarded: number, missions: Array }}
 */
function claimMissionRewards(user) {
  checkMissionReset(user);

  if (user.missionsProgress.missionsClaimed) {
    return { pointsAwarded: 0, alreadyClaimed: true };
  }

  let totalPoints = 0;
  const missions = getMissionsWithProgress(user);

  missions.forEach(m => {
    if (m.completed) {
      totalPoints += m.reward;
    }
  });

  if (totalPoints > 0) {
    user.totalPoints += totalPoints;
    user.missionsProgress.missionsClaimed = true;
  }

  return { pointsAwarded: totalPoints, missions, alreadyClaimed: false };
}

module.exports = {
  DAILY_MISSIONS,
  getMissionsWithProgress,
  updateMissionProgress,
  claimMissionRewards,
  checkMissionReset,
};
