const { getDb } = require('../db');

// Sessions last 30 days; after that the lock screen asks for the code again.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// How stale last_seen has to be before we write it again. Every authenticated
// request passes through here, and Today alone fires four or five — writing on
// each would put a disk write on the hot path of every screen for a field
// nobody reads at that resolution. Five minutes is finer than the UI's own
// "active now / 3 days ago" wording.
// ponytail: coarse timestamp, no separate activity table. If per-request
// history is ever wanted, that's a new table, not a finer clock here.
const TOUCH_INTERVAL_MS = 5 * 60_000;

function touchSession(db, token, row, ip) {
  const seen = row.last_seen || row.created_at;
  const age = seen ? Date.now() - new Date(String(seen).replace(' ', 'T') + 'Z').getTime() : Infinity;
  // A moved IP is worth recording immediately — it's the signal that a session
  // is being used from somewhere new, which is the whole point of the feature.
  if (age < TOUCH_INTERVAL_MS && row.ip === ip) return;
  try {
    db.prepare("UPDATE sessions SET last_seen = datetime('now'), ip = $ip WHERE token = $t")
      .run({ ip: ip || null, t: token });
  } catch { /* never fail a request over bookkeeping */ }
}

function requireProfile(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  try {
    const db = getDb();
    const row = db.prepare('SELECT profile_id, created_at, last_seen, ip FROM sessions WHERE token = $t').get({ t: token });
    if (!row) return res.status(401).json({ error: 'Session invalid' });

    const created = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() - created > SESSION_TTL_MS) {
      db.prepare('DELETE FROM sessions WHERE token = $t').run({ t: token });
      return res.status(401).json({ error: 'Session expired' });
    }

    touchSession(db, token, row, req.ip);

    req.profileId = row.profile_id;
    req.sessionToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Expired rows are otherwise only deleted when their token is USED — so a
// session nobody ever returns to sits in the table forever. Inert until the
// device list shipped, which listed every row for a profile and therefore
// showed long-dead sessions as signed-in devices: production had two from 2
// July still listed on 10 August, 9 days past the 30-day TTL. That is exactly
// the wrong answer from a feature built to tell you who is signed in.
// created_at is 'YYYY-MM-DD HH:MM:SS' UTC, so a string compare in the same
// shape orders correctly.
function pruneExpiredSessions(db, profileId = null) {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
  try {
    return profileId == null
      ? db.prepare('DELETE FROM sessions WHERE created_at < $c').run({ c: cutoff }).changes
      : db.prepare('DELETE FROM sessions WHERE created_at < $c AND profile_id = $p')
          .run({ c: cutoff, p: profileId }).changes;
  } catch { return 0; }
}

module.exports = { requireProfile, pruneExpiredSessions, SESSION_TTL_MS };
