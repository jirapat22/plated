// I.O. — Pat's Discord assistant. Pat drops a meal photo or a nutrition label
// into the #plated channel, I.O. estimates it, and on ✅ it logs it here.
//
// I.O. is a bot, not a person with a passcode, so it gets its own gate: the
// IO_API_KEY header, which acts as exactly ONE profile (IO_PROFILE_ID) and
// fails closed when either is unset. It reuses the real meals/foods routers so
// a quick log from Discord goes through the same validation, idempotency and
// bookkeeping as one typed in the app — but only through the handful of routes
// allowlisted below. Everything else (settings, export, deletes, weight edits,
// other profiles) answers 404, so a leaked key can add meals and read Pat's own
// food/weight history (for the coach), nothing more.
const express = require('express');
const { sameKey } = require('./orbit');
const mealsRoutes = require('./meals');
const foodsRoutes = require('./foods');
const weightRoutes = require('./weight');
const measurementsRoutes = require('./measurements');

function requireIoKey(req, res, next) {
  const required = process.env.IO_API_KEY?.trim();
  const pid = parseInt(process.env.IO_PROFILE_ID);
  if (!required || !(pid > 0)) {
    return res.status(503).json({ error: 'I.O. access is not configured (IO_API_KEY / IO_PROFILE_ID unset)' });
  }
  if (!sameKey(req.headers['x-io-key'], required)) {
    return res.status(401).json({ error: 'invalid or missing I.O. key' });
  }
  req.profileId = pid;
  next();
}

// Only these "METHOD /path" pairs get through to the real router; a longer
// path ending in "/" is a prefix (GET /day/2026-10-29). A bare "/" is exact:
// as a prefix it would match everything under the mount, which is how the
// first version of this let GET /weight/day/... through on a "GET /" rule.
function allow(...rules) {
  return (req, res, next) => {
    const hit = rules.some(r => {
      const [method, p] = r.split(' ');
      const prefix = p.length > 1 && p.endsWith('/');
      return req.method === method && (prefix ? req.path.startsWith(p) : req.path === p);
    });
    if (!hit) return res.status(404).json({ error: 'Not available to I.O.' });
    // ?profile= lets a person view a connected profile's day. I.O. only ever
    // sees its own profile, so the parameter is refused rather than ignored.
    if (req.query.profile !== undefined) return res.status(400).json({ error: 'profile is not allowed here' });
    next();
  };
}

const router = express.Router();
router.use(requireIoKey);
router.use('/meals', allow('POST /log', 'GET /day/', 'GET /summary'), mealsRoutes); // log a meal, read days back
router.use('/foods', allow('POST /'), foodsRoutes);                    // save a food read off a label
// Read-only, for I.O.'s training coach (daily totals above, plus weight and tape measurements)
router.use('/weight', allow('GET /'), weightRoutes);
router.use('/measurements', allow('GET /'), measurementsRoutes);

module.exports = router;
