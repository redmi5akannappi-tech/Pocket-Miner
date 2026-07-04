# VerusHash WASM Miner — Optimization Notes

> Context doc so future sessions (and other chats) don't re-derive this. Last updated 2026-07-04.

## What this project is
Browser VerusCoin miner. Computes **VerusHash 2.2** in WASM, submits pool-accepted
shares to **LuckPool** (`ap.luckpool.net:3956`) through a stratum↔WebSocket proxy
(`server/src/websocket/stratumProxy.js`). Hash input = header(140) + solution(1347)
= **1487 bytes**. Real search space (merged-mining v7) = the **11-byte counting
nonce** in the solution tail at input offset 1476 (header nonce stays zeroed).

## Correctness invariants (already correct — do NOT break)
- Merged-mining v7: zero the header nonce + the two MMR roots (solution bytes 8..71,
  i.e. offset 11..75 in the CompactSize-prefixed buffer) **for hashing**; restore the
  original MMR roots **for submission**.
- Target check: VerusHash output is raw **little-endian**; reverse it to big-endian and
  compare MSB-first against the 32-byte big-endian target (`hash <= target` wins).
- Submitted `nonce2` = the 11-byte counting nonce (22 hex), not the 28-byte header nonce.
- `scripts/mine_test.js` is the reference that gets shares **accepted** by the pool.

## What was changed (2026-07-04)
Goal: speed up hashing while **keeping the original path** (user wants both, auto-selected).
- **`verus_hash_batch`** (C): runs the whole loop inside WASM — increments the counting
  nonce in place, hashes, compares target, returns the winning index (or -1). Extra
  `best_hash` out-param returns the lowest hash seen (UI "best"). Signature:
  `(input, input_len, nonce_offset_RELATIVE, inc_len, iterations, target, out_hash, best_hash)`.
  ⚠️ `nonce_offset` passed to C is **relative** to input start; JS keeps a separate
  absolute heap offset for its own reads (nonceRel vs nonceAbs).
- **Resident heap buffer**: worker builds the 1487-byte input into `HEAPU8` once per job.
- **SIMD "turbo" binary**: `verus_hash_simd.{js,wasm}` built with `-O3 -msimd128`.
  Worker feature-detects WASM SIMD and loads turbo, else baseline. Both export
  `verus_hash` AND `verus_hash_batch`.
- **Auto mode**: worker `start` message accepts `perfMode` = `auto|fast|compat`
  (default auto). `auto` → batch loop + turbo when available, else original per-hash loop.
- **Baseline build** bumped to `-O3` (dropped `-fno-inline`, which crippled the hot path;
  inlining proven safe by verify_batch).
- **Fixed 10× hashrate display bug**: worker now posts a true per-second H/s
  (`hashCount / elapsedSeconds`) instead of the raw count over the 10 s report window.

## Files
- `scripts/compile-verus-wasm.sh` — builds BOTH binaries. **Generates its own
  `verus_wrapper.cpp` inline via heredoc and compiles THAT** — the checked-in
  `scripts/verus_wrapper.c` is a documentation mirror, NOT compiled.
- `client/public/miner.worker.js` — `mineLoopBatch()` (fast) + `mineLoopPerHash()`
  (original, unchanged) + `mineLoop()` dispatcher + SIMD detection.
- `client/src/hooks/useMiner.js` — sums per-worker H/s, `formatHashrate` expects H/s.
- `scripts/verify_batch.js`, `scripts/bench_wasm.js` — local test/bench (see below).

## Build gotchas (WSL)
- Needs `emcc` (EMSDK). User builds in WSL: `cd .../scripts && bash compile-verus-wasm.sh`.
- Skip-clone branch didn't create `crypto/verus_hash.h` when `VerusCoin/src` clone is
  absent → fixed by mirroring `wasm_patch/verus_hash.h` into `crypto/`.
- `llvm-objcopy` fails with "Operation not permitted" when writing the `.wasm` in place on
  `/mnt/c` (WSL DrvFs) → fixed: build into a native dir (`$OUT_DIR`, default `/tmp/...`)
  then `cp` to `client/public/wasm/`.
- After ANY change, rebuild **and hard-refresh** the browser (Ctrl+Shift+R) so the new
  `.wasm` and `miner.worker.js` load together (avoid stale cached `.wasm`).

## How to test locally (no browser, from repo root)
- `node scripts/verify_batch.js` — proves `verus_hash_batch` ≡ looping single
  `verus_hash`, on both binaries, and baseline hash == SIMD hash. **All passed.**
- `node scripts/bench_wasm.js` — raw throughput per binary.
- `node scripts/mine_test.js 16` — compat path against real pool (needs network).
  - `BATCH=1 node scripts/mine_test.js 16` (PowerShell: `$env:BATCH=1; ...`) → fast path.
  - `WASM=verus_hash_simd.wasm ...` → test the SIMD binary.
- Sandbox note: project mounted at `/c/...`; node available; NO emcc; NO pool network.

## Measured performance (i7-12th-gen, single-thread, 2026-07-04)
- Baseline binary: **28.4 KH/s/thread**. SIMD binary: **40.7 KH/s/thread** (~**1.42×**).
- Batch loop vs per-hash: **+1–2% only** — the JS↔WASM boundary was NOT the bottleneck.
- 16-thread real rate ≈ 280 KH/s baseline → ~380 KH/s SIMD (the UI showed 2.8M/3.8M
  because of the 10× label bug, now fixed).
- Pool accepted a real share → hashing is correct end-to-end.

## Why hashrate is "low" and how to improve (research)
WASM has **no AES-NI and no CLMUL/PCLMULQDQ** opcodes; VerusHash 2.2 is built around
both (Haraka = AES rounds; CLHash = carry-less multiply). So it runs **fully software**
crypto — ~10–30× slower than the CPU's idle hardware AES units. Native i7-12700 ≈
2.5–4 MH/s; WASM ≈ 0.38 MH/s (~10–15% of native). This is a platform ceiling, not JS.

Improvement options, ranked reward÷effort:
1. `-O3` + inlining (done). 
2. **T-table software AES** (~1.5–2.5×, moderate) — replace textbook S-box+xtime
   MixColumns with 4 combined 1 KB T-tables. Best bang for buck. NOT yet done.
3. **Bitsliced / N-way SIMD AES** (~2–4×, high effort) — process 4–8 nonces per 128-bit
   lane with a gate-logic S-box (no table gathers). The real path to "fast". NOT done.
4. SIMD-emulated CLMUL for CLHash (some %, moderate–high). NOT done.
Not worth it: WebGPU (Verus is GPU-resistant), waiting for WASM AES opcodes.
Realistic ceiling even after 2–4: ~0.8–1.2 MH/s — still below native.

## Open next steps
- Rebuild + hard-refresh to pick up: best-hash display, `-O3` baseline, honest label.
- If user wants more speed: implement **T-table AES** (#2) first; validate with verify_batch.js.
