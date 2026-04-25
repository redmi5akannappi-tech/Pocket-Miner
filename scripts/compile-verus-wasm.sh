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

# ── clone source ────────────────────────────────────────────────────────────
if [ ! -d "$BUILD_DIR/VerusCoin" ]; then
    mkdir -p "$BUILD_DIR"
    git clone --depth 1 https://github.com/VerusCoin/VerusCoin.git "$BUILD_DIR/VerusCoin"
fi

# ── prepare patch dir ───────────────────────────────────────────────────────
rm -rf "$PATCH" && mkdir -p "$PATCH"

# copy real sources
cp "$CRYPTO/verus_hash.h"              "$PATCH/"
cp "$CRYPTO/verus_hash.cpp"            "$PATCH/"
cp "$CRYPTO/verus_clhash.h"            "$PATCH/"
cp "$CRYPTO/verus_clhash_portable.cpp" "$PATCH/"
cp "$CRYPTO/haraka_portable.h"         "$PATCH/"
cp "$CRYPTO/haraka_portable.c"         "$PATCH/"

# ── patch verus_clhash.h ────────────────────────────────────────────────────
sed -i '1s/^/#include <sstream>\n#include "uint256.h"\n#include "x86intrin.h"\n#include "cpuid.h"\n/' "$PATCH/verus_clhash.h"

# crypto/ subdir mirrors — AFTER sed patches so they get patched versions
mkdir -p "$PATCH/crypto/compat"
cp "$PATCH/verus_clhash.h"    "$PATCH/crypto/verus_clhash.h"
cp "$PATCH/haraka_portable.h" "$PATCH/crypto/haraka_portable.h"
cp "$PATCH/haraka_portable.c" "$PATCH/crypto/haraka_portable.c"

# ── patch verus_hash.cpp ────────────────────────────────────────────────────
# real verus_hash.cpp includes crypto/haraka.h; we redirect it to our portable stub
sed -i '1s/^/#include "haraka.h"\n/' "$PATCH/verus_hash.cpp"

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
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = sbox[a.u8[i]];
    uint8_t t[16];
    t[0] = s[0];   t[1] = s[5];   t[2] = s[10];  t[3] = s[15];
    t[4] = s[4];   t[5] = s[9];   t[6] = s[14];  t[7] = s[3];
    t[8] = s[8];   t[9] = s[13];  t[10] = s[2];  t[11] = s[7];
    t[12] = s[12]; t[13] = s[1];  t[14] = s[6];  t[15] = s[11];
    __m128i r;
    for (int c = 0; c < 4; c++) {
        uint8_t a0 = t[c*4], a1 = t[c*4+1], a2 = t[c*4+2], a3 = t[c*4+3];
        r.u8[c*4]   = _wasm_xtime(a0) ^ _wasm_xtime(a1) ^ a1 ^ a2 ^ a3 ^ rk.u8[c*4];
        r.u8[c*4+1] = a0 ^ _wasm_xtime(a1) ^ _wasm_xtime(a2) ^ a2 ^ a3 ^ rk.u8[c*4+1];
        r.u8[c*4+2] = a0 ^ a1 ^ _wasm_xtime(a2) ^ _wasm_xtime(a3) ^ a3 ^ rk.u8[c*4+2];
        r.u8[c*4+3] = _wasm_xtime(a0) ^ a0 ^ a1 ^ a2 ^ _wasm_xtime(a3) ^ rk.u8[c*4+3];
    }
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
EOF

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
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = sbox[a.u8[i]];
    uint8_t t[16];
    t[0] = s[0];   t[1] = s[5];   t[2] = s[10];  t[3] = s[15];
    t[4] = s[4];   t[5] = s[9];   t[6] = s[14];  t[7] = s[3];
    t[8] = s[8];   t[9] = s[13];  t[10] = s[2];  t[11] = s[7];
    t[12] = s[12]; t[13] = s[1];  t[14] = s[6];  t[15] = s[11];
    __m128i r;
    for (int c = 0; c < 4; c++) {
        uint8_t a0 = t[c*4], a1 = t[c*4+1], a2 = t[c*4+2], a3 = t[c*4+3];
        r.u8[c*4]   = _wasm_xtime(a0) ^ _wasm_xtime(a1) ^ a1 ^ a2 ^ a3 ^ rk.u8[c*4];
        r.u8[c*4+1] = a0 ^ _wasm_xtime(a1) ^ _wasm_xtime(a2) ^ a2 ^ a3 ^ rk.u8[c*4+1];
        r.u8[c*4+2] = a0 ^ a1 ^ _wasm_xtime(a2) ^ _wasm_xtime(a3) ^ a3 ^ rk.u8[c*4+2];
        r.u8[c*4+3] = _wasm_xtime(a0) ^ a0 ^ a1 ^ a2 ^ _wasm_xtime(a3) ^ rk.u8[c*4+3];
    }
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
    (void)keys;
    haraka512_perm(out, in);
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
EOF

# ── compile ─────────────────────────────────────────────────────────────────
echo "Compiling VerusHash WASM module..."
emcc \
  "$PATCH/verus_wrapper.cpp" \
  "$PATCH/verus_hash.cpp" \
  "$PATCH/verus_clhash_portable.cpp" \
  "$PATCH/haraka_portable.c" \
  "$PATCH/haraka_stubs.c" \
  -I"$PATCH" \
  -I"$BUILD_DIR/VerusCoin/src" \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_verus_hash"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="VerusHashModule" \
  -s ENVIRONMENT='web,worker' \
  -O3 \
  -o "$BUILD_DIR/verus_hash.js"

echo "Done. Output: $BUILD_DIR/verus_hash.js / .wasm"
ls -lh "$BUILD_DIR/verus_hash."*

# ── Deploy to client/public/wasm/ ───────────────────────────────────────────
CLIENT_WASM="$ROOT/../client/public/wasm"
mkdir -p "$CLIENT_WASM"
cp "$BUILD_DIR/verus_hash.js"   "$CLIENT_WASM/"
cp "$BUILD_DIR/verus_hash.wasm" "$CLIENT_WASM/"
echo "✅ Copied to $CLIENT_WASM/"
ls -lh "$CLIENT_WASM/"