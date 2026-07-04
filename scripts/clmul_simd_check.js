'use strict';
// Validate a WASM-SIMD model of _mm_mulhrs_epi16_emu (the CLHash hot-loop op) is
// BIT-EXACT vs the scalar emu — including the wrap-not-saturate edge. The SIMD C
// will use i32x4 extmul (exact 16×16→32) + add 0x4000 + arith >>15 + wrap-narrow.
const toI16 = (x) => { x &= 0xFFFF; return x >= 0x8000 ? x - 0x10000 : x; };

// scalar reference (verbatim from verus_clhash_portable.cpp:239)
function mulhrs_scalar(a, b) { // a,b: Int16Array(8) → Int16Array(8)
  const r = new Int16Array(8);
  for (let i = 0; i < 8; i++) r[i] = toI16(((a[i] * b[i]) + 0x4000) >> 15);
  return r;
}
// SIMD model: per lane p=extmul_s(a,b) [exact int32]; t=(p+0x4000)>>15 [arith];
// narrow by WRAP (low 16 bits), NOT saturate — matches the scalar int16 cast.
function mulhrs_simd(a, b) {
  const r = new Int16Array(8);
  for (let i = 0; i < 8; i++) {
    const p = Math.imul(a[i], b[i]);        // i32x4 extmul_{low,high}_i16x8_s
    const t = (p + 0x4000) >> 15;           // i32x4 add + i32x4 shr_s(15)
    r[i] = toI16(t & 0xFFFF);               // wrap-narrow (v128_and 0xFFFF + pack)
  }
  return r;
}

const rnd16 = () => { const a = new Int16Array(8); for (let i=0;i<8;i++) a[i] = ((Math.random()*65536)|0) - 32768; return a; };
const eq = (a,b) => { for (let i=0;i<8;i++) if (a[i]!==b[i]) return false; return true; };

let bad = 0;
// random
for (let it=0; it<200000; it++){ const a=rnd16(), b=rnd16();
  if (!eq(mulhrs_scalar(a,b), mulhrs_simd(a,b))) bad++; }
// edge cases incl. the saturation-wrap corner (-32768 * -32768)
const edges = [-32768, -1, 0, 1, 32767, 16384, -16384];
for (const x of edges) for (const y of edges) {
  const a = new Int16Array(8).fill(x), b = new Int16Array(8).fill(y);
  if (!eq(mulhrs_scalar(a,b), mulhrs_simd(a,b))) { bad++; console.log(`edge fail ${x}*${y}: scal=${mulhrs_scalar(a,b)[0]} simd=${mulhrs_simd(a,b)[0]}`); }
}
// show the wrap corner explicitly
const c = new Int16Array(8).fill(-32768);
console.log(`corner -32768*-32768: emu=${mulhrs_scalar(c,c)[0]} (wraps; real _mm_mulhrs saturates to 32767 — emu does NOT, so SIMD must wrap too)`);
console.log(bad===0 ? 'PASS: SIMD mulhrs model == scalar emu over 200k random + all edges (wrap-exact)'
                    : `FAIL: ${bad} mismatches`);
process.exit(bad===0?0:1);
