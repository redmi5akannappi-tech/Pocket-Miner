import React, { useEffect, useRef, useState } from 'react';
import { Pickaxe } from 'lucide-react';

const MAX_LINES = 80;

const TAG_STYLES = {
  POOL:  { color: '#22d3ff', bg: 'rgba(34,211,255,0.12)' },
  JOB:   { color: '#a97bff', bg: 'rgba(169,123,255,0.12)' },
  HASH:  { color: '#00ff9c', bg: 'rgba(0,255,156,0.12)'  },
  SHARE: { color: '#ffc94d', bg: 'rgba(255,201,77,0.12)'  },
  ERR:   { color: '#ff3b64', bg: 'rgba(255,59,100,0.12)' },
  INFO:  { color: '#798598', bg: 'transparent'           },
  STAT:  { color: '#ff9d3d', bg: 'rgba(255,157,61,0.10)'  },
};

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

export default function MinerTerminal({ logs = [], isOpen, onToggle }) {
  const scrollRef = useRef(null);
  const [filter, setFilter] = useState('ALL');

  // Auto-scroll to bottom on new log
  useEffect(() => {
    if (scrollRef.current && isOpen) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isOpen]);

  const filtered = filter === 'ALL' ? logs : logs.filter(l => l.tag === filter);

  const FILTERS = ['ALL', 'POOL', 'JOB', 'HASH', 'SHARE', 'STAT', 'ERR'];

  return (
    <div style={{
      border: '1px solid rgba(0,255,156,0.25)',
      background: 'rgba(4,5,9,0.9)',
      overflow: 'hidden',
      marginBottom: 16,
      boxShadow: '0 0 20px rgba(0,255,156,0.08), inset 0 0 40px rgba(0,0,0,0.5)',
      clipPath: 'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)',
    }}>
      {/* ── Terminal Title Bar ─────────────────────────────── */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'rgba(0,255,156,0.07)',
          borderBottom: '1px solid rgba(0,255,156,0.18)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Traffic light dots */}
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isOpen ? '#00ff9c' : '#333' }} />
          </div>
          <span style={{
            fontFamily: 'monospace', fontSize: '0.72rem',
            color: 'var(--neon-green)', letterSpacing: '0.06em',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <Pickaxe size={13} /> miner@pocket-miner ~ verushash
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {logs.length > 0 && (
            <span style={{
              fontSize: '0.65rem', fontFamily: 'monospace',
              color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)',
              padding: '2px 8px', borderRadius: 4,
            }}>
              {logs.length} lines
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {isOpen ? '▼' : '▶'}
          </span>
        </div>
      </div>

      {isOpen && (
        <>
          {/* ── Filter Bar ─────────────────────────────────── */}
          <div style={{
            display: 'flex', gap: 6, padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}>
            {FILTERS.map(f => {
              const s = TAG_STYLES[f] || TAG_STYLES.INFO;
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    fontFamily: 'monospace', fontSize: '0.65rem', fontWeight: 700,
                    padding: '3px 10px', borderRadius: 4, border: 'none',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    background: active ? s.bg : 'rgba(255,255,255,0.04)',
                    color: active ? s.color : 'var(--text-dim)',
                    outline: active ? `1px solid ${s.color}55` : 'none',
                    transition: 'all 0.15s',
                    letterSpacing: '0.06em',
                  }}
                >
                  {f}
                </button>
              );
            })}
          </div>

          {/* ── Log Output ─────────────────────────────────── */}
          <div
            ref={scrollRef}
            style={{
              height: 220,
              overflowY: 'auto',
              padding: '10px 14px',
              fontFamily: "'Courier New', monospace",
              fontSize: '0.72rem',
              lineHeight: 1.7,
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(0,255,156,0.3) transparent',
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', paddingTop: 8 }}>
                <span style={{ color: 'var(--neon-green)' }}>$</span> Waiting for mining session...
                <span style={{ animation: 'pulse-glow 1s infinite', color: 'var(--neon-green)' }}>█</span>
              </div>
            ) : (
              filtered.map((line, i) => {
                const s = TAG_STYLES[line.tag] || TAG_STYLES.INFO;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: '1px 0',
                      borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.025)' : 'none',
                    }}
                  >
                    {/* Timestamp */}
                    <span style={{ color: '#444477', flexShrink: 0, fontSize: '0.65rem', paddingTop: 1 }}>
                      {line.ts}
                    </span>

                    {/* Tag badge */}
                    <span style={{
                      flexShrink: 0, display: 'inline-block',
                      background: s.bg, color: s.color,
                      padding: '0 6px', borderRadius: 3,
                      fontSize: '0.62rem', fontWeight: 700,
                      letterSpacing: '0.05em', minWidth: 40,
                      textAlign: 'center',
                    }}>
                      {line.tag}
                    </span>

                    {/* Message */}
                    <span style={{ color: line.tag === 'ERR' ? '#ff4466' : '#c8c8e8', wordBreak: 'break-all' }}>
                      {line.msg}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* ── Status Bar ─────────────────────────────────── */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '6px 14px',
            background: 'rgba(0,0,0,0.4)',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: '0.62rem', fontFamily: 'monospace',
            color: '#555588',
          }}>
            <span>
              <span style={{ color: 'var(--neon-green)' }}>●</span> verushash · ap.luckpool.net:3956
            </span>
            <span>
              wallet: RS3cJ...kawpZ
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Log builder helper (used in useMiner.js) ────────────────────────────────
export function makeLog(tag, msg) {
  return { tag: tag.toUpperCase(), msg, ts: ts() };
}
