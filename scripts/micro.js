// A/B micro-test: does the nonce-increment method affect hash distinctness?
'use strict';
const fs = require('fs'), path = require('path');
const hexToBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < h.length; i += 2) o[i / 2] = parseInt(h.slice(i, i + 2), 16); return o; };
const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const SOLUTION_HEX = 2688, COMPACT_PREFIX = 'fd4005';

async function loadWasm() {
  const bin = fs.readFileSync(path.join(__dirname, '..', 'client', 'public', 'wasm', 'verus_hash.wasm'));
  let mem; const die = (m) => { throw new Error('wasm ' + m); };
  const { instance } = await WebAssembly.instantiate(bin, { env: { __assert_fail: () => die('a'), _abort_js: () => die('b'), emscripten_resize_heap: (r) => { try { mem.grow(Math.ceil((Math.max(r >>> 0, mem.buffer.byteLength * 2) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } } }, wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 } });
  const ex = instance.exports; mem = ex.memory; ex.__wasm_call_ctors && ex.__wasm_call_ctors();
  const malloc = ex.malloc || ex._malloc, vh = ex.verus_hash || ex._verus_hash;
  const inPtr = malloc(2048), outPtr = malloc(32);
  return (bytes) => { new Uint8Array(mem.buffer).set(bytes, inPtr); vh(inPtr, bytes.length, outPtr); return new Uint8Array(mem.buffer).slice(outPtr, outPtr + 32); };
}

const JOB = require('./_capjob.js');

(async () => {
  const hash = await loadWasm();
  let t = JOB.solutionTemplate; t = t.length < SOLUTION_HEX ? t + '0'.repeat(SOLUTION_HEX - t.length) : t.substring(0, SOLUTION_HEX);
  const en1 = JOB.extranonce1; { const p = SOLUTION_HEX - 30; t = t.substring(0, p) + en1 + t.substring(p + en1.length); }
  const sol = hexToBytes(COMPACT_PREFIX + t); sol.fill(0, 11, 75);
  const hdr = new Uint8Array(140); hdr.set(hexToBytes(JOB.version).subarray(0, 4), 0); hdr.set(hexToBytes(JOB.time).subarray(0, 4), 100);
  const base = new Uint8Array(140 + sol.length); base.set(hdr, 0); base.set(sol, 140);
  const nOff = 140 + (1347 - 15 + en1.length / 2), nLen = 15 - en1.length / 2;

  const run = (label, N, mutate) => {
    const input = base.slice(); let best = null; const hist = {}; const seen = new Set();
    for (let i = 0; i < N; i++) {
      mutate(input, i);
      const h = hash(input); const hx = bytesToHex(h);
      let z = 0; while (hx[z] === '0') z++; hist[z] = (hist[z] || 0) + 1;
      if (!best || hx < best) best = hx;
      if (i < 200000) seen.add(hx.slice(0, 16)); // distinctness sample
    }
    console.log(`\n[${label}] N=${N}  best=${best.slice(0, 16)}  distinct(first200k,16hexprefix)=${seen.size}`);
    console.log('  zero-nibble hist:', Object.keys(hist).sort((a, b) => a - b).map((z) => `${z}:${hist[z]}`).join('  '));
  };

  // ── byte-sensitivity map: flip each tail byte, see if the hash changes ──
  console.log('byte-sensitivity of the final 20 bytes (input len ' + base.length + ', nOff=' + nOff + ', nLen=' + nLen + '):');
  const h0 = bytesToHex(hash(base));
  for (let off = base.length - 20; off < base.length; off++) {
    const probe = base.slice(); probe[off] ^= 0xff;
    const changed = bytesToHex(hash(probe)) !== h0;
    console.log(`  byte ${off} (tail idx ${off - (base.length - 15)}): ${changed ? 'AFFECTS hash' : '— no effect'}`);
  }

  const N = 400000;
  // Method A: verify_hash counter-write (8-byte LE counter at nOff)
  run('A counter-write', N, (input, i) => { let v = i; for (let k = 0; k < Math.min(nLen, 8); k++) { input[nOff + k] = v & 0xff; v = Math.floor(v / 256); } });
  // Method B: mine_test ++nonce (persistent LE increment across nLen-1 bytes)
  const nonce = new Uint8Array(nLen); for (let k = 0; k < nLen; k++) nonce[k] = (Math.random() * 256) | 0; nonce[nLen - 1] = 3;
  const input = base.slice();
  console.log('\n[B debug]');
  for (let i = 0; i < 100001; i++) {
    for (let k = 0; k < nLen - 1; k++) { if (++nonce[k]) break; }
    input.set(nonce, nOff);
    if (i === 0 || i === 300 || i === 100000) {
      console.log(`  i=${i} nonce=${bytesToHex(nonce)} input[${nOff}..${nOff + 4}]=${bytesToHex(input.subarray(nOff, nOff + 5))} hash=${bytesToHex(hash(input)).slice(0, 16)}`);
    }
  }
  run('B ++nonce', N, (input) => { for (let k = 0; k < nLen - 1; k++) { if (++nonce[k]) break; } input.set(nonce, nOff); });
})();
