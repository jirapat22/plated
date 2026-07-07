const express = require('express');
const crypto = require('crypto');
const { getDb, seedProfileDefaults, adoptOrphanData, countProfiles } = require('../db');
const { requireProfile } = require('../middleware/auth');

const router = express.Router();

// ── Passcode hashing (node:crypto scrypt — no native deps) ───────
function hashCode(code, salt) {
  return crypto.scryptSync(String(code), salt, 64).toString('hex');
}
function verifyCode(code, salt, expectedHex) {
  const a = Buffer.from(hashCode(code, salt), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function findProfileByCode(db, code) {
  return db.prepare('SELECT * FROM profiles').all()
    .find(p => verifyCode(code, p.pass_salt, p.pass_hash)) || null;
}
function publicProfile(p) {
  return { id: p.id, name: p.name, accent_color: p.accent_color, is_admin: !!p.is_admin };
}
function isAdmin(db, profileId) {
  return !!db.prepare('SELECT is_admin FROM profiles WHERE id = $id').get({ id: profileId })?.is_admin;
}
function createSession(db, profileId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, profile_id) VALUES ($t, $p)').run({ t: token, p: profileId });
  return token;
}
const isValidCode = c => /^\d{4}$/.test(String(c ?? ''));

// GET /api/auth/status — public: does any profile exist yet?
router.get('/status', (req, res) => {
  try {
    res.json({ hasProfiles: countProfiles(getDb()) > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login { passcode } — public
router.post('/login', (req, res) => {
  try {
    const { passcode } = req.body;
    if (!isValidCode(passcode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });

    const db = getDb();
    const profile = findProfileByCode(db, passcode);
    if (!profile) return res.status(404).json({ error: 'No profile for this code' });

    res.json({ token: createSession(db, profile.id), profile: publicProfile(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/profiles { name, passcode, accent_color } — public (create)
router.post('/profiles', (req, res) => {
  try {
    const { name, passcode, accent_color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (!isValidCode(passcode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });

    const db = getDb();
    if (findProfileByCode(db, passcode)) {
      return res.status(409).json({ error: 'That code is already taken — pick another' });
    }

    const wasFirst = countProfiles(db) === 0;
    const salt = crypto.randomBytes(16).toString('hex');
    const result = db.prepare(
      'INSERT INTO profiles (name, accent_color, pass_hash, pass_salt) VALUES ($n, $c, $h, $s)'
    ).run({ n: name.trim(), c: accent_color || '#c8b8ff', h: hashCode(passcode, salt), s: salt });

    const id = result.lastInsertRowid;
    seedProfileDefaults(db, id);
    if (wasFirst) {
      adoptOrphanData(db, id);                          // inherits legacy single-user data
      db.prepare('UPDATE profiles SET is_admin = 1 WHERE id = $id').run({ id }); // first profile = admin
    }

    const profile = db.prepare('SELECT * FROM profiles WHERE id = $id').get({ id });
    res.status(201).json({ token: createSession(db, id), profile: publicProfile(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireProfile, (req, res) => {
  try {
    const p = getDb().prepare('SELECT * FROM profiles WHERE id = $id').get({ id: req.profileId });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    res.json(publicProfile(p));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auth/me { name?, accent_color? }
router.patch('/me', requireProfile, (req, res) => {
  try {
    const db = getDb();
    const { name, accent_color } = req.body;
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      db.prepare('UPDATE profiles SET name = $n WHERE id = $id').run({ n: name.trim(), id: req.profileId });
    }
    if (accent_color !== undefined) {
      db.prepare('UPDATE profiles SET accent_color = $c WHERE id = $id').run({ c: accent_color, id: req.profileId });
    }
    res.json(publicProfile(db.prepare('SELECT * FROM profiles WHERE id = $id').get({ id: req.profileId })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/me/passcode { newPasscode }
router.post('/me/passcode', requireProfile, (req, res) => {
  try {
    const { newPasscode } = req.body;
    if (!isValidCode(newPasscode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });

    const db = getDb();
    const others = db.prepare('SELECT * FROM profiles WHERE id != $id').all({ id: req.profileId });
    if (others.some(p => verifyCode(newPasscode, p.pass_salt, p.pass_hash))) {
      return res.status(409).json({ error: 'That code is already taken' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE profiles SET pass_hash = $h, pass_salt = $s WHERE id = $id')
      .run({ h: hashCode(newPasscode, salt), s: salt, id: req.profileId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout — ends the current session on this device
router.post('/logout', requireProfile, (req, res) => {
  try {
    getDb().prepare('DELETE FROM sessions WHERE token = $t').run({ t: req.sessionToken });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/me — delete this profile and all of its data
router.delete('/me', requireProfile, (req, res) => {
  const db = getDb();
  const id = req.profileId;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM meal_sessions  WHERE profile_id = $id').run({ id }); // cascades entries
    db.prepare('DELETE FROM water_log      WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM weight_log     WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM meal_templates WHERE profile_id = $id').run({ id }); // cascades items
    // Batches aren't cascade-deleted with the profile — hide their backing
    // foods first (same treatment as the single-batch DELETE route) so they
    // don't linger visible in search/Custom after the profile is gone.
    db.prepare(`UPDATE foods SET hidden = 1 WHERE id IN
      (SELECT food_id FROM batches WHERE profile_id = $id AND food_id IS NOT NULL)`).run({ id });
    db.prepare('DELETE FROM batches WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM daily_overrides   WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM profile_settings  WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM profile_food_stats WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM sessions WHERE profile_id = $id').run({ id });
    db.prepare('DELETE FROM profiles WHERE id = $id').run({ id });
    db.exec('COMMIT');
    res.json({ success: true });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: manage who is admin ───────────────────────────────────
// GET /api/auth/admin/profiles — list all profiles (admin only)
router.get('/admin/profiles', requireProfile, (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(db, req.profileId)) return res.status(403).json({ error: 'Admin only' });
    const rows = db.prepare('SELECT id, name, accent_color, is_admin FROM profiles ORDER BY id ASC').all();
    res.json(rows.map(r => ({ ...r, is_admin: !!r.is_admin })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin/set { profileId, is_admin } — grant/revoke admin (admin only)
router.post('/admin/set', requireProfile, (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(db, req.profileId)) return res.status(403).json({ error: 'Admin only' });

    const { profileId, is_admin } = req.body;
    const target = db.prepare('SELECT id FROM profiles WHERE id = $id').get({ id: profileId });
    if (!target) return res.status(404).json({ error: 'Profile not found' });

    // Don't allow removing the last admin
    if (!is_admin) {
      const admins = db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE is_admin = 1').get().c;
      if (admins <= 1 && isAdmin(db, profileId)) {
        return res.status(400).json({ error: 'At least one admin is required' });
      }
    }
    db.prepare('UPDATE profiles SET is_admin = $v WHERE id = $id').run({ v: is_admin ? 1 : 0, id: profileId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
