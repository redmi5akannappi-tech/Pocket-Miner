#pragma once
#include "haraka_portable.h"
#include "x86intrin.h"

#ifdef __cplusplus
extern "C" {
#endif

void load_constants(void);
void haraka512_zero(unsigned char *out, const unsigned char *in);
void haraka512(unsigned char *out, const unsigned char *in);
void haraka256(unsigned char *out, const unsigned char *in);
void haraka512_keyed(unsigned char *out, const unsigned char *in, const __m128i *keys);

#ifdef __cplusplus
}
#endif
