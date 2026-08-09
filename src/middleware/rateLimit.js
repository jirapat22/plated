// Per-IP limiter for the unauthenticated auth routes.
//
// No dependency: this is the whole feature in ~60 lines, and express-rate-limit
// would be a package for what a Map does. In-memory and per-process, so it
// resets on deploy — fine for slowing credential guessing on a single-instance
// app, and not a claim to be anything sturdier.
//
// Needs `app.set('trust proxy', 1)` to be meaningful behind Railway's proxy;
// without it every request arrives with the proxy's IP and one attacker would
// lock out everybody.
//
// `count` picks what accrues toward the limit:
//
//   'failures'  the route calls res.locals.recordFailure() on a bad attempt.
//               Nothing else counts, and NOTHING clears the window early.
//               This replaces a clearRateLimit() that deleted the IP's entry
//               outright on any success — which made the limiter decorative,
//               because anyone holding a single valid code (including a
//               throwaway profile they had just created) could reset the
//               window every ten guesses and walk the whole 10,000-code space.
//               Measured before the fix: 36 guesses where the cap was 10.
//
//   'requests'  every request through the middleware counts. For capping an
//               action that succeeds by design, like profile creation.
function rateLimit({ windowMs, max, blockMs, count = 'failures' }) {
  const hits = new Map();          // ip -> { count, resetAt, blockedUntil }
  const MAX_KEYS = 5000;           // bound the map so an IP spray can't grow it forever

  return function limiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';

    let e = hits.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs, blockedUntil: 0 };
      hits.set(key, e);
    }

    const deny = () => {
      const retry = Math.max(1, Math.ceil((e.blockedUntil - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        error: `Too many attempts — try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}`,
      });
    };

    if (e.blockedUntil > now) return deny();

    // The two modes need different comparisons to both mean "max events are
    // allowed". A request is counted BEFORE the handler runs, so the block has
    // to trip on the one that exceeds the cap (> max). A failure is recorded
    // from INSIDE the handler, after that attempt has already been answered, so
    // it trips on the one that reaches it (>= max) and the next request is
    // refused. Both end up allowing exactly `max`.
    if (count === 'requests') {
      e.count++;
      if (e.count > max) { e.blockedUntil = Date.now() + blockMs; return deny(); }
    } else {
      res.locals.recordFailure = () => {
        e.count++;
        if (e.count >= max) e.blockedUntil = Date.now() + blockMs;
      };
    }

    // Opportunistic sweep of expired entries — cheaper than a timer, and only
    // runs once the map is already large.
    if (hits.size > MAX_KEYS) {
      for (const [k, v] of hits) if (now > v.resetAt && v.blockedUntil < now) hits.delete(k);
    }

    next();
  };
}

module.exports = { rateLimit };
