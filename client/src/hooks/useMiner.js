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

  const workerRef        = useRef(null);
  const pendingSharesRef = useRef([]);
  const submitTimerRef   = useRef(null);
  const hashrateRef      = useRef(0);

  const MODE_CPU = { eco: 15, balanced: 40, turbo: 75 };

  const log = useCallback((tag, msg) => addLog(setLogs, tag, msg), []);

  // ─── Flush accumulated shares to backend ───────────────────────────────────
  const flushShares = useCallback(async (sid, hr) => {
    const shares = [...pendingSharesRef.current];
    pendingSharesRef.current = [];
    if (!shares.length || !sid) return;

    for (const share of shares) {
      try {
        const result = await submitShare(sid, share, hr);
        if (result?.valid) {
          log('SHARE', `✓ Accepted  nonce: 0x${share.nonce}  job: ${share.jobId}`);
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

    log('POOL', `Connecting to ap.luckpool.net:3956 (verushash)...`);
    log('INFO', `Mode: ${selectedMode.toUpperCase()}  ·  CPU target: ${MODE_CPU[selectedMode]}%`);

    try {
      const sessionData = await startSession(selectedMode);
      const sid = sessionData.sessionId;
      setSessionId(sid);
      setSessionShares(0);
      setIsMining(true);
      setCpuPercent(MODE_CPU[selectedMode]);

      log('POOL', `✓ Session started  id: ${sid}`);
      log('INFO', `Wallet: RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ`);

      // Spawn Web Worker
      const worker = new Worker('/miner.worker.js');
      workerRef.current = worker;

      worker.onmessage = (e) => {
        const { type, value, data } = e.data;

        if (type === 'wasm_status') {
          setWasmLoaded(e.data.loaded);
          log(e.data.loaded ? 'HASH' : 'INFO', e.data.message);
        }

        if (type === 'hashrate') {
          setHashrate(value);
          hashrateRef.current = value;
          const kh = (value / 1000).toFixed(2);
          log('STAT', `${kh} KH/s  ·  shares: ${sessionShares}`);
        }

        if (type === 'share') {
          log('HASH', `⛏ Found!  nonce: 0x${data.nonce}  hash: ${data.hash.slice(0, 16)}...  diff: ${data.difficulty}`);
          pendingSharesRef.current.push(data);
        }

        if (type === 'stopped') {
          log('INFO', 'Worker stopped.');
          setHashrate(0);
          setCpuPercent(0);
        }

        if (type === 'error') {
          log('ERR', data.message || 'Worker error');
        }
      };

      worker.onerror = (e) => {
        log('ERR', `Worker crash: ${e.message}`);
        setError(e.message);
        stopMining();
      };

      worker.postMessage({
        cmd: 'start',
        mode: selectedMode,
        job: { jobId: 'genesis', blob: `session_${sid}`, difficulty: 3 },
        upgradeLevel: sessionData.upgrade?.cpuLevel || 1,
      });

      log('JOB', `Initial job dispatched  blob: session_${sid?.slice(0,8)}...  diff: 3`);

      // Periodic share flush
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
    if (!isMining && !workerRef.current) return;

    log('INFO', 'Stopping miner...');

    if (workerRef.current) {
      workerRef.current.postMessage({ cmd: 'stop' });
      setTimeout(() => { workerRef.current?.terminate(); workerRef.current = null; }, 500);
    }

    if (submitTimerRef.current) {
      clearInterval(submitTimerRef.current);
      submitTimerRef.current = null;
    }

    setIsMining(false);
    setHashrate(0);
    setCpuPercent(0);

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
      log('INFO', `Mode set to ${newMode.toUpperCase()}`);
    }
  }, [isMining, log]);

  // ─── Receive new pool job (from WebSocket Stratum proxy) ────────────────────
  const receiveNewJob = useCallback((job) => {
    if (workerRef.current) {
      workerRef.current.postMessage({ cmd: 'new_job', job });
      log('JOB', `New job from pool  id: ${job.jobId}  diff: ${job.difficulty || 3}  algo: ${job.algorithm || 'verushash'}`);
    }
  }, [log]);

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (submitTimerRef.current) clearInterval(submitTimerRef.current);
    };
  }, []);

  return {
    isMining, mode, hashrate, cpuPercent,
    sessionShares, sessionId, error, logs,
    wasmLoaded,
    startMining, stopMining, changeMode, receiveNewJob,
  };
}
