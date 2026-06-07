require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists before DB init
const dataDir =
  process.env.NODE_ENV === 'production'
    ? '/data'
    : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
process.env.DATA_DIR = dataDir;

const { initDb } = require('./src/db');
const { authenticateToken } = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const foodsRoutes = require('./src/routes/foods');
const mealsRoutes = require('./src/routes/meals');
const waterRoutes = require('./src/routes/water');
const weightRoutes = require('./src/routes/weight');
const settingsRoutes   = require('./src/routes/settings');
const ironlogRoutes    = require('./src/routes/ironlog');
const templatesRoutes  = require('./src/routes/templates');
const notesRoutes      = require('./src/routes/notes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Auth routes — no token required
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/foods', authenticateToken, foodsRoutes);
app.use('/api/meals', authenticateToken, mealsRoutes);
app.use('/api/water', authenticateToken, waterRoutes);
app.use('/api/weight', authenticateToken, weightRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes);
app.use('/api/ironlog',    authenticateToken, ironlogRoutes);
app.use('/api/templates',  authenticateToken, templatesRoutes);
app.use('/api/notes',      authenticateToken, notesRoutes);

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

function start() {
  // Generate icons if missing (e.g. fresh deployment)
  const iconPath = path.join(__dirname, 'public', 'icons', 'icon-192.png');
  if (!fs.existsSync(iconPath)) {
    try { require('./scripts/gen-icons'); } catch (e) { console.warn('Icon gen skipped:', e.message); }
  }

  initDb();

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
