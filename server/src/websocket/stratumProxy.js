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
    this.shareId      = 1;
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
    if (!this.connected || !this.socket) return false;

    const msg = {
      id:     this.shareId++,
      method: 'submit',
      params: {
        id:     share.minerId || this.workerName,
        job_id: share.jobId,
        nonce:  share.nonce,
        result: share.hash,
      },
    };

    this.socket.write(JSON.stringify(msg) + '\n');
    return true;
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    this.socket?.destroy();
    this.socket    = null;
    this.connected = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _login() {
    const loginMsg = {
      id:     1,
      method: 'login',
      params: {
        login: `${this.wallet}.${this.workerName}`,
        pass:  'x',
        agent: `pocket-miner/1.0 (${this.algorithm})`,
        algo:  [this.algorithm],
      },
    };
    this.socket.write(JSON.stringify(loginMsg) + '\n');
    console.log(`[STRATUM] Login sent → wallet: ${this.wallet}, algo: ${this.algorithm}`);
  }

  _onPoolMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return console.warn('[STRATUM] Bad JSON from pool:', raw.slice(0, 80)); }

    // Login response
    if (msg.id === 1) {
      if (msg.error) {
        console.error('[STRATUM] Login rejected:', msg.error);
        return;
      }
      console.log('[STRATUM] ✅ Login accepted by pool');
      if (msg.result?.job) {
        this._onNewJob(msg.result.job);
      }
      return;
    }

    // New job pushed by pool
    if (msg.method === 'job' && msg.params) {
      this._onNewJob(msg.params);
      return;
    }

    // Share result
    if (msg.result !== undefined && msg.id > 1) {
      const accepted = !!msg.result;
      console.log(`[STRATUM] Share ${accepted ? '✅ accepted' : '❌ rejected'} (id ${msg.id})`);
      this._broadcast({
        type:     'share_result',
        accepted,
        shareId:  msg.id,
        error:    msg.error || null,
      });
    }
  }

  _onNewJob(poolJob) {
    this.currentJob = {
      jobId:      poolJob.job_id  || poolJob.id || `job_${Date.now()}`,
      blob:       poolJob.blob,
      target:     poolJob.target,
      difficulty: poolJob.difficulty || 3,
      algorithm:  poolJob.algo || this.algorithm,
      height:     poolJob.height,
      seed_hash:  poolJob.seed_hash,
      timestamp:  Date.now(),
    };
    console.log(`[STRATUM] New job: ${this.currentJob.jobId} | height: ${this.currentJob.height}`);
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
