import React, { useState, Suspense, lazy } from 'react';
import { UserProvider } from './context/UserContext';
import Dashboard from './components/Dashboard';
import BottomNav from './components/BottomNav';
import './styles/global.css';

// Dashboard loads eagerly (first paint). Secondary tabs are code-split so the
// initial bundle stays small — important on mobile / Telegram cold starts.
const UpgradesPage = lazy(() => import('./components/UpgradesPage'));
const RewardsPage  = lazy(() => import('./components/RewardsPage'));
const MissionsPage = lazy(() => import('./components/MissionsPage'));
const Leaderboard  = lazy(() => import('./components/Leaderboard'));
const AboutPage    = lazy(() => import('./components/AboutPage'));

const PAGES = {
  dashboard:   Dashboard,
  upgrades:    UpgradesPage,
  rewards:     RewardsPage,
  missions:    MissionsPage,
  leaderboard: Leaderboard,
  about:       AboutPage,
};

function PageFallback() {
  return (
    <div className="page-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50vh' }}>
      <div className="spinner" />
    </div>
  );
}

function AppContent() {
  const [activePage, setActivePage] = useState('dashboard');
  const PageComponent = PAGES[activePage] || Dashboard;

  return (
    <div className="app-shell">
      {/* Static ambient background */}
      <div className="stars-bg" aria-hidden="true" />

      {/* Main Content */}
      <main style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0 }}>
        <Suspense fallback={<PageFallback />}>
          <PageComponent key={activePage} />
        </Suspense>
      </main>

      {/* Bottom Navigation */}
      <BottomNav activePage={activePage} onNavigate={setActivePage} />
    </div>
  );
}

export default function App() {
  return (
    <UserProvider>
      <AppContent />
    </UserProvider>
  );
}
