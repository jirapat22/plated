const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'water_goal_ml', 'ironlog_api_url', 'protein_multiplier',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit',
]);

function allSettings(db) {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key != 'passcode_hash'"
  ).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

router.get('/', (req, res) => {
  try {
    res.json(allSettings(getDb()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/', (req, res) => {
  try {
    const db = getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)'
    );
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED.has(key)) stmt.run({ key, value: String(value) });
    }
    res.json(allSettings(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test IronLog connection
router.get('/ironlog/test', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ironlog_api_url'").get();
    const url = row?.value?.trim();
    if (!url) return res.status(400).json({ error: 'IronLog URL not configured' });

    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Export all data as JSON
router.get('/export', (req, res) => {
  try {
    const db = getDb();
    const payload = {
      exported_at: new Date().toISOString(),
      foods:         db.prepare('SELECT * FROM foods').all(),
      meal_sessions: db.prepare('SELECT * FROM meal_sessions').all(),
      meal_entries:  db.prepare('SELECT * FROM meal_entries').all(),
      water_log:     db.prepare('SELECT * FROM water_log').all(),
      weight_log:    db.prepare('SELECT * FROM weight_log').all(),
      settings:      allSettings(db),
    };
    const filename = `plated-export-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
