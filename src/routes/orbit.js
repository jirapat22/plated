const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { buildRangeReport, toMarkdown, toCsv } = require('../utils/report');
const { buildExportPayload } = require('../utils/exportPayload');
const { tzFor, isRealDate } = require('../utils/tz');
const { trendWeight } = require('../utils/macros');

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

// When food was last logged, as opposed to when the app was last touched.
//
// lastActive() counts opening the app (it reads sessions.created_at), which is
// the right signal for "is this profile still in use" and the wrong one for the
// widget's honesty line. The widget says "nothing logged since 9:04am" so that
// "740 kcal left" cannot imply room that has already been eaten — and a login
// at noon must not clear that warning without a meal behind it.
function lastLoggedAt(db, pid) {
  const row = db.prepare(`
    SELECT MAX(me.logged_at) AS t FROM meal_entries me
    JOIN meal_sessions ms ON ms.id = me.meal_session_id
    WHERE ms.profile_id = $pid
  `).get({ pid });
  return row?.t || null;
}

// Bodyweight for the widget's home-screen line. Both figures on purpose: the
// trend is what Plated's own card leads with (one weigh-in carries ~2 kg of
// water, see today.js), and the raw reading is what the person last stood on,
// so a widget can show either without this feed deciding for it. Null when
// there is nothing recent enough to average — never a stale number dressed up
// as a current one.
function weightFor(db, pid) {
  const latest = db.prepare(
    'SELECT weight_kg FROM weight_log WHERE profile_id = $pid ORDER BY date DESC, id DESC LIMIT 1'
  ).get({ pid })?.weight_kg ?? null;
  let trend = null;
  try {
    trend = trendWeight(db, pid);
  } catch { /* a feed must not fail over a garnish */ }
  const r1 = n => (n == null ? null : Math.round(n * 10) / 10);
  return { weight_kg: r1(latest), trend_weight_kg: r1(trend) };
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
        // Separate from last_active, which a login bumps — see lastLoggedAt.
        last_logged_at: lastLoggedAt(db, p.id),
        ...weightFor(db, p.id),
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

// The weekly copy lands in a git repo (orbit-vault), where anything committed
// stays in history for good. The first run shipped the profile's
// ironlog_api_key that way. The manual export keeps credentials (a restore
// needs them to reconnect IronLog); this copy drops every setting whose name
// says it's a credential, so the vault never holds a live key again.
const SECRET_SETTING = /(^|_)(api_?key|key|token|secret|password|passcode)$/i;
function withoutSecrets(payload) {
  const settings = Object.fromEntries(
    Object.entries(payload.settings || {}).filter(([k]) => !SECRET_SETTING.test(k))
  );
  return { ...payload, settings };
}

// GET /api/orbit/weekly-export?profile_id=1&from=YYYY-MM-DD&to=YYYY-MM-DD
// Weekly backup + nutrition summary for the Obsidian vault, fetched by the
// GitHub Action in jirapat22/orbit-vault every Sunday night. Same Orbit key
// gate as the rest of this router. from/to are LOCAL calendar dates (the
// caller works out Mon..Sun in the user's zone), both inclusive.
router.get('/weekly-export', (req, res) => {
  const pid = Number(req.query.profile_id);
  const { from, to } = req.query;
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'profile_id required' });
  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD with from <= to' });
  }
  try {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = $pid').get({ pid })) {
      return res.status(404).json({ error: 'no such profile' });
    }
    const report = buildRangeReport(db, pid, from, to);
    const week = String(req.query.week || '');
    // Reuse the report's own Markdown, retitled for the vault.
    const markdown = toMarkdown(report).replace(/^# Nutrition report/, `# 🥗 Plated: week ${week}`.trim());
    res.json({
      app: 'plated',
      generated_at: new Date().toISOString(),
      summary: { from, to, ...report.summary, goals: report.goals, vsGoal: report.vsGoal, adherence: report.adherence, weight: report.weight },
      markdown,
      csv: toCsv(report),
      full: withoutSecrets(buildExportPayload(db, pid)),
    });
  } catch (err) {
    console.error('weekly export error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
module.exports.requireOrbitKey = requireOrbitKey;
// bugReports.js hand-rolled its own copy of this gate; one implementation of a
// key check is enough, and this is the one that compares in constant time.
module.exports.sameKey = sameKey;
