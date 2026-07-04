'use strict';
// verify_bitslice_wasm.js — validate the COMPILED WASM-SIMD bitsliced Haraka
// (haraka_bitslice.inc) against the node-validated blueprint (bitslice_cmodel.js).
// Run AFTER building the turbo binary in WSL:
//     node scripts/verify_bitslice_wasm.js
// Exercises the self-test exports over many random vectors and localizes any
// mismatch to ortho / round / haraka512_x2 / haraka256_x4. This is the granular
// gate the plan calls for — it pins the SIMD intrinsics before verify_batch.js
// (full-hash equivalence) is trusted.
const fs = require('fs');
const path = require('path');
const cm = require('./bitslice_cmodel.js');
const WASM = path.join(__dirname, '..', 'client', 'public', 'wasm', 'verus_hash_simd.wasm');

async function load() {
  const bin = fs.readFileSync(WASM);
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
  const pick = (n) => ex[n] || ex['_' + n];
  const need = ['malloc', 'bs_selftest_round', 'bs_selftest_h512x2', 'bs_selftest_h256x4'];
  const fns = {}; const missing = [];
  for (const n of need) { const f = pick(n); if (!f) missing.push(n); else fns[n] = f; }
  return { ex, mem, fns, missing };
}

const rnd = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0; return a; };
const eq = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const hex = (a) => Buffer.from(a).toString('hex');

(async () => {
  let w;
  try { w = await load(); }
  catch (e) { console.log('FAIL: could not load verus_hash_simd.wasm —', e.message); process.exit(1); }
  if (w.missing.length) {
    console.log('FAIL: turbo binary missing self-test exports:', w.missing.join(', '));
    console.log('  → rebuild: cd scripts && bash compile-verus-wasm.sh   (needs the bitslice patch)');
    process.exit(1);
  }
  const heap = () => new Uint8Array(w.mem.buffer);
  const P = { a: w.fns.malloc(256), b: w.fns.malloc(256), c: w.fns.malloc(256), d: w.fns.malloc(256) };
  const put = (ptr, bytes) => heap().set(bytes, ptr);
  const get = (ptr, n) => heap().slice(ptr, ptr + n);
  let fail = 0;

  // ── (1) ortho + round in isolation ──
  { let bad = 0; const N = 5000;
    for (let it = 0; it < N; it++) {
      const blocks = rnd(128), keys = rnd(128);
      put(P.a, blocks); put(P.b, keys);
      w.fns.bs_selftest_round(P.a, P.b, P.c, P.d);
      const planesGot = get(P.c, 128), roundGot = get(P.d, 128);
      // cmodel expected
      const blkArr = Array.from({ length: 8 }, (_, i) => blocks.subarray(i * 16, i * 16 + 16));
      const keyArr = Array.from({ length: 8 }, (_, i) => keys.subarray(i * 16, i * 16 + 16));
      const planesExp = new Uint8Array(128);
      const pC = cm.toPlanesC(blkArr); for (let i = 0; i < 8; i++) planesExp.set(cm.bigToBytes(pC[i]), i * 16);
      const q = cm.toPlanesC(blkArr); cm.cRound(q, cm.toPlanesC(keyArr));
      const roundExp = new Uint8Array(128);
      const rb = cm.fromPlanesC(q); for (let i = 0; i < 8; i++) roundExp.set(rb[i], i * 16);
      if (!eq(planesGot, planesExp)) { if (bad < 3) console.log(`ORTHO mismatch it=${it}\n  got ${hex(planesGot)}\n  exp ${hex(planesExp)}`); bad++; }
      else if (!eq(roundGot, roundExp)) { if (bad < 3) console.log(`ROUND mismatch it=${it}\n  got ${hex(roundGot)}\n  exp ${hex(roundExp)}`); bad++; }
    }
    fail += bad; console.log(bad === 0 ? `PASS: wasm ortho+round == cmodel over ${N} vectors` : `FAIL: ortho/round ${bad} mismatches`);
  }

  // ── (2) haraka512_port_x2 ──
  { let bad = 0; const N = 5000;
    for (let it = 0; it < N; it++) {
      const in2 = rnd(128); put(P.a, in2);
      w.fns.bs_selftest_h512x2(P.a, P.c);
      const got = get(P.c, 64);
      const exp = cm.cmodel_haraka512_port([in2.subarray(0, 64), in2.subarray(64, 128)]);
      const expFlat = new Uint8Array(64); expFlat.set(exp[0], 0); expFlat.set(exp[1], 32);
      if (!eq(got, expFlat)) { if (bad < 3) console.log(`H512x2 mismatch it=${it}\n  got ${hex(got)}\n  exp ${hex(expFlat)}`); bad++; }
    }
    fail += bad; console.log(bad === 0 ? `PASS: wasm haraka512_port_x2 == cmodel over ${N} vectors` : `FAIL: h512x2 ${bad} mismatches`);
  }

  // ── (3) haraka256_port_x4 ──
  { let bad = 0; const N = 5000;
    for (let it = 0; it < N; it++) {
      const in4 = rnd(128); put(P.a, in4);
      w.fns.bs_selftest_h256x4(P.a, P.c);
      const got = get(P.c, 128);
      const ins = Array.from({ length: 4 }, (_, s) => in4.subarray(s * 32, s * 32 + 32));
      const exp = cm.cmodel_haraka256_port(ins);
      const expFlat = new Uint8Array(128); for (let s = 0; s < 4; s++) expFlat.set(exp[s], s * 32);
      if (!eq(got, expFlat)) { if (bad < 3) console.log(`H256x4 mismatch it=${it}\n  got ${hex(got)}\n  exp ${hex(expFlat)}`); bad++; }
    }
    fail += bad; console.log(bad === 0 ? `PASS: wasm haraka256_port_x4 == cmodel over ${N} vectors` : `FAIL: h256x4 ${bad} mismatches`);
  }

  console.log(fail === 0
    ? '\n✅ ALL PASS — compiled SIMD bitsliced Haraka is bit-exact. Safe to wire into verus_hash_batch.'
    : '\n❌ FAIL — do NOT wire in yet; the mismatch above localizes the bug (ortho vs round vs perm).');
  process.exit(fail === 0 ? 0 : 1);
})();
