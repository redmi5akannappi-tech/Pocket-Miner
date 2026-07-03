import React, { useState } from 'react';

const POOL_URL = 'https://luckpool.net/verus/miner.html?RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';
const WALLET  = 'RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';

const MILESTONES = [
  {
    icon: '🦀',
    title: 'VerusHash C++ Source',
    desc: 'Ported the official VerusCoin C++ hashing library (VerusHash 2.2b) including portable AES-NI emulation (Haraka-512) for non-x86 targets.',
  },
  {
    icon: '🔧',
    title: 'Compiled to WebAssembly',
    desc: 'Used Emscripten to cross-compile VerusHash to WASM, preserving the full haraka round-constant tables and portable AES emulation path.',
  },
  {
    icon: '⚡',
    title: 'Real-Time Browser Mining',
    desc: 'The WASM module runs inside a Web Worker — fully off the main thread — delivering ~50 KH/s without freezing the UI.',
  },
  {
    icon: '📡',
    title: 'Zcash Stratum Protocol',
    desc: 'Built a Node.js Stratum proxy that speaks the full Zcash/Verus Stratum protocol (mining.subscribe → mining.authorize → mining.notify → mining.submit) to Luckpool.',
  },
  {
    icon: '🎯',
    title: 'Pool-Assigned Difficulty',
    desc: 'The proxy captures the pool\'s real mining.set_target and forwards it to the worker, which compares hashes against the actual target — not a hardcoded value.',
  },
  {
    icon: '🏆',
    title: 'Valid Share Submission',
    desc: 'Found shares are submitted to Luckpool in real time via the WebSocket → Stratum bridge. Pool acceptance/rejection is relayed back to the terminal.',
  },
];

const TECH_STACK = [
  { label: 'Algorithm',      value: 'VerusHash 2.2b' },
  { label: 'Runtime',        value: 'WebAssembly (Emscripten)' },
  { label: 'Threading',      value: 'Web Worker (off main thread)' },
  { label: 'Protocol',       value: 'Zcash Stratum (TCP)' },
  { label: 'Pool',           value: 'Luckpool (ap.luckpool.net:3956)' },
  { label: 'Backend',        value: 'Node.js + Express + WebSocket' },
  { label: 'Frontend',       value: 'React + Vite' },
  { label: 'Hashrate',       value: '~50 KH/s (browser, no GPU)' },
];

export default function AboutPage() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(POOL_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="about-page">
      {/* Hero */}
      <div className="about-hero">
        <div className="about-hero-badge">⛏ Open Source</div>
        <h1 className="about-title">Pocket Miner</h1>
        <p className="about-subtitle">
          The world's first <strong>browser-based VerusCoin miner</strong> powered by
          real WebAssembly — not JavaScript approximations.
        </p>
      </div>

      {/* Pool Link Card */}
      <div className="about-pool-card">
        <div className="about-pool-label">
          <span className="about-pool-dot" /> Live on Luckpool
        </div>
        <p className="about-pool-desc">
          Track your mining stats, submitted shares, and estimated rewards directly on the pool dashboard.
        </p>
        <div className="about-pool-url-row">
          <code className="about-pool-url">{POOL_URL.replace('https://', '')}</code>
          <div className="about-pool-actions">
            <button
              className="about-btn about-btn-copy"
              onClick={handleCopy}
              id="btn-copy-pool-url"
              aria-label="Copy pool URL"
            >
              {copied ? '✅ Copied!' : '📋 Copy'}
            </button>
            <a
              className="about-btn about-btn-open"
              href={POOL_URL}
              target="_blank"
              rel="noopener noreferrer"
              id="btn-open-pool"
              aria-label="Open pool dashboard"
            >
              🔗 Open
            </a>
          </div>
        </div>
        <div className="about-wallet-row">
          <span className="about-wallet-label">Wallet:</span>
          <code className="about-wallet">{WALLET}</code>
        </div>
      </div>

      {/* What we built */}
      <section className="about-section">
        <h2 className="about-section-title">What We Built</h2>
        <div className="about-milestones">
          {MILESTONES.map((m, i) => (
            <div className="about-milestone" key={i}>
              <div className="about-milestone-icon">{m.icon}</div>
              <div className="about-milestone-body">
                <h3 className="about-milestone-title">{m.title}</h3>
                <p className="about-milestone-desc">{m.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Tech Stack */}
      <section className="about-section">
        <h2 className="about-section-title">Tech Stack</h2>
        <div className="about-tech-grid">
          {TECH_STACK.map((t, i) => (
            <div className="about-tech-item" key={i}>
              <span className="about-tech-label">{t.label}</span>
              <span className="about-tech-value">{t.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="about-section">
        <h2 className="about-section-title">How It Works</h2>
        <div className="about-flow">
          {[
            ['Browser', 'Spawns a Web Worker running the WASM VerusHash module'],
            ['Web Worker', 'Iterates nonces, builds 140-byte Verus block headers, hashes them'],
            ['WebSocket', 'Streams found shares to the backend Node.js server'],
            ['Stratum Proxy', 'Forwards shares upstream to Luckpool via the Zcash Stratum protocol'],
            ['Luckpool', 'Validates the share against the current network difficulty and credits the wallet'],
          ].map(([step, detail], i) => (
            <div className="about-flow-step" key={i}>
              <div className="about-flow-num">{i + 1}</div>
              <div className="about-flow-body">
                <strong>{step}</strong>
                <span>{detail}</span>
              </div>
              {i < 4 && <div className="about-flow-arrow">↓</div>}
            </div>
          ))}
        </div>
      </section>

      <div className="about-footer">
        Built with ❤️ · VerusCoin · WebAssembly · Luckpool
      </div>
    </div>
  );
}
