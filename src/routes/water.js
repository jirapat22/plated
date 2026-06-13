const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

function dayData(db, date, pid) {
  const entries = db.prepare(
    'SELECT * FROM water_log WHERE date = $date AND profile_id = $pid ORDER BY logged_at ASC'
  ).all({ date, pid });
  const total_ml = entries.reduce((s, r) => s + r.amount_ml, 0);
  const override = db.prepare(
    "SELECT value FROM daily_overrides WHERE profile_id = $pid AND date = $date AND key = 'water_goal_ml'"
  ).get({ date, pid });
  const setting = db.prepare(
    "SELECT value FROM profile_settings WHERE profile_id = $pid AND key = 'water_goal_ml'"
  ).get({ pid });
  const goal_ml = parseInt(override?.value || setting?.value || 2500);
  return { date, entries, total_ml, goal_ml };
}

router.get('/today', (req, res) => {
  try {
    const date = new Date().toISOString().split('T')[0];
    res.json(dayData(getDb(), date, req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/day/:date', (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    res.json(dayData(getDb(), req.params.date, req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { amount_ml, date } = req.body;
    if (!amount_ml || amount_ml <= 0) {
      return res.status(400).json({ error: 'amount_ml must be > 0' });
    }
    const db = getDb();
    const logDate = date || new Date().toISOString().split('T')[0];
    const result = db.prepare(
      'INSERT INTO water_log (date, amount_ml, profile_id) VALUES ($date, $amount_ml, $pid)'
    ).run({ date: logDate, amount_ml, pid: req.profileId });
    const entry = db.prepare('SELECT * FROM water_log WHERE id = $id')
      .get({ id: result.lastInsertRowid });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/goal/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const { goal_ml } = req.body;
    if (!goal_ml || goal_ml < 100) return res.status(400).json({ error: 'goal_ml must be >= 100' });
    getDb().prepare(
      "INSERT OR REPLACE INTO daily_overrides (profile_id, date, key, value) VALUES ($pid, $date, 'water_goal_ml', $value)"
    ).run({ pid: req.profileId, date, value: String(goal_ml) });
    res.json({ date, goal_ml: parseInt(goal_ml) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM water_log WHERE id = $id AND profile_id = $pid')
      .run({ id: req.params.id, pid: req.profileId });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
