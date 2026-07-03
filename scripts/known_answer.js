// Known-answer test: reconstruct the canonical VerusHash input from a REAL block
// and find which field-clearing reproduces the block's actual PoW hash.
'use strict';
const fs = require('fs'), path = require('path');
const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const rev = (hex) => hex.match(/../g).reverse().join('');
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'blk_fields.json'), 'utf8'));

async function loadWasm() {
  const bin = fs.readFileSync(path.join(__dirname, '..', 'client', 'public', 'wasm', 'verus_hash.wasm'));
  let mem; const die = (m) => { throw new Error('wasm ' + m); };
  const { instance } = await WebAssembly.instantiate(bin, { env: { __assert_fail: () => die('a'), _abort_js: () => die('b'), emscripten_resize_heap: (r) => { try { mem.grow(Math.ceil((Math.max(r >>> 0, mem.buffer.byteLength * 2) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } } }, wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 } });
  const ex = instance.exports; mem = ex.memory; ex.__wasm_call_ctors && ex.__wasm_call_ctors();
  const malloc = ex.malloc || ex._malloc, vh = ex.verus_hash || ex._verus_hash;
  const inPtr = malloc(4096), outPtr = malloc(32);
  return (bytes) => { new Uint8Array(mem.buffer).set(bytes, inPtr); vh(inPtr, bytes.length, outPtr); return new Uint8Array(mem.buffer).slice(outPtr, outPtr + 32); };
}

(async () => {
  const hash = await loadWasm();
  const sol = Buffer.from(F.solution, 'hex');           // 1344 bytes
  console.log(`block PoW hash (display): ${F.powHash}`);
  console.log(`block PoW hash (internal/rev): ${rev(F.powHash)}`);
  console.log(`version=${F.version} time=${F.time} solBytes=${sol.length}\n`);

  const verLE = Buffer.alloc(4); verLE.writeUInt32LE(F.version >>> 0);
  const timeLE = Buffer.alloc(4); timeLE.writeUInt32LE(F.time >>> 0);

  // Build a candidate 1487-byte input with a given clearing profile.
  function build({ clearHeader = true, clearTime = false, clearMMR = false, clearBits = true }) {
    const h = new Uint8Array(1487);
    h.set(verLE, 0);                                     // version kept
    if (!clearHeader) { /* would need real prevhash/merkle/sapling — only meaningful when NOT cleared */ }
    if (!clearTime) h.set(timeLE, 100);                  // time kept (default)
    if (!clearBits) { /* bits kept — need real bits; skip */ }
    // compactSize + solution
    h[140] = 0xfd; h[141] = 0x40; h[142] = 0x05;
    h.set(sol, 143);
    if (clearMMR) h.fill(0, 143 + 8, 143 + 8 + 64);      // zero hashPrevMMRRoot+hashBlockMMRRoot
    return h;
  }

  const want = rev(F.powHash);
  const wantD = F.powHash;
  const tryProfile = (name, opts) => {
    const h = hash(build(opts));
    const hx = bytesToHex(h);
    const match = hx === want ? 'MATCH(internal)' : rev(hx) === want ? 'MATCH(rev)' : hx === wantD ? 'MATCH(display)' : rev(hx) === wantD ? 'MATCH(revD)' : 'no';
    console.log(`  [${name}] -> ${hx.slice(0, 24)}…  ${match === 'no' ? 'no match' : '✅ ' + match}`);
    return match !== 'no';
  };

  console.log('candidate clearings (header prevhash/merkle/sapling/nonce always zeroed):');
  let hit = false;
  hit = tryProfile('time-kept, MMR-zeroed, bits-zeroed', { clearMMR: true, clearBits: true }) || hit;
  hit = tryProfile('time-kept, MMR-intact, bits-zeroed', { clearMMR: false, clearBits: true }) || hit;
  hit = tryProfile('time-zeroed, MMR-zeroed', { clearTime: true, clearMMR: true }) || hit;
  hit = tryProfile('time-zeroed, MMR-intact', { clearTime: true, clearMMR: false }) || hit;
  if (!hit) console.log('\n⚠️  none matched — header prevhash/merkle/sapling may NOT be fully cleared, or more fields differ.');
  else console.log('\n✅ found the exact clearing profile.');
})();
