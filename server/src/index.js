require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
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

// Render (and most PaaS) sit behind a reverse proxy — trust it so req.ip and
// express-rate-limit see the real client address, not the proxy's.
app.set('trust proxy', 1);

// ─── Middleware ────────────────────────────────────────────────────────────────
// Gzip API responses + static assets.
app.use(compression());

// Since the server now serves the SPA on the same origin, configure a scoped CSP
// that permits the Telegram Web App SDK and same-origin WebSocket while keeping
// everything else locked down. (Default helmet CSP would block the TG script.)
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://telegram.org', "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'worker-src': ["'self'", 'blob:'],
      'font-src': ["'self'", 'data:'],
      'frame-ancestors': ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
      'upgrade-insecure-requests': null, // don't force https on localhost dev
    },
  },
}));

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
    // Allow any localhost port (dev), any .onrender.com subdomain (prod), + explicit allowed list
    if (
      origin.startsWith('http://localhost:') || 
      origin.endsWith('.onrender.com') || 
      ALLOWED_ORIGINS.includes(origin)
    ) {
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

// ─── API 404 (JSON) ────────────────────────────────────────────────────────────
// Scoped to /api so unknown API paths return JSON, while app routes fall through
// to the SPA index.html below.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Static SPA (single-service hosting) ────────────────────────────────────────
// Serve the built React app from client/dist on the same origin as the API + WS.
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST, {
  index: false, // index.html is served explicitly by the SPA fallback (no-cache)
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
    // Vite emits content-hashed filenames under /assets → safe to cache forever.
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Worker + wasm + other root files: revalidate so updates ship immediately.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback: any non-API GET returns index.html (client-side routing).
app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    if (err) next(err);
  });
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
