// bitslice_haraka_check.js — Stage 2 (2c spec). Build the full N-way bitsliced
// Haraka permutations on the validated 2a round and prove them BIT-EXACT vs the
// scalar C reference (haraka_portable.c), in pure JS. No emcc.
//
//   * haraka512_port  : 8-way bitslice = 2 nonces × 4 chunks/state  → sponge (Write)
//   * haraka256_port  : 8-way bitslice = 4 nonces × 2 chunks/state  → GenNewCLKey chain
//
// WHY this is sufficient to prove grouped verus_hash ≡ scalar verus_hash:
//   The 4-nonce batch changes ONLY the two Haraka permutations above. Everything
//   else in Finalize2b — verusclhash (CLMUL) and the per-nonce keyed haraka512 —
//   stays scalar and byte-identical per nonce. So if both perms are bit-exact for
//   every lane, the full per-nonce hash is bit-exact. (This is the "2b" the notes
//   called skippable; we build it anyway because the unpack-mixing + lane layout
//   is exactly where the C port's bugs will live, and it is the golden reference
//   the uncompilable C is validated against — see DUMP mode at the bottom.)
//
// Bitslice model (identical to bitslice_check.js): 8 planes q[0..7], each a BigInt
// bitmask over up to 128 lanes; lane = block*16 + byteIdx, byteIdx = row+4*col
// (column-major AES std); plane q[i] bit `lane` = bit i of byte `lane`. q[0]=LSB.
'use strict';

// ─────────────────────────── AES S-box ───────────────────────────
const sbox = [
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
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];

// Haraka round constants (rc), copied verbatim from haraka_portable.c haraka_rc[40][16].
const haraka_rc = [
[0x9d,0x7b,0x81,0x75,0xf0,0xfe,0xc5,0xb2,0x0a,0xc0,0x20,0xe6,0x4c,0x70,0x84,0x06],
[0x17,0xf7,0x08,0x2f,0xa4,0x6b,0x0f,0x64,0x6b,0xa0,0xf3,0x88,0xe1,0xb4,0x66,0x8b],
[0x14,0x91,0x02,0x9f,0x60,0x9d,0x02,0xcf,0x98,0x84,0xf2,0x53,0x2d,0xde,0x02,0x34],
[0x79,0x4f,0x5b,0xfd,0xaf,0xbc,0xf3,0xbb,0x08,0x4f,0x7b,0x2e,0xe6,0xea,0xd6,0x0e],
[0x44,0x70,0x39,0xbe,0x1c,0xcd,0xee,0x79,0x8b,0x44,0x72,0x48,0xcb,0xb0,0xcf,0xcb],
[0x7b,0x05,0x8a,0x2b,0xed,0x35,0x53,0x8d,0xb7,0x32,0x90,0x6e,0xee,0xcd,0xea,0x7e],
[0x1b,0xef,0x4f,0xda,0x61,0x27,0x41,0xe2,0xd0,0x7c,0x2e,0x5e,0x43,0x8f,0xc2,0x67],
[0x3b,0x0b,0xc7,0x1f,0xe2,0xfd,0x5f,0x67,0x07,0xcc,0xca,0xaf,0xb0,0xd9,0x24,0x29],
[0xee,0x65,0xd4,0xb9,0xca,0x8f,0xdb,0xec,0xe9,0x7f,0x86,0xe6,0xf1,0x63,0x4d,0xab],
[0x33,0x7e,0x03,0xad,0x4f,0x40,0x2a,0x5b,0x64,0xcd,0xb7,0xd4,0x84,0xbf,0x30,0x1c],
[0x00,0x98,0xf6,0x8d,0x2e,0x8b,0x02,0x69,0xbf,0x23,0x17,0x94,0xb9,0x0b,0xcc,0xb2],
[0x8a,0x2d,0x9d,0x5c,0xc8,0x9e,0xaa,0x4a,0x72,0x55,0x6f,0xde,0xa6,0x78,0x04,0xfa],
[0xd4,0x9f,0x12,0x29,0x2e,0x4f,0xfa,0x0e,0x12,0x2a,0x77,0x6b,0x2b,0x9f,0xb4,0xdf],
[0xee,0x12,0x6a,0xbb,0xae,0x11,0xd6,0x32,0x36,0xa2,0x49,0xf4,0x44,0x03,0xa1,0x1e],
[0xa6,0xec,0xa8,0x9c,0xc9,0x00,0x96,0x5f,0x84,0x00,0x05,0x4b,0x88,0x49,0x04,0xaf],
[0xec,0x93,0xe5,0x27,0xe3,0xc7,0xa2,0x78,0x4f,0x9c,0x19,0x9d,0xd8,0x5e,0x02,0x21],
[0x73,0x01,0xd4,0x82,0xcd,0x2e,0x28,0xb9,0xb7,0xc9,0x59,0xa7,0xf8,0xaa,0x3a,0xbf],
[0x6b,0x7d,0x30,0x10,0xd9,0xef,0xf2,0x37,0x17,0xb0,0x86,0x61,0x0d,0x70,0x60,0x62],
[0xc6,0x9a,0xfc,0xf6,0x53,0x91,0xc2,0x81,0x43,0x04,0x30,0x21,0xc2,0x45,0xca,0x5a],
[0x3a,0x94,0xd1,0x36,0xe8,0x92,0xaf,0x2c,0xbb,0x68,0x6b,0x22,0x3c,0x97,0x23,0x92],
[0xb4,0x71,0x10,0xe5,0x58,0xb9,0xba,0x6c,0xeb,0x86,0x58,0x22,0x38,0x92,0xbf,0xd3],
[0x8d,0x12,0xe1,0x24,0xdd,0xfd,0x3d,0x93,0x77,0xc6,0xf0,0xae,0xe5,0x3c,0x86,0xdb],
[0xb1,0x12,0x22,0xcb,0xe3,0x8d,0xe4,0x83,0x9c,0xa0,0xeb,0xff,0x68,0x62,0x60,0xbb],
[0x7d,0xf7,0x2b,0xc7,0x4e,0x1a,0xb9,0x2d,0x9c,0xd1,0xe4,0xe2,0xdc,0xd3,0x4b,0x73],
[0x4e,0x92,0xb3,0x2c,0xc4,0x15,0x14,0x4b,0x43,0x1b,0x30,0x61,0xc3,0x47,0xbb,0x43],
[0x99,0x68,0xeb,0x16,0xdd,0x31,0xb2,0x03,0xf6,0xef,0x07,0xe7,0xa8,0x75,0xa7,0xdb],
[0x2c,0x47,0xca,0x7e,0x02,0x23,0x5e,0x8e,0x77,0x59,0x75,0x3c,0x4b,0x61,0xf3,0x6d],
[0xf9,0x17,0x86,0xb8,0xb9,0xe5,0x1b,0x6d,0x77,0x7d,0xde,0xd6,0x17,0x5a,0xa7,0xcd],
[0x5d,0xee,0x46,0xa9,0x9d,0x06,0x6c,0x9d,0xaa,0xe9,0xa8,0x6b,0xf0,0x43,0x6b,0xec],
[0xc1,0x27,0xf3,0x3b,0x59,0x11,0x53,0xa2,0x2b,0x33,0x57,0xf9,0x50,0x69,0x1e,0xcb],
[0xd9,0xd0,0x0e,0x60,0x53,0x03,0xed,0xe4,0x9c,0x61,0xda,0x00,0x75,0x0c,0xee,0x2c],
[0x50,0xa3,0xa4,0x63,0xbc,0xba,0xbb,0x80,0xab,0x0c,0xe9,0x96,0xa1,0xa5,0xb1,0xf0],
[0x39,0xca,0x8d,0x93,0x30,0xde,0x0d,0xab,0x88,0x29,0x96,0x5e,0x02,0xb1,0x3d,0xae],
[0x42,0xb4,0x75,0x2e,0xa8,0xf3,0x14,0x88,0x0b,0xa4,0x54,0xd5,0x38,0x8f,0xbb,0x17],
[0xf6,0x16,0x0a,0x36,0x79,0xb7,0xb6,0xae,0xd7,0x7f,0x42,0x5f,0x5b,0x8a,0xbb,0x34],
[0xde,0xaf,0xba,0xff,0x18,0x59,0xce,0x43,0x38,0x54,0xe5,0xcb,0x41,0x52,0xf6,0x26],
[0x78,0xc9,0x9e,0x83,0xf7,0x9c,0xca,0xa2,0x6a,0x02,0xf3,0xb9,0x54,0x9a,0xe9,0x4c],
[0x35,0x12,0x90,0x22,0x28,0x6e,0xc0,0x40,0xbe,0xf7,0xdf,0x1b,0x1a,0xa5,0x51,0xae],
[0xcf,0x59,0xa6,0x48,0x0f,0xbc,0x73,0xc1,0x2b,0xd2,0x7e,0xba,0x3c,0x61,0xc1,0xa0],
[0xa1,0x9d,0xc5,0xe9,0xfd,0xbd,0xd6,0x4a,0x88,0x82,0x28,0x02,0x03,0xcc,0x6a,0x75]];
const RC = haraka_rc.map(r => Uint8Array.from(r));

// ─────────────────────── scalar reference (mirrors haraka_portable.c) ───────────────────────
const XT = (x) => ((x << 1) ^ (((x >> 7) & 1) * 0x1b)) & 0xff;
const SRp = [0,5,10,15,4,9,14,3,8,13,2,7,12,1,6,11];

// refAesenc: textbook SubBytes+ShiftRows+MixColumns+AddKey — proven == the C
// T-table aesenc in aes_ttable_check.js / bitslice_check.js.
function refAesenc(a, rk) {
  const s = new Uint8Array(16); for (let i=0;i<16;i++) s[i]=sbox[a[i]];
  const t = new Uint8Array(16); for (let i=0;i<16;i++) t[i]=s[SRp[i]];
  const r = new Uint8Array(16);
  for (let c=0;c<4;c++){ const a0=t[c*4],a1=t[c*4+1],a2=t[c*4+2],a3=t[c*4+3];
    r[c*4]  =(XT(a0)^XT(a1)^a1^a2^a3^rk[c*4])&0xff;
    r[c*4+1]=(a0^XT(a1)^XT(a2)^a2^a3^rk[c*4+1])&0xff;
    r[c*4+2]=(a0^a1^XT(a2)^XT(a3)^a3^rk[c*4+2])&0xff;
    r[c*4+3]=(XT(a0)^a0^a1^a2^XT(a3)^rk[c*4+3])&0xff; }
  return r;
}
// aesenc in place on a 16-byte slice of `s` at offset `off`, key rk (Uint8Array 16)
function aesencAt(s, off, rk) {
  const blk = s.subarray(off, off+16);
  const r = refAesenc(blk, rk);
  s.set(r, off);
}
// unpacklo32 / unpackhi32 — verbatim from haraka_portable.c (operate on 16-byte views)
function unpacklo32(out, oOff, a, aOff, b, bOff) {
  const tmp = new Uint8Array(16);
  tmp.set(a.subarray(aOff,   aOff+4),   0);
  tmp.set(b.subarray(bOff,   bOff+4),   4);
  tmp.set(a.subarray(aOff+4, aOff+8),   8);
  tmp.set(b.subarray(bOff+4, bOff+8),  12);
  out.set(tmp, oOff);
}
function unpackhi32(out, oOff, a, aOff, b, bOff) {
  const tmp = new Uint8Array(16);
  tmp.set(a.subarray(aOff+8,  aOff+12), 0);
  tmp.set(b.subarray(bOff+8,  bOff+12), 4);
  tmp.set(a.subarray(aOff+12, aOff+16), 8);
  tmp.set(b.subarray(bOff+12, bOff+16),12);
  out.set(tmp, oOff);
}
// The 8-step mixing block from haraka512_perm, on a 64-byte state s. Uses a 16-byte
// tmp. Order and in-place aliasing are IDENTICAL to the C.
function haraka512_mix(s) {
  const tmp = new Uint8Array(16);
  unpacklo32(tmp, 0, s, 0,  s, 16);
  unpackhi32(s,  0, s, 0,  s, 16);
  unpacklo32(s, 16, s, 32, s, 48);
  unpackhi32(s, 32, s, 32, s, 48);
  unpacklo32(s, 48, s, 0,  s, 32);
  unpackhi32(s,  0, s, 0,  s, 32);
  unpackhi32(s, 32, s, 16, tmp, 0);
  unpacklo32(s, 16, s, 16, tmp, 0);
}
// haraka512_perm (reference) — 64 bytes in → 64 bytes out.
function haraka512_perm_ref(inBuf) {
  const s = Uint8Array.from(inBuf);
  for (let i=0;i<5;i++){
    for (let j=0;j<2;j++){
      aesencAt(s, 0,  RC[4*2*i+4*j+0]);
      aesencAt(s, 16, RC[4*2*i+4*j+1]);
      aesencAt(s, 32, RC[4*2*i+4*j+2]);
      aesencAt(s, 48, RC[4*2*i+4*j+3]);
    }
    haraka512_mix(s);
  }
  return s;
}
// haraka512_port (reference) — perm + feed-forward + truncate to 32 bytes.
function haraka512_port_ref(inBuf) {
  const buf = haraka512_perm_ref(inBuf);
  for (let i=0;i<64;i++) buf[i] ^= inBuf[i];
  const out = new Uint8Array(32);
  out.set(buf.subarray(8,16),   0);
  out.set(buf.subarray(24,32),  8);
  out.set(buf.subarray(32,40), 16);
  out.set(buf.subarray(48,56), 24);
  return out;
}
// haraka256_port (reference) — 32 bytes in → 32 bytes out (perm on 2 chunks + FF).
function haraka256_mix(s) {
  const tmp = new Uint8Array(16);
  unpacklo32(tmp, 0, s, 0,  s, 16);
  unpackhi32(s, 16, s, 0,  s, 16);
  s.set(tmp, 0);
}
function haraka256_port_ref(inBuf) {
  const s = Uint8Array.from(inBuf.subarray(0,32));
  for (let i=0;i<5;i++){
    for (let j=0;j<2;j++){
      aesencAt(s, 0,  RC[2*2*i+2*j+0]);
      aesencAt(s, 16, RC[2*2*i+2*j+1]);
    }
    haraka256_mix(s);
  }
  const out = new Uint8Array(32);
  for (let i=0;i<32;i++) out[i] = inBuf[i] ^ s[i];
  return out;
}

// ─────────────────────── bitslice primitives (from bitslice_check.js 2a) ───────────────────────
const MASK = (1n << 128n) - 1n;
const NOT = (x) => (~x) & MASK;
function bitsliceSbox(q) {
  const x0=q[7], x1=q[6], x2=q[5], x3=q[4], x4=q[3], x5=q[2], x6=q[1], x7=q[0];
  const y14=x3^x5, y13=x0^x6, y9=x0^x3, y8=x0^x5;
  const t0=x1^x2, y1=t0^x7, y4=y1^x3, y12=y13^y14, y2=y1^x0, y5=y1^x6, y3=y5^y8;
  const t1=x4^y12, y15=t1^x5, y20=t1^x1, y6=y15^x7, y10=y15^t0, y11=y20^y9;
  const y7=x7^y11, y17=y10^y11, y19=y10^y8, y16=t0^y11, y21=y13^y16, y18=x0^y16;
  const t2=y12&y15, t3=y3&y6, t4=t3^t2, t5=y4&x7, t6=t5^t2, t7=y13&y16, t8=y5&y1, t9=t8^t7;
  const t10=y2&y7, t11=t10^t7, t12=y9&y11, t13=y14&y17, t14=t13^t12, t15=y8&y10, t16=t15^t12;
  const t17=t4^t14, t18=t6^t16, t19=t9^t14, t20=t11^t16, t21=t17^y20, t22=t18^y19, t23=t19^y21, t24=t20^y18;
  const t25=t21^t22, t26=t21&t23, t27=t24^t26, t28=t25&t27, t29=t28^t22, t30=t23^t24, t31=t22^t26;
  const t32=t31&t30, t33=t32^t24, t34=t23^t33, t35=t27^t33, t36=t24&t35, t37=t36^t34, t38=t27^t36;
  const t39=t29&t38, t40=t25^t39, t41=t40^t37, t42=t29^t33, t43=t29^t40, t44=t33^t37, t45=t42^t41;
  const z0=t44&y15, z1=t37&y6, z2=t33&x7, z3=t43&y16, z4=t40&y1, z5=t29&y7, z6=t42&y11, z7=t45&y17, z8=t41&y10;
  const z9=t44&y12, z10=t37&y3, z11=t33&y4, z12=t43&y13, z13=t40&y5, z14=t29&y2, z15=t42&y9, z16=t45&y14, z17=t41&y8;
  const t46=z15^z16, t47=z10^z11, t48=z5^z13, t49=z9^z10, t50=z2^z12, t51=z2^z5, t52=z7^z8, t53=z0^z3;
  const t54=z6^z7, t55=z16^z17, t56=z12^t48, t57=t50^t53, t58=z4^t46, t59=z3^t54, t60=t46^t57;
  const t61=z14^t57, t62=t52^t58, t63=t49^t58, t64=z4^t59, t65=t61^t62, t66=z1^t63;
  const s0=t59^t63, s6=t56^NOT(t62), s7=t48^NOT(t60), t67=t64^t65, s3=t53^t66, s4=t51^t66, s5=t47^t65;
  const s1=t64^NOT(s3), s2=t55^NOT(t67);
  q[7]=s0; q[6]=s1; q[5]=s2; q[4]=s3; q[3]=s4; q[2]=s5; q[1]=s6; q[0]=s7;
}
const NB = 8, L = NB*16;                 // 8 blocks, 128 lanes
const P0 = () => [0n,0n,0n,0n,0n,0n,0n,0n];
// blocks: array of NB Uint8Array(16) → 8 planes
function toPlanes(blocks){ const q=P0();
  for (let b=0;b<NB;b++) for (let by=0;by<16;by++){ const v=blocks[b][by], lane=BigInt(b*16+by);
    for (let i=0;i<8;i++) if ((v>>i)&1) q[i]|=(1n<<lane); } return q; }
function fromPlanes(q){ const out=[]; for (let b=0;b<NB;b++){ const a=new Uint8Array(16);
  for (let by=0;by<16;by++){ const lane=BigInt(b*16+by); let v=0;
    for (let i=0;i<8;i++) if ((q[i]>>lane)&1n) v|=(1<<i); a[by]=v; } out.push(a); } return out; }
function permLanes(q, srcOf){ const r=P0();
  for (let out=0;out<L;out++){ const inl=BigInt(srcOf[out]), ob=BigInt(out);
    for (let i=0;i<8;i++) if ((q[i]>>inl)&1n) r[i]|=(1n<<ob); } return r; }
const xtimePlanes = (q) => [q[7], q[0]^q[7], q[1], q[2]^q[7], q[3]^q[7], q[4], q[5], q[6]];
const srShift = Array.from({length:L}, (_,o)=>{ const b=o>>4,p=o&15; return b*16+SRp[p]; });
const rotSrc = (k) => Array.from({length:L}, (_,o)=>{ const b=o>>4,i16=o&15,c=i16>>2,r=i16&3; return b*16+4*c+((r+k)&3); });
const R1s=rotSrc(1), R2s=rotSrc(2), R3s=rotSrc(3);
function mixColumns(q){ const t2=xtimePlanes(q);
  const t2r1=permLanes(t2,R1s), ar1=permLanes(q,R1s), ar2=permLanes(q,R2s), ar3=permLanes(q,R3s);
  const y=P0(); for (let i=0;i<8;i++) y[i]=t2[i]^t2r1[i]^ar1[i]^ar2[i]^ar3[i]; return y; }
// One 8-way bitsliced AES round: SubBytes→ShiftRows→MixColumns→AddRoundKey(kq)
function bitsliceRound(q, kq){
  bitsliceSbox(q);
  let r = permLanes(q, srShift);
  r = mixColumns(r);
  for (let i=0;i<8;i++) q[i]=r[i]^kq[i];
}

// ─────────────────────── 8-way bitsliced Haraka perms ───────────────────────
// Build the per-block key-plane set for a haraka512 subround. blocksPerState=4,
// nStates=2 → block b uses RC[base + (b % 4)].
function keyPlanes512(base) {
  const keys = [];
  for (let b=0;b<8;b++) keys.push(RC[base + (b & 3)]);
  return toPlanes(keys);
}
// haraka256 subround: blocksPerState=2, nStates=4 → block b uses RC[base + (b % 2)].
function keyPlanes256(base) {
  const keys = [];
  for (let b=0;b<8;b++) keys.push(RC[base + (b & 1)]);
  return toPlanes(keys);
}

// Bitsliced haraka512_perm for 2 states (nonces). in2 = [Uint8Array(64), Uint8Array(64)].
// Returns [Uint8Array(64), Uint8Array(64)]. Blocks: state s → blocks 4s+chunk.
function bs_haraka512_perm(in2, dump) {
  // pack the 8 chunks (state0 c0..c3, state1 c0..c3) into planes
  let blocks = [];
  for (let s=0;s<2;s++) for (let c=0;c<4;c++) blocks.push(in2[s].subarray(c*16, c*16+16));
  let q = toPlanes(blocks);
  for (let i=0;i<5;i++){
    for (let j=0;j<2;j++){
      const kq = keyPlanes512(4*2*i + 4*j);
      bitsliceRound(q, kq);
    }
    // mixing: apply the reference 64-byte mix independently to each state, in
    // the byte domain (a fixed lane permutation; byte-domain is the simplest
    // provably-correct spec). Convert planes→bytes→mix→planes.
    const b = fromPlanes(q);
    for (let s=0;s<2;s++){
      const st = new Uint8Array(64);
      for (let c=0;c<4;c++) st.set(b[4*s+c], c*16);
      haraka512_mix(st);
      for (let c=0;c<4;c++) b[4*s+c] = st.subarray(c*16, c*16+16);
    }
    q = toPlanes(b);
    if (dump) dump.push({ tag:`h512_after_step${i}`, planes:q.map(x=>x.toString(16)) });
  }
  const outBlocks = fromPlanes(q);
  const out = [new Uint8Array(64), new Uint8Array(64)];
  for (let s=0;s<2;s++) for (let c=0;c<4;c++) out[s].set(outBlocks[4*s+c], c*16);
  return out;
}
// Bitsliced haraka512_port for 2 states — perm + feed-forward + truncate.
function bs_haraka512_port(in2) {
  const perm = bs_haraka512_perm(in2);
  const out = [new Uint8Array(32), new Uint8Array(32)];
  for (let s=0;s<2;s++){
    const buf = perm[s];
    for (let i=0;i<64;i++) buf[i] ^= in2[s][i];
    out[s].set(buf.subarray(8,16),   0);
    out[s].set(buf.subarray(24,32),  8);
    out[s].set(buf.subarray(32,40), 16);
    out[s].set(buf.subarray(48,56), 24);
  }
  return out;
}

// Bitsliced haraka256_port for 4 states (nonces). in4 = 4×Uint8Array(32).
// Blocks: state s → blocks 2s+chunk (chunk 0..1). Upper chunk lanes unused = 0.
function bs_haraka256_port(in4) {
  let blocks = [];
  for (let s=0;s<4;s++) for (let c=0;c<2;c++) blocks.push(in4[s].subarray(c*16, c*16+16));
  let q = toPlanes(blocks);
  for (let i=0;i<5;i++){
    for (let j=0;j<2;j++){
      const kq = keyPlanes256(2*2*i + 2*j);
      bitsliceRound(q, kq);
    }
    const b = fromPlanes(q);
    for (let s=0;s<4;s++){
      const st = new Uint8Array(32);
      for (let c=0;c<2;c++) st.set(b[2*s+c], c*16);
      haraka256_mix(st);
      for (let c=0;c<2;c++) b[2*s+c] = st.subarray(c*16, c*16+16);
    }
    q = toPlanes(b);
  }
  const outBlocks = fromPlanes(q);
  const out = [];
  for (let s=0;s<4;s++){
    const o = new Uint8Array(32);
    for (let c=0;c<2;c++) o.set(outBlocks[2*s+c], c*16);
    for (let i=0;i<32;i++) o[i] = in4[s][i] ^ o[i];   // feed-forward
    out.push(o);
  }
  return out;
}

// Export the validated reference + helpers so the C-blueprint model
// (bitslice_cmodel.js) can reuse them without duplicating the rc table.
module.exports = {
  sbox, RC, SRp, XT, refAesenc,
  haraka512_perm_ref, haraka512_port_ref, haraka256_port_ref,
  haraka512_mix, haraka256_mix, unpacklo32, unpackhi32,
  bs_haraka512_port, bs_haraka256_port,
};

// ─────────────────────────────── validation ───────────────────────────────
const rndN = (n) => { const a=new Uint8Array(n); for(let i=0;i<n;i++) a[i]=(Math.random()*256)|0; return a; };
const eq = (a,b) => { if (a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; };

// only run the self-test when invoked directly (`node bitslice_haraka_check.js`)
if (require.main !== module) return;

let fail = 0;

// Anchor the reference to ground truth: published Haraka512-256 v2 KAT for the
// input 0x00,0x01,...,0x3f. Proves the rc constants, aesenc, unpack-mixing, perm
// structure and truncation are all transcribed correctly (haraka256 reuses them).
{ const inp = new Uint8Array(64); for (let i=0;i<64;i++) inp[i]=i;
  const hex = Buffer.from(haraka512_port_ref(inp)).toString('hex');
  const KAT = 'be7f723b4e80a99813b292287f306f625a6d57331cae5f34dd9277b0945be2aa';
  const ok = hex === KAT; if (!ok) fail++;
  console.log(ok ? 'PASS: haraka512_port reference == published Haraka512-256 v2 KAT'
                 : `FAIL: haraka512 KAT mismatch\n  got ${hex}\n  want ${KAT}`);
}

// haraka512_port: bitsliced 2-nonce == reference
{ let bad=0; const ITER=4000;
  for (let it=0; it<ITER; it++){
    const a=rndN(64), b=rndN(64);
    const [ba,bb] = bs_haraka512_port([a,b]);
    const ra=haraka512_port_ref(a), rb=haraka512_port_ref(b);
    if (!eq(ba,ra) || !eq(bb,rb)){ if(bad<4) console.log(`h512 MISMATCH it=${it}`); bad++; }
  }
  fail += bad;
  console.log(bad===0 ? `PASS: bitsliced haraka512_port (2-nonce, 8-way) == reference over ${ITER*2} states`
                      : `FAIL: haraka512_port has ${bad} mismatches`);
}

// haraka256_port: bitsliced 4-nonce == reference
{ let bad=0; const ITER=4000;
  for (let it=0; it<ITER; it++){
    const ins = [rndN(32),rndN(32),rndN(32),rndN(32)];
    const got = bs_haraka256_port(ins);
    for (let s=0;s<4;s++){ const ref=haraka256_port_ref(ins[s]);
      if (!eq(got[s],ref)){ if(bad<4) console.log(`h256 MISMATCH it=${it} s=${s}`); bad++; } }
  }
  fail += bad;
  console.log(bad===0 ? `PASS: bitsliced haraka256_port (4-nonce, 8-way) == reference over ${ITER*4} states`
                      : `FAIL: haraka256_port has ${bad} mismatches`);
}

process.exit(fail===0 ? 0 : 1);
