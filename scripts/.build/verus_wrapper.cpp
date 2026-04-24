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
 * Compute VerusHash 2.2b of `input_len` bytes at `input`,
 * write 32-byte result into `output`.
 */
EMSCRIPTEN_KEEPALIVE
void verus_hash(const uint8_t* input, uint32_t input_len, uint8_t* output) {
    /* CVerusHashV2b is the latest VerusHash used for mining */
    CVerusHashV2b::Hash(output, input, input_len);
}

} /* extern "C" */
