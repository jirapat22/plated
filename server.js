require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
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
const weightRoutes = require('./src/routes/weight');
const measurementsRoutes = require('./src/routes/measurements');
const settingsRoutes   = require('./src/routes/settings');
const ironlogRoutes    = require('./src/routes/ironlog');
const orbitRoutes      = require('./src/routes/orbit');
const bugReportsRoutes = require('./src/routes/bugReports');
const batchesRoutes    = require('./src/routes/batches');
const connectionsRoutes = require('./src/routes/connections');
const leftoversRoutes   = require('./src/routes/leftovers');
const presetsRoutes     = require('./src/routes/presets');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS at its proxy, so without this every request arrives
// with the proxy's address and the per-IP login limiter would treat the whole
// internet as one client — one attacker would lock everybody out.
app.set('trust proxy', 1);

// Old address → new domain. Since 18/10/2026 the app lives at
// plated.jirapat.dev; a browser visiting the old *.up.railway.app address
// gets a permanent (301) redirect so bookmarks move over by themselves.
// Only page loads (GET/HEAD) are redirected — /api keeps working on the old
// address, because a redirect can drop the auth header or turn a POST into a
// GET, which would break Orbit, Ironlog and old installed PWAs still syncing.
const CANONICAL_HOST = 'plated.jirapat.dev';
app.use((req, res, next) => {
  const onOldHost = (req.get('host') || '').endsWith('.up.railway.app');
  const isPageLoad = req.method === 'GET' || req.method === 'HEAD';
  const isMachinePath = req.path.startsWith('/api') || req.path === '/health';
  if (onOldHost && isPageLoad && !isMachinePath) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// CORS only where something off-origin actually reads.
//
// This was `cors({ origin: true, credentials: true })` on every route, which
// reflects whatever Origin asks and permits credentials with it. The app itself
// never needed a byte of that: the PWA is served from this same origin, so its
// fetches are same-origin and CORS does not enter into it. What the header did
// was tell every other site on the internet that their scripts may read our
// responses — harmless today only because auth is a Bearer token in a header
// rather than a cookie, so a cross-site page has nothing to send. That is one
// refactor away from mattering, and it is a strange thing to be relying on.
//
// The Orbit dashboard is the one genuine cross-origin reader, so it keeps CORS
// and nothing else does. No `credentials`: Orbit authenticates with an API key
// header, which needs no cookie. Mounted by path with app.use so preflight
// OPTIONS is covered too.
const orbitCors = cors({ origin: true });
app.use('/api/orbit-summary', orbitCors);
app.use('/api/orbit', orbitCors);
// Everything below this line goes out gzipped. Nothing was compressed at all,
// so a cold load shipped ~550kb of JS and CSS uncompressed — settings.js 83kb,
// trends.js 81kb, style.css 59kb — over cellular, to a phone, on a codebase
// that is ~90% mobile. Text compresses about 4x. Mounted before the routes so
// it covers JSON bodies too, which matters most for the summary feed History
// pulls and the full-history export.
app.use(compression());
app.use(express.json({ limit: '256kb' }));

// Dashboard tile for Orbit. Two things were wrong with this: it was public, and
// it SUMMED every profile's intake into one figure — so it leaked what people
// ate to anyone who found the URL, and the number it showed stopped meaning
// anything the moment a second person logged a meal. Now behind the same key as
// /api/orbit (fails closed when unset), and it reports participation rather
// than anyone's food. Same {label, stat, status, updatedAt} shape as before.
app.get('/api/orbit-summary', orbitRoutes.requireOrbitKey, (req, res) => {
  try {
    const { getDb } = require('./src/db');
    const { todayLocal, tzFor } = require('./src/utils/tz');
    // ms.date is a LOCAL calendar day (the client sends its own localDate()).
    // date('now') is UTC, so this compared a local day against a UTC one and
    // served yesterday's totals as "Today" for the whole NZ morning.
    // And "today" is now per profile: with people in different countries there
    // is no single date that means today for all of them, so ask each profile
    // about its own.
    const db = getDb();
    const profiles = db.prepare('SELECT id FROM profiles').all();
    const loggedToday = db.prepare(`
      SELECT 1 FROM meal_sessions ms
      JOIN meal_entries me ON me.meal_session_id = ms.id
      WHERE ms.profile_id = $pid AND ms.date = $today LIMIT 1
    `);
    const total = profiles.length;
    const active = profiles.filter(p =>
      loggedToday.get({ pid: p.id, today: todayLocal(tzFor(db, p.id)) })).length;
    res.json({
      label:     'Logged today',
      stat:      total === 0 ? 'No profiles yet' : `${active} of ${total} profile${total === 1 ? '' : 's'}`,
      status:    total > 0 && active > 0 ? 'active' : 'warning',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orbit admin feed — gated on ORBIT_API_KEY, and FAILS CLOSED when it is unset
// (503, not a pass-through). This comment said "public by default" long after
// that stopped being true, which is the more dangerous direction for a comment
// about an auth gate to be wrong in: it invites the next person to add a second
// route beside it on the belief that the feed is meant to be open.
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
app.use('/api/weight', requireProfile, weightRoutes);
app.use('/api/measurements', requireProfile, measurementsRoutes);
app.use('/api/settings', requireProfile, settingsRoutes);
app.use('/api/ironlog',    requireProfile, ironlogRoutes);
app.use('/api/batches',    requireProfile, batchesRoutes);
app.use('/api/leftovers',  requireProfile, leftoversRoutes);
app.use('/api/connections', requireProfile, connectionsRoutes);
app.use('/api/presets',    requireProfile, presetsRoutes);

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

  // Sweep sessions past the 30-day TTL. requireProfile only expires a token
  // when someone presents it, so abandoned ones accumulate — production held
  // two from 2 July still sitting there on 10 August.
  const { pruneExpiredSessions } = require('./src/middleware/auth');
  const { getDb } = require('./src/db');
  const swept = pruneExpiredSessions(getDb());
  if (swept) console.log(`Pruned ${swept} expired session(s)`);

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
