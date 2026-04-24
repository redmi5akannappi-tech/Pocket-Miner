require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const connectDB = require('./config/db');
const { handleWsConnection } = require('./websocket/wsHandler');

// Route imports
const sessionRoutes = require('./routes/session');
const sharesRoutes = require('./routes/shares');
const userRoutes = require('./routes/user');
const upgradesRoutes = require('./routes/upgrades');
const withdrawRoutes = require('./routes/withdraw');
const leaderboardRoutes = require('./routes/leaderboard');
const missionsRoutes = require('./routes/missions');

const app = express();
const server = http.createServer(app);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// CORS — allow localhost (dev) + Render deployed frontend (prod)
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Telegram WebApp, mobile, curl)
    if (!origin) return callback(null, true);
    // Allow any .onrender.com subdomain + explicit allowed list
    if (origin.endsWith('.onrender.com') || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'pocket-miner-api' });
});

// ─── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/session', sessionRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/user', userRoutes);
app.use('/api/upgrades', upgradesRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/user', missionsRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ─── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', handleWsConnection);
console.log('[WS] WebSocket server initialized on /ws');

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

const startServer = async () => {
  if (process.env.USE_MEMORY !== 'true') {
    await connectDB();
  } else {
    console.log('[DB] 🧪 Skipping MongoDB — using in-memory store');
  }

  server.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Pocket Miner API running on port ${PORT}`);
    console.log(`[SERVER] Mode: ${process.env.USE_MEMORY === 'true' ? 'IN-MEMORY (no DB)' : 'MongoDB'}`);
  });
};

startServer().catch(err => {
  console.error('[SERVER] Failed to start:', err.message);
  process.exit(1);
});
