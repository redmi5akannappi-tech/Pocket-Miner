<div align="center">

# ⛏️ Pocket Miner

### Mine Real VerusCoin From Your Browser

A Telegram Web App that turns any device into a real cryptocurrency miner. Powered by VerusHash 2.2 compiled to WebAssembly, Pocket Miner connects directly to mining pools and earns real VRSC — no downloads, no installs, just open and mine.

[![VerusCoin](https://img.shields.io/badge/coin-VerusCoin_(VRSC)-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48L3N2Zz4=)](https://verus.io)
[![Pool](https://img.shields.io/badge/pool-LuckPool-green?style=for-the-badge)](https://luckpool.net)
[![WASM](https://img.shields.io/badge/hash-VerusHash_2.2_WASM-orange?style=for-the-badge)](https://webassembly.org)
[![License](https://img.shields.io/badge/license-MIT-purple?style=for-the-badge)](#license)

<br/>

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ⛏️  ~300 KH/s per device                         │
│   🎯  Real pool shares — verified & accepted        │
│   💰  Earn actual VRSC cryptocurrency               │
│   🌐  Runs in any modern browser                    │
│   📱  Telegram Web App integration                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

</div>

---

## 🌟 What Makes This Special

Most "browser miners" are fake — they simulate mining with random numbers and never actually earn anything. **Pocket Miner is different.**

We compiled the full VerusCoin hashing algorithm (VerusHash 2.2 with CLHash + keyed Haraka512) to **WebAssembly**, running the exact same cryptographic computation that native miners use. Shares submitted by Pocket Miner are **verified and accepted** by real mining pools.

```
✅✅ SHARE ACCEPTED (id 10) — THIS IS THE CORRECT ENCODING
✅✅ SHARE ACCEPTED (id 11) — THIS IS THE CORRECT ENCODING
✅✅ SHARE ACCEPTED (id 12) — THIS IS THE CORRECT ENCODING
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  📱 User Device (Browser / Telegram)                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  React Frontend (Vite)                                 │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  Web Worker × N threads                          │  │  │
│  │  │  ┌────────────────────────────────────────────┐  │  │  │
│  │  │  │  VerusHash 2.2 WASM                        │  │  │  │
│  │  │  │  • Haraka512 (portable, no AES-NI needed)  │  │  │  │
│  │  │  │  • CLHash key mutation                     │  │  │  │
│  │  │  │  • Keyed Haraka512 finalization             │  │  │  │
│  │  │  └────────────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └───────────────────────┬────────────────────────────────┘  │
└──────────────────────────┼───────────────────────────────────┘
                           │ WebSocket
┌──────────────────────────┼───────────────────────────────────┐
│  🖥️ Backend (Node.js)    │                                   │
│  ┌───────────────────────┴────────────────────────────────┐  │
│  │  Stratum Proxy                                         │  │
│  │  WebSocket ←→ TCP translation                          │  │
│  └───────────────────────┬────────────────────────────────┘  │
│  ┌───────────────────────┴────────────────────────────────┐  │
│  │  REST API + Auth + Anti-cheat + Reward tracking        │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────┼───────────────────────────────────┘
                           │ Stratum TCP
                     ┌─────┴─────┐
                     │  LuckPool │
                     │  :3956    │
                     └───────────┘
```

**Mining Flow:**
1. User opens Telegram Bot → launches Web App
2. Selects mode (Eco / Balanced / Turbo / Monster) → clicks **Mine**
3. Web Workers load `verus_hash.wasm` and begin hashing
4. Workers build: `header(140B) + solution(1347B) = 1487B` → hash with VerusHash 2.2
5. When `hash < target`: share is sent via WebSocket → Stratum proxy → Pool
6. Pool verifies and accepts → user earns real VRSC

---

## ⚡ Performance

| Device | Threads | Hashrate | Shares/hr* |
|--------|---------|----------|------------|
| Desktop (16-core) | 15 | ~300 KH/s | ~50 |
| Laptop (8-core) | 7 | ~140 KH/s | ~25 |
| Mobile (4-core) | 3 | ~50 KH/s | ~8 |

_*Approximate, depends on pool difficulty_

> VerusHash was designed to be CPU-friendly — no GPU advantage. This makes browser mining viable unlike SHA-256 or Ethash.

---

## 💰 Mining Details

| Setting | Value |
|---------|-------|
| **Algorithm** | VerusHash 2.2 (`Finalize2b` — CLHash + keyed Haraka512) |
| **Pool** | `ap.luckpool.net:3956` (backup: `na.luckpool.net:3956`) |
| **Protocol** | Zcash Stratum (ZIP 301) with PBaaS merged-mining support |
| **WASM Size** | ~80 KB (hash binary) + ~180 KB (JS glue) |
| **Solution** | v7 merged-mining with canonical header clearing |

---

## 🚀 Quickstart

### Prerequisites
- Node.js ≥ 18
- MongoDB Atlas account (or local MongoDB)
- [Emscripten SDK](https://emscripten.org) (only for WASM compilation)

### 1. Clone & install

```bash
git clone https://github.com/youruser/Pocket-Miner.git
cd Pocket-Miner
npm run install:all
```

### 2. Configure

```bash
cd server && cp .env.example .env
```

Edit `server/.env`:
```env
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/pocket-miner
TELEGRAM_BOT_TOKEN=<your_bot_token>

# Pool config (pre-configured for LuckPool):
WALLET_ADDRESS=RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ
POOL_HOST=ap.luckpool.net
POOL_PORT=3956
```

### 3. Run

```bash
# From project root — starts both server and client:
npm run dev
```

Open `http://localhost:5173` — works in browser during development (no Telegram required).

### 4. Compile WASM (optional — pre-built binary included)

```bash
# Install Emscripten first:
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh

# Compile VerusHash to WASM:
cd scripts && bash compile-verus-wasm.sh
```

The script automatically:
- Clones VerusCoin source for crypto primitives
- Patches for portable (non-AES-NI) compilation
- Adds CLHash stubs for WASM linking
- Compiles with Emscripten → outputs to `client/public/wasm/`

---

## 🧬 Technical Deep Dive

### The VerusHash 2.2 Challenge

VerusHash 2.2 is a CPU-optimized proof-of-work algorithm that combines:
- **Haraka512** — a short-input hash using AES round functions
- **CLHash** — a carry-less multiplication hash for memory-hard key mutation
- **Keyed Haraka512** — final compression with input-dependent round constants

The native implementation relies heavily on AES-NI and CLMUL CPU instructions. For WASM, we use a fully **portable** implementation with software AES emulation.

### Merged Mining (PBaaS v7)

VerusCoin uses a merged-mining model where multiple chains share proof-of-work. The block hash is computed over a **canonical** header:

```
ZEROED for hashing:     prevhash, merkleroot, saplingroot, bits, nonce
KEPT for hashing:       version, time
ZEROED in solution:     hashPrevMMRRoot, hashBlockMMRRoot (bytes 8..71)
```

The real search nonce lives in the **last 15 bytes** of the 1344-byte solution:
```
solution[1329..1332] = extraNonce1 (pool-assigned, 4 bytes)
solution[1333..1343] = counting nonce (miner iterates, 11 bytes)
```

When submitting, the original MMR roots are **restored** — the pool needs them intact for validation.

### Key Implementation Details

| Component | Detail |
|-----------|--------|
| Hash input | `header(140B) + CompactSize(3B) + solution(1344B) = 1487 bytes` |
| Hash output | 32 bytes, **little-endian** (reversed for display/target comparison) |
| Target comparison | `hash[31-i] vs target[i]` for `i = 0..31` (LE hash vs BE target) |
| Nonce submitted | 11-byte counting nonce (solution tail), NOT 28-byte header nonce |
| WASM hasher | Static `CVerusHashV2` with `SOLUTION_VERUSHHASH_V2_2` (created once, reused) |

---

## 📡 API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/health` | Server health check |
| `GET`  | `/api/user/stats` | Full user profile + upgrades |
| `POST` | `/api/session/start` | Start mining session |
| `POST` | `/api/session/end` | End session + calculate rewards |
| `POST` | `/api/shares/submit` | Submit a PoW share |
| `POST` | `/api/upgrades/buy` | Buy upgrade (cpu/efficiency/boost) |
| `GET`  | `/api/leaderboard` | Top miners by points |
| `GET`  | `/api/user/missions` | Daily missions + progress |

### WebSocket Protocol

```
Client → { type: "auth",  telegramId, sessionId }
Client → { type: "share", shareData: { jobId, nonce2Hex, time, hash, solution, ... } }
Server → { type: "job",   job: { jobId, version, prevhash, merkle, target, ... } }
Server → { type: "share_result", accepted: true/false }
```

---

## 🎮 Gamification

| Upgrade | Effect | Base Cost |
|---------|--------|-----------|
| ⚙️ CPU Processor | +10% hashrate per level | 500 pts |
| ❄️ Cooling System | +8% efficiency per level | 300 pts |
| 🚀 Boost Core | +5% reward multiplier | 800 pts |

Mining modes control CPU usage:

| Mode | CPU Target | Sleep/Batch |
|------|-----------|-------------|
| 🌱 Eco | 15% | 25ms |
| ⚖️ Balanced | 40% | 18ms |
| 🔥 Turbo | 75% | 7ms |
| 💀 Monster | 100% | 0ms |

---

## 🔐 Authentication

| Environment | Behavior |
|-------------|----------|
| Development (`DEV_BYPASS=true`) | Accepts any request, uses `x-telegram-id` header |
| Production | **Telegram InitData HMAC-SHA256** verification required |

---

## 🚢 Deployment

### Render (recommended)

1. Push to GitHub
2. Create **Web Service** for backend:
   - Build: `cd server && npm install`
   - Start: `node src/index.js`
   - Set env vars (MongoDB, Telegram, pool config)
3. Deploy **Static Site** for client:
   - Build: `npm install && npm run build`
   - Publish: `dist/`

See [`render.yaml`](render.yaml) for the full Blueprint spec.

---

## 🐛 Bugs We Conquered

Building a browser-based pool miner required solving problems nobody had documented before. Here's the battle log:

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | WASM used `Hash()` instead of `Finalize2b()` | Skipped CLHash entirely → wrong algorithm | Rewrote to use `Write()` + `Finalize2b()` |
| 2 | C function params `(out, in, len)` vs JS `(in, len, out)` | Hash written to input buffer → all-zero output | Matched C signature to JS calling convention |
| 3 | PBaaS header nonce populated instead of zeroed | Hash input didn't match pool's canonical header | Detect v7 merged-mining, zero non-canonical fields |
| 4 | MMR roots zeroed in submission (not just hashing) | Pool couldn't validate solution integrity | Save originals, restore before submission |
| 5 | Sent 28-byte header nonce2 instead of 11-byte counting nonce | Pool couldn't reconstruct solution | Send only solution tail nonce |
| 6 | Hash compared as big-endian but output is little-endian | Shares never found (comparing wrong byte) | Reverse comparison: `hash[31-i] vs target[i]` |
| 7 | Non-portable AES-NI/CLMUL symbols missing in WASM | Linker errors on build | Added portable stubs redirecting to `_port` variants |

---

## ⚠️ Legal & Ethical

- Mining is **opt-in** — never auto-starts
- CPU usage is **throttled and disclosed** to users
- No executables are downloaded — pure WASM in the browser sandbox
- All earnings are **transparently calculated** and logged
- Users can stop mining at any time with a single tap

---

## 📄 License

MIT

---

<div align="center">

**Built with determination, debugged with patience** ⛏️

*"If the pool accepts the share, the fix is correct end-to-end."*

</div>
