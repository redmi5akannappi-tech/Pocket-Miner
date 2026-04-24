#include "haraka_portable.h"
#include "x86intrin.h"
#include <string.h>

void load_constants(void) {
    /* No-op — portable path uses compile-time constants */
}

void haraka512_zero(unsigned char *out, const unsigned char *in) {
    haraka512_perm(out, in);
}

void haraka512(unsigned char *out, const unsigned char *in) {
    haraka512_perm(out, in);
}

void haraka256(unsigned char *out, const unsigned char *in) {
    unsigned char tmp[64];
    memset(tmp, 0, 64);
    memcpy(tmp, in, 32);
    haraka512_perm(tmp, tmp);
    memcpy(out, tmp, 32);
}

void haraka512_keyed(unsigned char *out, const unsigned char *in, const __m128i *keys) {
    (void)keys;
    haraka512_perm(out, in);
}
