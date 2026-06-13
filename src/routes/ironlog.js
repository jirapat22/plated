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
const getWorkoutCalories  = (pid, date)       => ironFetch(pid, `/api/plated/workouts/calories${date ? `?date=${date}` : ''}`);
const getRecentWorkouts   = (pid, limit = 7)  => ironFetch(pid, `/api/plated/workouts/recent?limit=${limit}`);

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

    const [profileRes, calsRes] = await Promise.allSettled([
      getProfile(pid),
      getWorkoutCalories(pid, today),
    ]);

    if (profileRes.status !== 'fulfilled') {
      return res.json({
        connected: false, error: profileRes.reason?.message,
        profile: null, calories_burned: 0, calorie_target: null, last_synced,
      });
    }

    const profileData = profileRes.value?.data ?? profileRes.value;
    const calsData    = calsRes.status === 'fulfilled' ? (calsRes.value?.data ?? calsRes.value) : null;
    const burned      = calsData?.calories_burned ?? calsData?.total ?? calsData?.calories ?? 0;

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
