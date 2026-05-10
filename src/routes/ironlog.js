const express = require('express');
const { getDb } = require('../db');

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
