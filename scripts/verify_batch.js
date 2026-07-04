'use strict';
// No-network correctness check for verus_hash_batch.
// Proves: batch loop === looping the single verus_hash (increment/offset/target
// logic), and that the SIMD binary hashes identically to the baseline.
//   node scripts/verify_batch.js
const fs = require('fs');
const path = require('path');
const WASM_DIR = path.join(__dirname, '..', 'client', 'public', 'wasm');

async function load(file) {
  const bin = fs.readFileSync(path.join(WASM_DIR, file));
  let mem; const die = (m) => { throw new Error('wasm ' + m); };
  const { instance } = await WebAssembly.instantiate(bin, {
    env: {
      __assert_fail: () => die('assert'), _abort_js: () => die('abort'),
      emscripten_resize_heap: (r) => { try { mem.grow(Math.ceil((Math.max(r >>> 0, mem.buffer.byteLength * 2) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } },
    },
    wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 },
  });
  const ex = instance.exports; mem = ex.memory;
  ex.__wasm_call_ctors && ex.__wasm_call_ctors();
  const malloc = ex.malloc || ex._malloc, vh = ex.verus_hash || ex._verus_hash, vhb = ex.verus_hash_batch || ex._verus_hash_batch;
  const inPtr = malloc(2048), outPtr = malloc(32), tgtPtr = malloc(32);
  const heap = () => new Uint8Array(mem.buffer);
  return {
    hasBatch: !!vhb, heap, inPtr, outPtr, tgtPtr,
    single: (bytes) => { heap().set(bytes, inPtr); vh(inPtr, bytes.length, outPtr); return heap().slice(outPtr, outPtr + 32); },
    batch: (inputLen, nonceRel, incLen, iters) => vhb(inPtr, inputLen, nonceRel, incLen, iters, tgtPtr, outPtr, 0),
  };
}

// Post-increment then check the STORED value: on a Uint8Array, `++p[i]` evaluates
// to the untruncated 256 on wrap, so it must not gate the carry (matches C uint8_t
// ++ semantics and the worker's incrementNonce2).
const incLE = (p, off, len) => { for (let k = 0; k < len; k++) { p[off + k]++; if (p[off + k] !== 0) break; } };
const rev = (h) => { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = h[31 - i]; return r; };
// Compare two big-endian 32-byte arrays (MSB = index 0).
const cmpBEarr = (a, b) => { for (let i = 0; i < 32; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
// Matches C meets_target: reverse(rawHash) as big-endian <= target(big-endian).
const meets = (rawHash, targetBE) => cmpBEarr(rev(rawHash), targetBE) <= 0;
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

(async () => {
  const INPUT_LEN = 1487, nonceRel = 1476, incLen = 11, N = 2000;
  const firstHash = {};
  let allOK = true;

  for (const file of ['verus_hash.wasm', 'verus_hash_simd.wasm']) {
    const w = await load(file);
    if (!w.hasBatch) { console.log(`${file}: NO verus_hash_batch export — rebuild needed`); allOK = false; continue; }

    const base = new Uint8Array(INPUT_LEN);
    for (let i = 0; i < INPUT_LEN; i++) base[i] = (i * 131 + 7) & 0xff;
    for (let k = 0; k < incLen; k++) base[nonceRel + k] = 0;    // zero nonce seed

    // Reference: manual increment-first per-hash scan.
    const js = base.slice(); const hashes = [];
    for (let i = 0; i < N; i++) { incLE(js, nonceRel, incLen); hashes.push(w.single(js)); }

    // Target = the MINIMUM display hash (reverse of raw) across the scan → forces
    // the loop to iterate deep before the winner, exercising compare many times.
    const disp = hashes.map(rev);
    let idxMin = 0;
    for (let i = 1; i < N; i++) if (cmpBEarr(disp[i], disp[idxMin]) < 0) idxMin = i;
    const target = disp[idxMin].slice();   // big-endian threshold, as the pool sends
    let expIdx = -1;
    for (let i = 0; i < N; i++) { if (meets(hashes[i], target)) { expIdx = i; break; } }

    // (1) WIN path — batch from the same seed should land on the deep winner.
    w.heap().set(base, w.inPtr);
    w.heap().set(target, w.tgtPtr);
    const idx = w.batch(INPUT_LEN, nonceRel, incLen, N);
    const outHash = w.heap().slice(w.outPtr, w.outPtr + 32);
    const jsN = base.slice(); for (let i = 0; i <= idx; i++) incLE(jsN, nonceRel, incLen);
    const heapNonce = w.heap().slice(w.inPtr + nonceRel, w.inPtr + nonceRel + incLen);

    const idxOK = idx === expIdx;
    const hashOK = idx >= 0 && eq(outHash, hashes[idx]);
    const nonceOK = eq(heapNonce, jsN.slice(nonceRel, nonceRel + incLen));

    // (2) NO-WIN path — an all-zero target is unreachable; expect -1 and the nonce
    // advanced by exactly N (the whole batch ran).
    w.heap().set(base, w.inPtr);
    w.heap().set(new Uint8Array(32), w.tgtPtr);
    const idxNone = w.batch(INPUT_LEN, nonceRel, incLen, N);
    const jsAll = base.slice(); for (let i = 0; i < N; i++) incLE(jsAll, nonceRel, incLen);
    const heapAll = w.heap().slice(w.inPtr + nonceRel, w.inPtr + nonceRel + incLen);
    const noneOK = idxNone === -1 && eq(heapAll, jsAll.slice(nonceRel, nonceRel + incLen));

    allOK = allOK && idxOK && hashOK && nonceOK && noneOK;

    console.log(`\n=== ${file} ===`);
    console.log(`  deep winner index   expected=${expIdx}  batch=${idx}   ${idxOK ? 'OK' : 'MISMATCH'}`);
    console.log(`  out_hash == ref      ${hashOK ? 'OK' : 'MISMATCH'}`);
    console.log(`  heap nonce advanced  ${nonceOK ? 'OK' : 'MISMATCH'}`);
    console.log(`  no-win → -1, ran all ${noneOK ? 'OK' : 'MISMATCH'} (idx=${idxNone})`);
    if (!noneOK) console.log(`    heapNonce=${Buffer.from(heapAll).toString('hex')} expected=${Buffer.from(jsAll.slice(nonceRel, nonceRel + incLen)).toString('hex')}`);
    firstHash[file] = hashes[0];
  }

  const a = firstHash['verus_hash.wasm'], b = firstHash['verus_hash_simd.wasm'];
  if (a && b) {
    const same = eq(a, b); allOK = allOK && same;
    console.log(`\nbaseline vs SIMD identical hash (same input): ${same ? 'OK' : 'MISMATCH'}`);
    console.log(`  baseline: ${Buffer.from(a).toString('hex')}`);
    console.log(`  simd    : ${Buffer.from(b).toString('hex')}`);
  }

  console.log(`\n${allOK ? '✅ ALL CHECKS PASSED — batch loop is consistent with single-hash on both binaries' : '❌ FAILURES ABOVE'}`);
  process.exit(allOK ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
