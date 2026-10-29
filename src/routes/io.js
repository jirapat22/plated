// I.O. — Pat's Discord assistant. Pat drops a meal photo or a nutrition label
// into the #plated channel, I.O. estimates it, and on ✅ it logs it here.
//
// I.O. is a bot, not a person with a passcode, so it gets its own gate: the
// IO_API_KEY header, which acts as exactly ONE profile (IO_PROFILE_ID) and
// fails closed when either is unset. It reuses the real meals/foods routers so
// a quick log from Discord goes through the same validation, idempotency and
// bookkeeping as one typed in the app — but only through the handful of routes
// allowlisted below. Everything else (settings, export, delete, weight, other
// profiles) answers 404, so a leaked key can add meals and nothing more.
const express = require('express');
const { sameKey } = require('./orbit');
const mealsRoutes = require('./meals');
const foodsRoutes = require('./foods');

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

// Only these "METHOD /path" pairs get through to the real router; a path
// ending in "/" is a prefix (GET /day/2026-10-29).
function allow(...rules) {
  return (req, res, next) => {
    const hit = rules.some(r => {
      const [method, p] = r.split(' ');
      return req.method === method && (p.endsWith('/') ? req.path.startsWith(p) : req.path === p);
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
router.use('/meals', allow('POST /log', 'GET /day/'), mealsRoutes);   // log a meal, read today back
router.use('/foods', allow('POST /'), foodsRoutes);                    // save a food read off a label

module.exports = router;
