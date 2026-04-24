import React from 'react';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Mine',     icon: '⛏️' },
  { id: 'upgrades',  label: 'Upgrades', icon: '🔧' },
  { id: 'rewards',   label: 'Rewards',  icon: '💰' },
  { id: 'missions',  label: 'Missions', icon: '📋' },
  { id: 'leaderboard', label: 'Ranks',  icon: '🏆' },
];

export default function BottomNav({ activePage, onNavigate }) {
  return (
    <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`nav-item ${activePage === item.id ? 'active' : ''}`}
          onClick={() => onNavigate(item.id)}
          aria-label={item.label}
          id={`nav-${item.id}`}
        >
          <span className="nav-icon" role="img" aria-hidden="true">{item.icon}</span>
          <span className="nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
