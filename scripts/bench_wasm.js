'use strict';
// Raw single-thread VerusHash throughput: baseline vs SIMD binary, and
// per-hash boundary cost (single verus_hash calls vs one verus_hash_batch call).
const fs = require('fs');
const path = require('path');
const WASM_DIR = path.join(__dirname, '..', 'client', 'public', 'wasm');

async function load(file) {
  const bin = fs.readFileSync(path.join(WASM_DIR, file));
  let mem; const die = (m) => { throw new Error('wasm ' + m); };
  const { instance } = await WebAssembly.instantiate(bin, {
    env: { __assert_fail: () => die('a'), _abort_js: () => die('b'),
      emscripten_resize_heap: (r) => { try { mem.grow(Math.ceil((Math.max(r >>> 0, mem.buffer.byteLength * 2) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } } },
    wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 },
  });
  const ex = instance.exports; mem = ex.memory;
  ex.__wasm_call_ctors && ex.__wasm_call_ctors();
  const malloc = ex.malloc || ex._malloc, vh = ex.verus_hash || ex._verus_hash, vhb = ex.verus_hash_batch || ex._verus_hash_batch;
  const inPtr = malloc(2048), outPtr = malloc(32), tgtPtr = malloc(32);
  const heap = () => new Uint8Array(mem.buffer);
  return { heap, inPtr, outPtr, tgtPtr,
    single: (b) => { heap().set(b, inPtr); vh(inPtr, b.length, outPtr); },
    batch: (len, nrel, ilen, it) => vhb(inPtr, len, nrel, ilen, it, tgtPtr, outPtr, 0) };
}

(async () => {
  const LEN = 1487, nrel = 1476, ilen = 11, ITERS = 40000;
  const base = new Uint8Array(LEN); for (let i = 0; i < LEN; i++) base[i] = (i * 131 + 7) & 0xff;

  for (const file of ['verus_hash.wasm', 'verus_hash_simd.wasm']) {
    const w = await load(file);
    // warm up
    w.heap().set(base, w.inPtr); for (let i = 0; i < 2000; i++) w.single(base);

    // (A) per-hash path: JS drives each hash (boundary crossing + copy per hash)
    let t = process.hrtime.bigint();
    for (let i = 0; i < ITERS; i++) { base[nrel] = i & 0xff; w.single(base); }
    let msSingle = Number(process.hrtime.bigint() - t) / 1e6;

    // (B) batch path: one call, unreachable target so it runs all ITERS in-WASM
    w.heap().set(base, w.inPtr); w.heap().set(new Uint8Array(32), w.tgtPtr);
    t = process.hrtime.bigint();
    w.batch(LEN, nrel, ilen, ITERS);
    let msBatch = Number(process.hrtime.bigint() - t) / 1e6;

    const khA = (ITERS / msSingle).toFixed(1), khB = (ITERS / msBatch).toFixed(1);
    console.log(`\n=== ${file} ===`);
    console.log(`  per-hash (JS loop): ${msSingle.toFixed(0)} ms  → ${khA} KH/s/thread`);
    console.log(`  batch  (in-WASM)  : ${msBatch.toFixed(0)} ms  → ${khB} KH/s/thread`);
    console.log(`  batch speedup     : ${(msSingle / msBatch).toFixed(2)}x  (removes the JS↔WASM per-hash cost)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
