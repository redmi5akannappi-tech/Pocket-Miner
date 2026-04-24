/**
 * verus_wrapper.c
 * 
 * Emscripten-compilable C wrapper for VerusHash 2.1
 * This file is compiled to WebAssembly using:
 *   emcc verus_wrapper.c [verushash sources] -o ../../../client/public/wasm/verus_hash.js ...
 *
 * The wrapper exposes three functions to JavaScript:
 *   - verus_hash(inputPtr, inputLen, outputPtr)  → fills output with 32-byte hash
 *   - alloc(size)                                → malloc in WASM heap
 *   - dealloc(ptr)                               → free in WASM heap
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* ── VerusHash 2.1 dependencies (included from the cloned VerusCoin repo) ── */
/* These paths assume you run compile.sh from scripts/ with the repo cloned   */
#include "verushash/verushash.h"

/* ── Exported: allocate a buffer in WASM linear memory ─────────────────────── */
EMSCRIPTEN_KEEPALIVE
uint8_t* alloc(uint32_t size) {
    return (uint8_t*)malloc(size);
}

/* ── Exported: free a WASM buffer ──────────────────────────────────────────── */
EMSCRIPTEN_KEEPALIVE
void dealloc(uint8_t* ptr) {
    free(ptr);
}

/* ── Exported: hash input bytes, write 32-byte result to output ────────────── */
EMSCRIPTEN_KEEPALIVE
void verus_hash(const uint8_t* input, uint32_t input_len, uint8_t* output) {
    /* VerusHash 2.1 — accepts an 80-byte block header, outputs 32-byte hash   */
    CVerusHashV2b::Hash(output, input, input_len);
}

/* ── Exported: verify a hash meets a difficulty target ────────────────────── */
EMSCRIPTEN_KEEPALIVE
int meets_difficulty(const uint8_t* hash, uint32_t bits) {
    /* Count leading zero bits — simplified difficulty check */
    uint32_t required_zeros = bits;
    for (uint32_t i = 0; i < 32 && required_zeros >= 8; i++) {
        if (hash[i] != 0) return 0;
        required_zeros -= 8;
    }
    if (required_zeros > 0) {
        uint8_t mask = 0xFF << (8 - required_zeros);
        if (hash[32 - required_zeros / 8 - 1] & mask) return 0;
    }
    return 1;
}
