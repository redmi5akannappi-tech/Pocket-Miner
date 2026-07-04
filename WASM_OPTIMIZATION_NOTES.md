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
- **Real lever remains Stage 2**: batch N nonces through bitsliced AES so the
  inversion latency is amortized across N blocks. Big effort, ~3–4× ceiling. That is
  the only remaining path above the current ~0.38 MH/s platform floor.

### STAGE 2 (part 4, 2026-07-04) — N-way bitsliced AES: primitives DONE + self-testable; wiring next
Bitsliced AES processes **8 independent AES blocks in parallel** via a gate-logic
S-box (AND/XOR/OR/NOT, NO table gather) so inversion latency is amortized →
throughput-bound (fixes the Stage-1 latency problem). Fills a 128-bit reg: 8 blocks
× 16 bytes = 128 lane-bits.

#### ⚠️ PROFILING CORRECTION (changes the whole target — read this)
The part-3 plan's premise ("CLHash finalize is ~1 haraka vs ~47/hash") was WRONG by
~3×. Counting `aesenc` calls from source (`verus_hash.h` + `haraka_portable.c`) per
hash of the 1487-byte input:
| Phase | calls | aesenc | share |
|---|---|---|---|
| Write sponge | 46× haraka512_port (40 aesenc) | 1,840 | ~25% |
| **GenNewCLKey** | **276× haraka256_port (20 aesenc)** | **5,520** | **~75%** |
| keyed final | 1× haraka512_keyed | 40 | <1% |
`GenNewCLKey` (`verus_hash.h:145`) regenerates the CLHash key EVERY hash (seed =
curBuf, unique per nonce → cache check at `:152` always misses; `keySizeInBytes=8832`
→ `n256blks=276`). So bitslicing ONLY the sponge caps end-to-end at ~1.33×. The real
lever is the keygen `haraka256` chain — serial within a nonce, **independent across
nonces**, so bitsliceable at **4 nonces** (haraka256 = 2 blocks/subround → 4×2 = 8).
**DECISION (user-approved): batch 4 nonces.** Sponge runs 8-way as two 2-nonce
streams (haraka512_x2); keygen runs 8-way as 4 nonces (haraka256_x4).

#### Checklist
- [x] 2a. Bitsliced AES round == reference. `scripts/bitslice_check.js`. (2a layout:
      lane = block*16+byteIdx; SubBytes gate net; SR/MC = lane permutes; xtime plane op.)
- [x] 2b. **DONE** (built, not skipped — the mixing/layout is where bugs live).
      Full 8-way bitsliced haraka512_port (2-nonce) AND haraka256_port (4-nonce) ==
      scalar reference, in pure JS. `scripts/bitslice_haraka_check.js`. Reference is
      ANCHORED to the published **Haraka512-256 v2 KAT** (input 00..3f), so rc consts,
      aesenc, unpack-mixing, truncation are all proven, not just self-consistent.
- [x] 2d-core. **DONE (needs your WSL build to confirm).** WASM-SIMD C written +
      wired + self-testable:
      - `scripts/bitslice_cmodel.js` — models the EXACT C op-network (8×8 bit-transpose
        ortho + bitwise S-box + swizzle SR/MC) and proves it == reference in node.
        C in-reg layout = "blocks-in-bits": plane[i].byte[by] = {bit i of each of the
        8 blocks' AES-byte[by]}. → S-box bitwise, SR/MC = `wasm_i8x16_swizzle`, ortho
        = 3-stage SWAPMOVE. (This resolves the part-3 "hard part": no bit-permute net.)
      - `scripts/haraka_bitslice.inc` — the C, 1:1 with the cmodel. Exports
        `haraka512_port_x2`, `haraka256_port_x4`, and self-test entry points.
      - `compile-verus-wasm.sh` appends it to `haraka_portable.c` guarded
        `#ifdef __wasm_simd128__` (turbo only; single-block scalar aesenc untouched).
      - `scripts/bitslice_golden.json` — golden vectors (from the cmodel).
      - `scripts/verify_bitslice_wasm.js` — loads the turbo `.wasm`, drives the
        self-test exports over 5k random vectors/each, compares to the cmodel, and
        LOCALIZES any bug to ortho / round / h512x2 / h256x4. Harness proven correct
        against a cmodel mock (buffer layout OK).
- [x] 2d-core VALIDATED on real compiled WASM (`verify_bitslice_wasm.js`: ALL PASS —
      ortho/round/h512x2/h256x4 bit-exact over 5k vectors each). Transcription risk gone.
- [~] 2c step 1 — **midstate sponge cache DONE** in `verus_hash_batch` (both binaries).
      Bytes [0,nonce_offset) are constant per batch → absorb the 1472-byte aligned
      prefix ONCE, snapshot the 32-byte chaining value, resume per-nonce + Write only
      the 15-byte tail. Eliminates ~46/47 sponge haraka512/hash → ~1.33× (sponge is
      ~25% of AES work). Proven bit-identical to a full Write for the post-FillExtra
      curBuf that Finalize2b hashes (JS model of the sponge, 300 inputs). Gate:
      verify_batch.js (batch==single-hash) + bench_wasm.js. NO bitslicing yet — pure
      scalar, low risk.
- [x] 2c step 1 MEASURED: **~4.1× single-thread** (batch 37.6 → 156 KH/s baseline,
      ~38 → 153 KH/s SIMD). verify_batch.js PASS on both. Way above the predicted 1.33×
      → see re-corrected profile below.
- [~] 2c step 2 — **NOT WORTH DOING (batched keygen).** My "keygen = 75%" was WRONG:
      GenNewCLKey's seed is `curBuf[0:32]` = the sponge CHAINING value, which comes only
      from bytes [0,1472) → **nonce-independent**. So the cache check (`verus_hash.h:152`)
      HITS every hash after the first: the 276-deep haraka256 chain runs **once per job**,
      not per hash (VerusCoin's own design). Bitslicing it via haraka256_port_x4 would
      optimize a cached, ~0-cost op. The `haraka256_port_x4` primitive stays validated but
      unused. **DO NOT build verus_hash_batch_x4.**

#### RE-CORRECTED PROFILE (post-midstate, keygen-cache accounted)
Per hash, keygen cached → the sponge (46× haraka512 recomputing the SAME constant
chaining) was ~76% of cost; midstate removes it entirely (tail is 15B < 32 → 0 sponge
haraka512/hash). Remaining per-hash bottleneck ≈ **CLHash (`verusclhash_port`)** +
GenNewCLKey's cached refresh memcpy/memset (~8KB) + 1 keyed haraka512. Measured 4.1×
= sponge was ~76% of the (keygen-cached) per-hash time.
- SIMD (153) ≈ baseline (156), baseline marginally AHEAD: vpaes never helped Haraka
  (Stage-1 finding) and the sponge is now gone, so the turbo binary buys nothing here.
  Consider defaulting the worker to baseline, or wire haraka512_x2 into the once-per-job
  prefix (marginal). The next real lever is **CLHash SIMD (option #4)**, not Haraka.
- The bitsliced Haraka primitive (2d) is correct + validated but now has no high-value
  target (sponge gone, keygen cached). Keep as infrastructure; don't wire further w/o a
  reason. **The win this stage = midstate, discovered while scoping the bitslice.**

### NEXT MOVES (post-midstate, ranked) — the hot path is now CLHash, not Haraka
Where per-hash time goes now: `verusclhash_sv2_2_port`'s 32-iteration loop, each doing
~2× `_mm_clmulepi64_si128_emu` (→ `clmul64`, a scalar windowed 64-bit carry-less
multiply, `verus_clhash_portable.cpp:176`) + `mulhrs` emu, plus GenNewCLKey's per-hash
~8KB key refresh memcpy/memset. Haraka is basically done.

#### TEST RESULTS (2026-07-05) — SIMD attack on the CLHash hot loop
Investigated the two hot ops in `verusclhash_..._port`'s 32-iter loop:
- **`clmul64` / `_mm_clmulepi64_si128_emu` → DEAD END (don't build).** A 64-bit
  carry-less multiply needs either PCLMULQDQ (absent in WASM) or `i64x2.mul` (also
  absent). The fast windowed method needs a 128-bit-entry GATHER (no SIMD support);
  schoolbook is 64 emulated-128-bit-shift steps (~5× MORE ops than the scalar
  windowed `clmul64`); no bit-spread trick gives GF(2) mult. Same root cause as
  Stage-1 vpaes: without the hardware primitive, SIMD ALU can't emulate it cheaply.
- **`_mm_mulhrs_epi16_emu` → BUILT + validated, pending your bench.** This one WASM
  CAN do: scalar 8-lane int16 mulhrs → `i32x4.extmul_low/high_i16x8` (exact 16×16→32)
  + `+0x4000` + arith `>>15` + WRAP-narrow to i16. **Bit-exact vs the scalar emu over
  200k random + all edges incl. the -32768² wrap corner** (`scripts/clmul_simd_check.js`
  PASS — note the emu WRAPS, so we must NOT use `i16x8.q15mulr_sat`, which saturates).
  Wired as a `#ifdef __wasm_simd128__` drop-in (turbo only) via `compile-verus-wasm.sh`
  (marker `MULHRS_SIMD_PATCH`). ~64 mulhrs/hash, ~40→~7 ops each → up to ~30% of CLHash.
  ⚠️ **OPEN QUESTION the bench answers:** `-O3 -msimd128` may ALREADY auto-vectorize
  that trivial loop (would explain turbo≈baseline today). If bench improves → keep;
  if flat → compiler already did it, revert (guarded, trivial). Correctness gate:
  verify_batch.js. Speed gate: bench_wasm.js turbo vs baseline.
  BUILD: just `bash compile-verus-wasm.sh` (NO clean needed — the patch is
  marker-guarded `MULHRS_SIMD_PATCH` and edits the existing wasm_patch file in place;
  do NOT `rm -rf wasm_patch`, that forces a network re-clone). Then
  `node scripts/verify_batch.js` + `bench_wasm.js`.
  → **RESULT (2026-07-05, measured): NO GAIN.** verify_batch PASS (bit-exact), but
  bench unchanged: SIMD 154 vs baseline 157 KH/s — identical to pre-patch (153/156).
  Conclusion: `-O3 -msimd128` already auto-vectorized the scalar mulhrs loop, so the
  manual version is redundant. Patch is harmless (bit-exact, turbo-only, guarded) and
  LEFT IN like the vpaes Stage-1 code; optional to revert (delete the `MULHRS_SIMD_PATCH`
  awk block in compile-verus-wasm.sh — needs a clean rebuild to drop from wasm_patch).

#### ✅ SIMD FRONT IS TAPPED OUT (conclusion)
Three independent SIMD attempts on the hot path all gave ~0: vpaes aesenc (Stage 1),
mulhrs (auto-vectorized), and clmul (impossible — no WASM primitive). Turbo (154) ≈
baseline (157), baseline marginally AHEAD. **Recommendation: default the worker to the
BASELINE binary** (`verus_hash.wasm`) and optionally stop building/shipping turbo — it
buys nothing post-midstate. The stage win was **midstate (4.1×)**; Haraka+CLHash SIMD is
exhausted. Only remaining easy lever = drop GenNewCLKey's redundant per-hash ~8KB memset
(NEXT MOVES #2), a small scalar win. Beyond that, we're at the WASM software-crypto floor.

**#2 memset — CHECKED, NOT WORTH IT (don't re-litigate).** That memset zeroes the
`pMoveScratch` region (`verus_clhash.h:322,341`) — the scratch holding CLHash's 64
per-hash key-fixup pointers (the key mutate/restore = the ASIC-resistance core).
Reward ~3–6%; risk = corrupting the fixup → subtly wrong hashes → POOL-REJECTED shares.
Un-gate-able cheaply: verify_batch.js can't catch it (batch & single break identically);
only the golden hash `fd564318…` would, and only for one input. Gambling a validated 4×
miner for ~5% on the crypto core = bad trade. Leave it.
2. **Micro — drop redundant per-hash key work.** GenNewCLKey re-`memset`s the non-refresh
   half of the ~8KB key every hash (`verus_hash.h:179`). If CLHash only mutates within
   `refreshsize`, that memset (and part of the memcpy) may be skippable per-hash. Cheap,
   low-risk, measurable once #1 shrinks the AES/clmul cost. Validate with verify_batch.js.
3. **Free — default the worker to the BASELINE binary.** Post-midstate SIMD (153) ≈
   baseline (156), baseline marginally faster (vpaes never helped; sponge gone). Dropping
   the turbo path removes build/download complexity for ~0 loss. (Revisit if #1 lands —
   a SIMD clmul WOULD make turbo win again.)

**DEAD END (checked, don't re-derive): "CLHash midstate."** Can't precompute the
nonce-independent prefix of the CLHash loop: block selection is `pbuf = buf +
(selector & 3)` with `selector = acc` (data-dependent), and 3 of the 4 buf blocks are
constant BUT the nonce block `buf[2]` gets pulled into `acc` within the first ~1–2 of
32 iterations, so the precomputable prefix is ~0. The sponge-midstate trick does NOT
extend here — CLHash's data-dependent addressing is exactly its ASIC-resistance.

#### YOUR NEXT STEP — build + validate the primitive (WSL), before any wiring
```
cd .../Pocket\ Miner/scripts && bash compile-verus-wasm.sh 2>&1 | tail -20
cd .. && node scripts/verify_bitslice_wasm.js     # EXPECT: ALL PASS (bit-exact)
node scripts/verify_batch.js                      # unchanged: still passes (batch untouched)
```
If `verify_bitslice_wasm.js` FAILS: the printed mismatch says WHICH primitive
(ortho/round/h512x2/h256x4) — that's a C-vs-cmodel bug in `haraka_bitslice.inc`
(likely an intrinsic name/typo, the ONE real risk since I have no emcc). Baseline is
unaffected (SIMD is `#ifdef`-guarded), so mining keeps working meanwhile.

#### 2c integration design (for the next session, once the primitive is green)
Reimplement the Finalize2b tail for a 4-nonce group in `verus_wrapper.cpp` (new
export `verus_hash_batch_x4`, keep the scalar `verus_hash_batch` as fallback):
1. **Sponge**: the 4 nonces share the input except the 11-byte counting nonce at
   offset 1476 (last block). Compute the shared 46-block prefix ONCE (scalar), snapshot
   curBuf; per nonce restore + Write the 15-byte tail. (Midstate — bigger win than
   bitslicing the shared prefix; the part-3 "interleave two full sponges" recomputes
   the shared prefix redundantly.) Then only the per-nonce keyed-final needs haraka512;
   sponge bitslicing (h512x2) is optional once midstate lands.
2. **Keygen (the 75%)**: reimplement `GenNewCLKey`'s 276-deep haraka256 chain for the
   4 seeds in lockstep via `haraka256_port_x4` into 4 separate key buffers (need 4×8832B;
   replicate the refresh-copy `memcpy(key+size,key,refreshsize)`). This is the main win.
3. **Finalize** (per nonce, scalar): `vclh(curBuf,key_s)` (CLMUL) + `haraka512_keyed`.
4. **CONTRACT (do not break):** on a WIN leave the resident heap buffer's 11-byte nonce
   = the WINNING lane's nonce (JS rebuilds the share from the heap nonce, not the
   returned idx — worker `:486`); keep the 8-arg export shape; best_hash = min across
   lanes. Gate: `verify_batch.js` (SIMD==baseline hash) + `bench_wasm.js`.
Declare `haraka512_port_x2`/`haraka256_port_x4` in a header the wrapper sees, guarded
so the baseline build (no SIMD) uses a scalar fallback and still links.

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
  `scripts/verus_wrapper.c` is a documentation mirror, NOT compiled. Also copies
  `haraka_bitslice.inc` into the patch tree and appends the guarded include.
- **Stage 2 bitslice (all pure-node, no emcc):**
  - `scripts/bitslice_check.js` — 2a: bitsliced AES round == reference.
  - `scripts/bitslice_haraka_check.js` — 2b: bitsliced haraka512_x2 / haraka256_x4 ==
    reference, anchored to the Haraka512-256 v2 KAT. Requireable (exports the ref).
  - `scripts/bitslice_cmodel.js` — 2d blueprint: models the EXACT C op-network
    (ortho + swizzle round) == reference; `node bitslice_cmodel.js dump` writes goldens.
  - `scripts/haraka_bitslice.inc` — the WASM-SIMD C (1:1 with the cmodel). turbo only.
  - `scripts/verify_bitslice_wasm.js` — run AFTER building: compiled SIMD == cmodel.
  - `scripts/bitslice_golden.json` — golden vectors (documentation / no-oracle fallback).
  - `scripts/clmul_simd_check.js` — validates the SIMD `mulhrs` model bit-exact vs the
    scalar emu (incl. wrap corner); documents the `clmul` SIMD dead-end reasoning.
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
