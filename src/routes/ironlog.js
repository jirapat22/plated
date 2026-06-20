const express = require('express');
const { getDb } = require('../db');

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
  };
}

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
      : new Date().toISOString().split('T')[0];
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

    res.json({
      connected:       true,
      profile:         profileData,
      calories_burned: burned,
      calorie_target:  calorieGoal != null ? Math.round(calorieGoal + burned) : null,
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

// GET /api/ironlog/raw — shows exactly what IronLog sends (for debugging)
router.get('/raw', async (req, res) => {
  try {
    const pid = req.profileId;
    const today = new Date().toISOString().split('T')[0];
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

    const updates = {};

    if (p.tdee)         { setSetting('tdee',         p.tdee);         updates.tdee         = p.tdee;         }
    if (p.bodyweight)   { setSetting('bodyweight_kg', p.bodyweight);                                         updates.bodyweight_kg = p.bodyweight; }
    if (p.calorie_goal) { setSetting('calorie_goal',  p.calorie_goal); updates.calorie_goal = p.calorie_goal; }
    if (p.protein_goal) { setSetting('protein_goal',  p.protein_goal); updates.protein_goal = p.protein_goal; }
    if (p.carb_goal)    { setSetting('carb_goal',     p.carb_goal);    updates.carb_goal    = p.carb_goal;    }
    if (p.fat_goal)     { setSetting('fat_goal',      p.fat_goal);     updates.fat_goal     = p.fat_goal;     }
    if (p.fiber_goal)   { setSetting('fiber_goal',    p.fiber_goal);   updates.fiber_goal   = p.fiber_goal;   }
    if (p.phase && ['cut','maintain','bulk'].includes(p.phase)) {
      setSetting('phase', p.phase);
      updates.phase = p.phase;
    }

    // Import bodyweight history from IronLog into the weight log (dedupe by date)
    let weightsImported = 0;
    try {
      const bwRaw  = await getBodyweight(pid, 60);
      const bwList = bwRaw?.data ?? bwRaw;
      if (Array.isArray(bwList)) {
        const exists = db.prepare('SELECT 1 FROM weight_log WHERE profile_id = $pid AND date = $date');
        const insert = db.prepare(
          "INSERT INTO weight_log (date, weight_kg, profile_id, source) VALUES ($date, $kg, $pid, 'ironlog')"
        );
        for (const w of bwList) {
          const date = String(w.date || '').split('T')[0];
          const kg   = w.weight_kg ?? w.weight;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || kg == null) continue;
          if (!exists.get({ pid, date })) { insert.run({ date, kg, pid }); weightsImported++; }
        }
      }
    } catch { /* bodyweight import is best-effort */ }
    if (weightsImported) updates.bodyweight_entries_imported = weightsImported;

    res.json({ synced: true, updates, profile_raw: profileData });
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

    res.json({ phase, tdee, calorie_goal });
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
