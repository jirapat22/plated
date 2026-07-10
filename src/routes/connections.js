const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');

const router = express.Router();

// Unambiguous alphabet — no 0/O or 1/I — so a code read aloud or texted
// doesn't get mistyped. 8 chars keeps guessing impractical (32^8 space)
// while still being nameable/type-able by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function publicProfile(p) {
  return { id: p.id, name: p.name, accent_color: p.accent_color };
}

// GET /api/connections/code — my current connect code (generated on first ask)
router.get('/code', (req, res) => {
  try {
    const db = getDb();
    let profile = db.prepare('SELECT connect_code FROM profiles WHERE id = $id').get({ id: req.profileId });
    if (!profile.connect_code) {
      const code = genCode();
      db.prepare('UPDATE profiles SET connect_code = $c WHERE id = $id').run({ c: code, id: req.profileId });
      profile = { connect_code: code };
    }
    res.json({ connect_code: profile.connect_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/code/regenerate — invalidate the old code (doesn't
// affect connections already made with it)
router.post('/code/regenerate', (req, res) => {
  try {
    const db = getDb();
    const code = genCode();
    db.prepare('UPDATE profiles SET connect_code = $c WHERE id = $id').run({ c: code, id: req.profileId });
    res.json({ connect_code: code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/connections — profiles I'm connected to
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const rows = db.prepare(`
      SELECT p.id, p.name, p.accent_color FROM profile_connections pc
      JOIN profiles p ON p.id = (CASE WHEN pc.profile_a_id = $pid THEN pc.profile_b_id ELSE pc.profile_a_id END)
      WHERE pc.profile_a_id = $pid OR pc.profile_b_id = $pid
      ORDER BY p.name ASC
    `).all({ pid });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections { code } — connect using someone else's code
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code required' });

    const target = db.prepare('SELECT * FROM profiles WHERE connect_code = $c').get({ c: code });
    if (!target) return res.status(404).json({ error: 'No profile matches that code' });
    if (target.id === pid) return res.status(400).json({ error: "That's your own code" });

    const existing = db.prepare(`
      SELECT 1 FROM profile_connections
      WHERE (profile_a_id = $a AND profile_b_id = $b) OR (profile_a_id = $b AND profile_b_id = $a)
    `).get({ a: pid, b: target.id });
    if (existing) return res.status(409).json({ error: `Already connected to ${target.name}` });

    db.prepare('INSERT INTO profile_connections (profile_a_id, profile_b_id) VALUES ($a, $b)')
      .run({ a: pid, b: target.id });
    res.status(201).json(publicProfile(target));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/connections/:profileId — disconnect (either side can do this)
router.delete('/:profileId', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const otherId = parseInt(req.params.profileId);
    const result = db.prepare(`
      DELETE FROM profile_connections
      WHERE (profile_a_id = $a AND profile_b_id = $b) OR (profile_a_id = $b AND profile_b_id = $a)
    `).run({ a: pid, b: otherId });
    if (result.changes === 0) return res.status(404).json({ error: 'Not connected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
