// bitslice_cmodel.js — Stage 2 (2d blueprint). Models the EXACT op-network the
// WASM-SIMD C will run, validates it bit-exact against the proven reference in
// bitslice_haraka_check.js, and emits golden vectors the C test harness asserts
// against. Because there is no emcc here, this file IS how the C is de-risked:
// every intrinsic the C uses has a 1:1 JS twin below, checked to ground truth.
//
// C in-register layout ("blocks-in-bits"):
//   8 planes P[0..7], each a v128 (16 bytes). Plane P[i] byte `by` (0..15 = AES
//   byte-index) holds, in its 8 bits, {bit i of block0.byte[by] .. block7.byte[by]}.
//   → S-box = bitwise on the 8 planes (Boyar-Peralta, layout-agnostic).
//   → ShiftRows / MixColumns column-rotates = wasm_i8x16_swizzle on the 16 bytes.
//   → xtime / AddRoundKey = bitwise plane ops.
//   Only the ortho transpose (byte layout <-> plane layout) is non-trivial C.
'use strict';
const ref = require('./bitslice_haraka_check.js');
const { RC, refAesenc, haraka512_port_ref, haraka256_port_ref,
        haraka512_mix, haraka256_mix } = ref;

// ── the four fixed swizzle index vectors (identical to the vpaes .inc constants) ──
const VP_SR = [0,5,10,15,4,9,14,3,8,13,2,7,12,1,6,11];               // ShiftRows
const rotIdx = (k)=>Array.from({length:16},(_,o)=>{const c=o>>2,r=o&3;return 4*c+((r+k)&3);});
const VP_R1 = rotIdx(1), VP_R2 = rotIdx(2), VP_R3 = rotIdx(3);       // MixColumns rotates

// ── BigInt plane helpers (128-bit; bit position = by*8 + block) ──
const MASK = (1n<<128n)-1n;
const NOT = (x)=>(~x)&MASK;
function toPlanesC(blocks){ const p=[0n,0n,0n,0n,0n,0n,0n,0n];
  for(let b=0;b<8;b++) for(let by=0;by<16;by++){ const v=blocks[b][by];
    for(let i=0;i<8;i++) if((v>>i)&1) p[i]|=(1n<<BigInt(by*8+b)); } return p; }
function fromPlanesC(p){ const blocks=[];
  for(let b=0;b<8;b++){ const a=new Uint8Array(16);
    for(let by=0;by<16;by++){ let v=0; for(let i=0;i<8;i++) if((p[i]>>BigInt(by*8+b))&1n) v|=(1<<i); a[by]=v; }
    blocks.push(a); } return blocks; }
const bigToBytes = (x)=>{ const a=new Uint8Array(16); for(let by=0;by<16;by++) a[by]=Number((x>>BigInt(by*8))&0xFFn); return a; };
const bytesToBig = (a)=>{ let x=0n; for(let by=0;by<16;by++) x|=BigInt(a[by])<<BigInt(by*8); return x; };
// wasm_i8x16_swizzle(plane, idx): out byte o = in byte idx[o]
function swizzle(plane, idx){ const a=bigToBytes(plane), o=new Uint8Array(16);
  for(let i=0;i<16;i++) o[i]=a[idx[i]]; return bytesToBig(o); }

// ── ortho: 8×8 bit-transpose across the 8 registers, per byte lane ──
// Standard 3-stage network (Hacker's Delight fig 7-6, generalized to registers).
// Involution-structured: the same network is its own inverse (deortho == ortho).
// This is the ONLY subtle piece of C; validated below against toPlanesC/fromPlanesC.
function orthoNet(regs){ // regs: 8×Uint8Array(16); transforms in place, returns regs
  const swapmove = (x,y,mask,sh)=>{ // per-byte SWAPMOVE between registers x,y
    for(let by=0;by<16;by++){ const t=((x[by]>>sh)^y[by])&mask; y[by]^=t; x[by]=(x[by]^(t<<sh))&0xff; } };
  // stage 0: shift 1, mask 0x55, pairs (0,1)(2,3)(4,5)(6,7)
  for(const c of [0,2,4,6]) swapmove(regs[c], regs[c+1], 0x55, 1);
  // stage 1: shift 2, mask 0x33, pairs (0,2)(1,3)(4,6)(5,7)
  for(const c of [0,1,4,5]) swapmove(regs[c], regs[c+2], 0x33, 2);
  // stage 2: shift 4, mask 0x0F, pairs (0,4)(1,5)(2,6)(3,7)
  for(const c of [0,1,2,3]) swapmove(regs[c], regs[c+4], 0x0F, 4);
  return regs;
}
// planes-as-16-byte-registers <-> BigInt planes
const regsToBig = (regs)=>regs.map(bytesToBig);
const bigToRegs = (p)=>p.map(bigToBytes);

// ── bitsliced S-box (Boyar-Peralta, BearSSL aes_ct) on 8 BigInt planes ──
function bitsliceSbox(q){
  const x0=q[7],x1=q[6],x2=q[5],x3=q[4],x4=q[3],x5=q[2],x6=q[1],x7=q[0];
  const y14=x3^x5,y13=x0^x6,y9=x0^x3,y8=x0^x5;
  const t0=x1^x2,y1=t0^x7,y4=y1^x3,y12=y13^y14,y2=y1^x0,y5=y1^x6,y3=y5^y8;
  const t1=x4^y12,y15=t1^x5,y20=t1^x1,y6=y15^x7,y10=y15^t0,y11=y20^y9;
  const y7=x7^y11,y17=y10^y11,y19=y10^y8,y16=t0^y11,y21=y13^y16,y18=x0^y16;
  const t2=y12&y15,t3=y3&y6,t4=t3^t2,t5=y4&x7,t6=t5^t2,t7=y13&y16,t8=y5&y1,t9=t8^t7;
  const t10=y2&y7,t11=t10^t7,t12=y9&y11,t13=y14&y17,t14=t13^t12,t15=y8&y10,t16=t15^t12;
  const t17=t4^t14,t18=t6^t16,t19=t9^t14,t20=t11^t16,t21=t17^y20,t22=t18^y19,t23=t19^y21,t24=t20^y18;
  const t25=t21^t22,t26=t21&t23,t27=t24^t26,t28=t25&t27,t29=t28^t22,t30=t23^t24,t31=t22^t26;
  const t32=t31&t30,t33=t32^t24,t34=t23^t33,t35=t27^t33,t36=t24&t35,t37=t36^t34,t38=t27^t36;
  const t39=t29&t38,t40=t25^t39,t41=t40^t37,t42=t29^t33,t43=t29^t40,t44=t33^t37,t45=t42^t41;
  const z0=t44&y15,z1=t37&y6,z2=t33&x7,z3=t43&y16,z4=t40&y1,z5=t29&y7,z6=t42&y11,z7=t45&y17,z8=t41&y10;
  const z9=t44&y12,z10=t37&y3,z11=t33&y4,z12=t43&y13,z13=t40&y5,z14=t29&y2,z15=t42&y9,z16=t45&y14,z17=t41&y8;
  const t46=z15^z16,t47=z10^z11,t48=z5^z13,t49=z9^z10,t50=z2^z12,t51=z2^z5,t52=z7^z8,t53=z0^z3;
  const t54=z6^z7,t55=z16^z17,t56=z12^t48,t57=t50^t53,t58=z4^t46,t59=z3^t54,t60=t46^t57;
  const t61=z14^t57,t62=t52^t58,t63=t49^t58,t64=z4^t59,t65=t61^t62,t66=z1^t63;
  const s0=t59^t63,s6=t56^NOT(t62),s7=t48^NOT(t60),t67=t64^t65,s3=t53^t66,s4=t51^t66,s5=t47^t65;
  const s1=t64^NOT(s3),s2=t55^NOT(t67);
  q[7]=s0;q[6]=s1;q[5]=s2;q[4]=s3;q[3]=s4;q[2]=s5;q[1]=s6;q[0]=s7;
}
const xtimePlanes = (q)=>[q[7], q[0]^q[7], q[1], q[2]^q[7], q[3]^q[7], q[4], q[5], q[6]];

// ── one 8-way bitsliced AES round in the C layout (all swizzles + bitwise) ──
function cRound(q, kq){
  bitsliceSbox(q);                                   // SubBytes
  const sr = q.map(p=>swizzle(p, VP_SR));            // ShiftRows
  const t2 = xtimePlanes(sr);                        // MixColumns...
  const y = [0n,0n,0n,0n,0n,0n,0n,0n];
  for(let i=0;i<8;i++){
    const t2r1 = swizzle(t2[i], VP_R1);
    const ar1  = swizzle(sr[i], VP_R1);
    const ar2  = swizzle(sr[i], VP_R2);
    const ar3  = swizzle(sr[i], VP_R3);
    y[i] = t2[i] ^ t2r1 ^ ar1 ^ ar2 ^ ar3 ^ kq[i];  // ...+ AddRoundKey
  }
  for(let i=0;i<8;i++) q[i]=y[i];
}

// key planes for a haraka512 subround: block b uses RC[base + (b&3)]
function keyPlanes(base, mod){ const keys=[]; for(let b=0;b<8;b++) keys.push(RC[base+(b&mod)]); return toPlanesC(keys); }

// ── full cmodel haraka perms (ortho in → rounds → deortho → byte-domain mix) ──
function cmodel_haraka512_perm(in2, golden){
  // 8 blocks: state0 c0..c3, state1 c0..c3
  let blocks=[]; for(let s=0;s<2;s++) for(let c=0;c<4;c++) blocks.push(Uint8Array.from(in2[s].subarray(c*16,c*16+16)));
  for(let i=0;i<5;i++){
    let q = regsToBig(orthoNet(blocks.map(b=>Uint8Array.from(b))));   // ortho
    if(golden && i===0) golden.afterOrtho = q.map(x=>bigToBytes(x));
    cRound(q, keyPlanes(8*i+0, 3));
    cRound(q, keyPlanes(8*i+4, 3));
    if(golden && i===0) golden.afterRounds = q.map(x=>bigToBytes(x));
    blocks = orthoNet(bigToRegs(q));                                  // deortho (same net)
    if(golden && i===0) golden.afterDeortho = blocks.map(b=>Uint8Array.from(b));
    // byte-domain unpack mixing, per state
    for(let s=0;s<2;s++){ const st=new Uint8Array(64);
      for(let c=0;c<4;c++) st.set(blocks[4*s+c], c*16);
      haraka512_mix(st);
      for(let c=0;c<4;c++) blocks[4*s+c]=Uint8Array.from(st.subarray(c*16,c*16+16)); }
  }
  const out=[new Uint8Array(64),new Uint8Array(64)];
  for(let s=0;s<2;s++) for(let c=0;c<4;c++) out[s].set(blocks[4*s+c], c*16);
  return out;
}
function cmodel_haraka512_port(in2){
  const perm=cmodel_haraka512_perm(in2); const out=[new Uint8Array(32),new Uint8Array(32)];
  for(let s=0;s<2;s++){ const buf=perm[s]; for(let i=0;i<64;i++) buf[i]^=in2[s][i];
    out[s].set(buf.subarray(8,16),0); out[s].set(buf.subarray(24,32),8);
    out[s].set(buf.subarray(32,40),16); out[s].set(buf.subarray(48,56),24); }
  return out;
}
function cmodel_haraka256_port(in4){
  let blocks=[]; for(let s=0;s<4;s++) for(let c=0;c<2;c++) blocks.push(Uint8Array.from(in4[s].subarray(c*16,c*16+16)));
  // upper 4 lanes-of-... actually 8 blocks: state s → blocks 2s+c
  for(let i=0;i<5;i++){
    let q = regsToBig(orthoNet(blocks.map(b=>Uint8Array.from(b))));
    cRound(q, keyPlanes(4*i+0, 1));
    cRound(q, keyPlanes(4*i+2, 1));
    blocks = orthoNet(bigToRegs(q));
    for(let s=0;s<4;s++){ const st=new Uint8Array(32);
      for(let c=0;c<2;c++) st.set(blocks[2*s+c], c*16);
      haraka256_mix(st);
      for(let c=0;c<2;c++) blocks[2*s+c]=Uint8Array.from(st.subarray(c*16,c*16+16)); }
  }
  const out=[]; for(let s=0;s<4;s++){ const o=new Uint8Array(32);
    for(let c=0;c<2;c++) o.set(blocks[2*s+c], c*16);
    for(let i=0;i<32;i++) o[i]=in4[s][i]^o[i]; out.push(o); }
  return out;
}

// ─────────────────────────────── validation ───────────────────────────────
const rndN=(n)=>{const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=(Math.random()*256)|0;return a;};
const eq=(a,b)=>{if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;};
let fail=0;

// (1) ortho network == direct transpose, and is its own inverse
{ let bad=0;
  for(let it=0;it<3000;it++){
    const blocks=Array.from({length:8},()=>rndN(16));
    const net = regsToBig(orthoNet(blocks.map(b=>Uint8Array.from(b))));
    const direct = toPlanesC(blocks);
    for(let i=0;i<8;i++) if(net[i]!==direct[i]) bad++;
    const back = orthoNet(bigToRegs(net));                 // deortho
    for(let b=0;b<8;b++) if(!eq(back[b],blocks[b])) bad++;
  }
  fail+=bad; console.log(bad===0?'PASS: ortho network == direct transpose, and deortho∘ortho == id'
                                :`FAIL: ortho network ${bad} mismatches`);
}
// (2) cRound (8-way, C layout) == reference aesenc per block
{ let bad=0;
  for(let it=0;it<3000;it++){
    const blocks=Array.from({length:8},()=>rndN(16)), keys=Array.from({length:8},()=>rndN(16));
    const q=toPlanesC(blocks), kq=toPlanesC(keys);
    cRound(q,kq); const got=fromPlanesC(q);
    for(let b=0;b<8;b++){ const r=refAesenc(blocks[b],keys[b]); if(!eq(got[b],r)) bad++; }
  }
  fail+=bad; console.log(bad===0?'PASS: cRound (8-way, C layout) == reference aesenc over 24000 blocks'
                                :`FAIL: cRound ${bad} mismatches`);
}
// (3) cmodel haraka512_port (2-nonce) == reference
{ let bad=0;
  for(let it=0;it<2000;it++){ const a=rndN(64),b=rndN(64);
    const [ca,cb]=cmodel_haraka512_port([a,b]);
    if(!eq(ca,haraka512_port_ref(a))||!eq(cb,haraka512_port_ref(b))) bad++; }
  fail+=bad; console.log(bad===0?'PASS: cmodel haraka512_port (2-nonce) == reference over 4000 states'
                                :`FAIL: cmodel haraka512 ${bad} mismatches`);
}
// (4) cmodel haraka256_port (4-nonce) == reference
{ let bad=0;
  for(let it=0;it<2000;it++){ const ins=[rndN(32),rndN(32),rndN(32),rndN(32)];
    const got=cmodel_haraka256_port(ins);
    for(let s=0;s<4;s++) if(!eq(got[s],haraka256_port_ref(ins[s]))) bad++; }
  fail+=bad; console.log(bad===0?'PASS: cmodel haraka256_port (4-nonce) == reference over 8000 states'
                                :`FAIL: cmodel haraka256 ${bad} mismatches`);
}

module.exports = { toPlanesC, fromPlanesC, orthoNet, cRound, keyPlanes,
                   cmodel_haraka512_port, cmodel_haraka256_port,
                   VP_SR, VP_R1, VP_R2, VP_R3, bigToBytes };

// `node bitslice_cmodel.js dump` → write a few deterministic golden vectors to
// scripts/bitslice_golden.json (documentation + a no-oracle fallback for the C).
if (require.main === module && process.argv[2] === 'dump') {
  const hex = (a)=>Buffer.from(a).toString('hex');
  const det = (n,seed)=>{ const a=new Uint8Array(n); for(let i=0;i<n;i++) a[i]=(i*7+seed*31+1)&0xff; return a; };
  const vecs = [];
  for (let v=0; v<4; v++){
    const s0=det(64,2*v), s1=det(64,2*v+1);
    const h512=cmodel_haraka512_port([s0,s1]);
    const k=[det(32,v),det(32,v+5),det(32,v+9),det(32,v+13)];
    const h256=cmodel_haraka256_port(k);
    vecs.push({
      h512_in:[hex(s0),hex(s1)], h512_out:h512.map(hex),
      h256_in:k.map(hex), h256_out:h256.map(hex),
    });
  }
  // also one single-round + ortho vector to pin the transpose in isolation
  const blocks=Array.from({length:8},(_,b)=>det(16,b)), keys=Array.from({length:8},(_,b)=>det(16,b+20));
  const planes=toPlanesC(blocks);                      // == ortho(blocks)
  const q=toPlanesC(blocks); cRound(q, toPlanesC(keys));
  const roundOut=fromPlanesC(q);
  const round1 = { blocks:blocks.map(hex), keys:keys.map(hex),
                   planes:planes.map(x=>hex(bigToBytes(x))), round_out:roundOut.map(hex) };
  require('fs').writeFileSync(require('path').join(__dirname,'bitslice_golden.json'),
    JSON.stringify({ note:'golden vectors from bitslice_cmodel.js — the validated 2d blueprint',
                     round1, haraka:vecs }, null, 2));
  console.log('wrote scripts/bitslice_golden.json');
  process.exit(0);
}

if (require.main === module) process.exit(fail===0?0:1);
