/**
 * miner.worker.js
 *
 * VerusHash Web Worker — runs off the main thread so UI never freezes.
 *
 * Priority:
 *   1. Real VerusHash via compiled verus_hash.wasm   ← valid pool shares
 *   2. JS stub fallback                               ← demo only, shares rejected
 *
 * Messages IN  (postMessage from main thread):
 *   { cmd: 'start',   job, mode, upgradeLevel }
 *   { cmd: 'stop' }
 *   { cmd: 'new_job', job }
 *
 * Messages OUT (postMessage to main thread):
 *   { type: 'wasm_status', loaded: bool, message: string }
 *   { type: 'hashrate',    value: number }         ← H/s, every second
 *   { type: 'share',       data: ShareData }       ← valid nonce found
 *   { type: 'stopped' }
 *   { type: 'error',       data: { message } }
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let running        = false;
let currentJob     = null;
let wasmReady      = false;
let wasmExports    = null;
let hashCount      = 0;
let upgradeLevel   = 1;
let modeThrottle   = 40;   // target CPU% (eco=15, balanced=40, turbo=75)

// ─── WASM Loading ─────────────────────────────────────────────────────────────
async function loadWasm() {
  try {
    // WebAssembly.instantiateStreaming requires the server to serve
    // verus_hash.wasm with Content-Type: application/wasm
    // In dev (Vite), static files in /public are served correctly.
    const resp = await fetch('/wasm/verus_hash.wasm');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const { instance } = await WebAssembly.instantiateStreaming(resp, {
      env: {
        // VerusHash compiled with Emscripten uses its own memory — no imports needed
        // but some builds may need these stubs
        emscripten_memcpy_js: (dst, src, num) => {
          const mem = new Uint8Array(instance.exports.memory.buffer);
          mem.copyWithin(dst, src, src + num);
        },
      },
    });

    wasmExports = instance.exports;
    wasmReady   = true;

    self.postMessage({
      type: 'wasm_status',
      loaded: true,
      message: '✅ verus_hash.wasm loaded — REAL VerusHash active!',
    });

    return true;
  } catch (err) {
    wasmReady = false;
    self.postMessage({
      type: 'wasm_status',
      loaded: false,
      message: `⚠️ WASM not found (${err.message}) — using JS stub (demo only)`,
    });
    return false;
  }
}

// ─── WASM VerusHash call ──────────────────────────────────────────────────────
function verusHashWasm(inputHex) {
  const input    = hexToBytes(inputHex);
  const inputLen = input.length;

  // Allocate WASM heap buffers
  const inputPtr  = wasmExports.alloc(inputLen);
  const outputPtr = wasmExports.alloc(32);

  try {
    // Write input into WASM memory
    const mem = new Uint8Array(wasmExports.memory.buffer);
    mem.set(input, inputPtr);

    // Call VerusHash
    wasmExports.verus_hash(inputPtr, inputLen, outputPtr);

    // Read 32-byte hash result
    const result = new Uint8Array(wasmExports.memory.buffer, outputPtr, 32);
    return bytesToHex(result);
  } finally {
    // Always free — no memory leaks
    wasmExports.dealloc(inputPtr);
    wasmExports.dealloc(outputPtr);
  }
}

// ─── JS Stub (fallback — NOT real VerusHash, shares will be rejected by pool) ─
function pseudoVerusHash(blob, nonce) {
  // XorShift64 + mix — fast for UI demo, not cryptographically valid
  let h = BigInt('0x' + blob.slice(0, 16)) ^ BigInt(nonce) ^ BigInt('0xdeadbeefcafebabe');
  for (let i = 0; i < 8; i++) {
    h ^= h << 13n;
    h ^= h >> 7n;
    h ^= h << 17n;
    h &= 0xFFFFFFFFFFFFFFFFn;
  }
  return h.toString(16).padStart(16, '0').repeat(4).slice(0, 64);
}

// ─── Block Header Builder ─────────────────────────────────────────────────────
function buildBlockHeader(job, nonce) {
  // Stratum fields: version(4) + prevhash(32) + merkle(32) + time(4) + bits(4) + nonce(4)
  const version  = (job.version  || '00000004').padStart(8,  '0');
  const prevhash = (job.prevhash || '0'.repeat(64)).padStart(64, '0');
  const merkle   = (job.merkle   || '0'.repeat(64)).padStart(64, '0');
  const time     = (job.time     || Math.floor(Date.now()/1000).toString(16)).padStart(8, '0');
  const bits     = (job.bits     || '1e0fffff').padStart(8, '0');
  const nonceHex = nonce.toString(16).padStart(8, '0');
  return version + prevhash + merkle + time + bits + nonceHex;
}

// ─── Difficulty check ─────────────────────────────────────────────────────────
function meetsDifficulty(hashHex, difficulty) {
  // Leading zero nibbles required
  const required = Math.floor(difficulty);
  return hashHex.startsWith('0'.repeat(required));
}

// ─── Main Mining Loop ─────────────────────────────────────────────────────────
async function mineLoop() {
  const BATCH      = 500;       // hashes per batch
  const REPORT_MS  = 1000;      // hashrate report interval
  const THROTTLE   = Math.max(0, Math.floor((100 - modeThrottle) * 0.3)); // ms idle per batch

  let lastReport   = Date.now();
  let nonce        = (Math.random() * 0xFFFFFFFF) >>> 0;   // random start nonce

  // Determine difficulty per mode
  const DIFFICULTY = { eco: 2, balanced: 3, turbo: 4 }[currentJob?.mode || 'balanced'] || 3;

  while (running && currentJob) {
    // ── Hash a batch of nonces ──────────────────────────────────────────────
    for (let i = 0; i < BATCH && running; i++) {
      nonce = (nonce + 1) >>> 0;

      const blob   = buildBlockHeader(currentJob, nonce);
      const hash   = wasmReady ? verusHashWasm(blob) : pseudoVerusHash(blob, nonce);
      hashCount++;

      if (meetsDifficulty(hash, DIFFICULTY)) {
        self.postMessage({
          type: 'share',
          data: {
            jobId:      currentJob.jobId,
            nonce:      nonce.toString(16).padStart(8, '0'),
            hash,
            difficulty: DIFFICULTY,
            blob,
            realHash:   wasmReady,   // tells backend: true = might be valid for pool
          },
        });
      }
    }

    // ── Report hashrate every second ────────────────────────────────────────
    const now = Date.now();
    if (now - lastReport >= REPORT_MS) {
      self.postMessage({ type: 'hashrate', value: hashCount });
      hashCount   = 0;
      lastReport  = now;
    }

    // ── Throttle CPU ────────────────────────────────────────────────────────
    if (THROTTLE > 0) {
      await sleep(THROTTLE);
    } else {
      // Still yield control so other events can fire
      await sleep(0);
    }
  }

  if (!running) {
    self.postMessage({ type: 'stopped' });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { cmd, job, mode, upgradeLevel: lvl } = e.data;

  switch (cmd) {
    case 'start':
      if (running) return;

      running      = true;
      currentJob   = { ...job, mode };
      upgradeLevel = lvl || 1;
      modeThrottle = { eco: 15, balanced: 40, turbo: 75 }[mode] || 40;

      // Try to load WASM (don't block — fall back to JS if unavailable)
      await loadWasm();

      // Begin mining loop
      mineLoop().catch(err => {
        running = false;
        self.postMessage({ type: 'error', data: { message: err.message } });
      });
      break;

    case 'new_job':
      if (running && e.data.job) {
        currentJob = { ...e.data.job, mode: currentJob?.mode || 'balanced' };
        // Loop picks up new job on next iteration (nonce resets to random)
      }
      break;

    case 'stop':
      running = false;
      break;
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
