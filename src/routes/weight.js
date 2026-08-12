const express = require('express');
const { getDb } = require('../db');
const { todayLocal, tzFor } = require('../utils/tz');
const { recalcMacroGoals } = require('../utils/macros');
const { snapshotGoals } = require('../utils/goals');

const router = express.Router();

// 20–400 kg. The measurements route already guards its input this way ("catch
// inches typed into a cm field"); weight never got the same treatment despite
// being the more expensive mistake — it feeds recalcMacroGoals, so entering 700
// for 70.0 silently rewrote the protein goal to ~1540 g and nothing on screen
// explained where that came from. Can't catch lb-typed-as-kg (300 lb reads as a
// legitimate 300) — only the decimal slips, which are the common ones.
function badWeight(v) {
  const w = parseFloat(v);
  return Number.isFinite(w) && w >= 20 && w <= 400
    ? null
    : 'Weight must be between 20 and 400 kg — check the decimal point';
}

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
    // Ceiling raised from 365 so Trends' "All" range can plot a weight history
    // longer than a year alongside the now-unbounded meal summary.
    const limit = Math.min(parseInt(req.query.limit) || 30, 5000);
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
    const bad = badWeight(weight_kg);
    if (bad) return res.status(400).json({ error: bad });
    // Every other write route format-checks its date; this one took whatever it
    // was given, so a junk string became a weight_log row that no date-keyed
    // read could ever match again.
    if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const db = getDb();
    const logDate = date || todayLocal(tzFor(db, req.profileId));
    const result = db.prepare(
      "INSERT INTO weight_log (date, weight_kg, note, profile_id, source) VALUES ($date, $weight_kg, $note, $pid, 'manual')"
    ).run({ date: logDate, weight_kg, note: note || null, pid: req.profileId });
    const entry = db.prepare('SELECT * FROM weight_log WHERE id = $id')
      .get({ id: result.lastInsertRowid });

    pushBodyweight(db, req.profileId, logDate, weight_kg);  // sync up to IronLog (best-effort)
    const macros = recalcMacroGoals(db, req.profileId);     // g/kg goals follow the trend
    // In g/kg mode a weigh-in moves the macro goals, so it is a goal change.
    snapshotGoals(db, req.profileId, todayLocal(tzFor(db, req.profileId)));
    res.status(201).json(macros ? { ...entry, macros } : entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const result = db
      .prepare('DELETE FROM weight_log WHERE id = $id AND profile_id = $pid')
      .run({ id: req.params.id, pid: req.profileId });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    recalcMacroGoals(db, req.profileId);   // removing a weigh-in moves the trend too
    snapshotGoals(db, req.profileId, todayLocal(tzFor(db, req.profileId)));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/weight/:id — correct a weigh-in's value (date stays put)
router.patch('/:id', (req, res) => {
  try {
    const weight_kg = parseFloat(req.body.weight_kg);
    const bad = badWeight(weight_kg);
    if (bad) return res.status(400).json({ error: bad });
    const db = getDb();
    const result = db.prepare(
      'UPDATE weight_log SET weight_kg = $w WHERE id = $id AND profile_id = $pid'
    ).run({ w: weight_kg, id: req.params.id, pid: req.profileId });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    const entry = db.prepare('SELECT * FROM weight_log WHERE id = $id').get({ id: req.params.id });
    pushBodyweight(db, req.profileId, entry.date, weight_kg);  // keep IronLog in sync (best-effort)
    const macros = recalcMacroGoals(db, req.profileId);
    snapshotGoals(db, req.profileId, todayLocal(tzFor(db, req.profileId)));
    res.json(macros ? { ...entry, macros } : entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
