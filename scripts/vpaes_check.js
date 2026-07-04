// vpaes_check.js — validate a table-free SIMD-friendly AES round (vpaes SubBytes
// via GF(2^4) inversion + standard ShiftRows/MixColumns) against the reference
// textbook AES round, in pure JS. No emcc needed. If this passes, the WASM-SIMD
// port (using wasm_i8x16_swizzle for the pshufb table lookups) is correct by
// construction: every index used stays in {0..15} U {0x80..0x8F}, for which
// wasm swizzle (zero on idx>=16) == x86 pshufb (zero on bit7).
//
// Constants are the canonical OpenSSL/Hamburg vpaes encryption tables.

'use strict';

// ---- AES S-box (reference) ----
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

const xt = (x) => ((x << 1) ^ ((x >> 7) * 0x1b)) & 0xff;

// ---- build a 16-byte vector from two little-endian 64-bit hex words ----
function vec(loHex, hiHex) {
  const v = new Uint8Array(16);
  let lo = BigInt(loHex), hi = BigInt(hiHex);
  for (let i = 0; i < 8; i++) { v[i]   = Number(lo & 0xffn); lo >>= 8n; }
  for (let i = 0; i < 8; i++) { v[8+i] = Number(hi & 0xffn); hi >>= 8n; }
  return v;
}

// vpaes encryption constants (OpenSSL vpaes-x86_64.pl)
const k_s0F  = vec('0x0F0F0F0F0F0F0F0F', '0x0F0F0F0F0F0F0F0F');
const k_ipt_lo = vec('0xC2B2E8985A2A7000', '0xCABAE09052227808');
const k_ipt_hi = vec('0x4C01307D317C4D00', '0xCD80B1FCB0FDCC81');
const k_inv  = vec('0x0E05060F0D080180', '0x040703090A0B0C02'); // inv
const k_inva = vec('0x01040A060F0B0780', '0x030D0E0C02050809'); // inva
const k_sbo_lo = vec('0xD0D26D176FBDC700', '0x15AABF7AC502A878'); // sbou
const k_sbo_hi = vec('0xCFE474A55FBB6A00', '0x8E1E90D1412B35FA'); // sbot

// ---- SIMD primitive models (match wasm_simd128 semantics) ----
// wasm_i8x16_swizzle(table, idx): lane = idx<16 ? table[idx] : 0
function swz(table, idx) {
  const r = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { const j = idx[i]; r[i] = j < 16 ? table[j] : 0; }
  return r;
}
function vxor(a, b) { const r = new Uint8Array(16); for (let i=0;i<16;i++) r[i]=a[i]^b[i]; return r; }
function vand(a, b) { const r = new Uint8Array(16); for (let i=0;i<16;i++) r[i]=a[i]&b[i]; return r; }
// per-byte high nibble (matches vpaes: (x & 0xF0) then >>4 with no cross-byte carry)
function hiNib(a) { const r = new Uint8Array(16); for (let i=0;i<16;i++) r[i]=(a[i]>>4)&0x0f; return r; }
function loNib(a) { return vand(a, k_s0F); }

// ---- vpaes SubBytes: ipt -> GF(2^4) inversion -> sbo (standard-domain sbox) ----
function vpaes_subbytes(state) {
  // input transform: t = iptlo[lo] ^ ipthi[hi]
  const lo = loNib(state), hi = hiNib(state);
  let x = vxor(swz(k_ipt_lo, lo), swz(k_ipt_hi, hi));  // xmm0 after ipt

  // .Lenc_entry (inversion). i = hi nibble, k = lo nibble of x.
  const i = hiNib(x);
  const k = loNib(x);
  const ak = swz(k_inva, k);         // a/k = inva[k]
  const j  = vxor(k, i);             // j = k ^ i
  let iak  = vxor(swz(k_inv, i), ak); // iak = inv[i] ^ a/k
  let jak  = vxor(swz(k_inv, j), ak); // jak = inv[j] ^ a/k
  const io = vxor(swz(k_inv, iak), j); // io = inv[iak] ^ j
  const jo = vxor(swz(k_inv, jak), i); // jo = inv[jak] ^ i

  // sbo: SubBytes output (standard domain) = sbou[io] ^ sbot[jo].
  // vpaes folds the AES S-box affine CONSTANT (0x63) into the round keys, so the
  // sbo tables give only the affine-linear part; add 0x63 back for a standalone sbox.
  const out = vxor(swz(k_sbo_lo, io), swz(k_sbo_hi, jo));
  for (let i = 0; i < 16; i++) out[i] ^= 0x63;
  return out;
}

// ---- ShiftRows via swizzle (fixed permutation) ----
const SR = Uint8Array.from([0,5,10,15,4,9,14,3,8,13,2,7,12,1,6,11]);
function shiftRows(s) { return swz(s, SR); }

// reference per-byte MixColumns (ground truth)
function mixColumnsRef(s) {
  const r = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    const a0=s[c*4],a1=s[c*4+1],a2=s[c*4+2],a3=s[c*4+3];
    r[c*4]   = (xt(a0)^xt(a1)^a1^a2^a3) & 0xff;
    r[c*4+1] = (a0^xt(a1)^xt(a2)^a2^a3) & 0xff;
    r[c*4+2] = (a0^a1^xt(a2)^xt(a3)^a3) & 0xff;
    r[c*4+3] = (xt(a0)^a0^a1^a2^xt(a3)) & 0xff;
  }
  return r;
}

// ---- SIMD MixColumns the WASM C will use ----
// xtime per byte: (x<<1) ^ (msb ? 0x1b : 0)   [wasm: shl(1) ^ (shr_arith(7) & 0x1b)]
function xtimeSIMD(v) { const r=new Uint8Array(16); for(let i=0;i<16;i++) r[i]=((v[i]<<1)&0xff)^((v[i]&0x80)?0x1b:0); return r; }
// Rk: rotate bytes by k WITHIN each 4-byte column: out[4c+j] = in[4c+((j+k)&3)]
function rotIdx(k){ const idx=new Uint8Array(16); for(let i=0;i<16;i++){const c=i>>2,j=i&3; idx[i]=4*c+((j+k)&3);} return idx; }
const R1=rotIdx(1), R2=rotIdx(2), R3=rotIdx(3);
// y = t2 ^ R1(t2) ^ R1(t) ^ R2(t) ^ R3(t)   (derived; t2 = xtime(t))
function mixColumnsSIMD(t){
  const t2=xtimeSIMD(t);
  return vxor(vxor(t2, swz(t2,R1)), vxor(swz(t,R1), vxor(swz(t,R2), swz(t,R3))));
}

// full SIMD-form AES round (exactly what the WASM C computes)
function vpaes_aesenc(state, rk) {
  return vxor(mixColumnsSIMD(shiftRows(vpaes_subbytes(state))), rk);
}

// ---- reference textbook AES round ----
function ref_aesenc(a, rk) {
  const s = new Uint8Array(16);
  for (let i=0;i<16;i++) s[i]=sbox[a[i]];
  const t = swz(s, SR); // SubBytes then ShiftRows (commute)
  const r = new Uint8Array(16);
  for (let c=0;c<4;c++){
    const a0=t[c*4],a1=t[c*4+1],a2=t[c*4+2],a3=t[c*4+3];
    r[c*4]   = (xt(a0)^xt(a1)^a1^a2^a3^rk[c*4]) & 0xff;
    r[c*4+1] = (a0^xt(a1)^xt(a2)^a2^a3^rk[c*4+1]) & 0xff;
    r[c*4+2] = (a0^a1^xt(a2)^xt(a3)^a3^rk[c*4+2]) & 0xff;
    r[c*4+3] = (xt(a0)^a0^a1^a2^xt(a3)^rk[c*4+3]) & 0xff;
  }
  return r;
}

// ============ TESTS ============
let fails = 0;

// Test 1 (the crux): vpaes SubBytes == sbox for all 256 byte values.
for (let b = 0; b < 256; b++) {
  const st = new Uint8Array(16).fill(b);
  const out = vpaes_subbytes(st);
  for (let i = 0; i < 16; i++) if (out[i] !== sbox[b]) {
    if (fails < 8) console.log(`SUBBYTES MISMATCH b=${b} got=${out[i]} want=${sbox[b]}`);
    fails++; break;
  }
}
console.log(fails === 0 ? 'PASS: vpaes SubBytes == AES S-box for all 256 values'
                        : `FAIL: SubBytes has ${fails} mismatches`);

// Test 1b: SIMD MixColumns (xtime + column rotates) == reference MixColumns.
let mfails = 0;
for (let it = 0; it < 100000; it++) {
  const s = new Uint8Array(16); for (let i=0;i<16;i++) s[i]=(Math.random()*256)|0;
  const A = mixColumnsSIMD(s), B = mixColumnsRef(s);
  for (let i=0;i<16;i++) if (A[i]!==B[i]) { if(mfails<8) console.log(`MIXCOL MISMATCH it=${it} byte=${i} simd=${A[i]} ref=${B[i]}`); mfails++; break; }
}
console.log(mfails === 0 ? 'PASS: SIMD MixColumns == reference over 100000 inputs'
                         : `FAIL: MixColumns has ${mfails} mismatches`);

// Test 2: full vpaes round == reference round over random inputs.
let rfails = 0;
const N = 200000;
for (let it = 0; it < N; it++) {
  const a = new Uint8Array(16), rk = new Uint8Array(16);
  for (let i=0;i<16;i++){ a[i]=(Math.random()*256)|0; rk[i]=(Math.random()*256)|0; }
  const A = vpaes_aesenc(a, rk), B = ref_aesenc(a, rk);
  for (let i=0;i<16;i++) if (A[i]!==B[i]) {
    if (rfails < 8) console.log(`ROUND MISMATCH it=${it} byte=${i} vpaes=${A[i]} ref=${B[i]}`);
    rfails++; break;
  }
}
console.log(rfails === 0 ? `PASS: vpaes AES round == reference over ${N} random inputs`
                         : `FAIL: round has ${rfails} mismatches`);

// DUMP=1 prints the exact wasm_u8x16_const(...) initializers for the C port.
if (process.env.DUMP) {
  const cst = (name, v) => console.log(`static const v128_t ${name} = wasm_u8x16_const(${Array.from(v).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(',')});`);
  console.log('--- C constants (lane order 0..15) ---');
  cst('VP_ipt_lo', k_ipt_lo); cst('VP_ipt_hi', k_ipt_hi);
  cst('VP_inv',    k_inv);    cst('VP_inva',  k_inva);
  cst('VP_sbo_lo', k_sbo_lo); cst('VP_sbo_hi', k_sbo_hi);
  cst('VP_SR', SR); cst('VP_R1', R1); cst('VP_R2', R2); cst('VP_R3', R3);
}

process.exit((fails === 0 && mfails === 0 && rfails === 0) ? 0 : 1);
