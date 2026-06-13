const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'water_goal_ml', 'ironlog_api_url', 'ironlog_api_key', 'protein_multiplier',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit', 'ironlog_last_synced',
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

// Delete all logged data (meals, water, weight, templates) — keeps foods + settings
router.delete('/data', (req, res) => {
  try {
    const db = getDb();
    db.exec(`
      DELETE FROM meal_sessions;
      DELETE FROM water_log;
      DELETE FROM weight_log;
      DELETE FROM meal_templates;
      DELETE FROM daily_overrides;
    `);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export meals as CSV
router.get('/export-csv', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT ms.date, ms.name AS meal_name,
             f.name AS food_name, me.quantity_g,
             me.calories, me.protein, me.carbs, me.fat, me.fiber
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      JOIN foods f ON f.id = me.food_id
      ORDER BY ms.date ASC, ms.meal_index ASC, me.logged_at ASC
    `).all();

    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [
      'Date,Meal,Food,Quantity (g),Calories (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g)',
      ...rows.map(r => [
        r.date, esc(r.meal_name), esc(r.food_name),
        r.quantity_g ?? '', r.calories ?? '', r.protein ?? '',
        r.carbs ?? '', r.fat ?? '', r.fiber ?? '',
      ].join(',')),
    ];

    const filename = `plated-meals-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
