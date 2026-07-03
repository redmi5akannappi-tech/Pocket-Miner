const net = require('net');

/**
 * VerusCoin Stratum ↔ WebSocket Proxy
 *
 * Architecture:
 *  - Backend opens ONE persistent TCP connection to the mining pool (Stratum protocol)
 *  - All connected WebSocket miners (WASM frontend workers) share this connection
 *  - Pool jobs are broadcast to all subscribers
 *  - Shares from each subscriber are forwarded upstream to the pool
 *
 * Pool:   ap.luckpool.net:3956 (primary) / na.luckpool.net:3956 (backup)
 * Algo:   verushash
 * Wallet: RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ
 */
class StratumProxy {
  constructor(config) {
    this.primaryHost  = config.primaryHost  || 'ap.luckpool.net';
    this.backupHost   = config.backupHost   || 'na.luckpool.net';
    this.port         = config.port         || 3956;
    this.wallet       = config.wallet;
    this.workerName   = config.workerName   || 'pocketminer';
    this.algorithm    = config.algorithm    || 'verushash';

    this.socket       = null;
    this.connected    = false;
    this.usingBackup  = false;
    this.buffer       = '';
    this.subscribers  = new Set();   // active WebSocket clients
    this.currentJob   = null;
    this.shareId      = 10;       // start at 10 to avoid conflicting with subscribe(1) and authorize(2)
    this.extranonce1  = '';          // assigned by pool after subscribe
    this.currentTarget = null;       // assigned by pool via mining.set_target
    this._retryTimer  = null;
    this._retryDelay  = 5_000;      // start at 5 s, back off to 60 s
    this._maxDelay    = 60_000;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  connect() {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    const host = this.usingBackup ? this.backupHost : this.primaryHost;
    console.log(`[STRATUM] Connecting to ${host}:${this.port} (${this.algorithm})...`);

    this.socket = new net.Socket();
    this.socket.setKeepAlive(true, 20_000);

    this.socket.connect(this.port, host, () => {
      this._connecting = false;
      this.connected   = true;
      this._retryDelay = 5_000;     // reset back-off on success
      console.log(`[STRATUM] ✅ Connected to ${host}:${this.port}`);
      this._login();
    });

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this._onPoolMessage(line.trim());
      }
    });

    this.socket.on('close', () => {
      this._connecting = false;
      this.connected   = false;
      console.warn('[STRATUM] ⚠️  Disconnected from pool.');
      this._scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      this._connecting = false;
      console.error(`[STRATUM] ❌ ${err.message}`);
      // Try backup on next reconnect
      this.usingBackup = !this.usingBackup;
      this.socket?.destroy();
    });
  }

  subscribe(ws) {
    this.subscribers.add(ws);
    // Send current job immediately to new subscriber so they can start working
    if (this.currentJob) {
      this._send(ws, { type: 'job', job: this.currentJob });
    }
    console.log(`[STRATUM] Subscriber added. Total: ${this.subscribers.size}`);
  }

  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  /**
   * Forward a share from a WebSocket client to the pool
   * @param {WebSocket} ws - the client that found the share
   * @param {{ jobId, nonce, hash, minerId }} share
   */
  submitShare(ws, share) {
    if (!this.connected || !this.socket) return { forwarded: false, reason: 'not connected' };

    // Only forward shares that the worker flagged as meeting the pool target
    // AND were computed with real WASM VerusHash (not JS stub)
    if (!share.meetsPool) {
      return { forwarded: false, reason: 'below pool target (local share only)' };
    }
    if (!share.realHash) {
      return { forwarded: false, reason: 'JS stub hash — not valid for pool' };
    }

    // ZIP 301 mining.submit format:
    //   params: ["WORKER_NAME", "JOB_ID", "TIME", "NONCE_2", "EQUIHASH_SOLUTION"]
    //
    // The WASM miner now builds the real solution (template + extraNonce1).
    // The proxy just forwards it as-is.
    const nonce2Hex = share.nonce2Hex || '';
    const time = share.time || (this.currentJob && this.currentJob.time) || '';

    // Solution comes directly from the worker (built from pool template + extraNonce1)
    const solution = share.solution || '';
    if (!solution || solution.length !== 2694) {
      console.log(`[STRATUM] ❌ Solution missing or wrong length: ${solution.length} (expected 2694)`);
      return { forwarded: false, reason: `solution length ${solution.length}, expected 2694` };
    }

    const msg = {
      id:     this.shareId++,
      method: 'mining.submit',
      params: [
        `${this.wallet}.${share.minerId || this.workerName}`,
        share.jobId,
        time,
        nonce2Hex,
        solution,
      ],
    };

    console.log(`[STRATUM] Submit: job=${share.jobId} time=${time} nonce2=${nonce2Hex.slice(0,16)}...(${nonce2Hex.length/2}B) en1=${this.extranonce1} solnVer=${solution.slice(6,14)} solnTail=${solution.slice(-30)} solnLen=${solution.length}`);
    this.socket.write(JSON.stringify(msg) + '\n');
    return { forwarded: true };
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    this.socket?.destroy();
    this.socket    = null;
    this.connected = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _login() {
    // 1. Send mining.subscribe (Zcash/Verus Stratum)
    const subMsg = {
      id: 1,
      method: 'mining.subscribe',
      params: ['PocketMiner/1.0', null, 'ap.luckpool.net', '3956'],
    };
    this.socket.write(JSON.stringify(subMsg) + '\n');
    console.log(`[STRATUM] Subscribe sent`);
  }

  _onPoolMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return console.warn('[STRATUM] Bad JSON from pool:', raw.slice(0, 80)); }

    // 1. Subscribe response -> Send authorize
    if (msg.id === 1) {
      if (msg.error) {
        console.error('[STRATUM] Subscribe rejected:', msg.error);
        return;
      }
      this.extranonce1 = msg.result[1];
      const nonce1Len = this.extranonce1.length / 2; // bytes
      const nonce2Len = 32 - nonce1Len;
      console.log(`[STRATUM] Subscribe accepted, extranonce1: ${this.extranonce1} (${nonce1Len} bytes) → NONCE_2 size: ${nonce2Len} bytes (${nonce2Len * 2} hex chars)`);
      
      const authMsg = {
        id: 2,
        method: 'mining.authorize',
        params: [`${this.wallet}.${this.workerName}`, 'd=1']
      };
      this.socket.write(JSON.stringify(authMsg) + '\n');
      console.log(`[STRATUM] Authorize sent → wallet: ${this.wallet}`);
      return;
    }

    // 2. Authorize response
    if (msg.id === 2) {
      if (msg.error || !msg.result) {
        console.error('[STRATUM] Authorize rejected:', msg.error);
        return;
      }
      console.log('[STRATUM] ✅ Login accepted by pool');
      return;
    }

    // 3. Target update from pool — store it for the next job
    if (msg.method === 'mining.set_target' && msg.params) {
      this.currentTarget = msg.params[0];
      // Derive difficulty: count leading zero nibbles in the target
      const leadingZeros = this.currentTarget.match(/^0*/)[0].length;
      console.log(`[STRATUM] Target set by pool: ${this.currentTarget.slice(0, 16)}... (diff ~${leadingZeros} nibbles)`);
      return;
    }

    // 4. New job pushed by pool (mining.notify)
    if (msg.method === 'mining.notify' && msg.params) {
      this._onNewJob(msg.params);
      return;
    }

    // 5. Share result (any id >= 10, since shares start at 10)
    if (msg.id >= 10) {
      const accepted = !!msg.result;
      const errDetail = msg.error ? JSON.stringify(msg.error) : 'none';
      console.log(`[STRATUM] Share ${accepted ? '✅ accepted' : '❌ rejected'} (id ${msg.id}) error: ${errDetail}`);
      this._broadcast({
        type:     'share_result',
        accepted,
        shareId:  msg.id,
        error:    msg.error || null,
      });
      return;
    }

    // 6. Unknown response — log it
    console.log(`[STRATUM] Unknown pool response: ${JSON.stringify(msg).slice(0, 200)}`);
    }

  _onNewJob(params) {
    // Zcash/Verus Stratum notify params:
    // [job_id, version, prevhash, merkle, sapling_root, time, bits, clean_jobs, solution_template?, daemon_nonce?]
    const target = this.currentTarget || '0000002000000000000000000000000000000000000000000000000000000000';
    // Difficulty = number of leading zero nibbles in the target
    const difficulty = target.match(/^0*/)[0].length || 5;

    // params[8] is the solution template (VerusHash V2.1+/PBaaS)
    const solutionTemplate = params[8] || '';
    // params[9] might be the daemon nonce (PBaaS requires it for header construction)
    const daemonNonce = params[9] || '';

    // Log ALL params so we can see what the pool sends
    console.log(`[STRATUM] mining.notify raw params (${params.length} total):`);
    for (let i = 0; i < params.length; i++) {
      const val = typeof params[i] === 'string' ? params[i].slice(0, 40) : params[i];
      console.log(`[STRATUM]   params[${i}]: ${val}${typeof params[i] === 'string' && params[i].length > 40 ? '...' : ''}`);
    }

    this.currentJob = {
      jobId:       params[0],
      version:     params[1],
      prevhash:    params[2],
      merkle:      params[3],
      sapling:     params[4],   // final sapling root
      time:        params[5],
      bits:        params[6],
      clean_jobs:  params[7],
      solutionTemplate,          // solution template from pool (PBaaS)
      daemonNonce,               // daemon nonce for PBaaS header (if provided)
      extranonce1: this.extranonce1,
      target,                   // real target from pool (or fallback)
      difficulty,               // derived from target leading zeros
      algorithm:   this.algorithm,
      timestamp:   Date.now(),
    };
    console.log(`[STRATUM] New job: ${this.currentJob.jobId} | target: ${target.slice(0,16)}... | diff: ${difficulty} | solnTemplate: ${solutionTemplate.slice(0,20) || 'none'} | daemonNonce: ${daemonNonce.slice(0,16) || 'none'} | paramsCount: ${params.length}`);
    this._broadcast({ type: 'job', job: this.currentJob });
  }

  _broadcast(data) {
    const payload = JSON.stringify(data);
    const dead = [];
    for (const ws of this.subscribers) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(payload);
      } else {
        dead.push(ws);
      }
    }
    dead.forEach(ws => this.subscribers.delete(ws));
  }

  _send(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  _scheduleReconnect() {
    clearTimeout(this._retryTimer);
    console.log(`[STRATUM] Reconnecting in ${this._retryDelay / 1000}s...`);
    this._retryTimer = setTimeout(() => {
      // Exponential back-off
      this._retryDelay = Math.min(this._retryDelay * 2, this._maxDelay);
      this.connect();
    }, this._retryDelay);
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────
let _instance = null;

function getStratumProxy() {
  if (_instance) return _instance;

  const wallet = process.env.WALLET_ADDRESS;
  const host   = process.env.POOL_HOST;

  if (!wallet || !host || wallet.includes('REPLACE') || host.includes('REPLACE')) {
    console.warn('[STRATUM] Pool credentials not configured — using simulated jobs.');
    return null;
  }

  _instance = new StratumProxy({
    primaryHost: process.env.POOL_HOST         || 'ap.luckpool.net',
    backupHost:  process.env.POOL_HOST_BACKUP  || 'na.luckpool.net',
    port:        parseInt(process.env.POOL_PORT || '3956'),
    wallet:      process.env.WALLET_ADDRESS,
    workerName:  process.env.WORKER_NAME       || 'pocketminer',
    algorithm:   process.env.POOL_ALGORITHM    || 'verushash',
  });

  return _instance;
}

module.exports = { StratumProxy, getStratumProxy };
