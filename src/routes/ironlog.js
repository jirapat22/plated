const express = require('express');
const { getDb } = require('../db');
const { todayLocal, localDayOf, tzFor } = require('../utils/tz');
const { recalcMacroGoals } = require('../utils/macros');
const { snapshotGoals } = require('../utils/goals');

// Extract all goals from IronLog profile data
function extractProfile(profileData) {
  if (!profileData) return {};
  return {
    tdee:         profileData.tdee_kcal        ?? profileData.tdee             ?? profileData.maintenance_calories ?? profileData.total_daily_energy ?? null,
    bodyweight:   profileData.bodyweight_kg     ?? profileData.weight_kg        ?? profileData.bodyweight           ?? null,
    calorie_goal: profileData.calorie_goal      ?? profileData.calories_goal    ?? null,
    protein_goal: profileData.protein_g         ?? profileData.protein_goal     ?? null,
    carb_goal:    profileData.carbs_g           ?? profileData.carb_goal        ?? profileData.carbs_goal           ?? null,
    fat_goal:     profileData.fat_g             ?? profileData.fat_goal         ?? null,
    fiber_goal:   profileData.fiber_g           ?? profileData.fiber_goal       ?? null,
    phase:        profileData.goal              ?? profileData.phase            ?? null,
    // Whether IronLog's tdee_kcal ALREADY contains logged training. True at its
    // moderate/very/athlete activity levels, where the BMR multiplier assumes
    // regular sessions; false at sedentary/light, where a workout is genuinely
    // extra. Plated adds calories_burned on top of the goal, so getting this
    // wrong is a silent few-hundred-kcal overshoot on every training day.
    // ?? not ||, because false is the meaningful value here.
    tdee_includes_workouts: profileData.tdee_includes_workouts ?? null,
  };
}

// The stored answer to "may I add today's burn to the target?". Absent for a
// profile that has never synced, or an IronLog too old to send the field — in
// which case fall back to adding it, which is what Plated did before the field
// existed and is the safe direction for the sedentary/light users who are the
// only ones who had it right by accident.
function tdeeIncludesWorkouts(pid) {
  return profileSetting(pid, 'tdee_includes_workouts') === '1';
}

// Mirrors public/js/utils/phase.js's phaseCalorieGoal on the frontend — can't
// share a module across the fetch boundary without a build step, so keep the
// two in sync by hand if this formula ever changes.
function phaseCalories(tdee, phase, deficit, surplus) {
  if (phase === 'cut')  return Math.round(tdee - deficit);
  if (phase === 'bulk') return Math.round(tdee + surplus);
  return Math.round(tdee);
}

const router = express.Router();

// IronLog is configured per profile — the URL and key live in that profile's
// settings (profile 2210 has its own IronLog, separate from everyone else's).
function profileSetting(pid, key) {
  return getDb()
    .prepare('SELECT value FROM profile_settings WHERE profile_id = $pid AND key = $key')
    .get({ pid, key })?.value;
}

function getBaseUrl(pid) {
  const url = profileSetting(pid, 'ironlog_api_url')?.trim();
  if (!url) throw new Error('IronLog URL not configured');
  return url.replace(/\/$/, ''); // strip trailing slash
}

// Trim whitespace/newlines that sneak in when pasting the key.
function getApiKey(pid) {
  return profileSetting(pid, 'ironlog_api_key')?.trim() || null;
}

async function ironFetch(pid, path) {
  const url    = getBaseUrl(pid);
  const apiKey = getApiKey(pid);

  const headers = apiKey
    ? { 'X-API-Key': apiKey, 'Authorization': `Bearer ${apiKey}` }
    : {};

  const resp = await fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(6000) });
  if (resp.status === 401) throw new Error('IronLog rejected the API key (401 Unauthorized) — check the key in Settings');
  if (!resp.ok) throw new Error(`IronLog returned ${resp.status} for ${path}`);

  const json = await resp.json();
  if (json && json.success === false) throw new Error(json.error || `IronLog request failed for ${path}`);
  return json;
}

// Typed helpers for the IronLog Plated API
// Bring IronLog weigh-ins into weight_log, which is the copy every calculation
// in the app reads. Deduped by local calendar day, and a day you already have
// is never overwritten — a manual correction outranks the scale.
//
// Shared by /sync and /today so the two can't disagree about which day a
// weigh-in belongs to: localDayOf, not split('T')[0]. Weighing at 7am NZ
// timestamps at ~19:00 UTC the day BEFORE, which is how 74% of one profile's
// weigh-ins once landed a day early.
function importBodyweight(db, pid, bwList) {
  if (!Array.isArray(bwList) || !bwList.length) return 0;
  const tz     = tzFor(db, pid);
  const exists = db.prepare('SELECT 1 FROM weight_log WHERE profile_id = $pid AND date = $date');
  const insert = db.prepare(
    "INSERT INTO weight_log (date, weight_kg, profile_id, source) VALUES ($date, $kg, $pid, 'ironlog')"
  );
  let added = 0;
  for (const w of bwList) {
    const date = localDayOf(w.date, tz);
    const kg   = w.weight_kg ?? w.weight ?? w.bodyweight_kg;
    if (!date || kg == null) continue;
    if (!exists.get({ pid, date })) { insert.run({ date, kg, pid }); added++; }
  }
  return added;
}

const getProfile         = (pid)             => ironFetch(pid, '/api/plated/profile');
const getBodyweight       = (pid, limit = 30) => ironFetch(pid, `/api/plated/bodyweight?limit=${limit}`);
// tz = client's getTimezoneOffset() (minutes behind UTC; NZ = -720). IronLog
// uses it to bucket workouts into the user's local calendar day.
const getWorkoutCalories  = (pid, date, tz = 0)      => ironFetch(pid, `/api/plated/workouts/calories${date ? `?date=${date}&tz=${tz}` : ''}`);
const getRecentWorkouts   = (pid, limit = 7, tz = 0) => ironFetch(pid, `/api/plated/workouts/recent?limit=${limit}&tz=${tz}`);

const workoutCalories = w =>
  Number(w?.calories_burned ?? w?.calories ?? w?.total_calories ?? w?.kcal ?? 0) || 0;

// Resolve a workout's calendar date in the USER's local timezone.
// Accepts a plain 'YYYY-MM-DD' (used as-is — already the user's logging day) or
// an ISO timestamp (shifted by the client's tz offset, in minutes behind UTC).
function workoutLocalDate(w, tzOffsetMin = 0) {
  const raw = w?.date ?? w?.performed_at ?? w?.completed_at ?? w?.created_at ?? w?.logged_at ?? w?.timestamp;
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s.split('T')[0] || null;
  return new Date(t - tzOffsetMin * 60000).toISOString().split('T')[0];
}

// GET /api/ironlog/today — profile + calories burned for today
router.get('/today', async (req, res) => {
  const pid = req.profileId;
  let last_synced = null;
  try { last_synced = profileSetting(pid, 'ironlog_last_synced') || null; } catch { /* ignore */ }

  try {
    // Use the caller's local date when supplied — the server's UTC "today" can
    // be the user's yesterday and pull the wrong day's workout.
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : todayLocal(tzFor(getDb(), pid));
    const tzOff = Number.isFinite(parseInt(req.query.tz)) ? parseInt(req.query.tz) : 0;

    // Pull the calories endpoint AND recent workouts. The endpoint can miss the
    // day when IronLog dates workouts in UTC but we ask for the user's local
    // date; summing recent workouts matched to the local day is tz-robust.
    const [profileRes, calsRes, recentRes, bwRes] = await Promise.allSettled([
      getProfile(pid),
      getWorkoutCalories(pid, today, tzOff),
      getRecentWorkouts(pid, 30, tzOff),
      getBodyweight(pid, 30),
    ]);

    if (profileRes.status !== 'fulfilled') {
      return res.json({
        connected: false, error: profileRes.reason?.message,
        profile: null, calories_burned: 0, calorie_target: null, last_synced,
      });
    }

    const profileData = profileRes.value?.data ?? profileRes.value;

    const calsData     = calsRes.status === 'fulfilled' ? (calsRes.value?.data ?? calsRes.value) : null;
    const endpointBurned = Number(calsData?.calories_burned ?? calsData?.total ?? calsData?.calories ?? 0) || 0;

    let matchedBurned = 0, matchedCount = 0;
    if (recentRes.status === 'fulfilled') {
      const list = recentRes.value?.data ?? recentRes.value;
      if (Array.isArray(list)) {
        for (const w of list) {
          if (workoutLocalDate(w, tzOff) === today) { matchedBurned += workoutCalories(w); matchedCount++; }
        }
      }
    }

    // Prefer the tz-matched recent workouts; fall back to the calories endpoint.
    const burned = matchedCount > 0 ? matchedBurned : endpointBurned;

    // Latest IronLog bodyweight — shown on Today when nothing is logged locally.
    let bodyweight = null;
    if (bwRes.status === 'fulfilled') {
      const bwList = bwRes.value?.data ?? bwRes.value;
      // Import, not just display. This route already had the weigh-ins in hand
      // and only rendered them, while the copy that Trends actually does maths
      // on (weight_log) was written solely by the manual Sync button in
      // Settings. So Today showed a weight from this morning while real
      // maintenance was computed from a scale reading four days old — the
      // number on screen and the number in the sum were different weights, with
      // nothing to suggest it.
      // A GET that writes, deliberately: this route already stamps
      // ironlog_last_synced below, and importing here is what finally makes
      // that label true.
      try {
        const added = importBodyweight(getDb(), pid, bwList);
        // New weigh-ins move trend weight, and in g/kg mode the macro goals
        // follow it. Without this they'd lag until the next manual sync.
        if (added) { recalcMacroGoals(getDb(), pid); snapshotGoals(getDb(), pid, today); }
      } catch { /* best-effort — never fail Today over the scale */ }
      if (Array.isArray(bwList) && bwList.length) {
        const norm = bwList
          .map(w => ({ date: workoutLocalDate(w, tzOff), kg: Number(w.weight_kg ?? w.weight ?? w.bodyweight_kg) || null }))
          .filter(w => w.date && w.kg != null)
          .sort((a, b) => a.date.localeCompare(b.date));
        const todays = norm.find(w => w.date === today);
        const latest = norm[norm.length - 1];
        const pick = todays || latest;
        if (pick) bodyweight = { date: pick.date, weight_kg: pick.kg, is_today: pick.date === today };
      }
    }

    const now = new Date().toISOString();
    try {
      getDb().prepare("INSERT OR REPLACE INTO profile_settings (profile_id,key,value) VALUES ($pid,'ironlog_last_synced',$v)")
        .run({ pid, v: now });
    } catch { /* non-fatal */ }

    const calorieGoal = parseFloat(profileSetting(pid, 'calorie_goal')) || null;

    // Taken from the profile THIS request already fetched, not the copy stored
    // at last sync — same data, one round trip newer, and it means a user who
    // changes their IronLog activity level sees the correct target on the next
    // app open rather than after they remember to hit Sync.
    const liveFlag = extractProfile(profileData).tdee_includes_workouts;
    const includesWorkouts = liveFlag != null ? !!liveFlag : tdeeIncludesWorkouts(pid);
    // The part of the burn you may actually eat back. Zero when the TDEE the
    // goal was derived from already assumed the training.
    const eatable = includesWorkouts ? 0 : burned;

    res.json({
      connected:       true,
      profile:         profileData,
      calories_burned: burned,
      tdee_includes_workouts: includesWorkouts,
      calorie_target:  calorieGoal != null ? Math.round(calorieGoal + eatable) : null,
      bodyweight,
      last_synced:     now,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message, profile: null, calories_burned: 0, calorie_target: null, last_synced });
  }
});

// GET /api/ironlog/bodyweight — weight history for Trends view
router.get('/bodyweight', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const data    = await getBodyweight(req.profileId, limit);
    const entries = data?.data ?? data;
    res.json({ entries: Array.isArray(entries) ? entries : [] });
  } catch {
    res.json({ entries: [] });
  }
});

// GET /api/ironlog/raw — shows exactly what IronLog sends (for debugging).
// No longer reachable from Settings: a raw JSON dump is not something anyone
// in this household needs on a phone. Still here because it is the fastest way
// to see what the other side actually returned — hit it directly when a sync
// looks wrong.
router.get('/raw', async (req, res) => {
  try {
    const pid = req.profileId;
    const today = todayLocal(tzFor(getDb(), pid));
    const [profileRes, calsRes, bwRes, recentRes] = await Promise.allSettled([
      getProfile(pid),
      getWorkoutCalories(pid, today),
      getBodyweight(pid, 30),
      getRecentWorkouts(pid, 7),
    ]);
    res.json({
      profile:         profileRes.status === 'fulfilled' ? profileRes.value : { error: profileRes.reason?.message },
      calories:        calsRes.status    === 'fulfilled' ? calsRes.value    : { error: calsRes.reason?.message    },
      bodyweight:      bwRes.status      === 'fulfilled' ? bwRes.value      : { error: bwRes.reason?.message      },
      recent_workouts: recentRes.status  === 'fulfilled' ? recentRes.value  : { error: recentRes.reason?.message  },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ironlog/sync — pull all goals directly from IronLog profile
router.post('/sync', async (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;

    const profileRaw  = await getProfile(pid);
    const profileData = profileRaw?.data ?? profileRaw;
    const p           = extractProfile(profileData);

    if (!p.tdee && !p.bodyweight && !p.calorie_goal) {
      return res.status(422).json({
        error: 'IronLog profile did not include recognisable fields.',
        profile_raw: profileData,
      });
    }

    const setSetting = (key, value) => {
      if (value == null) return;
      db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)')
        .run({ pid, key, value: String(value) });
    };
    const getSetting = key => profileSetting(pid, key);

    const updates = {};

    if (p.tdee)         { setSetting('tdee',         p.tdee);         updates.tdee         = p.tdee;         }
    // Re-read every sync: it tracks the user's IronLog activity level, so it
    // changes the moment they edit that, and a stale copy silently restores the
    // double count.
    if (p.tdee_includes_workouts != null) {
      setSetting('tdee_includes_workouts', p.tdee_includes_workouts ? '1' : '0');
      updates.tdee_includes_workouts = !!p.tdee_includes_workouts;
    }
    if (p.bodyweight)   { setSetting('bodyweight_kg', p.bodyweight);                                         updates.bodyweight_kg = p.bodyweight; }
    if (p.protein_goal) { setSetting('protein_goal',  p.protein_goal); updates.protein_goal = p.protein_goal; }
    if (p.carb_goal)    { setSetting('carb_goal',     p.carb_goal);    updates.carb_goal    = p.carb_goal;    }
    if (p.fat_goal)     { setSetting('fat_goal',      p.fat_goal);     updates.fat_goal     = p.fat_goal;     }
    if (p.fiber_goal)   { setSetting('fiber_goal',    p.fiber_goal);   updates.fiber_goal   = p.fiber_goal;   }

    // ── Who owns what ───────────────────────────────────────────────────────
    // IronLog owns TDEE and bodyweight: it measures them. Plated owns phase and
    // deficit: you choose them here, in the Goal Phase UI, and POST /phase
    // already derives the calorie goal from tdee + your phase + your deficit
    // via phaseCalories(). The goal is DERIVED, never stored independently.
    //
    // This route used to ignore all of that and write IronLog's phase and
    // calorie_goal verbatim. Live example: IronLog reported goal "maintain" and
    // calorie_goal 2043 while this profile was cutting at 1743 with a 300
    // deficit. One tap on Sync would have flipped the phase to maintain and
    // raised the goal by 300 — a deliberate cut undone silently, visible only
    // as a goal_history row nobody was looking at. The scale would have shown
    // it weeks later.
    //
    // So: adopt IronLog's phase only when this profile has never set one, and
    // recompute the goal locally whenever we have a phase to compute it from.
    // IronLog's calorie_goal is used only as the fallback for a profile with no
    // phase of its own — a fresh connection with nothing local to preserve.
    const localPhase = getSetting('phase');
    const phase = ['cut', 'maintain', 'bulk'].includes(localPhase) ? localPhase
      : (['cut', 'maintain', 'bulk'].includes(p.phase) ? p.phase : null);
    if (phase && phase !== localPhase) { setSetting('phase', phase); updates.phase = phase; }

    const tdeeNow = parseFloat(getSetting('tdee')) || null;
    if (phase && tdeeNow) {
      const deficit = parseFloat(getSetting('cut_deficit'))  || 500;
      const surplus = parseFloat(getSetting('bulk_surplus')) || 300;
      const goal = phaseCalories(tdeeNow, phase, deficit, surplus);
      setSetting('calorie_goal', goal);
      updates.calorie_goal = goal;
      // Say so, so the Settings panel can show why the number is not the one
      // IronLog sent — otherwise this reads as the sync quietly disagreeing.
      updates.calorie_goal_source = 'derived';
      if (p.calorie_goal && Math.round(p.calorie_goal) !== goal) {
        updates.ironlog_calorie_goal = Math.round(p.calorie_goal);
      }
    } else if (p.calorie_goal) {
      setSetting('calorie_goal', p.calorie_goal);
      updates.calorie_goal = p.calorie_goal;
      updates.calorie_goal_source = 'ironlog';
    }

    // Import bodyweight history from IronLog into the weight log (dedupe by date)
    let weightsImported = 0;
    try {
      const bwRaw = await getBodyweight(pid, 60);
      weightsImported = importBodyweight(db, pid, bwRaw?.data ?? bwRaw);
    } catch { /* bodyweight import is best-effort */ }
    if (weightsImported) updates.bodyweight_entries_imported = weightsImported;

    // Runs last, so it sees both the imported weigh-ins and any calorie goal
    // IronLog just pushed. In g/kg mode this overrides the macro goals IronLog
    // sent — the local multipliers are the source of truth for that profile.
    const macros = recalcMacroGoals(db, pid);
    if (macros) Object.assign(updates, { protein_goal: macros.protein, carb_goal: macros.carbs, fat_goal: macros.fat });
    // A sync can push a whole new calorie goal from IronLog. That is as real a
    // goal change as typing one, so it goes in the history the same way.
    snapshotGoals(db, pid, todayLocal(tzFor(db, pid)));

    // profile_raw (IronLog's entire upstream payload) used to ride along here.
    // Nothing consumed it — /api/ironlog/raw already exists for inspection —
    // so it was upstream data echoed to the client for no reason.
    res.json({ synced: true, updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ironlog/phase — change phase and recalculate calorie goal from stored TDEE
router.post('/phase', (req, res) => {
  try {
    const { phase } = req.body;
    if (!['cut', 'maintain', 'bulk'].includes(phase)) {
      return res.status(400).json({ error: 'phase must be cut, maintain, or bulk' });
    }

    const db = getDb();
    const pid = req.profileId;
    const getSetting = key => profileSetting(pid, key);
    const setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)')
        .run({ pid, key, value: String(value) });
    };

    const tdee    = parseFloat(getSetting('tdee'))         || null;
    const deficit = parseFloat(getSetting('cut_deficit'))  || 500;
    const surplus = parseFloat(getSetting('bulk_surplus')) || 300;

    setSetting('phase', phase);

    let calorie_goal = null;
    if (tdee) {
      calorie_goal = phaseCalories(tdee, phase, deficit, surplus);
      setSetting('calorie_goal', calorie_goal);
    }
    // Carbs are the remainder of the calorie goal in g/kg mode, so a phase
    // change has to re-derive them.
    const macros = recalcMacroGoals(db, pid);
    snapshotGoals(db, pid, todayLocal(tzFor(db, pid)));   // a phase switch recomputes the calorie goal

    res.json({ phase, tdee, calorie_goal, ...(macros ? { macros } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ironlog/test — used by Settings page
router.get('/test', async (req, res) => {
  try {
    const data = await getProfile(req.profileId);
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
