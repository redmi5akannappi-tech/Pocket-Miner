// bitslice_check.js — Stage 2. Validate a bitsliced AES round (Boyar-Peralta gate
// S-box + bitsliced ShiftRows/MixColumns) bit-exact vs the reference AES round, in
// pure JS. Foundation for the WASM-SIMD 8-way (2-nonce) bitsliced Haraka. No emcc.
//
// Bitslice model: 8 "planes" q[0..7]; q[i] holds bit i of every byte across all
// lanes (BigInt = arbitrary width). q[0]=LSB. Reference: BearSSL aes_ct.
'use strict';

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

// BigInt bit-plane ops (width up to MASKW bits). NOT masks to width.
const W = 256;
const MASK = (1n << BigInt(W)) - 1n;
const NOT = (x) => (~x) & MASK;

// Boyar-Peralta bitsliced AES S-box (BearSSL aes_ct br_aes_ct_bitslice_Sbox).
// q is array of 8 BigInts, modified in place.
function bitsliceSbox(q) {
  const x0=q[7], x1=q[6], x2=q[5], x3=q[4], x4=q[3], x5=q[2], x6=q[1], x7=q[0];
  // top linear
  const y14=x3^x5, y13=x0^x6, y9=x0^x3, y8=x0^x5;
  const t0=x1^x2, y1=t0^x7, y4=y1^x3, y12=y13^y14, y2=y1^x0, y5=y1^x6, y3=y5^y8;
  const t1=x4^y12, y15=t1^x5, y20=t1^x1, y6=y15^x7, y10=y15^t0, y11=y20^y9;
  const y7=x7^y11, y17=y10^y11, y19=y10^y8, y16=t0^y11, y21=y13^y16, y18=x0^y16;
  // non-linear
  const t2=y12&y15, t3=y3&y6, t4=t3^t2, t5=y4&x7, t6=t5^t2, t7=y13&y16, t8=y5&y1, t9=t8^t7;
  const t10=y2&y7, t11=t10^t7, t12=y9&y11, t13=y14&y17, t14=t13^t12, t15=y8&y10, t16=t15^t12;
  const t17=t4^t14, t18=t6^t16, t19=t9^t14, t20=t11^t16, t21=t17^y20, t22=t18^y19, t23=t19^y21, t24=t20^y18;
  const t25=t21^t22, t26=t21&t23, t27=t24^t26, t28=t25&t27, t29=t28^t22, t30=t23^t24, t31=t22^t26;
  const t32=t31&t30, t33=t32^t24, t34=t23^t33, t35=t27^t33, t36=t24&t35, t37=t36^t34, t38=t27^t36;
  const t39=t29&t38, t40=t25^t39, t41=t40^t37, t42=t29^t33, t43=t29^t40, t44=t33^t37, t45=t42^t41;
  const z0=t44&y15, z1=t37&y6, z2=t33&x7, z3=t43&y16, z4=t40&y1, z5=t29&y7, z6=t42&y11, z7=t45&y17, z8=t41&y10;
  const z9=t44&y12, z10=t37&y3, z11=t33&y4, z12=t43&y13, z13=t40&y5, z14=t29&y2, z15=t42&y9, z16=t45&y14, z17=t41&y8;
  // bottom linear
  const t46=z15^z16, t47=z10^z11, t48=z5^z13, t49=z9^z10, t50=z2^z12, t51=z2^z5, t52=z7^z8, t53=z0^z3;
  const t54=z6^z7, t55=z16^z17, t56=z12^t48, t57=t50^t53, t58=z4^t46, t59=z3^t54, t60=t46^t57;
  const t61=z14^t57, t62=t52^t58, t63=t49^t58, t64=z4^t59, t65=t61^t62, t66=z1^t63;
  const s0=t59^t63, s6=t56^NOT(t62), s7=t48^NOT(t60), t67=t64^t65, s3=t53^t66, s4=t51^t66, s5=t47^t65;
  const s1=t64^NOT(s3), s2=t55^NOT(t67);
  q[7]=s0; q[6]=s1; q[5]=s2; q[4]=s3; q[3]=s4; q[2]=s5; q[1]=s6; q[0]=s7;
}

// ---- validate S-box: pack all 256 bytes as lanes (byte b -> bit position b) ----
let fails = 0;
const q = [0n,0n,0n,0n,0n,0n,0n,0n];
for (let b = 0; b < 256; b++)
  for (let i = 0; i < 8; i++)
    if ((b >> i) & 1) q[i] |= (1n << BigInt(b));
bitsliceSbox(q);
for (let b = 0; b < 256; b++) {
  let out = 0;
  for (let i = 0; i < 8; i++) if ((q[i] >> BigInt(b)) & 1n) out |= (1 << i);
  if (out !== sbox[b]) { if (fails<8) console.log(`SBOX MISMATCH b=${b} got=${out} want=${sbox[b]}`); fails++; }
}
console.log(fails === 0 ? 'PASS: bitsliced S-box == AES S-box for all 256 values'
                        : `FAIL: bitsliced S-box has ${fails} mismatches`);

// ================= full bitsliced round vs reference =================
const xt = (x) => ((x << 1) ^ ((x >> 7) * 0x1b)) & 0xff;
const SRp = [0,5,10,15,4,9,14,3,8,13,2,7,12,1,6,11]; // ShiftRows byte permutation
function refAesenc(a, rk) {
  const s = new Uint8Array(16); for (let i=0;i<16;i++) s[i]=sbox[a[i]];
  const t = new Uint8Array(16); for (let i=0;i<16;i++) t[i]=s[SRp[i]];
  const r = new Uint8Array(16);
  for (let c=0;c<4;c++){ const a0=t[c*4],a1=t[c*4+1],a2=t[c*4+2],a3=t[c*4+3];
    r[c*4]  =(xt(a0)^xt(a1)^a1^a2^a3^rk[c*4])&0xff;
    r[c*4+1]=(a0^xt(a1)^xt(a2)^a2^a3^rk[c*4+1])&0xff;
    r[c*4+2]=(a0^a1^xt(a2)^xt(a3)^a3^rk[c*4+2])&0xff;
    r[c*4+3]=(xt(a0)^a0^a1^a2^xt(a3)^rk[c*4+3])&0xff; }
  return r;
}

const NB = 8, L = NB*16;                          // 8 blocks, 128 lanes
const P0 = () => [0n,0n,0n,0n,0n,0n,0n,0n];
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
function bitsliceRound(q, kq){
  bitsliceSbox(q);                    // SubBytes
  let r = permLanes(q, srShift);      // ShiftRows
  r = mixColumns(r);                  // MixColumns
  for (let i=0;i<8;i++) q[i]=r[i]^kq[i]; // AddRoundKey
}

let rfails = 0;
const rnd = () => { const a=new Uint8Array(16); for(let i=0;i<16;i++) a[i]=(Math.random()*256)|0; return a; };
for (let it=0; it<20000; it++){
  const blocks=[], keys=[];
  for (let b=0;b<NB;b++){ blocks.push(rnd()); keys.push(rnd()); }
  const q=toPlanes(blocks), kq=toPlanes(keys);
  bitsliceRound(q, kq);
  const got=fromPlanes(q);
  for (let b=0;b<NB;b++){ const ref=refAesenc(blocks[b], keys[b]);
    for (let i=0;i<16;i++) if (got[b][i]!==ref[i]){ if(rfails<8) console.log(`ROUND MISMATCH it=${it} blk=${b} byte=${i} got=${got[b][i]} ref=${ref[i]}`); rfails++; b=NB; break; } }
}
console.log(rfails === 0 ? `PASS: bitsliced AES round (8-way) == reference over ${20000*NB} blocks`
                         : `FAIL: bitsliced round has ${rfails} mismatches`);

process.exit((fails === 0 && rfails === 0) ? 0 : 1);
