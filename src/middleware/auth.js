const { getDb } = require('../db');

// Sessions last 30 days; after that the lock screen asks for the code again.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function requireProfile(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  try {
    const db = getDb();
    const row = db.prepare('SELECT profile_id, created_at FROM sessions WHERE token = $t').get({ t: token });
    if (!row) return res.status(401).json({ error: 'Session invalid' });

    const created = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() - created > SESSION_TTL_MS) {
      db.prepare('DELETE FROM sessions WHERE token = $t').run({ t: token });
      return res.status(401).json({ error: 'Session expired' });
    }

    req.profileId = row.profile_id;
    req.sessionToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { requireProfile, SESSION_TTL_MS };
