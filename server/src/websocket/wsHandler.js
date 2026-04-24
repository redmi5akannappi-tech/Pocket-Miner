const { validateShare } = require('../services/antiCheat');
const { getStratumProxy } = require('./stratumProxy');

// Active miner sessions: ws -> { telegramId, sessionId }
const activeMiners = new Map();

/**
 * Handle a new WebSocket connection from a WASM miner client.
 *
 * Flow:
 *  1. Client connects → server sends `connected` greeting
 *  2. Client sends `auth` with telegramId + sessionId
 *  3. Server registers client with StratumProxy so it receives pool jobs
 *  4. Client receives `job` from pool (forwarded by StratumProxy)
 *  5. Client solves PoW → sends `share`
 *  6. Server validates share → forwards to pool via StratumProxy
 *  7. Server sends `share_ack` back to client
 *  8. Pool sends new job → forwarded to all subscribed clients
 */
function handleWsConnection(ws, req) {
  let clientMeta = { telegramId: null, sessionId: null, authenticated: false };
  let pingInterval;

  // Get (or start) the Stratum proxy singleton
  const stratum = getStratumProxy();
  if (stratum && !stratum.connected) {
    stratum.connect();
  }

  // ─── Auth timeout (10 s) ──────────────────────────────────────────────────
  const authTimeout = setTimeout(() => {
    if (!clientMeta.authenticated) {
      ws.close(4001, 'Authentication timeout');
    }
  }, 10_000);

  // ─── Keep-alive ping every 30 s ───────────────────────────────────────────
  pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30_000);

  // ─── Message handler ──────────────────────────────────────────────────────
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return safeSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    switch (msg.type) {

      // ── Auth ───────────────────────────────────────────────────────────────
      case 'auth': {
        const { telegramId, sessionId } = msg;
        if (!telegramId || !sessionId) {
          return safeSend(ws, { type: 'error', message: 'Missing telegramId or sessionId' });
        }

        clientMeta = { telegramId, sessionId, authenticated: true };
        clearTimeout(authTimeout);
        activeMiners.set(ws, clientMeta);

        // Subscribe this client to pool jobs via Stratum proxy
        if (stratum) {
          stratum.subscribe(ws);
          console.log(`[WS] ${telegramId} subscribed to Stratum proxy`);
        } else {
          // No real pool — send a simulated job so the worker starts immediately
          safeSend(ws, {
            type: 'job',
            job: generateSimJob(sessionId),
          });
        }

        console.log(`[WS] Miner authenticated: ${telegramId} | session: ${sessionId}`);
        break;
      }

      // ── Share submission from WASM worker ─────────────────────────────────
      case 'share': {
        if (!clientMeta.authenticated) {
          return safeSend(ws, { type: 'error', message: 'Not authenticated' });
        }

        const { shareData, hashrate } = msg;

        // Anti-cheat validation (server-side)
        const validation = validateShare({
          shareData,
          hashrate,
          session: {
            startTime: Date.now() - 120_000, // lightweight stub
            sharesSubmitted: 1,
            invalidShares: 0,
          },
          telegramId: clientMeta.telegramId,
        });

        if (validation.valid) {
          // Forward to real pool if Stratum is connected
          if (stratum?.connected) {
            const forwarded = stratum.submitShare(ws, {
              jobId:    shareData?.jobId,
              nonce:    shareData?.nonce,
              hash:     shareData?.hash,
              minerId:  clientMeta.telegramId,
            });

            if (!forwarded) {
              console.warn(`[WS] Stratum not ready — share not forwarded (${clientMeta.telegramId})`);
            }
          }
        } else {
          console.warn(`[WS] Invalid share from ${clientMeta.telegramId}: ${validation.reason}`);
        }

        // Acknowledge to client regardless (reward tracking handled via /api/shares/submit REST call)
        safeSend(ws, {
          type:   'share_ack',
          valid:  validation.valid,
          reason: validation.reason || null,
          jobId:  shareData?.jobId,
        });

        // If no real pool, issue next simulated job after valid share
        if (!stratum && validation.valid) {
          safeSend(ws, {
            type: 'job',
            job:  generateSimJob(clientMeta.sessionId),
          });
        }

        break;
      }

      // ── Client stopping miner ──────────────────────────────────────────────
      case 'stop': {
        if (stratum) stratum.unsubscribe(ws);
        safeSend(ws, { type: 'stopped' });
        break;
      }

      // ── Hashrate telemetry (no-op, used for monitoring) ───────────────────
      case 'hashrate_update':
        break;

      default:
        safeSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  ws.on('close', (code) => {
    if (stratum) stratum.unsubscribe(ws);
    activeMiners.delete(ws);
    clearInterval(pingInterval);
    clearTimeout(authTimeout);
    console.log(`[WS] Disconnected (${clientMeta.telegramId || 'unauthed'}): code ${code}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Socket error:', err.message);
  });

  // ─── Greeting ─────────────────────────────────────────────────────────────
  safeSend(ws, {
    type:      'connected',
    message:   'Pocket Miner WebSocket ready. Send auth to begin.',
    algorithm: process.env.POOL_ALGORITHM || 'verushash',
    pool:      `${process.env.POOL_HOST || 'ap.luckpool.net'}:${process.env.POOL_PORT || 3956}`,
    timestamp: Date.now(),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _simJobCtr = 0;
function generateSimJob(sessionId) {
  _simJobCtr++;
  return {
    jobId:      `sim_${_simJobCtr}_${Date.now()}`,
    blob:       `session_${sessionId}_${Math.random().toString(36).slice(2)}`,
    target:     '000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    difficulty: 3,
    algorithm:  process.env.POOL_ALGORITHM || 'verushash',
    timestamp:  Date.now(),
  };
}

function safeSend(ws, data) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

function getActiveMiners() {
  return Array.from(activeMiners.values());
}

module.exports = { handleWsConnection, getActiveMiners };
