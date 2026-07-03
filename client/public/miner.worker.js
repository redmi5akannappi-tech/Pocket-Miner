/**
 * miner.worker.js
 *
 * VerusHash Web Worker — runs off the main thread so UI never freezes.
 *
 * Implements Zcash Stratum Protocol (ZIP 301) for VerusCoin mining:
 *   - Block header: version(4) + prevhash(32) + merkleroot(32) + reserved(32) + time(4) + bits(4) + nonce(32) = 140 bytes
 *   - Nonce = NONCE_1 (from pool) + NONCE_2 (miner iterates), total 32 bytes
 *   - Target comparison: 256-bit big-endian integer, hash <= target
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
let modeThrottle   = 40;   // target CPU% (eco=15, balanced=40, turbo=75, monster=100)
let THROTTLE       = 18;   // calculated sleep ms per batch

let verusHashFunc = null;
let inputPtr = null;
let outputPtr = null;

// ─── WASM Loading ─────────────────────────────────────────────────────────────
async function loadWasm() {
  try {
    // Import the Emscripten-generated JS glue code
    importScripts('/wasm/verus_hash.js');

    // Initialize the module — override locateFile so Emscripten finds
    // verus_hash.wasm at /wasm/ even inside a Web Worker (where
    // document.currentScript is undefined and path resolution breaks).
    const module = await self.VerusHashModule({
      locateFile: (path) => `/wasm/${path}`,
    });
    wasmExports = module;

    // Map the C function to JS using cwrap
    verusHashFunc = module.cwrap('verus_hash', 'void', ['number', 'number', 'number']);

    // Pre-allocate memory buffers ONCE to prevent heap fragmentation
    // VerusHash input = header(140) + solution(1347) = 1487 bytes
    // Allocating 2048 bytes to be safe
    inputPtr  = module._malloc(2048);
    outputPtr = module._malloc(32);

    wasmReady = true;

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
let cachedHeap = null;

// Get a live Uint8Array view of WASM linear memory.
// Uses Module.HEAPU8 which is explicitly exported by Emscripten.
// DO NOT access Module.wasmMemory — it's in the unexported symbols list
// and accessing it triggers abort() which sets ABORT=true globally.
function getHeap() {
  // If we have a cached view and it's still valid (buffer not detached), return it.
  if (cachedHeap && cachedHeap.buffer.byteLength > 0) return cachedHeap;

  // HEAPU8 is explicitly set by updateMemoryViews() in Emscripten glue
  if (wasmExports.HEAPU8 && wasmExports.HEAPU8.buffer) {
    cachedHeap = wasmExports.HEAPU8;
    return cachedHeap;
  }

  throw new Error('Cannot access WASM memory — HEAPU8 not available');
}

function verusHashWasm(inputBytes) {
  const heap = getHeap();

  // Write input into pre-allocated WASM buffer
  heap.set(inputBytes, inputPtr);

  // Call verus_hash(input, input_len, output) — C signature order!
  verusHashFunc(inputPtr, inputBytes.length, outputPtr);

  // Read back 32-byte result (fresh view in case memory grew)
  return new Uint8Array(getHeap().buffer, outputPtr, 32).slice();
}

// ─── JS Stub (fallback — NOT real VerusHash, shares will be rejected by pool) ─
function pseudoVerusHash(headerBytes) {
  // XorShift64 + mix — fast for UI demo, not cryptographically valid
  let h = 0xdeadbeefcafebaben;
  for (let i = 0; i < Math.min(headerBytes.length, 32); i++) {
    h ^= BigInt(headerBytes[i]) << BigInt((i % 8) * 8);
  }
  for (let i = 0; i < 8; i++) {
    h ^= h << 13n;
    h ^= h >> 7n;
    h ^= h << 17n;
    h &= 0xFFFFFFFFFFFFFFFFn;
  }
  // Expand to 32 bytes
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const val = h ^ BigInt(i * 0x9e3779b9);
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number((val >> BigInt(j * 8)) & 0xFFn);
    }
  }
  return out;
}

// ─── Block Header Builder (ZIP 301 compliant) ────────────────────────────────
// Zcash/Verus block header = 140 bytes:
//   version(4) + prevhash(32) + merkleroot(32) + reserved(32) + time(4) + bits(4) + nonce(32)
//
// All fields are already little-endian hex as sent by the pool per ZIP 301.
// The nonce = NONCE_1 (pool-assigned) + NONCE_2 (miner iterates)
// NONCE_2 length = 32 - len(NONCE_1) bytes

// Helper: convert hex to bytes and ensure exactly `len` bytes (pad or slice)
function hexField(hex, len) {
  const raw = hexToBytes(hex || '');
  if (raw.length === len) return raw;
  const out = new Uint8Array(len);
  out.set(raw.subarray(0, Math.min(raw.length, len)));
  return out;
}

// Parse the solution template version (first 4 bytes LE).
function solutionVersion(job) {
  const tmpl = job.solutionTemplate || '';
  if (tmpl.length < 8) return 0;
  return parseInt(tmpl.substring(0, 8).match(/../g).reverse().join(''), 16);
}

// Detect the VerusHash 2.2 merged-mining (PBaaS) hashing model.
//
// For solution version >= 7 with PBaaS headers (template byte 5 = numPBaaSHeaders > 0),
// the block hash is computed over a CANONICAL header where chain-specific fields are
// zeroed — the shared proof-of-work only commits to the merge-mining data in the
// solution + version + time. Reference: VerusCoin ClearNonCanonicalData() and
// ccminer verusscan.cpp scanhash_verus (memset of header + MMR roots before hashing).
//
// Fields ZEROED before hashing:
//   header: prevhash(4..35), merkleroot(36..67), saplingroot(68..99), bits(104..107), nonce(108..139)
//   solution: hashPrevMMRRoot + hashBlockMMRRoot (solution bytes 8..71)
// Fields KEPT: version(0..3), time(100..103), and the rest of the solution.
// The real search nonce lives entirely in the LAST 15 bytes of the solution.
function isMergedMiningV7(job) {
  if (solutionVersion(job) < 7) return false;
  const tmpl = job.solutionTemplate || '';
  if (tmpl.length < 12) return false;
  const numPBaaSHeaders = parseInt(tmpl.substring(10, 12), 16); // byte 5
  return numPBaaSHeaders > 0;
}

// Legacy alias kept for logging.
function isPBaaS(job) {
  return solutionVersion(job) > 6;
}

function buildBlockHeader(job, nonce2Bytes, merged) {
  const header = new Uint8Array(140);  // zero-filled
  let offset = 0;

  // version (4 bytes) — always kept
  header.set(hexField(job.version || '04000000', 4), offset); offset += 4;

  if (merged) {
    // Canonical (merged-mining) header: prevhash/merkleroot/saplingroot/bits/nonce
    // are left ZEROED. The pool clears the identical fields before verifying.
    offset += 32 + 32 + 32;                                   // prevhash+merkle+sapling → zero
    header.set(hexField(job.time, 4), 100);                   // time (kept)
    // bits (104..107) and nonce (108..139) stay zero.
    return header;
  }

  // ── Non-merged (legacy) header: fields populated, nonce = en1 + n2 ──
  header.set(hexField(job.prevhash, 32), offset); offset += 32;
  header.set(hexField(job.merkle, 32), offset); offset += 32;
  header.set(hexField(job.sapling, 32), offset); offset += 32;
  header.set(hexField(job.time, 4), offset); offset += 4;
  header.set(hexField(job.bits || '1e0fffff', 4), offset); offset += 4;

  const nonce1Bytes = hexToBytes(job.extranonce1 || '');
  const n1Len = Math.min(nonce1Bytes.length, 32);
  header.set(nonce1Bytes.subarray(0, n1Len), offset);
  const n2Len = Math.min(nonce2Bytes.length, 32 - n1Len);
  header.set(nonce2Bytes.subarray(0, n2Len), offset + n1Len);

  return header;
}

// ─── Solution Builder (PBaaS / VerusHash 2.2) ──────────────────────────────
// The pool sends a solution template (params[8] in mining.notify).
// For PBaaS, the search space is in the SOLUTION, not the header nonce.
// The miner must:
//   1. Pad the template back to 2688 hex chars (1344 bytes)
//   2. Embed extraNonce1 + nonce2 in the last 15 bytes (30 hex chars)
//   3. Prepend CompactSize prefix fd4005 → total 2694 hex chars / 1347 bytes
// Pool checks: soln.substr(-30).indexOf(extraNonce1) >= 0
// The pool hashes: header(140) + solution(1347) = 1487 bytes

const SOLUTION_BYTES = 1344;  // raw solution size
const SOLUTION_HEX = SOLUTION_BYTES * 2;  // 2688 hex chars
const COMPACT_PREFIX = 'fd4005';  // CompactSize for 1344

// Build base solution template (called once per job)
// Returns the padded template with extraNonce1 embedded, plus byte positions
function buildSolutionBase(job, merged) {
  // Start with the pool's solution template (trimmed of trailing zeros)
  let template = job.solutionTemplate || '';

  // Pad template back to full 2688 hex chars
  if (template.length < SOLUTION_HEX) {
    template = template + '0'.repeat(SOLUTION_HEX - template.length);
  } else if (template.length > SOLUTION_HEX) {
    template = template.substring(0, SOLUTION_HEX);
  }

  // Embed extraNonce1 in the last 30 hex chars (last 15 bytes)
  const en1 = job.extranonce1 || '';
  const en1Len = en1.length;  // in hex chars (8 for 4-byte extraNonce1)
  if (en1Len > 0) {
    const insertPos = SOLUTION_HEX - 30;
    template = template.substring(0, insertPos) + en1 + template.substring(insertPos + en1Len);
  }

  // Convert to bytes for the base (nonce2 area will be overwritten in-place)
  const fullSolutionHex = COMPACT_PREFIX + template;
  const solutionBytes = hexToBytes(fullSolutionHex);

  // Canonical merged-mining clearing: zero hashPrevMMRRoot + hashBlockMMRRoot
  // for HASHING, but save originals for SUBMISSION (pool validates intact MMR).
  // In the CompactSize-prefixed buffer these are solution bytes 8..71 → offset 3+8=11.
  let origMMR = null;
  if (merged) {
    origMMR = solutionBytes.slice(3 + 8, 3 + 8 + 64);  // save original 64 bytes
    solutionBytes.fill(0, 3 + 8, 3 + 8 + 64);           // zero for hashing
  }

  // Nonce2 position within the solution bytes:
  // CompactSize(3B) + raw_solution(1344B) = 1347 total
  // Last 15 bytes of raw solution = offset 1347-15 = 1332
  // extraNonce1 occupies first en1Len/2 bytes of that → nonce2 starts after
  const nonce2ByteOffset = 1347 - 15 + (en1Len / 2);  // where nonce2 goes in solution bytes
  const nonce2MaxBytes = 15 - (en1Len / 2);             // max nonce2 bytes that fit (11 for 4B en1)

  return {
    bytes: solutionBytes,           // 1347 bytes (MMR zeroed for hashing)
    origMMR,                        // original 64-byte MMR roots (null if not merged)
    nonce2ByteOffset,               // where to write nonce2 bytes
    nonce2MaxBytes,                 // how many nonce2 bytes fit (11)
  };
}

// ─── Target / Difficulty check (ZIP 301) ──────────────────────────────────────
// Per ZIP 301: "The miner compares proposed block hashes with this target as a
// 256-bit big-endian integer, and valid blocks MUST NOT have hashes larger than
// (above) the current target."
//
// Both hash and target are 32-byte big-endian. hash <= target means valid.

function meetsTarget(hashBytes, targetHex) {
  if (!targetHex) return false;
  // Pad target to 64 hex chars (32 bytes) if pool sends shorter.
  const paddedTarget = targetHex.padEnd(64, '0');
  const targetBytes = hexToBytes(paddedTarget);
  // VerusHash outputs the digest in LITTLE-ENDIAN (raw) byte order — a valid block
  // has TRAILING zeros in raw form. The pool/target space is BIG-ENDIAN (display),
  // so we must reverse the raw hash before comparing against the target.
  // (Verified: reversed raw hash of block 3000000 == its display hash.)
  for (let i = 0; i < 32; i++) {
    const hb = hashBytes[31 - i];  // big-endian: MSB is the LAST raw byte
    if (hb < targetBytes[i]) {
      console.log(`[WORKER] 🎯 SHARE FOUND! hashBE: ${bytesToHex(hashBytes.slice().reverse()).slice(0,16)}  target: ${paddedTarget.slice(0,16)}`);
      return true;   // hash < target → valid
    }
    if (hb > targetBytes[i]) return false;  // hash > target → invalid
  }
  return true; // hash == target → valid
}

// Local difficulty check for UI rewards (leading zero nibbles in hex)
function meetsLocalDifficulty(hashBytes, requiredZeroNibbles) {
  const hashHex = bytesToHex(hashBytes);
  return hashHex.startsWith('0'.repeat(requiredZeroNibbles));
}

// ─── Main Mining Loop ─────────────────────────────────────────────────────────
async function mineLoop() {
  // Bigger batches = less sleep(0) overhead on Windows (~4ms per sleep)
  // Monster: 20k hashes/batch → ~14ms work + 4ms sleep = 78% efficiency
  const BATCH      = THROTTLE === 0 ? 20000 : 500;
  const REPORT_MS  = 10_000;    // hashrate report every 10s (shares show instantly)
  
  let lastReport   = Date.now();

  // Pool target is the ONLY check — no local shares.
  // We only submit shares that meet the real pool difficulty.

  // Track current extranonce1 so we can resize nonce2 when it changes
  let lastExtranonce1 = null;  // null sentinel — forces init on first iteration
  let nonce2 = null;
  let nonce2Len = 0;
  let firstHashLogged = 0;
  let bestHash = null;  // track lowest hash for diagnostics

  while (running && currentJob) {
    // Recalculate nonce2 size when extranonce1 changes (new pool connection or first real job)
    const nonce1Hex = currentJob?.extranonce1 || '';
    if (nonce1Hex !== lastExtranonce1) {
      lastExtranonce1 = nonce1Hex;
      const nonce1Len = nonce1Hex.length / 2;
      nonce2Len = 32 - nonce1Len;
      
      if (nonce2Len <= 0 || nonce2Len > 32) {
        self.postMessage({ type: 'error', data: { message: `Invalid nonce sizes: nonce1=${nonce1Len}B, nonce2=${nonce2Len}B` } });
        return;
      }
      
      nonce2 = new Uint8Array(nonce2Len);
      crypto.getRandomValues(nonce2);
      console.log(`[WORKER] Nonce2 (re)initialized: nonce1=${nonce1Hex} (${nonce1Len}B) → nonce2=${nonce2Len}B (${nonce2Len*2} hex chars)`);
    }
    // ── Build solution base from pool template (once per job) ────────────────
    const pbaas = isPBaaS(currentJob);
    const merged = isMergedMiningV7(currentJob);
    const solnBase = buildSolutionBase(currentJob, merged);

    // ── Pre-allocate hash input buffer ──────────────────────────────────────
    const hashInput = new Uint8Array(140 + solnBase.bytes.length);

    // Build header ONCE. For merged mining the header nonce stays zeroed and the
    // real search nonce lives only in the solution tail.
    const baseHeader = buildBlockHeader(currentJob, nonce2, merged);
    hashInput.set(baseHeader, 0);

    // Copy base solution bytes (nonce2 area will be updated in-place)
    hashInput.set(solnBase.bytes, 140);

    // Pre-calculate offsets for in-place nonce2 updates
    const nonce1Len = (currentJob.extranonce1 || '').length / 2;
    const headerNonce2Offset = 108 + nonce1Len;  // nonce2 position in header
    // nonce2 position in solution (within hashInput):
    const solnNonce2Offset = 140 + solnBase.nonce2ByteOffset;
    const solnNonce2Len = solnBase.nonce2MaxBytes;  // how many bytes fit (11 for 4B en1)

    if (firstHashLogged < 1) {
      console.log(`[WORKER] merged-mining(v7): ${merged} | solnVer: ${solutionVersion(currentJob)} | headerCanonical: ${merged ? 'prevhash/merkle/sapling/bits/nonce ZEROED' : 'populated'} | solnNonce2Offset: ${solnNonce2Offset} | solnNonce2Len: ${solnNonce2Len}`);
    }

    for (let i = 0; i < BATCH && running; i++) {
      // Increment NONCE_2 (little-endian: increment from byte 0)
      if (self._nextNonce !== undefined) {
        crypto.getRandomValues(nonce2);
        self._nextNonce = undefined;
      } else {
        incrementNonce2(nonce2);
      }

      // Update nonce2 in the SOLUTION tail (the real search space). This makes
      // each hash attempt unique — for merged mining this is the ONLY entropy
      // that reaches the hash (the header nonce is zeroed).
      const n2Slice = nonce2.subarray(0, Math.min(nonce2.length, solnNonce2Len));
      hashInput.set(n2Slice, solnNonce2Offset);

      // Legacy (non-merged) path also iterates the header nonce.
      if (!merged) {
        hashInput.set(nonce2.subarray(0, Math.min(nonce2.length, 32 - nonce1Len)), headerNonce2Offset);
      }

      let hashBytes;
      if (wasmReady) {
        try {
          hashBytes = verusHashWasm(hashInput);
        } catch (e) {
          wasmReady = false;
          self.postMessage({ type: 'wasm_status', loaded: false, message: `⚠️ WASM error: ${e.message} — falling back to JS stub` });
          hashBytes = pseudoVerusHash(hashInput);
        }
      } else {
        hashBytes = pseudoVerusHash(hashInput);
      }
      hashCount++;

      // Track the best (lowest) hash we've seen — for diagnostics
      if (!bestHash || compareBytes(hashBytes, bestHash) < 0) {
        bestHash = hashBytes.slice();
      }

      // DEBUG: print first 3 hashes
      if (firstHashLogged < 3) {
        const hx = bytesToHex(hashBytes);
        console.log(`[WORKER] hash#${firstHashLogged+1}: ${hx}  (wasm:${wasmReady}  pbaas:${pbaas}  inputLen:${hashInput.length}B  target:${currentJob.target?.slice(0,16)})`);
        firstHashLogged++;
      }

      // Only report shares that meet the POOL target
      if (meetsTarget(hashBytes, currentJob.target)) {
        // Build submission solution from hashInput: copy the solution slice
        // (which has MMR zeroed + winning nonce), then restore intact MMR.
        const solField = hashInput.subarray(140).slice();          // 1347 bytes
        if (solnBase.origMMR) solField.set(solnBase.origMMR, 11);  // restore MMR for pool
        const solutionHex = bytesToHex(solField);

        // The counting nonce is only the solution tail (11 bytes for 4B en1)
        const countingHex = bytesToHex(n2Slice);

        // Hash display in big-endian (reverse raw LE bytes)
        const shareHashHex = bytesToHex(hashBytes.slice().reverse());

        self.postMessage({
          type: 'share',
          data: {
            jobId:      currentJob.jobId,
            nonce2Hex:  countingHex,  // 11-byte counting nonce, NOT full 28B header nonce
            time:       currentJob.time,
            hash:       shareHashHex,
            solution:   solutionHex,  // 2694-char solution with intact MMR + winning nonce
            meetsPool:  true,
            realHash:   wasmReady,
          },
        });
      }
    }

    // ── Report hashrate + best hash every second ─────────────────────────────
    const now = Date.now();
    if (now - lastReport >= REPORT_MS) {
      const bestHex = bestHash ? bytesToHex(bestHash.slice().reverse()) : 'none';
      self.postMessage({ type: 'hashrate', value: hashCount, bestHash: bestHex });
      hashCount   = 0;
      bestHash    = null;  // reset for next interval
      lastReport  = now;
    }

    // ── Throttle CPU ────────────────────────────────────────────────────────
    // Always yield at least once per batch so 'stop' messages can be processed
    await sleep(THROTTLE > 0 ? THROTTLE : 0);
  }

  if (!running) {
    self.postMessage({ type: 'stopped' });
  }
}

// ─── Increment NONCE_2 (little-endian) ────────────────────────────────────────
function incrementNonce2(nonce2) {
  for (let i = 0; i < nonce2.length; i++) {
    nonce2[i]++;
    if (nonce2[i] !== 0) break; // no carry needed
  }
}

// ─── Compare two LE byte arrays as big-endian integers (MSB is last byte) ─────
function compareBytes(a, b) {
  for (let i = Math.min(a.length, b.length) - 1; i >= 0; i--) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
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
      modeThrottle = { eco: 15, balanced: 40, turbo: 75, monster: 100 }[mode] || 40;
      
      // Calculate idle ms per batch
      THROTTLE = Math.max(0, Math.floor((100 - modeThrottle) * 0.3));

      // Try to load WASM (don't block — fall back to JS if unavailable)
      await loadWasm();

      // If stop() was called during WASM load, don't start the loop
      if (!running) break;

      // Begin mining loop
      mineLoop().catch(err => {
        running = false;
        self.postMessage({ type: 'error', data: { message: err.message } });
      });
      break;

    case 'new_job':
      if (running && e.data.job) {
        currentJob = { ...e.data.job, mode: currentJob?.mode || 'balanced' };
        console.log(`[WORKER] New job received: ${currentJob.jobId} target.length=${currentJob.target?.length} target=${currentJob.target?.slice(0,20)}...`);
        // Tell the loop to randomize its nonce
        self._nextNonce = true;
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
  if (!hex || hex.length === 0) return new Uint8Array(0);
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
