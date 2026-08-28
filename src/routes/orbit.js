const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { tzFor } = require('../utils/tz');

const router = express.Router();

// Orbit polls this on its own schedule with no per-request notion of the
// user's timezone, so "today" has to be pinned to a fixed zone rather than
// the server's UTC day — new Date().toISOString() alone would show NZ users
// yesterday's totals as "today" for roughly half of every day. Intl handles
// NZST/NZDT DST transitions correctly, unlike a fixed UTC+12/+13 offset.
// Override with ORBIT_TZ if this is ever run for a non-NZ user.
// Only the FALLBACK now, for a profile that has no timezone of its own. Each
// profile's rows are read in that profile's zone — this file was missed when
// timezones went per-profile, and it was the one place left asserting that
// everybody lives in New Zealand. One profile is in Asia/Bangkok, five hours
// behind: for those five hours every day the feed labelled her rows with the NZ
// date, so her "today" read 0 while her real today was still filed under the
// day the feed was calling yesterday.
const ORBIT_TZ = process.env.ORBIT_TZ?.trim() || 'Pacific/Auckland';
const isoInTz = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);

// Admin feed for the Orbit dashboard: every profile's name, goals, and today's
// and yesterday's intake. Requires ORBIT_API_KEY as `X-API-Key` or Bearer.
//
// Fails CLOSED when the variable is missing. It used to `return next()` in that
// case, so a deploy that forgot the variable published all of the above to
// anyone who found the URL, silently and with nothing to notice.
// Exported so /api/orbit-summary in server.js uses this exact function rather
// than a second copy that can drift. It shipped with no gate at all and served
// every profile's calories and protein, summed, to anyone who found the URL.
function requireOrbitKey(req, res, next) {
  const required = process.env.ORBIT_API_KEY?.trim();
  if (!required) {
    return res.status(503).json({ error: 'Orbit feed is not configured (ORBIT_API_KEY unset)' });
  }
  const auth = req.headers['authorization'];
  const key = req.headers['x-api-key']
    || (auth?.startsWith('Bearer ') ? auth.slice(7) : null);
  if (sameKey(key, required)) return next();
  return res.status(401).json({ error: 'invalid or missing Orbit key' });
}

// Constant-time compare. `===` on strings short-circuits at the first differing
// byte, so response time leaks how much of the key a guess got right and the
// secret can be walked out one character at a time. auth.js already does this
// properly for passcodes (timingSafeEqual in verifyCode); the two API-key gates
// were the pair still using a plain comparison. Lengths are compared first
// because timingSafeEqual throws on a mismatch — that leaks the length, which
// is a far cheaper thing to give away than the bytes.
function sameKey(given, required) {
  const a = Buffer.from(String(given ?? '').trim());
  const b = Buffer.from(required);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
router.use(requireOrbitKey);

function dayTotals(db, pid, date) {
  const t = db.prepare(`
    SELECT COALESCE(SUM(me.calories), 0) AS calories,
           COALESCE(SUM(me.protein),  0) AS protein,
           COALESCE(SUM(me.carbs),    0) AS carbs,
           COALESCE(SUM(me.fat),      0) AS fat
    FROM meal_sessions ms
    JOIN meal_entries me ON me.meal_session_id = ms.id
    WHERE ms.profile_id = $pid AND ms.date = $date
  `).get({ pid, date });
  return {
    calories: Math.round(t.calories),
    protein:  Math.round(t.protein),
    carbs:    Math.round(t.carbs),
    fat:      Math.round(t.fat),
  };
}

function lastActive(db, pid) {
  const row = db.prepare(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(created_at) AS t FROM sessions WHERE profile_id = $pid
      UNION ALL
      SELECT MAX(me.logged_at) FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id WHERE ms.profile_id = $pid
      UNION ALL
      SELECT MAX(logged_at) FROM weight_log WHERE profile_id = $pid
    )
  `).get({ pid });
  return row?.t || null;
}

// GET /api/orbit — admin overview of every Plated profile
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const now = Date.now();

    const profiles = db.prepare(
      'SELECT id, name, accent_color, created_at FROM profiles ORDER BY id ASC'
    ).all();

    const getGoals = db.prepare(`
      SELECT key, value FROM profile_settings
      WHERE profile_id = $pid AND key IN ('calorie_goal','protein_goal','carb_goal','fat_goal')
    `);

    const users = profiles.map(p => {
      const goalsRows = getGoals.all({ pid: p.id });
      const g = Object.fromEntries(goalsRows.map(r => [r.key, parseFloat(r.value) || null]));
      // This profile's own day boundary, not the server's and not NZ's.
      const tz        = tzFor(db, p.id);
      const today     = isoInTz(new Date(now), tz);
      const yesterday = isoInTz(new Date(now - 864e5), tz);
      return {
        id:           p.id,
        name:         p.name,
        accent_color: p.accent_color,
        created_at:   p.created_at,
        last_active:  lastActive(db, p.id),
        goals: {
          calories: g.calorie_goal ?? null,
          protein:  g.protein_goal ?? null,
          carbs:    g.carb_goal    ?? null,
          fat:      g.fat_goal     ?? null,
        },
        timezone:  tz,
        today:     { date: today,     ...dayTotals(db, p.id, today) },
        yesterday: { date: yesterday, ...dayTotals(db, p.id, yesterday) },
      };
    });

    res.json({
      app:          'plated',
      generated_at: new Date().toISOString(),
      user_count:   users.length,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.requireOrbitKey = requireOrbitKey;
// bugReports.js hand-rolled its own copy of this gate; one implementation of a
// key check is enough, and this is the one that compares in constant time.
module.exports.sameKey = sameKey;
