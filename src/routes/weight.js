const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// Fire-and-forget push of a manual weigh-in to IronLog (two-way sync).
// IronLog must expose POST /api/plated/bodyweight; until then this no-ops.
async function pushBodyweight(db, pid, date, weight_kg) {
  try {
    const get = k => db.prepare('SELECT value FROM profile_settings WHERE profile_id = $p AND key = $k')
      .get({ p: pid, k })?.value?.trim();
    const url = get('ironlog_api_url');
    const key = get('ironlog_api_key');
    if (!url || !key) return;
    await fetch(`${url.replace(/\/$/, '')}/api/plated/bodyweight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ date, weight_kg }),
      signal: AbortSignal.timeout(6000),
    });
  } catch { /* IronLog may not support POST yet — ignore */ }
}

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
      "INSERT INTO weight_log (date, weight_kg, note, profile_id, source) VALUES ($date, $weight_kg, $note, $pid, 'manual')"
    ).run({ date: logDate, weight_kg, note: note || null, pid: req.profileId });
    const entry = db.prepare('SELECT * FROM weight_log WHERE id = $id')
      .get({ id: result.lastInsertRowid });

    pushBodyweight(db, req.profileId, logDate, weight_kg);  // sync up to IronLog (best-effort)
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

// PATCH /api/weight/:id — correct a weigh-in's value (date stays put)
router.patch('/:id', (req, res) => {
  try {
    const weight_kg = parseFloat(req.body.weight_kg);
    if (!weight_kg || weight_kg <= 0) {
      return res.status(400).json({ error: 'weight_kg must be > 0' });
    }
    const db = getDb();
    const result = db.prepare(
      'UPDATE weight_log SET weight_kg = $w WHERE id = $id AND profile_id = $pid'
    ).run({ w: weight_kg, id: req.params.id, pid: req.profileId });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    const entry = db.prepare('SELECT * FROM weight_log WHERE id = $id').get({ id: req.params.id });
    pushBodyweight(db, req.profileId, entry.date, weight_kg);  // keep IronLog in sync (best-effort)
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
