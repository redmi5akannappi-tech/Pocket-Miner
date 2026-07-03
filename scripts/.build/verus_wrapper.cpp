/**
 * verus_wrapper.cpp
 *
 * Emscripten bridge for VerusHash 2.2b (the WASM-portable build).
 * Includes the *_portable variants so no AES-NI intrinsics are used.
 *
 * Exported symbols (callable from JS):
 *   alloc(size)                              → pointer in WASM heap
 *   dealloc(ptr)                             → free
 *   verus_hash(inputPtr, inputLen, outPtr)   → 32-byte VerusHash result
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* Force portable code paths — disables AES-NI which WASM can't use */
#define VERUS_HASH_PORTABLE 1
#ifdef __AES__
  #undef __AES__
#endif

/* VerusCoin uses verus_hash.h (not verushash.h) */
#include "verus_hash.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE
uint8_t* alloc(uint32_t size) {
    return (uint8_t*)malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void dealloc(uint8_t* ptr) {
    free(ptr);
}

/**
 * Compute VerusHash 2b2 of `input_len` bytes at `input`,
 * write 32-byte result into `output`.
 *
 * Uses CVerusHashV2 with solutionVersion=SOLUTION_VERUSHHASH_V2_2 (4)
 * and Finalize2b() — this matches the pool's vh.hash2b2() call.
 * The static Hash() method only does a Haraka512 loop and completely
 * skips the CLHash key mutation + keyed Haraka512 finalization step.
 */
EMSCRIPTEN_KEEPALIVE
void verus_hash(const uint8_t* input, uint32_t input_len, uint8_t* output) {
    static bool initialized = false;
    if (!initialized) {
        CVerusHash::init();
        CVerusHashV2::init();
        initialized = true;
    }
    CVerusHashV2 hasher(SOLUTION_VERUSHHASH_V2_2);
    hasher.Reset();
    hasher.Write(input, input_len);
    hasher.Finalize2b(output);
}

} /* extern "C" */
