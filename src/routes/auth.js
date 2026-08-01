const express = require('express');
const crypto = require('crypto');
const { promisify } = require('util');
const { getDb, seedProfileDefaults, adoptOrphanData, countProfiles } = require('../db');
const { requireProfile } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// ── Passcode hashing (node:crypto scrypt — no native deps) ───────
// ASYNC scrypt, not scryptSync. Node runs one thread: scryptSync measured ~33ms
// and findProfileByCode runs it once per profile, so every wrong passcode froze
// the entire app for ~33ms × profile count. A trivial request loop against
// /login made Plated unresponsive for everyone. The callback form hands the work
// to the libuv threadpool instead, leaving the event loop free.
const scrypt = promisify(crypto.scrypt);

async function hashCode(code, salt) {
  return (await scrypt(String(code), salt, 64)).toString('hex');
}
async function verifyCode(code, salt, expectedHex) {
  const a = Buffer.from(await hashCode(code, salt), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
// Sequential rather than Promise.all: the threadpool is 4 wide by default so
// parallel hashes only queue, and each profile carries its own salt, so there's
// no way to skip the scan.
async function findProfileByCode(db, code) {
  for (const p of db.prepare('SELECT * FROM profiles').all()) {
    if (await verifyCode(code, p.pass_salt, p.pass_hash)) return p;
  }
  return null;
}

// Passcodes are 4 digits and globally unique, so the whole space is 10,000 and
// a handful of those are live — brute force was purely a matter of patience.
// Ten tries per IP per 15 minutes, then a 15-minute cooling-off; a successful
// login clears the counter, so normal use never trips it.
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, blockMs: 15 * 60_000 });
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
// Accent color is rendered unescaped into inline `style` attributes in several
// views (own profile, admin list, and — since profile connections — other
// people's screens too), so it must be a plain hex color, never free text.
const isValidColor = c => /^#[0-9a-fA-F]{6}$/.test(String(c ?? ''));

// GET /api/auth/status — public: does any profile exist yet?
router.get('/status', (req, res) => {
  try {
    res.json({ hasProfiles: countProfiles(getDb()) > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login { passcode } — public
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!isValidCode(passcode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });

    const db = getDb();
    const profile = await findProfileByCode(db, passcode);
    if (!profile) return res.status(404).json({ error: 'No profile for this code' });

    res.locals.clearRateLimit?.();   // a real login shouldn't count toward a lockout
    res.json({ token: createSession(db, profile.id), profile: publicProfile(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/profiles { name, passcode, accent_color } — public (create)
// Rate-limited too: it runs the same per-profile scrypt scan to reject a
// taken code, so it's the same DoS lever as /login if left open.
router.post('/profiles', loginLimiter, async (req, res) => {
  try {
    const { name, passcode, accent_color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (!isValidCode(passcode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });
    if (accent_color !== undefined && !isValidColor(accent_color)) {
      return res.status(400).json({ error: 'Invalid accent color' });
    }

    const db = getDb();
    if (await findProfileByCode(db, passcode)) {
      return res.status(409).json({ error: 'That code is already taken — pick another' });
    }

    const wasFirst = countProfiles(db) === 0;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashCode(passcode, salt);
    const result = db.prepare(
      'INSERT INTO profiles (name, accent_color, pass_hash, pass_salt) VALUES ($n, $c, $h, $s)'
    ).run({ n: name.trim(), c: accent_color || '#c8b8ff', h: hash, s: salt });

    const id = result.lastInsertRowid;
    seedProfileDefaults(db, id);
    if (wasFirst) {
      adoptOrphanData(db, id);                          // inherits legacy single-user data
      db.prepare('UPDATE profiles SET is_admin = 1 WHERE id = $id').run({ id }); // first profile = admin
    }

    const profile = db.prepare('SELECT * FROM profiles WHERE id = $id').get({ id });
    res.locals.clearRateLimit?.();
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
      if (!isValidColor(accent_color)) return res.status(400).json({ error: 'Invalid accent color' });
      db.prepare('UPDATE profiles SET accent_color = $c WHERE id = $id').run({ c: accent_color, id: req.profileId });
    }
    res.json(publicProfile(db.prepare('SELECT * FROM profiles WHERE id = $id').get({ id: req.profileId })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/me/passcode { newPasscode }
router.post('/me/passcode', requireProfile, async (req, res) => {
  try {
    const { newPasscode } = req.body;
    if (!isValidCode(newPasscode)) return res.status(400).json({ error: 'Passcode must be 4 digits' });

    const db = getDb();
    const others = db.prepare('SELECT * FROM profiles WHERE id != $id').all({ id: req.profileId });
    for (const p of others) {
      if (await verifyCode(newPasscode, p.pass_salt, p.pass_hash)) {
        return res.status(409).json({ error: 'That code is already taken' });
      }
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashCode(newPasscode, salt);
    db.prepare('UPDATE profiles SET pass_hash = $h, pass_salt = $s WHERE id = $id')
      .run({ h: hash, s: salt, id: req.profileId });
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
    db.prepare('DELETE FROM weight_log     WHERE profile_id = $id').run({ id });
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
