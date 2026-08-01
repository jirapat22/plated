// Per-IP limiter for the unauthenticated auth routes.
//
// No dependency: this is the whole feature in ~35 lines, and express-rate-limit
// would be a package for what a Map does. In-memory and per-process, so it
// resets on deploy — fine for slowing credential guessing on a single-instance
// app, and not a claim to be anything sturdier.
//
// Needs `app.set('trust proxy', 1)` to be meaningful behind Railway's proxy;
// without it every request arrives with the proxy's IP and one attacker would
// lock out everybody.
function rateLimit({ windowMs, max, blockMs }) {
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
      const retry = Math.max(1, Math.ceil((e.blockedUntil - now) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        error: `Too many attempts — try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}`,
      });
    };

    if (e.blockedUntil > now) return deny();

    e.count++;
    if (e.count > max) { e.blockedUntil = now + blockMs; return deny(); }

    // Opportunistic sweep of expired entries — cheaper than a timer, and only
    // runs once the map is already large.
    if (hits.size > MAX_KEYS) {
      for (const [k, v] of hits) if (now > v.resetAt && v.blockedUntil < now) hits.delete(k);
    }

    // A route calls this after a genuine success so normal use never accrues
    // toward a lockout.
    res.locals.clearRateLimit = () => hits.delete(key);
    next();
  };
}

module.exports = { rateLimit };
