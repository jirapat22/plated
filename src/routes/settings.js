const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'water_goal_ml', 'ironlog_api_url', 'ironlog_api_key', 'protein_multiplier',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit', 'ironlog_last_synced',
  'target_weight_kg',
]);

function allSettings(db, pid) {
  const rows = db.prepare(
    'SELECT key, value FROM profile_settings WHERE profile_id = $pid'
  ).all({ pid });
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

router.get('/', (req, res) => {
  try {
    res.json(allSettings(getDb(), req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/', (req, res) => {
  try {
    const db = getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)'
    );
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED.has(key)) stmt.run({ pid: req.profileId, key, value: String(value) });
    }
    res.json(allSettings(db, req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test IronLog connection (this profile's URL)
router.get('/ironlog/test', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT value FROM profile_settings WHERE profile_id = $pid AND key = 'ironlog_api_url'"
    ).get({ pid: req.profileId });
    const url = row?.value?.trim();
    if (!url) return res.status(400).json({ error: 'IronLog URL not configured' });

    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Delete this profile's logged data (meals, water, weight, templates) — keeps foods + settings
router.delete('/data', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM meal_sessions  WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM water_log      WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM weight_log     WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM meal_templates WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM daily_overrides WHERE profile_id = $pid').run({ pid });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
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
      WHERE ms.profile_id = $pid
      ORDER BY ms.date ASC, ms.meal_index ASC, me.logged_at ASC
    `).all({ pid: req.profileId });

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
    const pid = req.profileId;
    const payload = {
      exported_at: new Date().toISOString(),
      foods:         db.prepare('SELECT * FROM foods').all(),
      meal_sessions: db.prepare('SELECT * FROM meal_sessions WHERE profile_id = $pid').all({ pid }),
      meal_entries:  db.prepare(`
        SELECT me.* FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
      `).all({ pid }),
      water_log:     db.prepare('SELECT * FROM water_log WHERE profile_id = $pid').all({ pid }),
      weight_log:    db.prepare('SELECT * FROM weight_log WHERE profile_id = $pid').all({ pid }),
      settings:      allSettings(db, pid),
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
