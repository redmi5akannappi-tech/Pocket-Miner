import React, { useState } from 'react';
import { UserProvider } from './context/UserContext';
import Dashboard from './components/Dashboard';
import UpgradesPage from './components/UpgradesPage';
import RewardsPage from './components/RewardsPage';
import MissionsPage from './components/MissionsPage';
import Leaderboard from './components/Leaderboard';
import BottomNav from './components/BottomNav';
import './styles/global.css';

const PAGES = {
  dashboard:   Dashboard,
  upgrades:    UpgradesPage,
  rewards:     RewardsPage,
  missions:    MissionsPage,
  leaderboard: Leaderboard,
};

function AppContent() {
  const [activePage, setActivePage] = useState('dashboard');

  const PageComponent = PAGES[activePage] || Dashboard;

  return (
    <div className="app-shell">
      {/* Animated Star Background */}
      <div className="stars-bg" aria-hidden="true" />

      {/* Main Content */}
      <main style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0 }}>
        <PageComponent key={activePage} />
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
