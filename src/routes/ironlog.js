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

// Base URL: env var takes precedence, falls back to the DB setting
// configured via the Settings UI (for backwards compatibility).
function getBaseUrl() {
  const envUrl = process.env.IRONLOG_API_URL?.trim();
  if (envUrl) return envUrl.replace(/\/$/, '');

  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'ironlog_api_url'")
    .get();
  const url = row?.value?.trim();
  if (!url) throw new Error('IronLog URL not configured');
  return url.replace(/\/$/, ''); // strip trailing slash
}

async function ironFetch(path) {
  const url    = getBaseUrl();
  const apiKey = process.env.IRONLOG_API_KEY?.trim();
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};

  const resp = await fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(6000) });
  if (resp.status === 401) throw new Error('IronLog rejected the API key (401 Unauthorized)');
  if (!resp.ok) throw new Error(`IronLog returned ${resp.status} for ${path}`);

  const json = await resp.json();
  if (json && json.success === false) throw new Error(json.error || `IronLog request failed for ${path}`);
  return json;
}

// Typed helpers for the IronLog Plated API
const getProfile         = ()         => ironFetch('/api/plated/profile');
const getBodyweight       = (limit = 30) => ironFetch(`/api/plated/bodyweight?limit=${limit}`);
const getWorkoutCalories  = (date)     => ironFetch(`/api/plated/workouts/calories${date ? `?date=${date}` : ''}`);
const getRecentWorkouts   = (limit = 7)  => ironFetch(`/api/plated/workouts/recent?limit=${limit}`);

// GET /api/ironlog/today — profile + calories burned for today
router.get('/today', async (req, res) => {
  let last_synced = null;
  try { last_synced = getDb().prepare("SELECT value FROM settings WHERE key='ironlog_last_synced'").get()?.value || null; } catch { /* ignore */ }

  try {
    const today = new Date().toISOString().split('T')[0];

    const [profileRes, calsRes] = await Promise.allSettled([
      getProfile(),
      getWorkoutCalories(today),
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
      getDb().prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ironlog_last_synced',$v)")
        .run({ v: now });
    } catch { /* non-fatal */ }

    const calorieGoalRow = getDb().prepare("SELECT value FROM settings WHERE key='calorie_goal'").get();
    const calorieGoal    = parseFloat(calorieGoalRow?.value) || null;

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
    const data    = await getBodyweight(limit);
    const entries = data?.data ?? data;
    res.json({ entries: Array.isArray(entries) ? entries : [] });
  } catch {
    res.json({ entries: [] });
  }
});

// GET /api/ironlog/raw — shows exactly what IronLog sends (for debugging)
router.get('/raw', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [profileRes, calsRes, bwRes, recentRes] = await Promise.allSettled([
      getProfile(),
      getWorkoutCalories(today),
      getBodyweight(30),
      getRecentWorkouts(7),
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

    const profileRaw  = await getProfile();
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
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)')
        .run({ key, value: String(value) });
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
    const getSetting = key => {
      const row = db.prepare('SELECT value FROM settings WHERE key = $key').get({ key });
      return row?.value;
    };
    const setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)')
        .run({ key, value: String(value) });
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
    const data = await getProfile();
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
