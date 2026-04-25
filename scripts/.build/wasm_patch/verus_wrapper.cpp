#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* Force portable code paths — disables AES-NI which WASM can't use */
#define VERUS_HASH_PORTABLE 1
#ifdef __AES__
  #undef __AES__
#endif

#include "verus_hash.h"

extern "C" {

/**
 * Compute VerusHash 2.2b of `len` bytes at `in`,
 * write 32-byte result into `out`.
 *
 * Called from JS as: verusHashFunc(outPtr, inPtr, len)
 */
EMSCRIPTEN_KEEPALIVE
void verus_hash(uint8_t *out, const uint8_t *in, uint32_t len) {
    CVerusHashV2::Hash(out, in, len);
}

} /* extern "C" */
