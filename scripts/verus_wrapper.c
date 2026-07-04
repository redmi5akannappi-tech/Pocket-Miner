/*
 * verus_wrapper.c  (DOCUMENTATION MIRROR — NOT COMPILED DIRECTLY)
 * ==============================================================
 * IMPORTANT: the WASM build in `compile-verus-wasm.sh` GENERATES its own
 * `verus_wrapper.cpp` inline (a heredoc) and compiles THAT, not this file.
 * This file exists to document the exported surface the browser worker calls.
 * If you change the exports, change them in BOTH places (keep them in sync).
 *
 * The real build compiles as C++ (VerusHash uses C++ classes) against the
 * portable, AES-NI-free code paths. It exposes:
 *   - verus_hash(inPtr, inLen, outPtr)                → single 32-byte hash
 *   - verus_hash_batch(inPtr, inLen, nonceOff,
 *                      incLen, iters, targetPtr,
 *                      outPtr)                         → in-WASM mining loop
 *   - malloc / free (Emscripten runtime)
 *
 * The batch loop is the performance path: JS builds the 1487-byte input into
 * the resident WASM heap once per job, then this loop increments the counting
 * nonce in place and hashes a whole batch without crossing the JS↔WASM boundary
 * per hash. It returns early (with the winning index) when a hash meets target.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* Force portable code paths — disables AES-NI which WASM can't use. */
#define VERUS_HASH_PORTABLE 1
#ifdef __AES__
  #undef __AES__
#endif

#include "verus_hash.h"

/* One persistent hasher, created lazily and reused across every call. */
static CVerusHashV2 *ensure_hasher(void) {
    static CVerusHashV2 *hasher = 0;
    if (!hasher) {
        CVerusHash::init();
        CVerusHashV2::init();
        hasher = new CVerusHashV2(SOLUTION_VERUSHHASH_V2_2);
    }
    return hasher;
}

/* Increment a little-endian counter of `len` bytes at `p`. */
static inline void inc_le(uint8_t *p, uint32_t len) {
    for (uint32_t k = 0; k < len; k++) {
        if (++p[k] != 0) break;  /* no carry needed */
    }
}

/* 1 if the raw little-endian `hash` (reversed to big-endian) is <= the 32-byte
 * big-endian `target`, i.e. a valid share. MSB-first: hash[31-i] vs target[i]. */
static inline int meets_target(const uint8_t *hash, const uint8_t *target) {
    for (int i = 0; i < 32; i++) {
        uint8_t hb = hash[31 - i];
        if (hb < target[i]) return 1;
        if (hb > target[i]) return 0;
    }
    return 1;  /* equal ⇒ valid */
}

/* 1 if display(a) < display(b) — raw LE hash `a` reversed is the smaller
 * big-endian value (closer to target). MSB is raw byte 31. */
static inline int is_lower(const uint8_t *a, const uint8_t *b) {
    for (int i = 31; i >= 0; i--) {
        if (a[i] < b[i]) return 1;
        if (a[i] > b[i]) return 0;
    }
    return 0;
}

extern "C" {

/* Compute VerusHash 2b2 of `len` bytes at `in`, write 32-byte result to `out`. */
EMSCRIPTEN_KEEPALIVE
void verus_hash(const uint8_t *in, uint32_t len, uint8_t *out) {
    CVerusHashV2 *hasher = ensure_hasher();
    hasher->Reset();
    hasher->Write(in, len);
    hasher->Finalize2b(out);
}

/*
 * Batch mining loop — see the header comment. Returns the 0-based index of the
 * winning hash (buffer + `out_hash` left at the winner) or -1 if none met the
 * target (buffer left at the last nonce tried, ready to continue next call).
 */
EMSCRIPTEN_KEEPALIVE
int32_t verus_hash_batch(uint8_t *input, uint32_t input_len,
                         uint32_t nonce_offset, uint32_t inc_len,
                         uint32_t iterations, const uint8_t *target,
                         uint8_t *out_hash, uint8_t *best_hash) {
    CVerusHashV2 *hasher = ensure_hasher();
    uint8_t *noncep = input + nonce_offset;
    uint8_t hash[32];
    uint8_t best[32]; memset(best, 0xFF, 32);   /* worst possible → any hash is lower */
    for (uint32_t i = 0; i < iterations; i++) {
        /* Increment first: the initial (random) nonce is never hashed directly. */
        inc_le(noncep, inc_len);
        hasher->Reset();
        hasher->Write(input, input_len);
        hasher->Finalize2b(hash);
        if (is_lower(hash, best)) memcpy(best, hash, 32);
        if (meets_target(hash, target)) {
            memcpy(out_hash, hash, 32);
            if (best_hash) memcpy(best_hash, best, 32);
            return (int32_t)i;
        }
    }
    if (best_hash) memcpy(best_hash, best, 32);
    return -1;
}

} /* extern "C" */
