#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT/.build"
PATCH="$BUILD_DIR/wasm_patch"
CRYPTO="$BUILD_DIR/VerusCoin/src/crypto"

# ── emsdk check ─────────────────────────────────────────────────────────────
if [ ! -d "$EMSDK" ]; then
    echo "ERROR: EMSDK env var not set. Run: source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi

# ── clone source + prepare patch dir ────────────────────────────────────────
# Skip if wasm_patch already has the core crypto sources (from a previous build
# or committed to the repo). This avoids dependence on upstream VerusCoin repo
# structure which may change.
if [ -f "$PATCH/verus_hash.h" ] && [ -f "$PATCH/verus_hash.cpp" ] && \
   [ -f "$PATCH/verus_clhash.h" ] && [ -f "$PATCH/verus_clhash_portable.cpp" ] && \
   [ -f "$PATCH/haraka_portable.h" ] && [ -f "$PATCH/haraka_portable.c" ]; then
    echo "✅ wasm_patch/ already has patched sources — skipping VerusCoin clone"
    mkdir -p "$PATCH/crypto/compat"
    # Ensure crypto/ mirrors are up to date
    cp "$PATCH/verus_clhash.h"    "$PATCH/crypto/verus_clhash.h"    2>/dev/null || true
    cp "$PATCH/haraka_portable.h" "$PATCH/crypto/haraka_portable.h" 2>/dev/null || true
    cp "$PATCH/haraka_portable.c" "$PATCH/crypto/haraka_portable.c" 2>/dev/null || true
else
    echo "Cloning VerusCoin for crypto sources..."
    # Remove stale/empty clone if the expected files don't exist
    if [ -d "$BUILD_DIR/VerusCoin" ] && [ ! -f "$CRYPTO/verus_hash.h" ]; then
        echo "  Removing stale VerusCoin clone..."
        rm -rf "$BUILD_DIR/VerusCoin"
    fi
    if [ ! -d "$BUILD_DIR/VerusCoin" ]; then
        mkdir -p "$BUILD_DIR"
        # Try default branch first, then 'dev' if crypto files not found
        git clone --depth 1 https://github.com/VerusCoin/VerusCoin.git "$BUILD_DIR/VerusCoin" || true
        if [ ! -f "$CRYPTO/verus_hash.h" ]; then
            echo "  Default branch missing crypto files, trying 'dev' branch..."
            rm -rf "$BUILD_DIR/VerusCoin"
            git clone --depth 1 --branch dev https://github.com/VerusCoin/VerusCoin.git "$BUILD_DIR/VerusCoin" || true
        fi
    fi

    # Verify the crypto source files exist
    if [ ! -f "$CRYPTO/verus_hash.h" ]; then
        echo "ERROR: Could not find verus_hash.h in VerusCoin clone at $CRYPTO"
        echo "  Searching for it..."
        find "$BUILD_DIR/VerusCoin" -name "verus_hash.h" 2>/dev/null || true
        echo ""
        echo "Please ensure the wasm_patch/ directory contains the pre-patched source files."
        echo "You can copy them from a working build: scripts/.build/wasm_patch/"
        exit 1
    fi

    # ── prepare patch dir ───────────────────────────────────────────────────
    rm -rf "$PATCH" && mkdir -p "$PATCH"

    # copy real sources
    cp "$CRYPTO/verus_hash.h"              "$PATCH/"
    cp "$CRYPTO/verus_hash.cpp"            "$PATCH/"
    cp "$CRYPTO/verus_clhash.h"            "$PATCH/"
    cp "$CRYPTO/verus_clhash_portable.cpp" "$PATCH/"
    cp "$CRYPTO/haraka_portable.h"         "$PATCH/"
    cp "$CRYPTO/haraka_portable.c"         "$PATCH/"

    # ── patch verus_clhash.h ────────────────────────────────────────────────
    sed -i '1s/^/#include <sstream>\n#include "uint256.h"\n#include "x86intrin.h"\n#include "cpuid.h"\n/' "$PATCH/verus_clhash.h"

    # crypto/ subdir mirrors — AFTER sed patches so they get patched versions
    mkdir -p "$PATCH/crypto/compat"
    cp "$PATCH/verus_clhash.h"    "$PATCH/crypto/verus_clhash.h"
    cp "$PATCH/haraka_portable.h" "$PATCH/crypto/haraka_portable.h"
    cp "$PATCH/haraka_portable.c" "$PATCH/crypto/haraka_portable.c"

    # ── patch verus_hash.cpp ────────────────────────────────────────────────
    # real verus_hash.cpp includes crypto/haraka.h; we redirect it to our portable stub
    sed -i '1s/^/#include "haraka.h"\n/' "$PATCH/verus_hash.cpp"
fi

# ── prepend WASM patch block to verus_clhash_portable.cpp ───────────────────
# This block is self-contained: it defines the types, operators, software AES,
# and the AES2_EMU / MIX2_EMU macros that the portable cpp expects.
PATCH_CPP=$(cat << 'CPPPATCH'
#ifndef __WASM_X86INTRIN_PATCH
#define __WASM_X86INTRIN_PATCH

#include <stdint.h>
#include <string.h>

typedef union { uint8_t u8[16]; uint32_t u32[4]; uint64_t u64[2]; } __m128i;
typedef __m128i u128;
typedef unsigned char u_char;

#ifdef __cplusplus
inline __m128i operator^(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] ^ b.u8[i];
    return r;
}
inline __m128i operator&(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] & b.u8[i];
    return r;
}
inline __m128i operator|(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] | b.u8[i];
    return r;
}
#endif

static inline uint8_t _wasm_xtime(uint8_t x) {
    return (x << 1) ^ ((x >> 7) * 0x1b);
}

static inline __m128i _mm_aesenc_si128(__m128i a, __m128i rk) {
    static const uint8_t sbox[256] = {
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    };
    /* T-table AES round (option #2): fold SubBytes + ShiftRows + MixColumns into
     * 4 combined 256-entry lookup tables, built once from the S-box. Replaces the
     * per-byte S-box + xtime MixColumns with 4 table loads + XORs per column.
     * Bit-identical to the textbook path (verified vs. reference over 500k inputs
     * in scripts/aes_ttable_check.js). u32/u8 union aliasing is valid — WASM is
     * little-endian. Used by the CLHash finalize path (AES2_EMU); the bulk Haraka
     * loop already uses its own T-table (aesenc() in haraka_portable.c). */
    static uint32_t T0[256], T1[256], T2[256], T3[256];
    static int _tt_init = 0;
    if (!_tt_init) {
        for (int x = 0; x < 256; x++) {
            uint8_t sv = sbox[x];
            uint8_t s2 = _wasm_xtime(sv);
            uint8_t s3 = (uint8_t)(s2 ^ sv);
            T0[x] = (uint32_t)s2 | ((uint32_t)sv << 8) | ((uint32_t)sv << 16) | ((uint32_t)s3 << 24);
            T1[x] = (uint32_t)s3 | ((uint32_t)s2 << 8) | ((uint32_t)sv << 16) | ((uint32_t)sv << 24);
            T2[x] = (uint32_t)sv | ((uint32_t)s3 << 8) | ((uint32_t)s2 << 16) | ((uint32_t)sv << 24);
            T3[x] = (uint32_t)sv | ((uint32_t)sv << 8) | ((uint32_t)s3 << 16) | ((uint32_t)s2 << 24);
        }
        _tt_init = 1;
    }
    __m128i r;
    r.u32[0] = T0[a.u8[0]]  ^ T1[a.u8[5]]  ^ T2[a.u8[10]] ^ T3[a.u8[15]] ^ rk.u32[0];
    r.u32[1] = T0[a.u8[4]]  ^ T1[a.u8[9]]  ^ T2[a.u8[14]] ^ T3[a.u8[3]]  ^ rk.u32[1];
    r.u32[2] = T0[a.u8[8]]  ^ T1[a.u8[13]] ^ T2[a.u8[2]]  ^ T3[a.u8[7]]  ^ rk.u32[2];
    r.u32[3] = T0[a.u8[12]] ^ T1[a.u8[1]]  ^ T2[a.u8[6]]  ^ T3[a.u8[11]] ^ rk.u32[3];
    return r;
}

static inline __m128i _mm_aesenclast_si128(__m128i a, __m128i rk) {
    static const uint8_t sbox[256] = {
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    };
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = sbox[a.u8[i]];
    uint8_t t[16];
    t[0] = s[0];   t[1] = s[5];   t[2] = s[10];  t[3] = s[15];
    t[4] = s[4];   t[5] = s[9];   t[6] = s[14];  t[7] = s[3];
    t[8] = s[8];   t[9] = s[13];  t[10] = s[2];  t[11] = s[7];
    t[12] = s[12]; t[13] = s[1];  t[14] = s[6];  t[15] = s[11];
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = t[i] ^ rk.u8[i];
    return r;
}

static inline __m128i _mm_xor_si128(__m128i a, __m128i b) { return a ^ b; }

#undef AES2_EMU
#define AES2_EMU(s0, s1, rci) do { \
    s0 = _mm_aesenc_si128(s0, rc[rci]); \
    s1 = _mm_aesenc_si128(s1, rc[rci + 1]); \
    s0 = _mm_aesenc_si128(s0, rc[rci + 2]); \
    s1 = _mm_aesenc_si128(s1, rc[rci + 3]); \
} while(0)

#undef MIX2_EMU
#define MIX2_EMU(s0, s1) do { \
    __m128i _tmp_mix = s0; \
    s0 = _tmp_mix ^ s1; \
    s1 = _tmp_mix ^ s0; \
} while(0)

#endif // __WASM_X86INTRIN_PATCH
CPPPATCH
)

# Only prepend/append if the file hasn't already been patched
if ! head -5 "$PATCH/verus_clhash_portable.cpp" | grep -q "__WASM_X86INTRIN_PATCH"; then
    { echo "$PATCH_CPP"; cat "$PATCH/verus_clhash_portable.cpp"; } > "$PATCH/verus_clhash_portable.cpp.tmp"
    mv "$PATCH/verus_clhash_portable.cpp.tmp" "$PATCH/verus_clhash_portable.cpp"

    # ── append missing symbol definitions ───────────────────────────────────────
    cat >> "$PATCH/verus_clhash_portable.cpp" << 'EOF'

// WASM stub definitions for symbols declared in verus_clhash.h
thread_local thread_specific_ptr verusclhasher_key;
thread_local thread_specific_ptr verusclhasher_descr;
int __cpuverusoptimized = 0;

void *alloc_aligned_buffer(uint64_t bufSize) {
    void *p = NULL;
    if (posix_memalign(&p, 32, bufSize) != 0) return NULL;
    return p;
}

// WASM stubs for non-portable (AES-NI) CLHash functions.
// Referenced by verusclhasher constructor but never called on WASM.
uint64_t verusclhash(void *random, const unsigned char buf[64], uint64_t keyMask, __m128i **pMoveScratch) {
    return verusclhash_port(random, buf, keyMask, pMoveScratch);
}
uint64_t verusclhash_sv2_1(void *random, const unsigned char buf[64], uint64_t keyMask, __m128i **pMoveScratch) {
    return verusclhash_sv2_1_port(random, buf, keyMask, pMoveScratch);
}
uint64_t verusclhash_sv2_2(void *random, const unsigned char buf[64], uint64_t keyMask, __m128i **pMoveScratch) {
    return verusclhash_sv2_2_port(random, buf, keyMask, pMoveScratch);
}
__m128i __verusclmulwithoutreduction64alignedrepeat(__m128i *randomsource, const __m128i buf[4], uint64_t keyMask, __m128i **pMoveScratch) {
    return __verusclmulwithoutreduction64alignedrepeat_port(randomsource, buf, keyMask, pMoveScratch);
}
__m128i __verusclmulwithoutreduction64alignedrepeat_sv2_1(__m128i *randomsource, const __m128i buf[4], uint64_t keyMask, __m128i **pMoveScratch) {
    return __verusclmulwithoutreduction64alignedrepeat_sv2_1_port(randomsource, buf, keyMask, pMoveScratch);
}
__m128i __verusclmulwithoutreduction64alignedrepeat_sv2_2(__m128i *randomsource, const __m128i buf[4], uint64_t keyMask, __m128i **pMoveScratch) {
    return __verusclmulwithoutreduction64alignedrepeat_sv2_2_port(randomsource, buf, keyMask, pMoveScratch);
}
EOF
else
    echo "✅ verus_clhash_portable.cpp already patched — skipping prepend/append"
fi

# ── stub: common.h ──────────────────────────────────────────────────────────
cat > "$PATCH/common.h" << 'EOF'
#pragma once
#include <stdint.h>
#include <string.h>
#include <string>

static inline uint16_t ReadLE16(const uint8_t* p){
    uint16_t v; memcpy(&v,p,2); return v; }
static inline uint32_t ReadLE32(const uint8_t* p){
    uint32_t v; memcpy(&v,p,4); return v; }
static inline uint64_t ReadLE64(const uint8_t* p){
    uint64_t v; memcpy(&v,p,8); return v; }
static inline void WriteLE16(uint8_t* p, uint16_t v){ memcpy(p,&v,2); }
static inline void WriteLE32(uint8_t* p, uint32_t v){ memcpy(p,&v,4); }
static inline void WriteLE64(uint8_t* p, uint64_t v){ memcpy(p,&v,8); }
static inline uint32_t ReadBE32(const uint8_t* p){
    uint32_t v; memcpy(&v,p,4);
    return ((v&0xFF)<<24)|((v>>8&0xFF)<<16)|((v>>16&0xFF)<<8)|(v>>24); }
static inline void WriteBE32(uint8_t* p, uint32_t v){
    uint32_t b=((v&0xFF)<<24)|((v>>8&0xFF)<<16)|((v>>16&0xFF)<<8)|(v>>24);
    memcpy(p,&b,4); }
static inline uint32_t ReadBE16(const uint8_t* p){
    uint16_t v; memcpy(&v,p,2); return ((v&0xFF)<<8)|(v>>8); }
EOF

mkdir -p "$PATCH/crypto"
cp "$PATCH/common.h" "$PATCH/crypto/common.h"

# verus_hash.cpp does #include "crypto/verus_hash.h". When the VerusCoin/src clone
# is absent (skip-clone branch), mirror the top-level header into crypto/ so the
# build stays self-contained and doesn't depend on the upstream checkout.
cp "$PATCH/verus_hash.h" "$PATCH/crypto/verus_hash.h"

# ── stub: hash.h ────────────────────────────────────────────────────────────
# We bridge to verus_clhash.h and verus_hash.h so mine_verus_v2_port can see
# CVerusHashV2bWriter, verusclhasher, thread_specific_ptr, etc.
cat > "$PATCH/hash.h" << 'EOF'
#pragma once
#include "uint256.h"
#include "arith_uint256.h"
#include "verus_clhash.h"
#include "verus_hash.h"

class CVerusHashV2Writer {
private:
    CVerusHashV2 state;
public:
    int nType;
    int nVersion;
    CVerusHashV2Writer(int nTypeIn, int nVersionIn) : nType(nTypeIn), nVersion(nVersionIn), state() {}
    void Reset() { state.Reset(); }
    CVerusHashV2Writer& write(const char *pch, size_t size) {
        state.Write((const unsigned char*)pch, size);
        return (*this);
    }
    uint256 GetHash() {
        uint256 result;
        state.Finalize((unsigned char*)&result);
        return result;
    }
    int64_t *xI64p() { return state.ExtraI64Ptr(); }
    CVerusHashV2 &GetState() { return state; }
    template<typename T> CVerusHashV2Writer& operator<<(const T& obj) { return (*this); }
};

class CVerusHashV2bWriter {
private:
    CVerusHashV2 state;
public:
    int nType;
    int nVersion;
    CVerusHashV2bWriter(int nTypeIn, int nVersionIn, int solutionVersion=SOLUTION_VERUSHHASH_V2, uint64_t keysize=VERUSKEYSIZE) : 
        nType(nTypeIn), nVersion(nVersionIn), state(solutionVersion) {}
    void Reset() { state.Reset(); }
    CVerusHashV2bWriter& write(const char *pch, size_t size) {
        state.Write((const unsigned char*)pch, size);
        return (*this);
    }
    uint256 GetHash() {
        uint256 result;
        state.Finalize2b((unsigned char*)&result);
        return result;
    }
    inline int64_t *xI64p() { return state.ExtraI64Ptr(); }
    CVerusHashV2 &GetState() { return state; }
    template<typename T> CVerusHashV2bWriter& operator<<(const T& obj) { return (*this); }
};
EOF

# ── stub: uint256.h ─────────────────────────────────────────────────────────
cat > "$PATCH/uint256.h" << 'EOF'
#pragma once
#include <stdint.h>
#include <string.h>
#include <string>

class uint256 {
public:
    uint8_t data[32];
    uint256() { memset(data, 0, 32); }
    uint256(const uint256& o) { memcpy(data, o.data, 32); }
    uint256& operator=(const uint256& o) { memcpy(data, o.data, 32); return *this; }
    bool operator==(const uint256& o) const { return memcmp(data, o.data, 32) == 0; }
    bool operator!=(const uint256& o) const { return !(*this == o); }
    bool operator<(const uint256& o) const { return memcmp(data, o.data, 32) < 0; }
    std::string GetHex() const { return std::string(64, '0'); }
    void SetHex(const char*) {}
};

inline uint256 uint256S(const char*) { return uint256(); }
EOF

# ── stub: arith_uint256.h ───────────────────────────────────────────────────
cat > "$PATCH/arith_uint256.h" << 'EOF'
#pragma once
#include "uint256.h"

class arith_uint256 : public uint256 {
public:
    arith_uint256() : uint256() {}
    explicit arith_uint256(const uint256& a) : uint256(a) {}
    bool operator>(const arith_uint256& o) const { return memcmp(data, o.data, 32) > 0; }
};

inline arith_uint256 UintToArith256(const uint256& a) {
    return arith_uint256(a);
}
EOF

# ── stub: primitives/block.h ────────────────────────────────────────────────
mkdir -p "$PATCH/primitives"
cat > "$PATCH/primitives/block.h" << 'EOF'
#pragma once
#include "uint256.h"
#include <vector>

class CBlockHeader {
public:
    uint256 hashPrevBlock;
    uint256 hashMerkleRoot;
    uint256 hashFinalSaplingRoot;
    uint32_t nVersion;
    uint32_t nTime;
    uint32_t nBits;
    uint256 nNonce;
    std::vector<unsigned char> nSolution;
};
EOF

# ── stub: tinyformat.h ──────────────────────────────────────────────────────
cat > "$PATCH/tinyformat.h" << 'EOF'
#pragma once
#include <string>
namespace tfm {
    template<typename... Args>
    std::string format(const std::string &fmt, Args... args) { return fmt; }
}
template<typename... Args>
std::string strprintf(const std::string &fmt, Args... args) { return tfm::format(fmt, args...); }
EOF

# ── stub: boost ─────────────────────────────────────────────────────────────
mkdir -p "$PATCH/boost"
cat > "$PATCH/boost/thread.hpp" << 'EOF'
#pragma once
namespace boost {
  class mutex { public: void lock(){} void unlock(){} class scoped_lock{public:scoped_lock(mutex&){}};};
  template<class M> class lock_guard{public:explicit lock_guard(M&){}~lock_guard(){}};
  class thread {};
}
EOF
cat > "$PATCH/boost/mutex.hpp" << 'EOF'
#pragma once
#include "thread.hpp"
EOF

# ── stub: asm/hwcap.h + sys/auxv.h ─────────────────────────────────────────
mkdir -p "$PATCH/asm" "$PATCH/sys"
cat > "$PATCH/asm/hwcap.h" << 'EOF'
#pragma once
#define HWCAP_AES  0
#define HWCAP_PMULL 0
#define HWCAP_SHA1  0
#define HWCAP_SHA2  0
EOF
cat > "$PATCH/sys/auxv.h" << 'EOF'
#pragma once
static inline unsigned long getauxval(unsigned long type){ (void)type; return 0; }
EOF

# ── stub: intrin.h ──────────────────────────────────────────────────────────
cat > "$PATCH/intrin.h" << 'EOF'
#pragma once
#include "x86intrin.h"
EOF

# ── stub: cpuid.h (GCC-style — VerusCoin uses __get_cpuid) ──────────────────
cat > "$PATCH/cpuid.h" << 'EOF'
#pragma once
#define __cpuid(leaf,a,b,c,d)      do{(a)=(b)=(c)=(d)=0;}while(0)
#define __cpuid_count(l,s,a,b,c,d) do{(a)=(b)=(c)=(d)=0;}while(0)
#define __get_cpuid_max(l,s)       0
#define __get_cpuid(l,a,b,c,d)     0
#define bit_AVX    0
#define bit_AES    0
#define bit_PCLMUL 0
#define bit_SSE2   0
#define bit_SSE4_1 0
#define bit_AVX2   0
EOF

# ── stub: x86intrin.h (for all other translation units) ─────────────────────
cat > "$PATCH/x86intrin.h" << 'EOF'
#pragma once
#include <stdint.h>
#include <string.h>

#ifndef __WASM_X86INTRIN_PATCH
#define __WASM_X86INTRIN_PATCH

typedef union { uint8_t u8[16]; uint32_t u32[4]; uint64_t u64[2]; } __m128i;
typedef __m128i u128;
typedef unsigned char u_char;
typedef union { uint8_t u8[32]; uint32_t u32[8]; uint64_t u64[4]; } __m256i;

#ifdef __cplusplus
inline __m128i operator^(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] ^ b.u8[i];
    return r;
}
inline __m128i operator&(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] & b.u8[i];
    return r;
}
inline __m128i operator|(const __m128i& a, const __m128i& b) {
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = a.u8[i] | b.u8[i];
    return r;
}
#endif

static inline __m128i _mm_setzero_si128(void){__m128i r;memset(&r,0,16);return r;}
static inline __m128i _mm_loadu_si128(const void* p){__m128i r;memcpy(&r,p,16);return r;}
static inline void _mm_storeu_si128(void* p,__m128i v){memcpy(p,&v,16);}
static inline __m128i _mm_load_si128(const void* p){__m128i r;memcpy(&r,p,16);return r;}
static inline void _mm_store_si128(void* p,__m128i v){memcpy(p,&v,16);}
static inline __m128i _mm_xor_si128(__m128i a,__m128i b){__m128i r;for(int i=0;i<16;i++)r.u8[i]=a.u8[i]^b.u8[i];return r;}
static inline __m128i _mm_and_si128(__m128i a,__m128i b){__m128i r;for(int i=0;i<16;i++)r.u8[i]=a.u8[i]&b.u8[i];return r;}
static inline __m128i _mm_or_si128(__m128i a,__m128i b){__m128i r;for(int i=0;i<16;i++)r.u8[i]=a.u8[i]|b.u8[i];return r;}
static inline __m128i _mm_set_epi64x(int64_t a,int64_t b){__m128i r;r.u64[0]=b;r.u64[1]=a;return r;}
static inline __m128i _mm_set1_epi8(char a){__m128i r;memset(&r,a,16);return r;}
static inline __m128i _mm_set_epi32(int a,int b,int c,int d){__m128i r;r.u32[0]=d;r.u32[1]=c;r.u32[2]=b;r.u32[3]=a;return r;}
static inline int _mm_movemask_epi8(__m128i a){int m=0;for(int i=0;i<16;i++)if(a.u8[i]&0x80)m|=(1<<i);return m;}
static inline __m128i _mm_shuffle_epi8(__m128i a,__m128i b){__m128i r;for(int i=0;i<16;i++){uint8_t idx=b.u8[i];r.u8[i]=(idx&0x80)?0:a.u8[idx&0x0F];}return r;}
static inline __m128i _mm_slli_epi64(__m128i a,int n){__m128i r;r.u64[0]=a.u64[0]<<n;r.u64[1]=a.u64[1]<<n;return r;}
static inline __m128i _mm_srli_epi64(__m128i a,int n){__m128i r;r.u64[0]=a.u64[0]>>n;r.u64[1]=a.u64[1]>>n;return r;}
static inline __m128i _mm_srli_si128(__m128i a,int n){__m128i r;memset(&r,0,16);if(n<16)memcpy(&r.u8[0],&a.u8[n],16-n);return r;}
static inline __m128i _mm_cvtsi64_si128(int64_t a){__m128i r;r.u64[0]=a;r.u64[1]=0;return r;}
static inline int64_t _mm_cvtsi128_si64(__m128i a){return a.u64[0];}
static inline __m128i _mm_clmulepi64_si128(__m128i a,__m128i b,int imm){(void)a;(void)b;(void)imm;return _mm_setzero_si128();}
static inline __m128i _mm_mulhrs_epi16(__m128i a,__m128i b){(void)b;return a;}
static inline __m128i _mm_unpacklo_epi64(__m128i a,__m128i b){__m128i r;r.u64[0]=a.u64[0];r.u64[1]=b.u64[0];return r;}
static inline __m128i _mm_unpackhi_epi64(__m128i a,__m128i b){__m128i r;r.u64[0]=a.u64[1];r.u64[1]=b.u64[1];return r;}
static inline __m128i _mm_castps_si128(void* a){(void)a;return _mm_setzero_si128();}
static inline void* _mm_castsi128_ps(__m128i a){(void)a;return NULL;}
static inline void* _mm_set_ps(float a,float b,float c,float d){(void)a;(void)b;(void)c;(void)d;return NULL;}
static inline void* _mm_load_ps(const void* a){(void)a;return NULL;}
static inline void _mm_store_ps(void* a,void* b){(void)a;(void)b;}

static inline uint8_t _wasm_xtime(uint8_t x) {
    return (x << 1) ^ ((x >> 7) * 0x1b);
}

static inline __m128i _mm_aesenc_si128(__m128i a, __m128i rk) {
    static const uint8_t sbox[256] = {
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    };
    /* T-table AES round (option #2): fold SubBytes + ShiftRows + MixColumns into
     * 4 combined 256-entry lookup tables, built once from the S-box. Replaces the
     * per-byte S-box + xtime MixColumns with 4 table loads + XORs per column.
     * Bit-identical to the textbook path (verified vs. reference over 500k inputs
     * in scripts/aes_ttable_check.js). u32/u8 union aliasing is valid — WASM is
     * little-endian. Used by the CLHash finalize path (AES2_EMU); the bulk Haraka
     * loop already uses its own T-table (aesenc() in haraka_portable.c). */
    static uint32_t T0[256], T1[256], T2[256], T3[256];
    static int _tt_init = 0;
    if (!_tt_init) {
        for (int x = 0; x < 256; x++) {
            uint8_t sv = sbox[x];
            uint8_t s2 = _wasm_xtime(sv);
            uint8_t s3 = (uint8_t)(s2 ^ sv);
            T0[x] = (uint32_t)s2 | ((uint32_t)sv << 8) | ((uint32_t)sv << 16) | ((uint32_t)s3 << 24);
            T1[x] = (uint32_t)s3 | ((uint32_t)s2 << 8) | ((uint32_t)sv << 16) | ((uint32_t)sv << 24);
            T2[x] = (uint32_t)sv | ((uint32_t)s3 << 8) | ((uint32_t)s2 << 16) | ((uint32_t)sv << 24);
            T3[x] = (uint32_t)sv | ((uint32_t)sv << 8) | ((uint32_t)s3 << 16) | ((uint32_t)s2 << 24);
        }
        _tt_init = 1;
    }
    __m128i r;
    r.u32[0] = T0[a.u8[0]]  ^ T1[a.u8[5]]  ^ T2[a.u8[10]] ^ T3[a.u8[15]] ^ rk.u32[0];
    r.u32[1] = T0[a.u8[4]]  ^ T1[a.u8[9]]  ^ T2[a.u8[14]] ^ T3[a.u8[3]]  ^ rk.u32[1];
    r.u32[2] = T0[a.u8[8]]  ^ T1[a.u8[13]] ^ T2[a.u8[2]]  ^ T3[a.u8[7]]  ^ rk.u32[2];
    r.u32[3] = T0[a.u8[12]] ^ T1[a.u8[1]]  ^ T2[a.u8[6]]  ^ T3[a.u8[11]] ^ rk.u32[3];
    return r;
}

static inline __m128i _mm_aesenclast_si128(__m128i a, __m128i rk) {
    static const uint8_t sbox[256] = {
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    };
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = sbox[a.u8[i]];
    uint8_t t[16];
    t[0] = s[0];   t[1] = s[5];   t[2] = s[10];  t[3] = s[15];
    t[4] = s[4];   t[5] = s[9];   t[6] = s[14];  t[7] = s[3];
    t[8] = s[8];   t[9] = s[13];  t[10] = s[2];  t[11] = s[7];
    t[12] = s[12]; t[13] = s[1];  t[14] = s[6];  t[15] = s[11];
    __m128i r;
    for (int i = 0; i < 16; i++) r.u8[i] = t[i] ^ rk.u8[i];
    return r;
}

static inline __m128i _mm_aesdec_si128(__m128i a,__m128i b){(void)b;return a;}
static inline __m128i _mm_aesdeclast_si128(__m128i a,__m128i b){(void)b;return a;}
static inline __m128i _mm_aesimc_si128(__m128i a){return a;}
static inline __m128i _mm_aeskeygenassist_si128(__m128i a,int imm){(void)imm;return a;}

#endif // __WASM_X86INTRIN_PATCH
EOF

# ── symlink other intrinsic headers so #include <immintrin.h> etc. work ──────
ln -sf "$PATCH/x86intrin.h" "$PATCH/immintrin.h"  2>/dev/null || cp "$PATCH/x86intrin.h" "$PATCH/immintrin.h"
ln -sf "$PATCH/x86intrin.h" "$PATCH/wmmintrin.h"  2>/dev/null || cp "$PATCH/x86intrin.h" "$PATCH/wmmintrin.h"
ln -sf "$PATCH/x86intrin.h" "$PATCH/emmintrin.h"  2>/dev/null || cp "$PATCH/x86intrin.h" "$PATCH/emmintrin.h"
ln -sf "$PATCH/x86intrin.h" "$PATCH/pmmintrin.h"  2>/dev/null || cp "$PATCH/x86intrin.h" "$PATCH/pmmintrin.h"
ln -sf "$PATCH/x86intrin.h" "$PATCH/smmintrin.h"  2>/dev/null || cp "$PATCH/x86intrin.h" "$PATCH/smmintrin.h"

# ── sse2neon stubs (ARM fallback paths in the portable cpp) ─────────────────
cat > "$PATCH/crypto/sse2neon.h" << 'EOF'
#pragma once
#include "../x86intrin.h"
EOF
cat > "$PATCH/crypto/compat/sse2neon.h" << 'EOF'
#pragma once
#include "../x86intrin.h"
EOF

# ── haraka.h (good one — used by verus_hash.cpp) ────────────────────────────
cat > "$PATCH/haraka.h" << 'EOF'
#pragma once
#include "x86intrin.h"

#ifdef __cplusplus
extern "C" {
#endif

#include "haraka_portable.h"

void load_constants(void);
void haraka512_zero(unsigned char *out, const unsigned char *in);
void haraka512(unsigned char *out, const unsigned char *in);
void haraka256(unsigned char *out, const unsigned char *in);
void haraka512_keyed(unsigned char *out, const unsigned char *in, const __m128i *keys);

#ifdef __cplusplus
}
#endif
EOF

# ── crypto/haraka.h (minimal redirect) ──────────────────────────────────────
cat > "$PATCH/crypto/haraka.h" << 'EOF'
#pragma once
#include "haraka_portable.h"
EOF

# ── haraka_stubs.c ──────────────────────────────────────────────────────────
cat > "$PATCH/haraka_stubs.c" << 'EOF'
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
    haraka512_port_keyed(out, in, keys);
}
EOF

# ── verus_wrapper.cpp ───────────────────────────────────────────────────────
cat > "$PATCH/verus_wrapper.cpp" << 'EOF'
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

/* One persistent hasher, created lazily and reused across every call — matches
 * the pool's verushash-node pattern and avoids per-hash allocation. */
static CVerusHashV2 *ensure_hasher() {
    static CVerusHashV2 *hasher = nullptr;
    if (!hasher) {
        CVerusHash::init();
        CVerusHashV2::init();
        hasher = new CVerusHashV2(SOLUTION_VERUSHHASH_V2_2);
    }
    return hasher;
}

/* Increment a little-endian counter of `len` bytes at `p` (matches JS
 * incrementNonce2 / mine_test.js). */
static inline void inc_le(uint8_t *p, uint32_t len) {
    for (uint32_t k = 0; k < len; k++) {
        if (++p[k] != 0) break;  /* no carry needed */
    }
}

/* Return 1 if the raw little-endian `hash` (reversed to big-endian) is <= the
 * 32-byte big-endian `target`, i.e. a valid share. Byte-identical to the JS
 * meetsTarget()/mine_test.js compare: MSB first, hash[31-i] vs target[i]. */
static inline int meets_target(const uint8_t *hash, const uint8_t *target) {
    for (int i = 0; i < 32; i++) {
        uint8_t hb = hash[31 - i];   /* big-endian: MSB is the last raw byte */
        if (hb < target[i]) return 1;
        if (hb > target[i]) return 0;
    }
    return 1;  /* equal ⇒ valid */
}

/* 1 if display(a) < display(b) — i.e. raw LE hash `a` reversed is the smaller
 * big-endian value (closer to target). MSB is raw byte 31. */
static inline int is_lower(const uint8_t *a, const uint8_t *b) {
    for (int i = 31; i >= 0; i--) {
        if (a[i] < b[i]) return 1;
        if (a[i] > b[i]) return 0;
    }
    return 0;
}

extern "C" {

/**
 * Compute VerusHash 2b2 of `len` bytes at `in`,
 * write 32-byte result into `out`.
 *
 * Uses CVerusHashV2 with solutionVersion=SOLUTION_VERUSHHASH_V2_2 (4)
 * and Finalize2b() — this matches the pool's vh.hash2b2() call.
 * The static Hash() method only does a Haraka512 loop and completely
 * skips the CLHash key mutation + keyed Haraka512 finalization step.
 *
 * Called from JS as: verusHashFunc(inPtr, len, outPtr)
 */
EMSCRIPTEN_KEEPALIVE
void verus_hash(const uint8_t *in, uint32_t len, uint8_t *out) {
    CVerusHashV2 *hasher = ensure_hasher();
    hasher->Reset();
    hasher->Write(in, len);
    hasher->Finalize2b(out);
}

/**
 * Batch mining loop — runs entirely inside WASM to eliminate the per-hash
 * JS↔WASM boundary and JS array churn.
 *
 * `input` is a resident 1487-byte buffer in the WASM heap (built once per job by
 * JS). Each iteration increments the little-endian counting nonce IN PLACE at
 * input[nonce_offset .. nonce_offset+inc_len) — for merged-mining v7 this is the
 * only entropy that reaches the hash (the header nonce stays zeroed) — then
 * hashes the full buffer and compares against the big-endian `target`.
 *
 * Returns:
 *   >= 0 : the 0-based index of the winning hash. The buffer is LEFT at the
 *          winning nonce and `out_hash` holds the 32-byte raw (LE) winning hash,
 *          so JS can read the solution + counting nonce straight from the heap.
 *   -1   : no win this batch. The buffer is left at the last nonce tried, so the
 *          next call simply continues the search.
 *
 * `best_hash` (optional, may be NULL) receives the lowest hash seen this batch —
 * for the UI "best" diagnostic. Pass 0/NULL to skip.
 *
 * Called from JS as:
 *   verusHashBatch(inPtr, inLen, nonceOff, incLen, iters, targetPtr, outPtr, bestPtr)
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

    /* ── Midstate (sponge prefix cache) ──────────────────────────────────────
     * Bytes [0, nonce_offset) are constant across the whole batch — only the
     * counting nonce at nonce_offset changes — so the Write sponge over the
     * largest 32-byte-aligned prefix is identical every iteration (~46 of 47
     * haraka512/hash here). Absorb it ONCE, snapshot the 32-byte chaining value,
     * then per-nonce resume from it and absorb only the tail (bytes [prefix,end),
     * which contains the nonce). Bit-identical to a full Write: after an aligned
     * prefix curPos==0 and only curBuf[0:32] carries forward; the stale
     * curBuf[32:64] is fully overwritten by the tail Write + Finalize2b's
     * FillExtra, so it can't affect the result. verify_batch.js is the gate. */
    uint32_t prefix_len = (nonce_offset / 32) * 32;
    bool use_mid = (prefix_len >= 32 && prefix_len <= input_len && prefix_len <= nonce_offset);
    uint8_t midstate[32];
    if (use_mid) {
        hasher->Reset();
        hasher->Write(input, prefix_len);
        memcpy(midstate, hasher->CurBuffer(), 32);   /* chaining value; curPos==0 */
    }
    const uint8_t *tail = input + prefix_len;
    uint32_t tail_len = input_len - prefix_len;

    for (uint32_t i = 0; i < iterations; i++) {
        /* Increment first: the initial (random) nonce is never hashed directly,
         * matching the JS loop which increments before hashing. */
        inc_le(noncep, inc_len);
        hasher->Reset();
        if (use_mid) {
            memcpy(hasher->CurBuffer(), midstate, 32);   /* resume from snapshot */
            hasher->Write(tail, tail_len);               /* absorb only the tail */
        } else {
            hasher->Write(input, input_len);
        }
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
EOF

# ── SIMD (vpaes) AES for Haraka512 — turbo binary only (option #3) ───────────
# Table-free WASM-SIMD AES round: SubBytes via GF(2^4) inversion using in-register
# swizzle nibble lookups (no memory gather — T-tables can't vectorize on WASM),
# then standard ShiftRows/MixColumns/AddKey. Bit-identical to the scalar T-table
# path — validated in scripts/vpaes_check.js. Emitted here (tracked) and injected
# into haraka_portable.c guarded by __wasm_simd128__, so the baseline (no -msimd128)
# keeps the scalar T-table aesenc. Constants generated by `DUMP=1 node vpaes_check.js`.
cat > "$PATCH/haraka_vpaes.inc" << 'INCEOF'
/* WASM-SIMD (vpaes) AES round — see scripts/vpaes_check.js for the validated model. */
#include <wasm_simd128.h>

void aesenc(unsigned char *s, const unsigned char *rk) {
    /* vpaes constants — function-local so they are valid C initializers. A
     * file-scope `static const v128_t = wasm_u8x16_const(...)` is rejected in C
     * as "initializer element is not a compile-time constant"; as locals, -O3
     * materializes them as v128.const immediates (hoisted when aesenc inlines). */
    const v128_t VP_s0F    = wasm_u8x16_const(0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f,0x0f);
    const v128_t VP_ipt_lo = wasm_u8x16_const(0x00,0x70,0x2a,0x5a,0x98,0xe8,0xb2,0xc2,0x08,0x78,0x22,0x52,0x90,0xe0,0xba,0xca);
    const v128_t VP_ipt_hi = wasm_u8x16_const(0x00,0x4d,0x7c,0x31,0x7d,0x30,0x01,0x4c,0x81,0xcc,0xfd,0xb0,0xfc,0xb1,0x80,0xcd);
    const v128_t VP_inv    = wasm_u8x16_const(0x80,0x01,0x08,0x0d,0x0f,0x06,0x05,0x0e,0x02,0x0c,0x0b,0x0a,0x09,0x03,0x07,0x04);
    const v128_t VP_inva   = wasm_u8x16_const(0x80,0x07,0x0b,0x0f,0x06,0x0a,0x04,0x01,0x09,0x08,0x05,0x02,0x0c,0x0e,0x0d,0x03);
    const v128_t VP_sbo_lo = wasm_u8x16_const(0x00,0xc7,0xbd,0x6f,0x17,0x6d,0xd2,0xd0,0x78,0xa8,0x02,0xc5,0x7a,0xbf,0xaa,0x15);
    const v128_t VP_sbo_hi = wasm_u8x16_const(0x00,0x6a,0xbb,0x5f,0xa5,0x74,0xe4,0xcf,0xfa,0x35,0x2b,0x41,0xd1,0x90,0x1e,0x8e);
    const v128_t VP_SR     = wasm_u8x16_const(0x00,0x05,0x0a,0x0f,0x04,0x09,0x0e,0x03,0x08,0x0d,0x02,0x07,0x0c,0x01,0x06,0x0b);
    const v128_t VP_R1     = wasm_u8x16_const(0x01,0x02,0x03,0x00,0x05,0x06,0x07,0x04,0x09,0x0a,0x0b,0x08,0x0d,0x0e,0x0f,0x0c);
    const v128_t VP_R2     = wasm_u8x16_const(0x02,0x03,0x00,0x01,0x06,0x07,0x04,0x05,0x0a,0x0b,0x08,0x09,0x0e,0x0f,0x0c,0x0d);
    const v128_t VP_R3     = wasm_u8x16_const(0x03,0x00,0x01,0x02,0x07,0x04,0x05,0x06,0x0b,0x08,0x09,0x0a,0x0f,0x0c,0x0d,0x0e);
    v128_t state = wasm_v128_load(s);
    v128_t key   = wasm_v128_load(rk);
    /* nibbles */
    v128_t lo = wasm_v128_and(state, VP_s0F);
    v128_t hi = wasm_v128_and(wasm_u32x4_shr(state, 4), VP_s0F);
    /* vpaes input transform */
    v128_t x  = wasm_v128_xor(wasm_i8x16_swizzle(VP_ipt_lo, lo),
                              wasm_i8x16_swizzle(VP_ipt_hi, hi));
    /* GF(2^4) inversion (vpaes entry) */
    v128_t i  = wasm_v128_and(wasm_u32x4_shr(x, 4), VP_s0F);
    v128_t k  = wasm_v128_and(x, VP_s0F);
    v128_t ak = wasm_i8x16_swizzle(VP_inva, k);
    v128_t j  = wasm_v128_xor(k, i);
    v128_t iak = wasm_v128_xor(wasm_i8x16_swizzle(VP_inv, i), ak);
    v128_t jak = wasm_v128_xor(wasm_i8x16_swizzle(VP_inv, j), ak);
    v128_t io = wasm_v128_xor(wasm_i8x16_swizzle(VP_inv, iak), j);
    v128_t jo = wasm_v128_xor(wasm_i8x16_swizzle(VP_inv, jak), i);
    /* SubBytes (standard domain): sbo tables + AES affine constant 0x63 */
    v128_t sub = wasm_v128_xor(wasm_i8x16_swizzle(VP_sbo_lo, io),
                               wasm_i8x16_swizzle(VP_sbo_hi, jo));
    sub = wasm_v128_xor(sub, wasm_u8x16_splat(0x63));
    /* ShiftRows */
    v128_t t = wasm_i8x16_swizzle(sub, VP_SR);
    /* MixColumns: y = t2 ^ R1(t2) ^ R1(t) ^ R2(t) ^ R3(t), t2 = xtime(t) */
    v128_t t2 = wasm_v128_xor(wasm_i8x16_shl(t, 1),
                    wasm_v128_and(wasm_i8x16_shr(t, 7), wasm_u8x16_splat(0x1b)));
    v128_t mc = wasm_v128_xor(
        wasm_v128_xor(t2, wasm_i8x16_swizzle(t2, VP_R1)),
        wasm_v128_xor(wasm_i8x16_swizzle(t, VP_R1),
            wasm_v128_xor(wasm_i8x16_swizzle(t, VP_R2), wasm_i8x16_swizzle(t, VP_R3))));
    /* AddRoundKey */
    wasm_v128_store(s, wasm_v128_xor(mc, key));
}
INCEOF

# Idempotently wrap the scalar aesenc in #ifndef __wasm_simd128__ and pull in the
# SIMD version above for the turbo build. Marker guard makes it safe to re-run.
if ! grep -q 'HARAKA_SIMD_AESENC_PATCH' "$PATCH/haraka_portable.c"; then
    awk '
      /^void aesenc\(unsigned char \*s, const unsigned char \*rk\)/ && !patched {
          print "/* HARAKA_SIMD_AESENC_PATCH */";
          print "#ifdef __wasm_simd128__";
          print "#include \"haraka_vpaes.inc\"";
          print "#else";
          print; patched=1; next;
      }
      /^void aesenc2\(/ && patched==1 { print "#endif"; patched=2 }
      { print }
    ' "$PATCH/haraka_portable.c" > "$PATCH/haraka_portable.c.tmp" \
      && mv "$PATCH/haraka_portable.c.tmp" "$PATCH/haraka_portable.c"
    cp "$PATCH/haraka_portable.c" "$PATCH/crypto/haraka_portable.c" 2>/dev/null || true
    echo "✅ Injected SIMD vpaes aesenc into haraka_portable.c (turbo build)"
else
    echo "✅ haraka_portable.c already has SIMD aesenc patch — skipping"
fi

# ── Stage 2: N-way bitsliced Haraka (turbo binary only) ─────────────────────
# Adds haraka512_port_x2 (2 states/8 blocks) + haraka256_port_x4 (4 states/8
# blocks) + self-test exports. 1:1 port of the node-validated scripts/
# bitslice_cmodel.js. Appended (not replacing aesenc) so the single-block scalar
# path is untouched; the batch loop calls these directly. Guarded __wasm_simd128__
# so the baseline build never sees the SIMD intrinsics.
cp "$ROOT/haraka_bitslice.inc" "$PATCH/haraka_bitslice.inc"
cp "$ROOT/haraka_bitslice.inc" "$PATCH/crypto/haraka_bitslice.inc" 2>/dev/null || true
if ! grep -q 'HARAKA_BITSLICE_PATCH' "$PATCH/haraka_portable.c"; then
    cat >> "$PATCH/haraka_portable.c" << 'EOF'

/* HARAKA_BITSLICE_PATCH */
#ifdef __wasm_simd128__
#include "haraka_bitslice.inc"
#endif
EOF
    cp "$PATCH/haraka_portable.c" "$PATCH/crypto/haraka_portable.c" 2>/dev/null || true
    echo "✅ Appended bitsliced Haraka (x2/x4 + self-test) to turbo build"
else
    echo "✅ haraka_portable.c already has bitslice patch — skipping (inc re-copied)"
fi

# ── CLHash: SIMD _mm_mulhrs_epi16_emu (turbo only) ──────────────────────────
# The only CLHash hot-loop op WASM SIMD can accelerate: the scalar 8-lane int16
# mulhrs loop → i32x4 extmul (exact 16×16→32) + round + arith>>15 + WRAP-narrow.
# Validated bit-exact (incl. the -32768² wrap corner) by scripts/clmul_simd_check.js.
# (clmul CANNOT be vectorized — no WASM PCLMULQDQ, gather-unfriendly; see notes.)
# NOTE: -O3 -msimd128 may already auto-vectorize this loop; bench_wasm.js is the
# arbiter of whether the manual version helps. Baseline keeps the scalar path.
if ! grep -q 'MULHRS_SIMD_PATCH' "$PATCH/verus_clhash_portable.cpp"; then
    awk '
      NR==1 { print "#ifdef __wasm_simd128__"; print "#include <wasm_simd128.h>"; print "#endif"; print "/* MULHRS_SIMD_PATCH */"; }
      /_mm_mulhrs_epi16_emu\(__m128i _a, __m128i _b\)$/ && !done {
          print; getline brace; print brace;                 # signature + "{"
          print "#ifdef __wasm_simd128__";
          print "    {";
          print "        v128_t _va = wasm_v128_load(&_a), _vb = wasm_v128_load(&_b);";
          print "        v128_t _lo = wasm_i32x4_extmul_low_i16x8(_va, _vb);";
          print "        v128_t _hi = wasm_i32x4_extmul_high_i16x8(_va, _vb);";
          print "        v128_t _k  = wasm_i32x4_splat(0x4000);";
          print "        _lo = wasm_i32x4_shr(wasm_i32x4_add(_lo, _k), 15);";
          print "        _hi = wasm_i32x4_shr(wasm_i32x4_add(_hi, _k), 15);";
          print "        v128_t _p = wasm_i16x8_shuffle(_lo, _hi, 0,2,4,6, 8,10,12,14);";  # wrap-narrow low16 of each i32
          print "        u128 _r; wasm_v128_store(&_r, _p); return _r;";
          print "    }";
          print "#endif";
          done=1; next;
      }
      { print }
    ' "$PATCH/verus_clhash_portable.cpp" > "$PATCH/verus_clhash_portable.cpp.tmp" \
      && mv "$PATCH/verus_clhash_portable.cpp.tmp" "$PATCH/verus_clhash_portable.cpp"
    echo "✅ Injected SIMD _mm_mulhrs_epi16_emu into verus_clhash_portable.cpp (turbo build)"
else
    echo "✅ verus_clhash_portable.cpp already has mulhrs SIMD patch — skipping"
fi

# ── compile ─────────────────────────────────────────────────────────────────
# build_wasm <out_base> <opt/simd flags...>
# Produces <out_base>.js + <out_base>.wasm. Both builds share the same sources
# and exports (including the new _verus_hash_batch loop); only the optimization
# / SIMD flags differ.
build_wasm() {
    local out_base="$1"; shift
    echo "Compiling VerusHash WASM module → $(basename "$out_base").{js,wasm} ($*)"
    emcc \
      "$PATCH/verus_wrapper.cpp" \
      "$PATCH/verus_hash.cpp" \
      "$PATCH/verus_clhash_portable.cpp" \
      "$PATCH/haraka_portable.c" \
      "$PATCH/haraka_stubs.c" \
      -I"$PATCH" \
      -I"$BUILD_DIR/VerusCoin/src" \
      -s WASM=1 \
      -s EXPORTED_FUNCTIONS='["_malloc","_free","_verus_hash","_verus_hash_batch"]' \
      -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8"]' \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s MODULARIZE=1 \
      -s EXPORT_NAME="VerusHashModule" \
      -s ENVIRONMENT='web,worker' \
      -s ASSERTIONS=1 \
      "$@" \
      -o "$out_base.js"
    echo "Done. Output: $out_base.js / .wasm"
    ls -lh "$out_base."*
}

# Emit build artifacts to a NATIVE Linux filesystem, not the /mnt/c DrvFs mount.
# emcc's post-link llvm-objcopy step rewrites the .wasm in place, which fails with
# "Operation not permitted" on Windows-mounted drives under WSL. We build here and
# only copy the finished files onto the (possibly mounted) client dir below.
OUT_DIR="${VERUS_WASM_OUT:-${TMPDIR:-/tmp}/verus_wasm_build}"
mkdir -p "$OUT_DIR"

# Baseline: maximum compatibility, no SIMD (software AES emulation only).
# NOTE: -O3 with inlining (dropped the old -fno-inline, which crippled the hot
# AES/Haraka path). verify_batch.js confirms inlining is correctness-safe.
build_wasm "$OUT_DIR/verus_hash"      -O3 -fkeep-static-consts

# Turbo: WebAssembly SIMD (-msimd128) + -O3 so the vectorizer can inline the
# __m128i operator/AES helpers and vectorize the 16-byte lanewise loops. Loaded
# only when the browser reports WASM SIMD support. Drop -fno-inline here.
build_wasm "$OUT_DIR/verus_hash_simd" -O3 -msimd128 -fkeep-static-consts

# ── Deploy to client/public/wasm/ ───────────────────────────────────────────
# Plain cp onto DrvFs works fine — only in-place objcopy did not.
CLIENT_WASM="$ROOT/../client/public/wasm"
mkdir -p "$CLIENT_WASM"
cp "$OUT_DIR/verus_hash.js"        "$CLIENT_WASM/"
cp "$OUT_DIR/verus_hash.wasm"      "$CLIENT_WASM/"
cp "$OUT_DIR/verus_hash_simd.js"   "$CLIENT_WASM/"
cp "$OUT_DIR/verus_hash_simd.wasm" "$CLIENT_WASM/"
echo "✅ Copied baseline + turbo binaries to $CLIENT_WASM/"
ls -lh "$CLIENT_WASM/"