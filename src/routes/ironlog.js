const express = require('express');
const { getDb } = require('../db');

// Resolve TDEE from whatever shape the IronLog profile returns
function extractTdee(profileData) {
  if (!profileData) return null;
  return profileData.tdee
    ?? profileData.maintenance_calories
    ?? profileData.maintenanceCalories
    ?? profileData.total_daily_energy
    ?? profileData.bmr
    ?? null;
}

// Resolve bodyweight from the profile
function extractBodyweight(profileData) {
  if (!profileData) return null;
  return profileData.bodyweight_kg
    ?? profileData.weight_kg
    ?? profileData.bodyweight
    ?? profileData.weight
    ?? null;
}

// Calculate calorie goal based on phase + TDEE
function phaseCalories(tdee, phase, deficit, surplus) {
  if (!tdee) return null;
  if (phase === 'cut')  return Math.round(tdee - deficit);
  if (phase === 'bulk') return Math.round(tdee + surplus);
  return Math.round(tdee); // maintain
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

    res.json({
      connected:       true,
      profile:         profileData,
      calories_burned: burned,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message, profile: null, calories_burned: 0 });
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

// POST /api/ironlog/sync — pull TDEE + bodyweight from IronLog, recalculate goals
router.post('/sync', async (req, res) => {
  try {
    const db = getDb();

    const profileRaw = await ironFetch('/api/plated/profile');
    const profileData = profileRaw?.data ?? profileRaw;

    const tdee       = extractTdee(profileData);
    const bodyweight = extractBodyweight(profileData);

    if (!tdee && !bodyweight) {
      return res.status(422).json({
        error: 'IronLog profile did not include TDEE or bodyweight. Check /api/ironlog/raw to see what fields are returned.',
      });
    }

    const getSetting = key => {
      const row = db.prepare('SELECT value FROM settings WHERE key = $key').get({ key });
      return row?.value;
    };
    const setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)')
        .run({ key, value: String(value) });
    };

    const phase   = getSetting('phase')        || 'maintain';
    const deficit = parseFloat(getSetting('cut_deficit'))  || 500;
    const surplus = parseFloat(getSetting('bulk_surplus')) || 300;
    const multiplier = parseFloat(getSetting('protein_multiplier')) || 2.2;

    const updates = {};

    // Save raw TDEE
    if (tdee) {
      setSetting('tdee', tdee);
      updates.tdee = tdee;

      // Recalculate calorie goal for current phase
      const newCalGoal = phaseCalories(tdee, phase, deficit, surplus);
      setSetting('calorie_goal', newCalGoal);
      updates.calorie_goal = newCalGoal;
    }

    // Recalculate protein goal from bodyweight
    if (bodyweight) {
      const newProteinGoal = Math.round(bodyweight * multiplier);
      setSetting('protein_goal', newProteinGoal);
      updates.protein_goal = newProteinGoal;
      updates.bodyweight_kg = bodyweight;
    }

    res.json({ synced: true, updates, phase, tdee, bodyweight_kg: bodyweight });
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
