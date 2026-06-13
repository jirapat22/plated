const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 365);
    const rows = getDb().prepare(
      'SELECT * FROM weight_log WHERE profile_id = $pid ORDER BY date DESC LIMIT $limit'
    ).all({ limit, pid: req.profileId });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/day/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const row = getDb().prepare(
      'SELECT * FROM weight_log WHERE date = $date AND profile_id = $pid ORDER BY logged_at DESC LIMIT 1'
    ).get({ date, pid: req.profileId });
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { weight_kg, note, date } = req.body;
    if (!weight_kg || weight_kg <= 0) {
      return res.status(400).json({ error: 'weight_kg must be > 0' });
    }
    const db = getDb();
    const logDate = date || new Date().toISOString().split('T')[0];
    const result = db.prepare(
      'INSERT INTO weight_log (date, weight_kg, note, profile_id) VALUES ($date, $weight_kg, $note, $pid)'
    ).run({ date: logDate, weight_kg, note: note || null, pid: req.profileId });
    const entry = db.prepare('SELECT * FROM weight_log WHERE id = $id')
      .get({ id: result.lastInsertRowid });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM weight_log WHERE id = $id AND profile_id = $pid')
      .run({ id: req.params.id, pid: req.profileId });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
