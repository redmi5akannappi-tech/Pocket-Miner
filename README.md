# ⛏️ Pocket Miner

A Telegram Web App for gamified crypto mining. Users voluntarily start mining sessions inside Telegram — their device runs a WASM PoW loop in a Web Worker, shares are validated by the backend, and rewards are tracked as real balance + in-game points.

---

## 🏗️ Architecture

```
User Device (Telegram)
  └── React Frontend (Vite)
        └── Web Worker  ←─── miner.worker.js (WASM PoW loop)
              │  sends shares
              ▼
Backend (Node.js + Express)
  ├── REST API  (/api/...)
  ├── WebSocket (/ws)        ←── receives shares from workers
  │     └── Stratum Proxy    ←── forwards to VerusCoin pool
  │           │
  │           └── ap.luckpool.net:3956  (VerusCoin)
  └── MongoDB  (users, sessions, rewards)
```

**Mining flow:**
1. User opens Telegram Bot → launches Web App
2. Selects mode (Eco / Balanced / Turbo) → clicks **Mine**
3. Frontend calls `POST /api/session/start`
4. WebSocket authenticates → backend sends first pool job
5. Web Worker hashes (PoW loop) → posts found shares to main thread
6. Main thread submits share via REST `POST /api/shares/submit` (validated) + WS (forwarded to pool)
7. Backend Stratum proxy forwards valid shares to `ap.luckpool.net:3956`
8. User stops → `POST /api/session/end` → rewards calculated

---

## 💰 Mining Details

| Setting       | Value |
|---------------|-------|
| Algorithm     | VerusHash (`verushash`) |
| Pool (primary)| `ap.luckpool.net:3956` |
| Pool (backup) | `na.luckpool.net:3956` |
| Wallet        | `RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ` |

> **Note:** The current Web Worker uses a JavaScript stub hasher (FNV-1a) that produces the correct format for testing the full pipeline. To enable real VerusCoin mining, replace `pseudoVerusHash()` in `client/public/miner.worker.js` with a WASM-compiled VerusHash function.

---

## 🚀 Quickstart

### Prerequisites
- Node.js ≥ 18
- MongoDB Atlas account (or local MongoDB)
- (Optional) Telegram Bot Token from [@BotFather](https://t.me/botfather)

### 1. Clone & install

```bash
cd "Pocket Miner/server"
npm install

cd "../client"
npm install
```

### 2. Configure backend

```bash
cd server
cp .env.example .env
```

Edit `.env`:
```env
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/pocket-miner
TELEGRAM_BOT_TOKEN=<your_bot_token>   # leave placeholder to use DEV_BYPASS

# Pre-configured:
WALLET_ADDRESS=RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ
POOL_HOST=ap.luckpool.net
POOL_PORT=3956
POOL_ALGORITHM=verushash
```

### 3. Run

**Terminal 1 — Backend:**
```bash
cd server
npm run dev
# → API on http://localhost:3001
# → WS  on ws://localhost:3001/ws
# → Stratum connects to ap.luckpool.net:3956
```

**Terminal 2 — Frontend:**
```bash
cd client
npm run dev
# → http://localhost:5173
```

Open `http://localhost:5173` — works in browser during development (no Telegram required thanks to `DEV_BYPASS=true`).

---

## 🔐 Authentication

| Environment | Behavior |
|-------------|----------|
| `NODE_ENV=development` + `DEV_BYPASS=true` | Accepts any request. Uses `x-telegram-id` header as user ID. |
| `NODE_ENV=production` | **Telegram InitData HMAC-SHA256 required.** Rejects all non-Telegram requests. |

To go production:
1. Set `NODE_ENV=production` in your deployment env
2. Set `DEV_BYPASS=false` (or remove it)
3. Set your real `TELEGRAM_BOT_TOKEN`

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/health` | Server health check |
| `GET`  | `/api/user/stats` | Full user profile + upgrades |
| `POST` | `/api/session/start` | Start mining session (`{ mode }`) |
| `POST` | `/api/session/end` | End session + calculate rewards (`{ sessionId }`) |
| `POST` | `/api/shares/submit` | Submit a PoW share (`{ sessionId, shareData, hashrate }`) |
| `POST` | `/api/upgrades/buy` | Buy upgrade (`{ type: "cpu"\|"efficiency"\|"boost" }`) |
| `POST` | `/api/upgrades/boost` | Activate 2x boost |
| `GET`  | `/api/upgrades/costs` | Get upgrade costs for current level |
| `POST` | `/api/withdraw` | Request withdrawal (`{ amount, walletAddress }`) |
| `GET`  | `/api/withdraw/history` | Withdrawal history |
| `GET`  | `/api/leaderboard` | Top miners by points |
| `GET`  | `/api/user/missions` | Daily missions + progress |
| `POST` | `/api/user/claim-missions` | Claim completed mission rewards |

**WebSocket** (`ws://host/ws`):
```
Client → { type: "auth",            telegramId, sessionId }
Client → { type: "share",           shareData, hashrate }
Client → { type: "stop" }
Server → { type: "connected" }
Server → { type: "job",             job: { jobId, blob, target, difficulty, algorithm } }
Server → { type: "share_ack",       valid, reason }
Server → { type: "share_result",    accepted, shareId }
```

---

## 🎮 Upgrades

| Upgrade | Effect | Base Cost |
|---------|--------|-----------|
| CPU Processor | +10% hashrate per level | 500 pts |
| Cooling System | +8% efficiency per level | 300 pts |
| Boost Core | +5% reward multiplier + boost duration | 800 pts |

Cost per level = `base × 1.6^(level - 1)`

**2× Boost**: Doubles reward multiplier for 5–15 min (scales with boost level). 1-hour cooldown.

---

## 🗄️ Database

MongoDB collections:
- `users` — profile, balance, points, streak, missions
- `sessions` — per-session mining stats and rewards
- `upgrades` — upgrade levels per user
- `transactions` — withdrawal and mining reward ledger

---

## 🚢 Deployment (Render)

1. Push repo to GitHub
2. Create **Web Service** on [Render](https://render.com):
   - Build: `cd server && npm install`
   - Start: `node src/index.js`
   - Set all env vars (MongoDB URI, Telegram token, pool config)
   - Set `NODE_ENV=production`, `DEV_BYPASS=false`
3. Deploy **Static Site** for `client/`:
   - Build: `npm install && npm run build`
   - Publish: `dist/`
   - Set `VITE_WS_URL=wss://your-backend.onrender.com/ws`

---

## 🔮 Upgrading to Real WASM Mining

The current worker uses a JS stub. To enable real VerusHash:

1. Get a WASM build of VerusHash (e.g. from the [VerusCoin community](https://github.com/VerusCoin))
2. Place `verus_hash_bg.wasm` + `verus_hash.js` in `client/public/wasm/`
3. In `miner.worker.js`, replace `pseudoVerusHash(input)` with:
   ```js
   import init, { verus_hash } from '/wasm/verus_hash.js';
   await init();
   const hashBytes = verus_hash(new TextEncoder().encode(input));
   const hash = Array.from(hashBytes).map(b => b.toString(16).padStart(2,'0')).join('');
   ```

---

## ⚠️ Legal & Ethical

- Mining is **opt-in** — never auto-starts
- CPU usage is **throttled and disclosed** to users
- No executables are downloaded to the user's device
- All earnings are **transparently calculated** and logged
