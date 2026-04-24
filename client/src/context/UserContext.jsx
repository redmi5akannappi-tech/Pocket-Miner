import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import axios from 'axios';

const UserContext = createContext(null);

const initialState = {
  loading: true,
  user: null,
  upgrade: null,
  activeSession: null,
  recentTransactions: [],
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING': return { ...state, loading: action.payload };
    case 'SET_DATA':    return { ...state, ...action.payload, loading: false, error: null };
    case 'SET_ERROR':   return { ...state, error: action.payload, loading: false };
    case 'UPDATE_USER': return { ...state, user: { ...state.user, ...action.payload } };
    case 'SET_SESSION': return { ...state, activeSession: action.payload };
    case 'SET_UPGRADE': return { ...state, upgrade: { ...state.upgrade, ...action.payload } };
    default: return state;
  }
}

// ─── Helper: get Telegram user (with dev fallback) ────────────────────────────
function getTelegramInitData() {
  try {
    const tg = window.Telegram?.WebApp;
    if (tg?.initData) return tg.initData;
  } catch {}
  return null;
}

function getTelegramUser() {
  try {
    const tg = window.Telegram?.WebApp;
    if (tg?.initDataUnsafe?.user) return tg.initDataUnsafe.user;
  } catch {}
  return { id: 'dev_user_12345', username: 'dev_miner', first_name: 'Dev' };
}

// ─── Axios instance ────────────────────────────────────────────────────────────
// Dev: Vite proxy rewrites /api → http://localhost:3001/api
// Prod: VITE_API_URL = https://pocket-miner-api.onrender.com/api
const API_BASE = import.meta.env.VITE_API_URL || '/api';
export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const initData = getTelegramInitData();
  const tgUser = getTelegramUser();

  if (initData) {
    config.headers['x-telegram-init-data'] = initData;
  } else {
    // Dev fallback headers
    config.headers['x-telegram-id'] = String(tgUser?.id || 'dev_user');
    config.headers['x-username'] = tgUser?.username || 'dev_miner';
  }
  return config;
});

export function UserProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get('/user/stats');
      dispatch({
        type: 'SET_DATA',
        payload: {
          user: data.user,
          upgrade: data.upgrade,
          activeSession: data.activeSession,
          recentTransactions: data.recentTransactions || [],
        },
      });
    } catch (err) {
      console.warn('[UserContext] API unreachable:', err.message);
      // Show UI with a guest user instead of blank screen
      dispatch({
        type: 'SET_DATA',
        payload: {
          user: {
            telegramId: 'guest',
            username: 'guest_miner',
            firstName: 'Guest',
            totalPoints: 0,
            pendingBalance: 0,
            totalEarned: 0,
            streak: 0,
            longestStreak: 0,
            totalValidShares: 0,
            totalMiningMinutes: 0,
          },
          upgrade: {
            cpuLevel: 1, efficiencyLevel: 1, boostLevel: 1,
            boostActive: false, rewardMultiplier: 1,
          },
          activeSession: null,
          recentTransactions: [],
        },
      });
    }
  }, []);

  // Initialize Telegram Web App
  useEffect(() => {
    try {
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        tg.setHeaderColor('#07071a');
        tg.setBackgroundColor('#07071a');
      }
    } catch {}

    fetchStats();
  }, [fetchStats]);

  const startSession = useCallback(async (mode) => {
    const { data } = await api.post('/session/start', { mode });
    dispatch({ type: 'SET_SESSION', payload: data });
    return data;
  }, []);

  const endSession = useCallback(async (sessionId) => {
    const { data } = await api.post('/session/end', { sessionId });
    dispatch({ type: 'SET_SESSION', payload: null });
    dispatch({ type: 'UPDATE_USER', payload: { totalPoints: data.totals.totalPoints, pendingBalance: data.totals.pendingBalance } });
    return data;
  }, []);

  const submitShare = useCallback(async (sessionId, shareData, hashrate) => {
    const { data } = await api.post('/shares/submit', { sessionId, shareData, hashrate });
    return data;
  }, []);

  const buyUpgrade = useCallback(async (type) => {
    const { data } = await api.post('/upgrades/buy', { type });
    dispatch({ type: 'UPDATE_USER', payload: { totalPoints: data.remainingPoints } });
    dispatch({ type: 'SET_UPGRADE', payload: data.multipliers });
    return data;
  }, []);

  const activateBoost = useCallback(async () => {
    const { data } = await api.post('/upgrades/boost');
    return data;
  }, []);

  const requestWithdraw = useCallback(async (amount, walletAddress) => {
    const { data } = await api.post('/withdraw', { amount, walletAddress });
    dispatch({ type: 'UPDATE_USER', payload: { pendingBalance: data.remainingBalance } });
    return data;
  }, []);

  const value = {
    ...state,
    api,
    fetchStats,
    startSession,
    endSession,
    submitShare,
    buyUpgrade,
    activateBoost,
    requestWithdraw,
  };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
}
