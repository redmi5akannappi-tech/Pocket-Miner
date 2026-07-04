/* haraka_bitslice.inc — Stage 2 (2d). N-way bitsliced Haraka for the turbo
 * (WASM-SIMD) binary. Processes MANY independent AES blocks at once through a
 * gate-logic S-box (no table gather), amortizing the SubBytes latency that made
 * Stage-1 vpaes a wash. Two entry points, both guarded __wasm_simd128__:
 *
 *   haraka512_port_x2(out0,out1, in0,in1)      — 2 states × 4 chunks = 8 blocks
 *                                                  → sponge (Write) at 2 nonces/call
 *   haraka256_port_x4(o0,o1,o2,o3, i0..i3)     — 4 states × 2 chunks = 8 blocks
 *                                                  → GenNewCLKey chain at 4 nonces/call
 *
 * This C is a 1:1 translation of scripts/bitslice_cmodel.js, which is validated
 * bit-exact vs the published Haraka512 KAT and the scalar reference in pure node
 * (no emcc). Layout ("blocks-in-bits"): 8 planes = 8 v128; plane[i] byte `by` holds
 * {bit i of block0.byte[by] .. block7.byte[by]} in its 8 bits. S-box = bitwise on
 * planes; ShiftRows/MixColumns rotates = i8x16 swizzles; ortho = 8×8 bit-transpose.
 *
 * DO NOT hand-edit the arithmetic — regenerate/verify against the cmodel. Validate
 * the compiled intrinsics with: node scripts/verify_bitslice_wasm.js (self-test).
 */
#include <wasm_simd128.h>
#include <emscripten.h>

/* ── 8×8 bit-transpose across the 8 plane registers, per byte lane. Standard
 * 3-stage SWAPMOVE network; it is its own inverse, so deortho == ortho. ── */
static inline void bs_ortho(v128_t q[8]) {
    const v128_t M1 = wasm_u8x16_splat(0x55);
    const v128_t M2 = wasm_u8x16_splat(0x33);
    const v128_t M4 = wasm_u8x16_splat(0x0f);
    #define BS_SWM(XI, YI, M, SH) do { \
        v128_t _t = wasm_v128_and(wasm_v128_xor(wasm_u8x16_shr(q[XI], SH), q[YI]), M); \
        q[YI] = wasm_v128_xor(q[YI], _t); \
        q[XI] = wasm_v128_xor(q[XI], wasm_i8x16_shl(_t, SH)); \
    } while (0)
    BS_SWM(0,1,M1,1); BS_SWM(2,3,M1,1); BS_SWM(4,5,M1,1); BS_SWM(6,7,M1,1);
    BS_SWM(0,2,M2,2); BS_SWM(1,3,M2,2); BS_SWM(4,6,M2,2); BS_SWM(5,7,M2,2);
    BS_SWM(0,4,M4,4); BS_SWM(1,5,M4,4); BS_SWM(2,6,M4,4); BS_SWM(3,7,M4,4);
    #undef BS_SWM
}

/* Boyar-Peralta bitsliced AES S-box (BearSSL aes_ct) on 8 v128 planes, in place.
 * q[0]=LSB. 1:1 with bitsliceSbox() in bitslice_cmodel.js. */
static inline void bs_sbox(v128_t q[8]) {
    #define X(a,b) wasm_v128_xor((a),(b))
    #define A(a,b) wasm_v128_and((a),(b))
    #define N(a)   wasm_v128_not((a))
    v128_t x0=q[7],x1=q[6],x2=q[5],x3=q[4],x4=q[3],x5=q[2],x6=q[1],x7=q[0];
    v128_t y14=X(x3,x5), y13=X(x0,x6), y9=X(x0,x3), y8=X(x0,x5);
    v128_t t0=X(x1,x2), y1=X(t0,x7), y4=X(y1,x3), y12=X(y13,y14), y2=X(y1,x0), y5=X(y1,x6), y3=X(y5,y8);
    v128_t t1=X(x4,y12), y15=X(t1,x5), y20=X(t1,x1), y6=X(y15,x7), y10=X(y15,t0), y11=X(y20,y9);
    v128_t y7=X(x7,y11), y17=X(y10,y11), y19=X(y10,y8), y16=X(t0,y11), y21=X(y13,y16), y18=X(x0,y16);
    v128_t t2=A(y12,y15), t3=A(y3,y6), t4=X(t3,t2), t5=A(y4,x7), t6=X(t5,t2), t7=A(y13,y16), t8=A(y5,y1), t9=X(t8,t7);
    v128_t t10=A(y2,y7), t11=X(t10,t7), t12=A(y9,y11), t13=A(y14,y17), t14=X(t13,t12), t15=A(y8,y10), t16=X(t15,t12);
    v128_t t17=X(t4,t14), t18=X(t6,t16), t19=X(t9,t14), t20=X(t11,t16), t21=X(t17,y20), t22=X(t18,y19), t23=X(t19,y21), t24=X(t20,y18);
    v128_t t25=X(t21,t22), t26=A(t21,t23), t27=X(t24,t26), t28=A(t25,t27), t29=X(t28,t22), t30=X(t23,t24), t31=X(t22,t26);
    v128_t t32=A(t31,t30), t33=X(t32,t24), t34=X(t23,t33), t35=X(t27,t33), t36=A(t24,t35), t37=X(t36,t34), t38=X(t27,t36);
    v128_t t39=A(t29,t38), t40=X(t25,t39), t41=X(t40,t37), t42=X(t29,t33), t43=X(t29,t40), t44=X(t33,t37), t45=X(t42,t41);
    v128_t z0=A(t44,y15), z1=A(t37,y6), z2=A(t33,x7), z3=A(t43,y16), z4=A(t40,y1), z5=A(t29,y7), z6=A(t42,y11), z7=A(t45,y17), z8=A(t41,y10);
    v128_t z9=A(t44,y12), z10=A(t37,y3), z11=A(t33,y4), z12=A(t43,y13), z13=A(t40,y5), z14=A(t29,y2), z15=A(t42,y9), z16=A(t45,y14), z17=A(t41,y8);
    v128_t t46=X(z15,z16), t47=X(z10,z11), t48=X(z5,z13), t49=X(z9,z10), t50=X(z2,z12), t51=X(z2,z5), t52=X(z7,z8), t53=X(z0,z3);
    v128_t t54=X(z6,z7), t55=X(z16,z17), t56=X(z12,t48), t57=X(t50,t53), t58=X(z4,t46), t59=X(z3,t54), t60=X(t46,t57);
    v128_t t61=X(z14,t57), t62=X(t52,t58), t63=X(t49,t58), t64=X(z4,t59), t65=X(t61,t62), t66=X(z1,t63);
    v128_t s0=X(t59,t63), s6=X(t56,N(t62)), s7=X(t48,N(t60)), t67=X(t64,t65), s3=X(t53,t66), s4=X(t51,t66), s5=X(t47,t65);
    v128_t s1=X(t64,N(s3)), s2=X(t55,N(t67));
    q[7]=s0; q[6]=s1; q[5]=s2; q[4]=s3; q[3]=s4; q[2]=s5; q[1]=s6; q[0]=s7;
    #undef X
    #undef A
    #undef N
}

/* One 8-way bitsliced AES round in the plane domain: SubBytes (bitwise) →
 * ShiftRows (swizzle) → MixColumns (xtime + column-rotate swizzles) → AddRoundKey.
 * kq = 8 key planes (precomputed constants). 1:1 with cRound() in the cmodel. */
static inline void bs_round(v128_t q[8], const v128_t kq[8]) {
    const v128_t SR = wasm_u8x16_const(0,5,10,15, 4,9,14,3, 8,13,2,7, 12,1,6,11);
    const v128_t R1 = wasm_u8x16_const(1,2,3,0, 5,6,7,4, 9,10,11,8, 13,14,15,12);
    const v128_t R2 = wasm_u8x16_const(2,3,0,1, 6,7,4,5, 10,11,8,9, 14,15,12,13);
    const v128_t R3 = wasm_u8x16_const(3,0,1,2, 7,4,5,6, 11,8,9,10, 15,12,13,14);
    bs_sbox(q);
    v128_t sr[8];
    for (int i = 0; i < 8; i++) sr[i] = wasm_i8x16_swizzle(q[i], SR);
    /* xtime planes: t2 = [sr7, sr0^sr7, sr1, sr2^sr7, sr3^sr7, sr4, sr5, sr6] */
    v128_t t2[8];
    t2[0]=sr[7]; t2[1]=wasm_v128_xor(sr[0],sr[7]); t2[2]=sr[1]; t2[3]=wasm_v128_xor(sr[2],sr[7]);
    t2[4]=wasm_v128_xor(sr[3],sr[7]); t2[5]=sr[4]; t2[6]=sr[5]; t2[7]=sr[6];
    for (int i = 0; i < 8; i++) {
        v128_t y = wasm_v128_xor(t2[i], wasm_i8x16_swizzle(t2[i], R1));
        y = wasm_v128_xor(y, wasm_i8x16_swizzle(sr[i], R1));
        y = wasm_v128_xor(y, wasm_i8x16_swizzle(sr[i], R2));
        y = wasm_v128_xor(y, wasm_i8x16_swizzle(sr[i], R3));
        q[i] = wasm_v128_xor(y, kq[i]);
    }
}

/* ── precomputed key planes (rc is fixed, so ortho of the key blocks is done once) ──
 * haraka512: 10 subrounds; block b uses rc[8*i+4*j + (b&3)] for both states.
 * haraka256: 10 subrounds; block b uses rc[4*i+2*j + (b&1)] for all four states. */
static v128_t bs_kq512[10][8];
static v128_t bs_kq256[10][8];
static int bs_keys_ready = 0;

/* build 8 planes from 8 key blocks via the same ortho transpose */
static void bs_keyplanes(const unsigned char blk[8][16], v128_t out[8]) {
    v128_t q[8];
    for (int b = 0; b < 8; b++) q[b] = wasm_v128_load(blk[b]);
    bs_ortho(q);
    for (int b = 0; b < 8; b++) out[b] = q[b];
}
static void bs_init_keys(void) {
    if (bs_keys_ready) return;
    load_constants_port();   /* ensure rc == haraka_rc (idempotent; also covers the
                              * isolated self-test path that never runs CVerusHashV2::init) */
    for (int sr = 0; sr < 10; sr++) {
        int base = 4 * sr;                 /* 512: 8*i+4*j == 4*(2i+j) == 4*sr */
        unsigned char blk[8][16];
        for (int b = 0; b < 8; b++) memcpy(blk[b], rc[base + (b & 3)], 16);
        bs_keyplanes(blk, bs_kq512[sr]);
    }
    for (int sr = 0; sr < 10; sr++) {
        int base = 2 * sr;                 /* 256: 4*i+2*j == 2*(2i+j) == 2*sr */
        unsigned char blk[8][16];
        for (int b = 0; b < 8; b++) memcpy(blk[b], rc[base + (b & 1)], 16);
        bs_keyplanes(blk, bs_kq256[sr]);
    }
    bs_keys_ready = 1;
}

/* SIMD unpacklo/hi via 32-bit lane shuffle */
#define BS_UNPACKLO(a,b) wasm_i32x4_shuffle((a),(b), 0,4,1,5)
#define BS_UNPACKHI(a,b) wasm_i32x4_shuffle((a),(b), 2,6,3,7)

/* haraka512 mixing on the 4 chunk-registers of one state (in place).
 * Matches haraka512_mix() in the JS reference exactly. */
static inline void bs_mix512(v128_t *a, v128_t *b, v128_t *c, v128_t *d) {
    v128_t tmp = BS_UNPACKLO(*a, *b);   /* lo(c0,c1) */
    v128_t na  = BS_UNPACKHI(*a, *b);   /* c0' = hi(c0,c1) */
    v128_t nb  = BS_UNPACKLO(*c, *d);   /* c1' = lo(c2,c3) */
    v128_t nc  = BS_UNPACKHI(*c, *d);   /* c2' = hi(c2,c3) */
    v128_t nd  = BS_UNPACKLO(na, nc);   /* c3' = lo(c0',c2') */
    v128_t na2 = BS_UNPACKHI(na, nc);   /* c0'' = hi(c0',c2') */
    v128_t nc2 = BS_UNPACKHI(nb, tmp);  /* c2'' = hi(c1',tmp) */
    v128_t nb2 = BS_UNPACKLO(nb, tmp);  /* c1'' = lo(c1',tmp) */
    *a = na2; *b = nb2; *c = nc2; *d = nd;
}
/* haraka256 mixing on the 2 chunk-registers of one state (in place). */
static inline void bs_mix256(v128_t *a, v128_t *b) {
    v128_t na = BS_UNPACKLO(*a, *b);    /* c0' = lo(c0,c1) */
    v128_t nb = BS_UNPACKHI(*a, *b);    /* c1' = hi(c0,c1) */
    *a = na; *b = nb;
}

/* ── haraka512_port for 2 states (8-way bitsliced) ── */
void haraka512_port_x2(unsigned char *out0, unsigned char *out1,
                       const unsigned char *in0, const unsigned char *in1) {
    bs_init_keys();
    v128_t blk[8];
    blk[0]=wasm_v128_load(in0);    blk[1]=wasm_v128_load(in0+16);
    blk[2]=wasm_v128_load(in0+32); blk[3]=wasm_v128_load(in0+48);
    blk[4]=wasm_v128_load(in1);    blk[5]=wasm_v128_load(in1+16);
    blk[6]=wasm_v128_load(in1+32); blk[7]=wasm_v128_load(in1+48);
    for (int i = 0; i < 5; i++) {
        v128_t q[8];
        for (int k = 0; k < 8; k++) q[k] = blk[k];
        bs_ortho(q);
        bs_round(q, bs_kq512[2*i]);
        bs_round(q, bs_kq512[2*i+1]);
        bs_ortho(q);                       /* deortho */
        for (int k = 0; k < 8; k++) blk[k] = q[k];
        bs_mix512(&blk[0], &blk[1], &blk[2], &blk[3]);   /* state 0 */
        bs_mix512(&blk[4], &blk[5], &blk[6], &blk[7]);   /* state 1 */
    }
    /* feed-forward + truncate, per state */
    unsigned char buf[64];
    const unsigned char *in[2] = { in0, in1 };
    unsigned char *out[2] = { out0, out1 };
    for (int s = 0; s < 2; s++) {
        wasm_v128_store(buf,    blk[4*s+0]); wasm_v128_store(buf+16, blk[4*s+1]);
        wasm_v128_store(buf+32, blk[4*s+2]); wasm_v128_store(buf+48, blk[4*s+3]);
        for (int i = 0; i < 64; i++) buf[i] ^= in[s][i];
        memcpy(out[s],      buf + 8,  8);
        memcpy(out[s] + 8,  buf + 24, 8);
        memcpy(out[s] + 16, buf + 32, 8);
        memcpy(out[s] + 24, buf + 48, 8);
    }
}

/* ── haraka256_port for 4 states (8-way bitsliced) ── */
void haraka256_port_x4(unsigned char *o0, unsigned char *o1,
                       unsigned char *o2, unsigned char *o3,
                       const unsigned char *i0, const unsigned char *i1,
                       const unsigned char *i2, const unsigned char *i3) {
    bs_init_keys();
    const unsigned char *in[4] = { i0, i1, i2, i3 };
    unsigned char *out[4] = { o0, o1, o2, o3 };
    v128_t blk[8];
    for (int s = 0; s < 4; s++) {
        blk[2*s+0] = wasm_v128_load(in[s]);
        blk[2*s+1] = wasm_v128_load(in[s] + 16);
    }
    for (int i = 0; i < 5; i++) {
        v128_t q[8];
        for (int k = 0; k < 8; k++) q[k] = blk[k];
        bs_ortho(q);
        bs_round(q, bs_kq256[2*i]);
        bs_round(q, bs_kq256[2*i+1]);
        bs_ortho(q);
        for (int k = 0; k < 8; k++) blk[k] = q[k];
        for (int s = 0; s < 4; s++) bs_mix256(&blk[2*s], &blk[2*s+1]);
    }
    /* feed-forward: out = in ^ state (full 32 bytes) */
    unsigned char st[32];
    for (int s = 0; s < 4; s++) {
        wasm_v128_store(st,      blk[2*s+0]);
        wasm_v128_store(st + 16, blk[2*s+1]);
        for (int i = 0; i < 32; i++) out[s][i] = in[s][i] ^ st[i];
    }
}

/* ── self-test exports (validated by scripts/verify_bitslice_wasm.js) ──
 * These let node exercise the compiled intrinsics in isolation, comparing to the
 * bit-exact cmodel BEFORE trusting the full hash. Turbo binary only. */
EMSCRIPTEN_KEEPALIVE
void bs_selftest_round(const unsigned char *blocks8 /*128*/, const unsigned char *keys8 /*128*/,
                       unsigned char *planes_out /*128*/, unsigned char *round_out /*128*/) {
    v128_t q[8], kq[8];
    for (int b = 0; b < 8; b++) q[b] = wasm_v128_load(blocks8 + 16*b);
    bs_ortho(q);
    for (int b = 0; b < 8; b++) wasm_v128_store(planes_out + 16*b, q[b]);   /* ortho == toPlanesC */
    unsigned char kb[8][16];
    for (int b = 0; b < 8; b++) memcpy(kb[b], keys8 + 16*b, 16);
    bs_keyplanes(kb, kq);
    bs_round(q, kq);
    bs_ortho(q);                                                            /* deortho → blocks */
    for (int b = 0; b < 8; b++) wasm_v128_store(round_out + 16*b, q[b]);
}

EMSCRIPTEN_KEEPALIVE
void bs_selftest_h512x2(const unsigned char *in2 /*128*/, unsigned char *out2 /*64*/) {
    haraka512_port_x2(out2, out2 + 32, in2, in2 + 64);
}

EMSCRIPTEN_KEEPALIVE
void bs_selftest_h256x4(const unsigned char *in4 /*128*/, unsigned char *out4 /*128*/) {
    haraka256_port_x4(out4, out4+32, out4+64, out4+96,
                      in4, in4+32, in4+64, in4+96);
}
