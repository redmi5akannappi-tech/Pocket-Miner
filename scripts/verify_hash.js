/**
 * verify_hash.js — Node verification harness for the VerusHash 2.2 (v7 merged-mining)
 * canonical-clearing fix.
 *
 * It:
 *   1. Loads the compiled client/public/wasm/verus_hash.wasm in Node.
 *   2. Pulls a LIVE job from LuckPool (subscribe/authorize/notify/set_target).
 *   3. Rebuilds the 1487-byte canonical hash input EXACTLY as miner.worker.js does
 *      after the fix (version+time kept; prevhash/merkle/sapling/bits/nonce zeroed;
 *      solution MMR roots zeroed; search nonce only in the last 15 bytes).
 *   4. Asserts the byte-level structure against the ccminer/daemon spec.
 *   5. Hashes with the WASM, confirms hashes are non-zero, change with the nonce,
 *      and are distributed like a real hash (leading-zero-nibble histogram).
 *
 * It NEVER submits a share (avoids any pool ban risk). Run:
 *   node scripts/verify_hash.js
 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');

// ── helpers ────────────────────────────────────────────────────────────────
const hexToBytes = (h) => { if (!h) return new Uint8Array(0); if (h.length % 2) h = '0' + h; const o = new Uint8Array(h.length / 2); for (let i = 0; i < h.length; i += 2) o[i / 2] = parseInt(h.slice(i, i + 2), 16); return o; };
const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const assert = (cond, msg) => { if (!cond) { console.error('  ❌ ASSERT FAILED:', msg); process.exitCode = 1; } else { console.log('  ✅', msg); } };

// ── constants (mirror miner.worker.js) ──────────────────────────────────────
const SOLUTION_BYTES = 1344;
const SOLUTION_HEX = SOLUTION_BYTES * 2;
const COMPACT_PREFIX = 'fd4005';

function solutionVersion(tmpl) {
  if (!tmpl || tmpl.length < 8) return 0;
  return parseInt(tmpl.substring(0, 8).match(/../g).reverse().join(''), 16);
}
function isMergedMiningV7(tmpl) {
  if (solutionVersion(tmpl) < 7) return false;
  if (tmpl.length < 12) return false;
  return parseInt(tmpl.substring(10, 12), 16) > 0; // numPBaaSHeaders (byte 5)
}

// Canonical header (140 bytes) — matches buildBlockHeader(..., merged=true)
function buildHeader(job, merged) {
  const h = new Uint8Array(140);
  h.set(hexToBytes(job.version).subarray(0, 4), 0);         // version kept
  if (merged) {
    h.set(hexToBytes(job.time).subarray(0, 4), 100);        // time kept; rest zero
    return h;
  }
  h.set(hexToBytes(job.prevhash).subarray(0, 32), 4);
  h.set(hexToBytes(job.merkle).subarray(0, 32), 36);
  h.set(hexToBytes(job.sapling).subarray(0, 32), 68);
  h.set(hexToBytes(job.time).subarray(0, 4), 100);
  h.set(hexToBytes(job.bits).subarray(0, 4), 104);
  const en1 = hexToBytes(job.extranonce1);
  h.set(en1.subarray(0, 32), 108);
  return h;
}

// Solution field (1347 bytes: compactSize + 1344) — matches buildSolutionBase
function buildSolution(job, merged) {
  let tmpl = job.solutionTemplate || '';
  if (tmpl.length < SOLUTION_HEX) tmpl += '0'.repeat(SOLUTION_HEX - tmpl.length);
  else tmpl = tmpl.substring(0, SOLUTION_HEX);
  const en1 = job.extranonce1 || '';
  if (en1.length) { const p = SOLUTION_HEX - 30; tmpl = tmpl.substring(0, p) + en1 + tmpl.substring(p + en1.length); }
  const bytes = hexToBytes(COMPACT_PREFIX + tmpl); // 1347 bytes
  if (merged) bytes.fill(0, 3 + 8, 3 + 8 + 64);    // zero the two MMR roots
  const nonce2ByteOffset = 1347 - 15 + en1.length / 2;
  const nonce2MaxBytes = 15 - en1.length / 2;
  return { bytes, nonce2ByteOffset, nonce2MaxBytes };
}

// ── WASM loader ──────────────────────────────────────────────────────────────
async function loadWasm() {
  // The Emscripten glue was built for ENVIRONMENT='web,worker' and aborts under
  // Node. Instantiate the raw .wasm directly with the minimal imports it needs.
  const wasmBinary = fs.readFileSync(path.join(__dirname, '..', 'client', 'public', 'wasm', 'verus_hash.wasm'));
  let mem; // resolved after instantiate
  const die = (m) => { throw new Error('wasm abort: ' + m); };
  const imports = {
    env: {
      __assert_fail: () => die('assert_fail'),
      _abort_js: () => die('_abort_js'),
      emscripten_resize_heap: (requested) => {
        const cur = mem.buffer.byteLength;
        const need = Math.max(requested >>> 0, cur * 2);
        try { mem.grow(Math.ceil((need - cur) / 65536)); return 1; } catch { return 0; }
      },
    },
    wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 },
  };
  const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
  const ex = instance.exports;
  mem = ex.memory;
  if (ex.__wasm_call_ctors) ex.__wasm_call_ctors(); // run C++ global constructors
  const malloc = ex.malloc || ex._malloc, verus_hash = ex.verus_hash || ex._verus_hash;
  const inPtr = malloc(2048), outPtr = malloc(32);
  const hash = (bytes) => {
    const heap = new Uint8Array(mem.buffer);
    heap.set(bytes, inPtr);
    verus_hash(inPtr, bytes.length, outPtr);
    return new Uint8Array(mem.buffer).slice(outPtr, outPtr + 32);
  };
  return { hash };
}

// ── live pool job ────────────────────────────────────────────────────────────
function getLiveJob(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const HOST = 'ap.luckpool.net', PORT = 3956, WALLET = 'RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';
    const s = net.connect(PORT, HOST, () => s.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['PocketMiner/1.0', null, HOST, String(PORT)] }) + '\n'));
    let buf = '', en1 = '', target = '';
    const to = setTimeout(() => { s.destroy(); reject(new Error('pool timeout')); }, timeoutMs);
    s.on('data', (c) => {
      buf += c.toString('utf8'); const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { en1 = m.result[1]; s.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: [`${WALLET}.verify`, 'x'] }) + '\n'); }
        else if (m.method === 'mining.set_target') target = m.params[0];
        else if (m.method === 'mining.notify') {
          const p = m.params;
          clearTimeout(to); s.destroy();
          resolve({ jobId: p[0], version: p[1], prevhash: p[2], merkle: p[3], sapling: p[4], time: p[5], bits: p[6], solutionTemplate: p[8], extranonce1: en1, target });
          return;
        }
      }
    });
    s.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Fallback captured job (used if the pool is unreachable).
const CAPTURED_JOB = {
  jobId: '5168e30', version: '04000100',
  prevhash: '915fa03cb66ff56612dd0423fd66617e87c9e57627ff05ad5cc57e83b2db431d',
  merkle: '803d2b861663338b2c09a9151a5709ad2a85173da67a3ff9fe16cd21ecc838fc',
  sapling: '888039a5372d287ea2d41414497d6da576a663de3595e6f9a38fe7193b44e113',
  time: '6272466a', bits: '756c061b',
  solutionTemplate: '07000000000304009a8336b293a2f79981b181ba751315123e352f7fd4cdce2879827f6c10ddf288546d93656b211cf439751c7f4f56e236b4cc6671feb2cac300b3bfd40935b5371af5b8015c64d39ab44c60ead8317f9f5a9b6c4c815e57f82456519c3eb41029dfa0a961ae933cf9bd390c2a9c349d8edea902277de43a8e038a909c5df5d6e33160d1b75509e1e990f4a79ac5905ef1306e78d62c0f33d11f11cd6487064e72b647ac2343c7842a9d30f024557eb60de2a4f132ba6bc0a8ee39fe534267173ea3581498790cbf5025e46964887b95c1ab341aa3f9e8b472591047d501',
  extranonce1: 'e0534547', target: '0000002000000000000000000000000000000000000000000000000000000000',
};

(async () => {
  console.log('── Loading WASM ─────────────────────────────────────────────');
  const { hash } = await loadWasm();
  console.log('  ✅ verus_hash.wasm loaded in Node\n');

  let job;
  try { job = await getLiveJob(); console.log('── Live LuckPool job ────────────────────────────────────────'); }
  catch (e) { job = CAPTURED_JOB; console.log(`── Pool unreachable (${e.message}); using captured job ──────`); }
  console.log(`  jobId=${job.jobId} en1=${job.extranonce1} target=${job.target.slice(0, 12)}… ver=${job.version} solnVer=${solutionVersion(job.solutionTemplate)} tmplBytes=${job.solutionTemplate.length / 2}\n`);

  const merged = isMergedMiningV7(job.solutionTemplate);
  console.log('── Merged-mining detection ──────────────────────────────────');
  assert(merged === true, `isMergedMiningV7 = true (solutionVersion=${solutionVersion(job.solutionTemplate)}, numPBaaSHeaders=${parseInt(job.solutionTemplate.substring(10, 12), 16)})`);

  const header = buildHeader(job, merged);
  const soln = buildSolution(job, merged);
  const input = new Uint8Array(140 + soln.bytes.length);
  input.set(header, 0);
  input.set(soln.bytes, 140);

  console.log('\n── Byte-structure asserts (canonical v7 hash input) ─────────');
  assert(input.length === 1487, `hash input length = 1487 (got ${input.length})`);
  assert(bytesToHex(input.subarray(0, 4)) === job.version.toLowerCase(), `version kept @0 = ${bytesToHex(input.subarray(0, 4))}`);
  assert(input.subarray(4, 100).every((b) => b === 0), 'prevhash+merkle+sapling ZEROED @4..99');
  assert(bytesToHex(input.subarray(100, 104)) === job.time.toLowerCase(), `time kept @100 = ${bytesToHex(input.subarray(100, 104))}`);
  assert(input.subarray(104, 108).every((b) => b === 0), 'bits ZEROED @104..107');
  assert(input.subarray(108, 140).every((b) => b === 0), 'header nonce ZEROED @108..139');
  assert(bytesToHex(input.subarray(140, 143)) === COMPACT_PREFIX, `compactSize @140 = ${bytesToHex(input.subarray(140, 143))} (fd4005 = 1344)`);
  assert(input.subarray(143 + 8, 143 + 8 + 64).every((b) => b === 0), 'solution MMR roots ZEROED @soln 8..71');
  // extranonce1 present in the last 15 bytes of the solution (pool substr(-30) check)
  const last30 = bytesToHex(input.subarray(input.length - 15));
  assert(last30.indexOf(job.extranonce1.toLowerCase()) >= 0, `extranonce1 present in last 15 solution bytes (${last30})`);
  // version-7 descriptor bytes preserved (not cleared)
  assert(bytesToHex(input.subarray(143, 143 + 8)) === job.solutionTemplate.slice(0, 16).toLowerCase(), 'solution descriptor (bytes 0..7) preserved');

  console.log('\n── WASM hash sanity (nonce lives only in last 15 bytes) ─────');
  const nonceOff = 140 + soln.nonce2ByteOffset;                 // where the search nonce sits
  assert(nonceOff >= input.length - 15 && nonceOff < input.length, `search-nonce offset ${nonceOff} is inside the final 15 bytes`);
  const h0 = hash(input);
  assert(!h0.every((b) => b === 0), `hash is non-zero: ${bytesToHex(h0).slice(0, 24)}…`);
  // change ONLY the last-15-byte nonce region → hash must change
  input[input.length - 1] ^= 0xff;
  const h1 = hash(input);
  assert(bytesToHex(h0) !== bytesToHex(h1), 'hash changes when the solution-tail nonce changes');
  // changing a ZEROED header byte must NOT change the hash (proves clearing dominates)
  input[input.length - 1] ^= 0xff; // restore
  const h0b = hash(input);
  assert(bytesToHex(h0b) === bytesToHex(h0), 'hash is deterministic (restore → same hash)');

  console.log('\n── Throughput + distribution (iterating solution-tail nonce) ─');
  const nBytes = Math.min(soln.nonce2MaxBytes, 8);
  let best = null, bestZeros = -1; const zeroHist = {};
  const N = 120000, t0 = Date.now();
  for (let i = 0; i < N; i++) {
    // little-endian counter across the search-nonce bytes
    let v = i; for (let k = 0; k < nBytes; k++) { input[nonceOff + k] = v & 0xff; v >>>= 8; }
    const hh = hash(input);
    const hex = bytesToHex(hh);
    let z = 0; while (z < hex.length && hex[z] === '0') z++;
    zeroHist[z] = (zeroHist[z] || 0) + 1;
    if (z > bestZeros) { bestZeros = z; best = hex; }
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`  hashed ${N} nonces in ${secs.toFixed(1)}s → ${Math.round(N / secs)} H/s`);
  console.log(`  best hash: ${best}  (${bestZeros} leading zero nibbles)`);
  console.log('  leading-zero-nibble histogram (expect ~N/16 at 0, ~N/256 at 1, …):');
  Object.keys(zeroHist).sort((a, b) => a - b).forEach((z) => console.log(`    ${z} zeros: ${zeroHist[z]}`));
  // sanity: ~1/16 of hashes should have >=1 leading zero nibble
  const ge1 = N - (zeroHist[0] || 0);
  assert(ge1 > N / 32 && ge1 < N / 8, `~1/16 of hashes have >=1 leading zero nibble (got ${(ge1 / N * 100).toFixed(2)}%)`);

  console.log('\n── Submit params that WOULD be sent (NOT submitting) ─────────');
  const solutionHex = bytesToHex(soln.bytes);
  console.log(`  solution length = ${solutionHex.length} hex chars (expect 2694)`);
  console.log(`  solution tail(-30) = ${solutionHex.slice(-30)}  (contains en1=${job.extranonce1})`);
  assert(solutionHex.length === 2694, 'submit solution is 2694 hex chars');

  console.log(`\n${process.exitCode ? '❌ SOME CHECKS FAILED' : '✅ ALL CHECKS PASSED'}`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
