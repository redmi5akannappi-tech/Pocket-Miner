import { useState, useRef, useCallback, useEffect } from 'react';
import { useUser } from '../context/UserContext';
import { makeLog } from '../components/MinerTerminal';

const SHARE_SUBMIT_INTERVAL = 10_000;
const MAX_LOGS = 80;

function addLog(setLogs, tag, msg) {
  setLogs(prev => {
    const next = [...prev, makeLog(tag, msg)];
    return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
  });
}

export function useMiner() {
  const { activeSession, startSession, endSession, submitShare } = useUser();

  const [isMining, setIsMining]         = useState(false);
  const [mode, setMode]                 = useState('balanced');
  const [hashrate, setHashrate]         = useState(0);
  const [cpuPercent, setCpuPercent]     = useState(0);
  const [sessionShares, setSessionShares] = useState(0);
  const [sessionId, setSessionId]       = useState(null);
  const [error, setError]               = useState(null);
  const [logs, setLogs]                 = useState([]);
  const [wasmLoaded, setWasmLoaded]     = useState(false);
  const [threadCount, setThreadCount]   = useState(0);

  // Array of workers instead of single worker
  const workersRef        = useRef([]);
  const pendingSharesRef  = useRef([]);
  const submitTimerRef    = useRef(null);
  const hashrateRef       = useRef(0);
  const wsSendShareRef    = useRef(null);
  // Track per-worker hashrate to sum them
  const workerHashratesRef = useRef({});

  const MODE_CPU = { eco: 15, balanced: 40, turbo: 75, monster: 100 };

  // How many threads per mode
  function getThreadCount(selectedMode) {
    const cores = navigator.hardwareConcurrency || 4;
    switch (selectedMode) {
      case 'eco':      return Math.max(1, Math.floor(cores * 0.25));
      case 'balanced': return Math.max(1, Math.floor(cores * 0.5));
      case 'turbo':    return Math.max(2, Math.floor(cores * 0.75));
      case 'monster':  return cores; // ALL cores
      default:         return Math.max(1, Math.floor(cores * 0.5));
    }
  }

  const log = useCallback((tag, msg) => addLog(setLogs, tag, msg), []);

  // Allow Dashboard to inject the WebSocket sendShare function
  const setWsSendShare = useCallback((fn) => {
    wsSendShareRef.current = fn;
  }, []);

  // ─── Flush accumulated shares to backend ───────────────────────────────────
  const flushShares = useCallback(async (sid, hr) => {
    const shares = [...pendingSharesRef.current];
    pendingSharesRef.current = [];
    if (!shares.length || !sid) return;

    for (const share of shares) {
      try {
        const result = await submitShare(sid, share, hr);
        if (result?.valid) {
          log('SHARE', `✓ Pool share accepted  nonce2: ${share.nonce2Hex?.slice(0,12)}  job: ${share.jobId}`);
          setSessionShares(prev => prev + 1);
        } else {
          log('SHARE', `✗ Rejected  reason: ${result?.reason || 'unknown'}`);
        }
      } catch (e) {
        log('ERR', `Share submit failed: ${e.message}`);
      }
    }
  }, [submitShare, log]);

  // ─── Start Mining ──────────────────────────────────────────────────────────
  const startMining = useCallback(async (selectedMode = mode) => {
    if (isMining) return;
    setError(null);
    setLogs([]);

    const numThreads = getThreadCount(selectedMode);
    const cores = navigator.hardwareConcurrency || 4;

    log('POOL', `Connecting to ap.luckpool.net:3956 (verushash)...`);
    log('INFO', `Mode: ${selectedMode.toUpperCase()}  ·  Threads: ${numThreads}/${cores} cores  ·  CPU: ${MODE_CPU[selectedMode]}%`);

    try {
      const sessionData = await startSession(selectedMode);
      const sid = sessionData.sessionId;
      setSessionId(sid);
      setSessionShares(0);
      setIsMining(true);
      setCpuPercent(MODE_CPU[selectedMode]);
      setThreadCount(numThreads);
      workerHashratesRef.current = {};

      log('POOL', `✓ Session started  id: ${sid}`);
      log('INFO', `Wallet: RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ`);

      // Spawn multiple Web Workers
      const workers = [];
      for (let t = 0; t < numThreads; t++) {
        const worker = new Worker('/miner.worker.js');
        const threadId = t;

        worker.onmessage = (e) => {
          const { type, value, data } = e.data;

          if (type === 'wasm_status') {
            // Only log WASM status from first thread
            if (threadId === 0) {
              setWasmLoaded(e.data.loaded);
              log(e.data.loaded ? 'HASH' : 'WARN', e.data.message);
            }
          }

          if (type === 'hashrate') {
            // Sum hashrates from all workers
            workerHashratesRef.current[threadId] = value;
            const totalHr = Object.values(workerHashratesRef.current).reduce((a, b) => a + b, 0);
            setHashrate(totalHr);
            hashrateRef.current = totalHr;
            // Only log from thread 0 to avoid spam
            if (threadId === 0) {
              const kh = (totalHr / 1000).toFixed(2);
              const best = e.data.bestHash ? e.data.bestHash.slice(0, 16) : '?';
              log('STAT', `${kh} KH/s (${numThreads}T)  best: ${best}...`);
            }
          }

          if (type === 'share') {
            log('POOL', `🎯 POOL SHARE FOUND!  thread: ${threadId}  hash: ${data.hash?.slice(0, 16)}...`);
            pendingSharesRef.current.push(data);
            if (wsSendShareRef.current) {
              console.log('[MINER] Forwarding share via WebSocket:', data.jobId, 'realHash:', data.realHash, 'meetsPool:', data.meetsPool);
              wsSendShareRef.current(data);
            } else {
              console.warn('[MINER] ⚠️ wsSendShareRef is NULL — share NOT forwarded to pool!');
              log('WARN', '⚠️ WebSocket not wired — share not forwarded to pool');
            }
          }

          if (type === 'stopped' && threadId === 0) {
            log('INFO', 'Workers stopped.');
            setHashrate(0);
            setCpuPercent(0);
          }

          if (type === 'error') {
            log('ERR', `Thread ${threadId}: ${data.message || 'Worker error'}`);
          }
        };

        worker.onerror = (e) => {
          log('ERR', `Thread ${threadId} crash: ${e.message}`);
          if (threadId === 0) {
            setError(e.message);
          }
        };

        worker.postMessage({
          cmd: 'start',
          mode: selectedMode,
          job: { jobId: 'genesis', blob: `session_${sid}`, difficulty: 3 },
          upgradeLevel: sessionData.upgrade?.cpuLevel || 1,
        });

        workers.push(worker);
      }

      workersRef.current = workers;
      log('JOB', `${numThreads} mining threads started — waiting for pool job...`);

      // Periodic share flush (REST path for point tracking)
      submitTimerRef.current = setInterval(() => {
        flushShares(sid, hashrateRef.current);
      }, SHARE_SUBMIT_INTERVAL);

    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      log('ERR', `Failed to start: ${msg}`);
      setError(msg);
      setIsMining(false);
    }
  }, [isMining, mode, startSession, flushShares, log]);

  // ─── Stop Mining ───────────────────────────────────────────────────────────
  const stopMining = useCallback(async () => {
    if (!isMining && !workersRef.current.length) return;

    log('INFO', `Stopping ${workersRef.current.length} mining threads...`);

    // Stop all workers
    for (const worker of workersRef.current) {
      worker.postMessage({ cmd: 'stop' });
    }
    setTimeout(() => {
      for (const worker of workersRef.current) {
        worker.terminate();
      }
      workersRef.current = [];
    }, 500);

    if (submitTimerRef.current) {
      clearInterval(submitTimerRef.current);
      submitTimerRef.current = null;
    }

    setIsMining(false);
    setHashrate(0);
    setCpuPercent(0);
    setThreadCount(0);

    if (sessionId) {
      await flushShares(sessionId, hashrateRef.current);
      try {
        const result = await endSession(sessionId);
        log('POOL', `Session ended  +${result.session?.pointsEarned || 0} pts  +${(result.session?.cryptoEarned || 0).toFixed(8)} VRC`);
      } catch (e) {
        log('ERR', `End session failed: ${e.message}`);
      }
      setSessionId(null);
    }
  }, [isMining, sessionId, endSession, flushShares, log]);

  // ─── Change mode ───────────────────────────────────────────────────────────
  const changeMode = useCallback((newMode) => {
    if (!isMining) {
      setMode(newMode);
      const threads = getThreadCount(newMode);
      const cores = navigator.hardwareConcurrency || 4;
      log('INFO', `Mode: ${newMode.toUpperCase()}  ·  ${threads}/${cores} threads`);
    }
  }, [isMining, log]);

  // ─── Receive new pool job (from WebSocket Stratum proxy) ────────────────────
  const receiveNewJob = useCallback((job) => {
    // Broadcast new job to ALL workers
    for (const worker of workersRef.current) {
      worker.postMessage({ cmd: 'new_job', job });
    }
    if (workersRef.current.length > 0) {
      log('JOB', `New job → ${workersRef.current.length} threads  id: ${job.jobId}  target: ${job.target?.slice(0,12)}...`);
    }
  }, [log]);

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      for (const worker of workersRef.current) {
        worker.terminate();
      }
      workersRef.current = [];
      if (submitTimerRef.current) clearInterval(submitTimerRef.current);
    };
  }, []);

  return {
    isMining, mode, hashrate, cpuPercent,
    sessionShares, sessionId, error, logs,
    wasmLoaded, setWsSendShare, threadCount,
    startMining, stopMining, changeMode, receiveNewJob,
  };
}
