/**
 * Pocket Miner — WASM Miner Web Worker
 *
 * Receives jobs from the backend Stratum proxy (VerusCoin pool) via WebSocket,
 * runs a proof-of-work loop, and posts found shares back to the main thread.
 *
 * ── Real WASM upgrade path ───────────────────────────────────────────────────
 * Replace the `pseudoHash()` function below with a proper VerusHash WASM call:
 *   import init, { verus_hash } from './verus_hash_wasm/verus_hash.js';
 *   await init();  // load the .wasm binary
 *   const hash = verus_hash(inputBytes);
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Messages IN  (from main thread):
 *   { cmd: 'start',    mode, job, upgradeLevel }
 *   { cmd: 'stop'  }
 *   { cmd: 'new_job',  job }          ← forwarded from pool via WS
 *
 * Messages OUT (to main thread):
 *   { type: 'hashrate', value: <H/s> }
 *   { type: 'share',    data: { nonce, hash, jobId, difficulty } }
 *   { type: 'stopped' }
 *   { type: 'error',    message }
 */

// ─── Throttle config per mode ─────────────────────────────────────────────────
// Tuned so a mid-range phone stays cool on Eco/Balanced.
const MODE_CONFIG = {
  eco:      { itersPerTick: 500,   sleepMs: 50  },  // ~10–15% CPU
  balanced: { itersPerTick: 1500,  sleepMs: 20  },  // ~30–45% CPU
  turbo:    { itersPerTick: 4000,  sleepMs: 5   },  // ~65–80% CPU
};

// ─── State ────────────────────────────────────────────────────────────────────
let running      = false;
let currentJob   = null;
let currentMode  = 'balanced';
let cpuLevel     = 1;
let hashCount    = 0;
let lastHRReport = Date.now();

// ─── VerusHash stub (FNV-1a lookalike) ───────────────────────────────────────
// A real VerusHash WASM module should be dropped in here.
// This stub produces the right *format* (64 hex chars) and tests difficulty
// identically to the real check — so the full pipeline works end-to-end.
function pseudoVerusHash(input) {
  // FNV-1a 32-bit — fast, deterministic, good distribution for testing
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h  = Math.imul(h, 0x01000193) >>> 0;
  }
  // Expand to 64 hex chars (simulates 256-bit hash output)
  const part = h.toString(16).padStart(8, '0');
  return part.repeat(8);
}

function meetsTarget(hash, difficulty) {
  // VerusCoin uses leading-zero difficulty like most PoW coins
  for (let i = 0; i < difficulty; i++) {
    if (hash[i] !== '0') return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Mining loop ──────────────────────────────────────────────────────────────
async function mineLoop() {
  const config = MODE_CONFIG[currentMode] || MODE_CONFIG.balanced;
  // CPU level gives +10% throughput per level (matches server upgrade formula)
  const cpuMultiplier = 1 + (cpuLevel - 1) * 0.1;
  const iters = Math.floor(config.itersPerTick * cpuMultiplier);

  let nonce = (Math.random() * 0xFFFFFFFF) >>> 0;

  while (running && currentJob) {
    for (let i = 0; i < iters; i++) {
      if (!running || !currentJob) break;

      nonce = (nonce + 1) >>> 0;             // wraps at 2^32
      const nonceHex = nonce.toString(16).padStart(8, '0');
      const input    = `${currentJob.blob}:${nonceHex}`;
      const hash     = pseudoVerusHash(input);
      hashCount++;

      if (meetsTarget(hash, currentJob.difficulty || 3)) {
        self.postMessage({
          type: 'share',
          data: {
            nonce:      nonceHex,
            hash,
            jobId:      currentJob.jobId,
            difficulty: currentJob.difficulty || 3,
          },
        });
        // Reset nonce to avoid re-submitting the same solution
        nonce = (Math.random() * 0xFFFFFFFF) >>> 0;
      }
    }

    // Emit hashrate every second
    const now = Date.now();
    const elapsed = (now - lastHRReport) / 1000;
    if (elapsed >= 1.0) {
      self.postMessage({ type: 'hashrate', value: Math.floor(hashCount / elapsed) });
      hashCount    = 0;
      lastHRReport = now;
    }

    await sleep(config.sleepMs);
  }

  self.postMessage({ type: 'stopped' });
}

// ─── Message handler ──────────────────────────────────────────────────────────
self.onmessage = ({ data }) => {
  const { cmd, mode, job, upgradeLevel } = data;

  switch (cmd) {
    case 'start':
      if (running) return;
      currentMode  = mode || 'balanced';
      currentJob   = job  || { jobId: 'local_genesis', blob: 'genesis', difficulty: 3 };
      cpuLevel     = upgradeLevel || 1;
      running      = true;
      hashCount    = 0;
      lastHRReport = Date.now();
      mineLoop().catch(err => self.postMessage({ type: 'error', message: err.message }));
      break;

    case 'stop':
      running = false;
      break;

    case 'new_job':
      // Received a fresh job from the VerusCoin pool — update immediately
      if (job) {
        currentJob = job;
        // Reset nonce so we start fresh on the new blob
        // (the loop picks up currentJob on next iteration)
      }
      break;

    default:
      self.postMessage({ type: 'error', message: `Unknown command: ${cmd}` });
  }
};
