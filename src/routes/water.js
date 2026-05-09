const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

function dayData(db, date) {
  const entries = db.prepare(
    'SELECT * FROM water_log WHERE date = $date ORDER BY logged_at ASC'
  ).all({ date });
  const total_ml = entries.reduce((s, r) => s + r.amount_ml, 0);
  return { date, entries, total_ml };
}

router.get('/today', (req, res) => {
  try {
    const date = new Date().toISOString().split('T')[0];
    res.json(dayData(getDb(), date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/day/:date', (req, res) => {
  try {
    res.json(dayData(getDb(), req.params.date));
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
      'INSERT INTO water_log (date, amount_ml) VALUES ($date, $amount_ml)'
    ).run({ date: logDate, amount_ml });
    const entry = db.prepare('SELECT * FROM water_log WHERE id = $id')
      .get({ id: result.lastInsertRowid });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM water_log WHERE id = $id')
      .run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
