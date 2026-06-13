const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// Admin feed for the Orbit dashboard. Open by default (single-admin use); set
// ORBIT_API_KEY in the environment to require `X-API-Key` / Bearer once you want
// to lock it down — no code change needed.
router.use((req, res, next) => {
  const required = process.env.ORBIT_API_KEY?.trim();
  if (!required) return next();
  const auth = req.headers['authorization'];
  const key = req.headers['x-api-key']
    || (auth?.startsWith('Bearer ') ? auth.slice(7) : null);
  if (key?.trim() === required) return next();
  return res.status(401).json({ error: 'invalid or missing Orbit key' });
});

function dayTotals(db, pid, date) {
  const t = db.prepare(`
    SELECT COALESCE(SUM(me.calories), 0) AS calories,
           COALESCE(SUM(me.protein),  0) AS protein,
           COALESCE(SUM(me.carbs),    0) AS carbs,
           COALESCE(SUM(me.fat),      0) AS fat
    FROM meal_sessions ms
    JOIN meal_entries me ON me.meal_session_id = ms.id
    WHERE ms.profile_id = $pid AND ms.date = $date
  `).get({ pid, date });
  return {
    calories: Math.round(t.calories),
    protein:  Math.round(t.protein),
    carbs:    Math.round(t.carbs),
    fat:      Math.round(t.fat),
  };
}

function lastActive(db, pid) {
  const row = db.prepare(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(created_at) AS t FROM sessions WHERE profile_id = $pid
      UNION ALL
      SELECT MAX(me.logged_at) FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id WHERE ms.profile_id = $pid
      UNION ALL
      SELECT MAX(logged_at) FROM water_log  WHERE profile_id = $pid
      UNION ALL
      SELECT MAX(logged_at) FROM weight_log WHERE profile_id = $pid
    )
  `).get({ pid });
  return row?.t || null;
}

// GET /api/orbit — admin overview of every Plated profile
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 864e5).toISOString().split('T')[0];

    const profiles = db.prepare(
      'SELECT id, name, accent_color, created_at FROM profiles ORDER BY id ASC'
    ).all();

    const getGoals = db.prepare(`
      SELECT key, value FROM profile_settings
      WHERE profile_id = $pid AND key IN ('calorie_goal','protein_goal','carb_goal','fat_goal')
    `);

    const users = profiles.map(p => {
      const goalsRows = getGoals.all({ pid: p.id });
      const g = Object.fromEntries(goalsRows.map(r => [r.key, parseFloat(r.value) || null]));
      return {
        id:           p.id,
        name:         p.name,
        accent_color: p.accent_color,
        created_at:   p.created_at,
        last_active:  lastActive(db, p.id),
        goals: {
          calories: g.calorie_goal ?? null,
          protein:  g.protein_goal ?? null,
          carbs:    g.carb_goal    ?? null,
          fat:      g.fat_goal     ?? null,
        },
        today:     { date: today,     ...dayTotals(db, p.id, today) },
        yesterday: { date: yesterday, ...dayTotals(db, p.id, yesterday) },
      };
    });

    res.json({
      app:          'plated',
      generated_at: new Date().toISOString(),
      user_count:   users.length,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
