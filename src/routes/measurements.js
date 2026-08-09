const express = require('express');
const { getDb } = require('../db');
const { todayLocal, tzFor } = require('../utils/tz');

const router = express.Router();

// Waist circumference at the navel. One row per profile per day — measuring
// twice in a day replaces rather than appends, same as a weigh-in should.
// ponytail: waist only. Chest/arms/thighs are a table shape away if ever asked
// for; adding columns nobody fills in is how tracking apps become chores.

// GET /api/measurements?limit=90 — newest first
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 180, 5000);
    res.json(getDb().prepare(
      'SELECT date, waist_cm FROM measurements WHERE profile_id = $pid ORDER BY date DESC LIMIT $limit'
    ).all({ pid: req.profileId, limit }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/measurements { waist_cm, date? }
router.post('/', (req, res) => {
  try {
    const waist = parseFloat(req.body?.waist_cm);
    // 40–200cm. Wide enough for any real body, tight enough to catch inches
    // typed into a cm field (a 32in waist entered raw would read as 32cm).
    if (!(waist >= 40 && waist <= 200)) {
      return res.status(400).json({ error: 'Waist must be between 40 and 200 cm' });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : todayLocal(tzFor(getDb(), req.profileId));
    getDb().prepare(`
      INSERT INTO measurements (profile_id, date, waist_cm) VALUES ($pid, $d, $w)
      ON CONFLICT(profile_id, date) DO UPDATE SET waist_cm = excluded.waist_cm,
                                                  logged_at = datetime('now')
    `).run({ pid: req.profileId, d: date, w: Math.round(waist * 10) / 10 });
    res.status(201).json({ date, waist_cm: Math.round(waist * 10) / 10 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/measurements/:date
router.delete('/:date', (req, res) => {
  try {
    const info = getDb().prepare('DELETE FROM measurements WHERE profile_id = $pid AND date = $d')
      .run({ pid: req.profileId, d: req.params.date });
    if (!info.changes) return res.status(404).json({ error: 'No measurement on that date' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
