import { useEffect, useRef, useCallback, useState } from 'react';

const WS_URL = typeof window !== 'undefined'
  ? (import.meta.env.VITE_WS_URL || `ws://${window.location.host}/ws`)
  : 'ws://localhost:3001/ws';

const RECONNECT_DELAY = 3000;

export function useWebSocket({ telegramId, sessionId, onJob, onAck, onLog, enabled }) {
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const [status, setStatus] = useState('disconnected');

  const emit = useCallback((tag, msg) => onLog?.(tag, msg), [onLog]);

  const connect = useCallback(() => {
    if (!enabled || !telegramId || !sessionId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');
    emit('POOL', `WebSocket connecting to ${WS_URL}...`);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      emit('POOL', '✓ WebSocket connected. Authenticating...');
      ws.send(JSON.stringify({ type: 'auth', telegramId, sessionId }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'connected':
            emit('POOL', `Server ready · algo: ${msg.algorithm} · pool: ${msg.pool}`);
            break;
          case 'job':
            emit('JOB', `New job ← pool  id: ${msg.job?.jobId}  target: ${msg.job?.target?.slice(0,12)}...`);
            onJob?.(msg.job);
            break;
          case 'share_ack':
            emit('SHARE', msg.valid
              ? `✓ Share ACK — valid  job: ${msg.jobId}`
              : `✗ Share ACK — invalid  reason: ${msg.reason}`);
            onAck?.(msg);
            break;
          case 'share_result':
            emit('SHARE', msg.accepted
              ? '✓ Pool accepted share!'
              : `✗ Pool rejected share  err: ${msg.error}`);
            break;
          case 'stopped':
            emit('INFO', 'WebSocket mining stopped.');
            break;
          case 'error':
            emit('ERR', `WS error: ${msg.message}`);
            break;
        }
      } catch {
        emit('ERR', 'Failed to parse WS message');
      }
    };

    ws.onclose = (e) => {
      setStatus('disconnected');
      wsRef.current = null;
      emit('POOL', `WebSocket closed (code ${e.code})`);

      if (enabled && e.code !== 1000) {
        emit('POOL', `Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY);
      }
    };

    ws.onerror = () => {
      emit('ERR', 'WebSocket connection error');
      ws.close();
    };
  }, [enabled, telegramId, sessionId, onJob, onAck, emit]);

  const sendShare = useCallback((shareData) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'share', shareData }));
    }
  }, []);

  const disconnect = useCallback(() => {
    clearTimeout(reconnectRef.current);
    if (wsRef.current) {
      wsRef.current.close(1000, 'User stopped mining');
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  useEffect(() => {
    if (enabled) connect();
    else disconnect();
    return () => { clearTimeout(reconnectRef.current); wsRef.current?.close(); };
  }, [enabled, connect, disconnect]);

  return { status, sendShare, disconnect };
}
