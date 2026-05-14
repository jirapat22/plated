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

const router = express.Router();

function getBaseUrl() {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'ironlog_api_url'")
    .get();
  const url = row?.value?.trim();
  if (!url) throw new Error('IronLog URL not configured');
  return url.replace(/\/$/, ''); // strip trailing slash
}

async function ironFetch(path) {
  const url = getBaseUrl();
  const resp = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error(`IronLog returned ${resp.status} for ${path}`);
  return resp.json();
}

// GET /api/ironlog/today — profile + calories burned for today
router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [profileRes, calsRes] = await Promise.allSettled([
      ironFetch('/api/plated/profile'),
      ironFetch(`/api/plated/workouts/calories?date=${today}`),
    ]);

    const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;
    const cals    = calsRes.status    === 'fulfilled' ? calsRes.value    : null;

    // Normalise — IronLog may wrap in { success, data } or return flat
    const profileData = profile?.data ?? profile;
    const calsData    = cals?.data    ?? cals;
    const burned      = calsData?.calories_burned ?? calsData?.total ?? calsData?.calories ?? 0;

    // Save last synced timestamp
    const now = new Date().toISOString();
    try {
      getDb().prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ironlog_last_synced',$v)")
        .run({ v: now });
    } catch { /* non-fatal */ }

    res.json({
      connected:       true,
      profile:         profileData,
      calories_burned: burned,
      last_synced:     now,
    });
  } catch (err) {
    // Return last known sync time even on failure
    let last_synced = null;
    try { last_synced = getDb().prepare("SELECT value FROM settings WHERE key='ironlog_last_synced'").get()?.value || null; } catch {}
    res.json({ connected: false, error: err.message, profile: null, calories_burned: 0, last_synced });
  }
});

// GET /api/ironlog/bodyweight — weight history for Trends view
router.get('/bodyweight', async (req, res) => {
  try {
    const data = await ironFetch('/api/plated/bodyweight');
    res.json(data);
  } catch {
    res.json({ entries: [] });
  }
});

// GET /api/ironlog/raw — shows exactly what IronLog sends (for debugging)
router.get('/raw', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [profileRes, calsRes, bwRes] = await Promise.allSettled([
      ironFetch('/api/plated/profile'),
      ironFetch(`/api/plated/workouts/calories?date=${today}`),
      ironFetch('/api/plated/bodyweight'),
    ]);
    res.json({
      profile:    profileRes.status === 'fulfilled' ? profileRes.value : { error: profileRes.reason?.message },
      calories:   calsRes.status    === 'fulfilled' ? calsRes.value    : { error: calsRes.reason?.message    },
      bodyweight: bwRes.status      === 'fulfilled' ? bwRes.value      : { error: bwRes.reason?.message      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ironlog/sync — pull all goals directly from IronLog profile
router.post('/sync', async (req, res) => {
  try {
    const db = getDb();

    const profileRaw  = await ironFetch('/api/plated/profile');
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
    // Try /api/plated first (known to work), fall back to /health
    let data;
    try {
      data = await ironFetch('/api/plated');
    } catch {
      data = await ironFetch('/health');
    }
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

module.exports = router;
