#include "verus_hash.h"
#include <stdint.h>
#include <string.h>

extern "C" {
    void verus_hash(uint8_t *out, const uint8_t *in, size_t len) {
        CVerusHashV2::Hash(out, in, len);
    }
}
