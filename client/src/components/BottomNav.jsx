import React from 'react';
import { Pickaxe, Cpu, Wallet, Target, Trophy, Info } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'dashboard',   label: 'Mine',     Icon: Pickaxe },
  { id: 'upgrades',    label: 'Upgrades', Icon: Cpu },
  { id: 'rewards',     label: 'Rewards',  Icon: Wallet },
  { id: 'missions',    label: 'Missions', Icon: Target },
  { id: 'leaderboard', label: 'Ranks',    Icon: Trophy },
  { id: 'about',       label: 'About',    Icon: Info },
];

export default function BottomNav({ activePage, onNavigate }) {
  return (
    <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
      {NAV_ITEMS.map(({ id, label, Icon }) => {
        const active = activePage === id;
        return (
          <button
            key={id}
            className={`nav-item ${active ? 'active' : ''}`}
            onClick={() => onNavigate(id)}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            id={`nav-${id}`}
          >
            <span className="nav-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
            </span>
            <span className="nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
