/**
 * mine_test.js — end-to-end LuckPool miner using the FIXED v7 canonical-clearing
 * reconstruction. Connects, mines across N worker threads with the real WASM, and
 * SUBMITS real shares to the pool, logging the pool's accept/reject verdict.
 *
 * This is the definitive test that our hash == the pool's hash: if the pool accepts
 * a share, the fix is correct end-to-end.
 *
 *   node scripts/mine_test.js            # uses (cores-1) threads
 *   node scripts/mine_test.js 4          # force 4 threads
 */
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── shared helpers ───────────────────────────────────────────────────────────
const hexToBytes = (h) => { if (!h) return new Uint8Array(0); if (h.length % 2) h = '0' + h; const o = new Uint8Array(h.length / 2); for (let i = 0; i < h.length; i += 2) o[i / 2] = parseInt(h.slice(i, i + 2), 16); return o; };
const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const SOLUTION_HEX = 2688, COMPACT_PREFIX = 'fd4005';
const solutionVersion = (t) => (!t || t.length < 8) ? 0 : parseInt(t.substring(0, 8).match(/../g).reverse().join(''), 16);
const isMergedV7 = (t) => solutionVersion(t) >= 7 && t.length >= 12 && parseInt(t.substring(10, 12), 16) > 0;

function buildHeader(job, merged) {
  const h = new Uint8Array(140);
  h.set(hexToBytes(job.version).subarray(0, 4), 0);
  if (merged) { h.set(hexToBytes(job.time).subarray(0, 4), 100); return h; }
  h.set(hexToBytes(job.prevhash).subarray(0, 32), 4);
  h.set(hexToBytes(job.merkle).subarray(0, 32), 36);
  h.set(hexToBytes(job.sapling).subarray(0, 32), 68);
  h.set(hexToBytes(job.time).subarray(0, 4), 100);
  h.set(hexToBytes(job.bits).subarray(0, 4), 104);
  h.set(hexToBytes(job.extranonce1).subarray(0, 32), 108);
  return h;
}
function buildSolution(job, merged) {
  let t = job.solutionTemplate || '';
  t = t.length < SOLUTION_HEX ? t + '0'.repeat(SOLUTION_HEX - t.length) : t.substring(0, SOLUTION_HEX);
  const en1 = job.extranonce1 || '';
  if (en1.length) { const p = SOLUTION_HEX - 30; t = t.substring(0, p) + en1 + t.substring(p + en1.length); }
  const bytes = hexToBytes(COMPACT_PREFIX + t); // MMR roots kept INTACT here
  return { bytes, nonce2ByteOffset: 1347 - 15 + en1.length / 2, nonce2MaxBytes: 15 - en1.length / 2 };
}
function meetsTarget(hash, targetBytes) {
  // hash is little-endian (raw); target is big-endian. Compare reversed.
  for (let i = 0; i < 32; i++) { const hb = hash[31 - i]; if (hb < targetBytes[i]) return true; if (hb > targetBytes[i]) return false; }
  return true;
}

// ── WASM (manual instantiation; glue is web/worker-only) ─────────────────────
async function loadWasm() {
  // WASM=verus_hash_simd.wasm validates the turbo (SIMD) binary against the pool.
  const wasmFile = process.env.WASM || 'verus_hash.wasm';
  const bin = fs.readFileSync(path.join(__dirname, '..', 'client', 'public', 'wasm', wasmFile));
  let mem; const die = (m) => { throw new Error('wasm ' + m); };
  const { instance } = await WebAssembly.instantiate(bin, {
    env: { __assert_fail: () => die('assert'), _abort_js: () => die('abort'),
      emscripten_resize_heap: (r) => { try { mem.grow(Math.ceil((Math.max(r >>> 0, mem.buffer.byteLength * 2) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } } },
    wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 },
  });
  const ex = instance.exports; mem = ex.memory;
  ex.__wasm_call_ctors && ex.__wasm_call_ctors();
  const malloc = ex.malloc || ex._malloc, vh = ex.verus_hash || ex._verus_hash;
  const vhb = ex.verus_hash_batch || ex._verus_hash_batch;
  const inPtr = malloc(2048), outPtr = malloc(32), tgtPtr = malloc(32);
  const heap = () => new Uint8Array(mem.buffer);
  const hash = (bytes) => { heap().set(bytes, inPtr); vh(inPtr, bytes.length, outPtr); return heap().slice(outPtr, outPtr + 32); };
  // Fast path: run the whole loop inside WASM. Returns the winning index (buffer +
  // outPtr left at the winner) or -1. nonceRel is relative to the input start.
  const batch = vhb ? (inputLen, nonceRel, incLen, iters) => vhb(inPtr, inputLen, nonceRel, incLen, iters, tgtPtr, outPtr, 0) : null;
  return { hash, batch, heap, inPtr, outPtr, tgtPtr, hasBatch: !!vhb };
}

// ═══════════════════════════ WORKER ═══════════════════════════════════════════
if (!isMainThread) {
  (async () => {
    const wasm = await loadWasm();
    const hash = wasm.hash;
    // BATCH=1 exercises the new in-WASM verus_hash_batch loop (fast path).
    const USE_BATCH = process.env.BATCH === '1' && wasm.hasBatch;
    if (process.env.BATCH === '1' && !wasm.hasBatch) {
      console.log(`[worker ${workerData.id}] ⚠️ BATCH requested but verus_hash_batch not exported — rebuild WASM; using per-hash loop`);
    }
    let job = null, targetBytes = null, input = null, inputLen = 0, nOff = 0, nLen = 0, nonce = null, merged = false, origMMR = null;
    let count = 0;
    const setJob = (j) => {
      job = j; merged = isMergedV7(j.solutionTemplate);
      targetBytes = hexToBytes(j.target.padEnd(64, '0'));
      const sol = buildSolution(j, merged), hdr = buildHeader(j, merged);
      input = new Uint8Array(140 + sol.bytes.length); input.set(hdr, 0); input.set(sol.bytes, 140);
      // Zero the two MMR roots (solution bytes 8..71) for HASHING only; keep the
      // originals to restore in the SUBMITTED solution (pool validates them).
      if (merged) { origMMR = input.slice(140 + 11, 140 + 75); input.fill(0, 140 + 11, 140 + 75); } else origMMR = null;
      nOff = 140 + sol.nonce2ByteOffset; nLen = sol.nonce2MaxBytes;
      inputLen = input.length;
      nonce = new Uint8Array(nLen);
      // unique per-worker start so threads don't overlap
      for (let k = 0; k < nLen; k++) nonce[k] = (Math.random() * 256) | 0;
      nonce[nLen - 1] = workerData.id; // last byte = worker id namespace
      if (USE_BATCH) {
        // Seed the counting nonce into the resident buffer, then hand the whole
        // input + target to the WASM heap once. The batch loop mutates it in place.
        input.set(nonce, nOff);
        const heap = wasm.heap();
        heap.set(input, wasm.inPtr);
        heap.set(targetBytes.subarray(0, 32), wasm.tgtPtr);
      }
    };
    let best = null; // lowest hash seen this interval (Uint8Array, compared big-endian)
    const lower = (a, b) => { for (let i = 0; i < 32; i++) { if (a[31 - i] < b[31 - i]) return true; if (a[31 - i] > b[31 - i]) return false; } return false; };
    parentPort.on('message', (m) => { if (m.job) setJob(m.job); });
    const tick = () => {
      if (!job) return setTimeout(tick, 50);

      // ── FAST PATH: whole batch inside WASM ────────────────────────────────
      if (USE_BATCH) {
        const ITERS = 20000;
        // inc_len = nLen-1 keeps the last byte as this worker's namespace (the
        // per-hash loop above increments the same low bytes).
        const idx = wasm.batch(inputLen, nOff, nLen - 1, ITERS);
        count += idx < 0 ? ITERS : idx + 1;
        if (idx >= 0) {
          const heap = wasm.heap();
          const h = heap.slice(wasm.outPtr, wasm.outPtr + 32);
          if (!best || lower(h, best)) best = h.slice();
          const solField = heap.slice(wasm.inPtr + 140, wasm.inPtr + inputLen); // MMR-zeroed + winning nonce
          if (origMMR) solField.set(origMMR, 11);                               // restore intact MMR
          const solutionHex = bytesToHex(solField);
          const counting = bytesToHex(heap.slice(wasm.inPtr + nOff, wasm.inPtr + nOff + nLen));
          parentPort.postMessage({ share: { jobId: job.jobId, time: job.time, hash: bytesToHex(h.slice().reverse()),
            counting, solutionHex, en1: job.extranonce1 } });
        }
        return setImmediate(tick);
      }

      // ── COMPAT PATH: per-hash JS loop ─────────────────────────────────────
      for (let i = 0; i < 20000; i++) {
        for (let k = 0; k < nLen - 1; k++) { nonce[k]++; if (nonce[k] !== 0) break; } // check STORED value; ++arr[k] returns 256 (truthy) on wrap
        input.set(nonce, nOff);
        const h = hash(input); count++;
        if (!best || lower(h, best)) best = h.slice();
        if (meetsTarget(h, targetBytes)) {
          const solField = input.subarray(140).slice();       // MMR-zeroed + winning nonce
          if (origMMR) solField.set(origMMR, 11);              // restore intact MMR for submission
          const solutionHex = bytesToHex(solField);            // 1347 bytes, MMR intact, tail = en1∥nonce
          const counting = bytesToHex(input.subarray(nOff, nOff + nLen)); // our 11-byte counting nonce
          parentPort.postMessage({ share: { jobId: job.jobId, time: job.time, hash: bytesToHex(h.slice().reverse()),
            counting, solutionHex, en1: job.extranonce1 } });
        }
      }
      setImmediate(tick);
    };
    setInterval(() => { parentPort.postMessage({ count, best: best ? bytesToHex(best.slice().reverse()) : null }); count = 0; best = null; }, 5000);
    tick();
  })();
}

// ═══════════════════════════ MAIN ════════════════════════════════════════════
else {
  const net = require('net');
  const HOST = 'ap.luckpool.net', PORT = 3956, WALLET = 'RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';
  const NTHREADS = parseInt(process.argv[2] || '', 10) || Math.max(1, os.cpus().length - 1);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let en1 = '', target = '', curJob = null, submitId = 10, bestEver = null;
  const rates = new Array(NTHREADS).fill(0);
  const workers = [];
  const pending = new Map(); // submitId -> hash

  const sock = net.connect(PORT, HOST, () => { log('connected'); sock.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['PocketMiner/1.0', null, HOST, String(PORT)] }) + '\n'); });
  let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf8'); const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) { en1 = m.result[1]; log('extranonce1', en1); sock.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: [`${WALLET}.minetest`, 'x'] }) + '\n'); }
      else if (m.id === 2) log('authorized', m.result);
      else if (m.method === 'mining.set_target') { target = m.params[0]; log('target', target.slice(0, 14) + '…'); }
      else if (m.method === 'mining.notify') {
        const p = m.params;
        curJob = { jobId: p[0], version: p[1], prevhash: p[2], merkle: p[3], sapling: p[4], time: p[5], bits: p[6], solutionTemplate: p[8], extranonce1: en1, target };
        log(`job ${curJob.jobId} merged=${isMergedV7(curJob.solutionTemplate)} solnVer=${solutionVersion(curJob.solutionTemplate)}`);
        workers.forEach((w) => w.postMessage({ job: curJob }));
      } else if (typeof m.id === 'number' && m.id >= 10) {
        const meta = pending.get(m.id); pending.delete(m.id);
        const tag = meta ? meta.variant : '?';
        if (m.result) log(`✅✅ SHARE ACCEPTED (id ${m.id}) VARIANT="${tag}" — THIS IS THE CORRECT ENCODING`);
        else log(`❌ rejected (id ${m.id}) variant="${tag}": ${JSON.stringify(m.error)}`);
      }
    }
  });
  sock.on('error', (e) => { log('SOCKET ERROR', e.message); process.exit(1); });
  sock.on('close', () => { log('socket closed'); process.exit(0); });

  const submit = (s) => {
    if (!en1) return;
    // nheqminer format: nonce param = 28-byte header-nonce tail (en1 stripped) = our counting nonce.
    const id = submitId++; pending.set(id, { variant: 'be-fixed', hash: s.hash });
    log(`🎯 found hashBE=${s.hash.slice(0, 24)}… → submitting (id ${id})`);
    sock.write(JSON.stringify({ id, method: 'mining.submit', params: [`${WALLET}.minetest`, s.jobId, s.time, s.counting, s.solutionHex] }) + '\n');
  };

  for (let i = 0; i < NTHREADS; i++) {
    const w = new Worker(__filename, { workerData: { id: i } });
    w.on('message', (m) => { if (m.share) submit(m.share); else if (typeof m.count === 'number') { rates[i] = m.count; if (m.best && (!bestEver || m.best < bestEver)) bestEver = m.best; } });
    w.on('error', (e) => log(`worker ${i} error`, e.message));
    workers.push(w);
  }
  log(`mining with ${NTHREADS} threads — path=${process.env.BATCH === '1' ? 'FAST (verus_hash_batch)' : 'compat (per-hash)'} — will submit real shares and report pool verdicts`);
  setInterval(() => { const hs = rates.reduce((a, b) => a + b, 0) / 5; log(`~${(hs / 1000).toFixed(1)} KH/s (${NTHREADS}T)  bestEver=${bestEver || 'none'}  target=${target.slice(0, 12)}`); }, 30000);
}
