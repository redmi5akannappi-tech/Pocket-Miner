# VerusHash WASM Miner — Optimization Notes

> Context doc so future sessions (and other chats) don't re-derive this. Last updated 2026-07-04 (part 2: T-table CLHash AES).

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

## What was changed (2026-07-04, part 2) — T-table AES (option #2)
- Rewrote the emulated **`_mm_aesenc_si128`** (SubBytes+ShiftRows+MixColumns) as a
  4×256 combined **T-table** lookup. Each output column = `T0[b0]^T1[b1]^T2[b2]^T3[b3]^rk`
  (4 loads + XORs) instead of 16 S-box lookups + per-byte GF `xtime` MixColumns.
  Tables are built once (lazy `_tt_init`) from the existing S-box.
- Edited in **two** heredocs of `scripts/compile-verus-wasm.sh`: the `PATCH_CPP`
  block (prepended to `verus_clhash_portable.cpp`) AND the `x86intrin.h` stub. Both
  copies were byte-identical; `_mm_aesenclast_si128` was left textbook (last round
  has no MixColumns, so a T-table gives no benefit there).
- ⚠️ **Incremental-build gotcha**: the script only prepends `PATCH_CPP` to
  `verus_clhash_portable.cpp` if it isn't already patched. A stale `.build/wasm_patch/`
  from a prior build keeps the OLD textbook AES. I patched the existing
  `.build/.../verus_clhash_portable.cpp` in place so the next build is correct, but
  for certainty do a **clean rebuild**: `rm -rf scripts/.build/wasm_patch` then
  `bash compile-verus-wasm.sh`. (`x86intrin.h` is regenerated every build, so it's
  always fresh.)
- **Correctness**: the T-table is provably bit-identical to the textbook AES round —
  validated over 500k random + edge-case `(state, roundkey)` pairs by the new
  `scripts/aes_ttable_check.js` (pure node, no emcc needed). Because outputs are
  identical, `verify_batch.js` and pool acceptance are unaffected.

## #3 STAGE 1 DONE (2026-07-04, part 2) — vpaes SIMD AES: CORRECT but NO speedup
Approved plan: `C:\Users\devan\.claude\plans\validated-zooming-corbato.md`.

### RESULT (measured on user's machine, single-thread)
- Compiled clean; **turbo `verus_hash_simd.wasm` CHANGED, baseline unchanged** (not
  inert like #2 — the SIMD code really landed).
- **Bit-exact**: `verify_batch.js` all-pass; baseline hash == SIMD hash. Correct.
- **Speed: ~1.0× (no gain)** — `bench_wasm.js`: baseline 18.4 KH/s vs turbo 18.2 KH/s.
- **Why no gain:** vpaes swaps 16 gather-loads for ~30 SIMD ALU ops, but per Haraka
  `aesenc` we hash ONE 16-byte block, and the GF(2⁴) inversion is a long SERIAL
  dependency chain (ipt→nibbles→inv→io/jo→sbo→SR→MC). One block gives the pipeline
  nothing to overlap, so the latency is exposed — about the same as the T-table,
  which the CPU pipelines fine. SIMD parallelizes the 16 bytes *within* a block, but
  the bottleneck is cross-op latency, not per-byte throughput. **The win needs many
  independent blocks in flight** to hide that latency → that is Stage 2 (N-nonce
  bitslice), not vpaes.
- **Decision:** Stage 1 is a correct but performance-neutral change. It's turbo-only
  and bit-exact, so harmless to keep, but it adds surface for zero benefit —
  reverting the `haraka_vpaes.inc` patch (keep `vpaes_check.js` as reference) is a
  clean option. Either way, **do NOT expect a speedup from it.**
- **Real lever remains Stage 2** (below): batch N nonces through bitsliced AES so the
  inversion latency is amortized across N blocks. Big effort, ~3–4× ceiling. That is
  the only remaining path above the current ~0.38 MH/s platform floor.
Goal: replace the scalar T-table `aesenc` in Haraka512 (the ~95% hot path) with a
table-free WASM-SIMD (`-msimd128`) AES round, **turbo binary only**; baseline keeps
T-table. Bit-identical output required.

Technique (validated): **vpaes** (vector-permute AES). Compute SubBytes via GF(2⁴)
inversion using in-register `wasm_i8x16_swizzle` nibble lookups (NO memory gather —
that's the whole point; T-tables can't vectorize on WASM). Then STANDARD ShiftRows
(fixed swizzle) + MixColumns (xtime, SIMD) + AddKey. State stays in standard domain,
so it drops into Haraka unchanged (no domain-amortization tricks needed for Stage 1).

Key facts nailed down:
- SubBytes = `sbou[io] ^ sbot[jo] ^ 0x63`. The `^0x63` is essential: vpaes folds the
  S-box affine CONSTANT into round keys, so the sbo tables give only the linear part.
- `io,jo` from the vpaes entry/inversion block (ipt input-transform → inv/inva
  lookups). Exact op sequence ported from OpenSSL `_vpaes_encrypt_core`.
- Portability proof: every swizzle index stays in {0..15}∪{0x80..0x8F}, so WASM
  `swizzle` (zero on idx≥16) ≡ x86 `pshufb` (zero on bit7). No masking needed.
- Canonical vpaes constants + the whole validated algorithm live in
  `scripts/vpaes_check.js`.

STATUS / progress:
- [x] Stage-1 vpaes AES round + SIMD MixColumns proven bit-identical to reference in
      JS (`node scripts/vpaes_check.js`: SubBytes==sbox all 256; MixColumns==ref 100k;
      full round==ref 200k). ALL PASS.
- [x] Ported to C: `scripts/compile-verus-wasm.sh` now (a) emits the SIMD aesenc as
      `haraka_vpaes.inc` (heredoc, tracked; constants from `DUMP=1 node vpaes_check.js`)
      and (b) idempotently injects it into `haraka_portable.c` guarded
      `#ifdef __wasm_simd128__`, scalar T-table kept in `#else`. Patch structure
      verified (marker `HARAKA_SIMD_AESENC_PATCH`; one #ifdef/#else/#endif; aesenc2
      untouched). Baseline build (no -msimd128) uses the scalar path unchanged.
- [~] First WSL build hit `error: initializer element is not a compile-time constant`
      on the file-scope `static const v128_t = wasm_u8x16_const(...)` (only constexpr
      in C++, not C). FIXED: constants moved to function-local `const v128_t` inside
      `aesenc` (regenerated in the `.inc` each build). Re-run the build.
- [ ] **NEXT — user must rebuild in WSL** (I have no emcc). Then verify. Commands:
      ```
      cd .../Pocket\ Miner/scripts && bash compile-verus-wasm.sh 2>&1 | tail -25
      cd .. && git status -s client/public/wasm/     # EXPECT: verus_hash_simd.wasm
                                                     #   CHANGED, verus_hash.wasm NOT
      node scripts/verify_batch.js                   # SIMD hash == baseline hash (bit-exact)
      node scripts/bench_wasm.js                     # measure turbo vs baseline H/s
      WASM=verus_hash_simd.wasm node scripts/mine_test.js 16   # pool-accepted share (needs net)
      ```
      Success = simd wasm changed + verify_batch passes + bench faster. Then browser
      hard-refresh (Ctrl+Shift+R). If verify_batch FAILS → the SIMD aesenc has a bug
      (revert is trivial: the scalar `#else` path is untouched; baseline unaffected).
      If the WSL build ERRORS on a `wasm_*` intrinsic name → that's the only real risk
      (name typo); the fix is in `haraka_vpaes.inc` in compile-verus-wasm.sh.

HANDOFF for a fresh chat: everything above is committed to tracked files
(`scripts/compile-verus-wasm.sh`, `scripts/vpaes_check.js`). The gitignored
`.build/wasm_patch/haraka_portable.c` gets patched automatically on the next build
(marker-guarded), so no manual .build edits are needed. Plan file:
`C:\Users\devan\.claude\plans\validated-zooming-corbato.md`.

## Files
- `scripts/compile-verus-wasm.sh` — builds BOTH binaries. **Generates its own
  `verus_wrapper.cpp` inline via heredoc and compiles THAT** — the checked-in
  `scripts/verus_wrapper.c` is a documentation mirror, NOT compiled.
- `client/public/miner.worker.js` — `mineLoopBatch()` (fast) + `mineLoopPerHash()`
  (original, unchanged) + `mineLoop()` dispatcher + SIMD detection.
- `client/src/hooks/useMiner.js` — sums per-worker H/s, `formatHashrate` expects H/s.
- `scripts/verify_batch.js`, `scripts/bench_wasm.js` — local test/bench (see below).
- `scripts/aes_ttable_check.js` — proves the T-table AES round ≡ textbook (pure node).

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
2. **T-table software AES** (done 2026-07-04, part 2) — replace textbook S-box+xtime
   MixColumns with 4 combined 256-entry T-tables. ⚠️ REALITY CHECK: the note above
   over-estimated this (~1.5–2.5×) because it assumed textbook AES everywhere. In
   fact the **bulk Haraka path was ALREADY T-tabled** upstream (`aesenc()` in
   `haraka_portable.c` uses `saes_table[4][256]`), doing ~1840 AES rounds/hash. The
   only textbook AES left was the emulated `_mm_aesenc_si128` used by the **CLHash
   finalize** path (`AES2_EMU`, a much smaller fraction of per-hash cost). That is
   now T-tabled too — so all software AES in the build uses T-tables — but the
   realistic speedup is **low single-digit %**, not 1.5–2.5×. Bench to confirm.
3. **Bitsliced / N-way SIMD AES** (~2–4×, high effort) — process 4–8 nonces per 128-bit
   lane with a gate-logic S-box (no table gathers). The real path to "fast". NOT done.
4. SIMD-emulated CLMUL for CLHash (some %, moderate–high). NOT done.
Not worth it: WebGPU (Verus is GPU-resistant), waiting for WASM AES opcodes.
Realistic ceiling even after 2–4: ~0.8–1.2 MH/s — still below native.

## Open next steps
- **Rebuild + hard-refresh** to pick up: best-hash display, `-O3` baseline, honest
  label, AND the T-table CLHash AES (part 2). Prefer a **clean** rebuild
  (`rm -rf scripts/.build/wasm_patch`) so the CLHash cpp is regenerated with the
  T-table from the updated compile script.
- After rebuild: `node scripts/verify_batch.js` (must still pass — output is
  bit-identical) then `node scripts/bench_wasm.js` to measure the actual delta from
  the CLHash T-table (expected: low single-digit %, since Haraka was already T-tabled).
- If user wants a real speedup: option #2 is now exhausted (all AES is T-tabled).
  The next lever is **#3 bitsliced / N-way SIMD AES** — that's where the 2–4× lives,
  but it's high effort and needs the `-msimd128` turbo binary. Validate with
  `aes_ttable_check.js`-style equivalence harness before wiring in.
