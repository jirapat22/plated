require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists before DB init.
// An explicit DATA_DIR wins (used by tests for isolation); otherwise default to
// the Railway volume in production and a local ./data folder in development.
const dataDir =
  process.env.DATA_DIR
    ? process.env.DATA_DIR
    : process.env.NODE_ENV === 'production'
      ? '/data'
      : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
process.env.DATA_DIR = dataDir;

const { initDb } = require('./src/db');
const { requireProfile } = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const foodsRoutes = require('./src/routes/foods');
const mealsRoutes = require('./src/routes/meals');
const waterRoutes = require('./src/routes/water');
const weightRoutes = require('./src/routes/weight');
const settingsRoutes   = require('./src/routes/settings');
const ironlogRoutes    = require('./src/routes/ironlog');
const templatesRoutes  = require('./src/routes/templates');
const orbitRoutes      = require('./src/routes/orbit');
const bugReportsRoutes = require('./src/routes/bugReports');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// Public — registered before express.static and all /api routers
app.get('/api/orbit-summary', (req, res) => {
  try {
    const { getDb } = require('./src/db');
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(me.calories), 0) AS calories,
             COALESCE(SUM(me.protein),  0) AS protein
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE ms.date = date('now')
    `).get();
    const logged = row.calories > 0 || row.protein > 0;
    res.json({
      label:     'Today',
      stat:      logged
        ? `${Math.round(row.calories)} kcal · ${Math.round(row.protein)}g protein`
        : 'Nothing logged today',
      status:    logged ? 'active' : 'warning',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orbit admin feed — public by default (optional ORBIT_API_KEY gate inside)
app.use('/api/orbit', orbitRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Auth — public (login / create profile / status); /me etc. self-guard
app.use('/api/auth', authRoutes);

// Bug / idea reports — public so they work on the lock screen too
app.use('/api/bug-report', bugReportsRoutes);

// Protected — every route below is scoped to the logged-in profile
app.use('/api/foods', requireProfile, foodsRoutes);
app.use('/api/meals', requireProfile, mealsRoutes);
app.use('/api/water', requireProfile, waterRoutes);
app.use('/api/weight', requireProfile, weightRoutes);
app.use('/api/settings', requireProfile, settingsRoutes);
app.use('/api/ironlog',    requireProfile, ironlogRoutes);
app.use('/api/templates',  requireProfile, templatesRoutes);

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || err.statusCode || 500;
  // Capture server faults (no status or 5xx) to Orbit — best-effort, never blocks.
  if (status >= 500) {
    try {
      bugReportsRoutes.captureReport({
        source: 'backend',
        message: err.message || 'Internal server error',
        stack: err.stack || null,
        context: { method: req.method, path: req.originalUrl || req.url },
      }).catch(() => {});
    } catch { /* ignore */ }
  }
  if (!res.headersSent) {
    res.status(status >= 500 ? 500 : status).json({ error: 'Internal server error' });
  }
});

function start() {
  // Generate icons if missing (e.g. fresh deployment)
  const iconPath = path.join(__dirname, 'public', 'icons', 'icon-192.png');
  if (!fs.existsSync(iconPath)) {
    try { require('./scripts/gen-icons'); } catch (e) { console.warn('Icon gen skipped:', e.message); }
  }

  initDb();

  // Forward any locally-stored reports that haven't reached Orbit yet.
  (async () => {
    if (process.env.ORBIT_URL?.trim()) {
      console.log(`Orbit reporting enabled → ${process.env.ORBIT_URL}`);
      try {
        const { flushed } = await bugReportsRoutes.flushUnsent();
        if (flushed) console.log(`Flushed ${flushed} pending report(s) to Orbit`);
      } catch (e) { console.warn('Orbit flush skipped:', e.message); }
    } else {
      console.log('Orbit reporting disabled (set ORBIT_URL + INGEST_SECRET to enable)');
    }
  })();

  const server = app.listen(PORT, () => {
    console.log(`Plated running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    console.log(`Data dir: ${dataDir}`);
  });

  const shutdown = () => {
    console.log('SIGTERM received — shutting down gracefully');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
