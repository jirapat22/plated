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
//   'requests'  every request through the middleware counts. The DEFAULT, and
//               deliberately so: it is the mode that still protects when a
//               caller forgets to choose. 'failures' was briefly the default,
//               and bugReports.js — public, unauthenticated, writes a row and
//               fires an outbound request to Orbit — passes no mode and never
//               calls recordFailure, so it silently counted nothing and the cap
//               stopped existing. A limiter that fails open on a forgotten
//               argument is worse than none, because it looks present.
//
//   'failures'  opt-in. The route calls res.locals.recordFailure() on a bad
//               attempt; nothing else counts, and NOTHING clears the window
//               early. Replaces a clearRateLimit() that deleted the IP's entry
//               outright on any success — which made the login limiter
//               decorative, because anyone holding a single valid code
//               (including a throwaway profile they had just created) could
//               reset the window every ten guesses and walk the whole
//               10,000-code space. Measured before that fix: 36 where the cap
//               was 10.
function rateLimit({ windowMs, max, blockMs, count = 'requests' }) {
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
    //
    // The sweep alone did not bound anything: it can only drop entries whose
    // window has already elapsed, and inside a 15-minute window none have. A
    // spray across an IPv6 /64 therefore grew the map without limit, and
    // MAX_KEYS was a number that never bound. After sweeping, evict oldest-first
    // until it does. Map preserves insertion order, so the first keys are the
    // least recently created — and evicting an attacker's key only gives them
    // back attempts they were already free to make from a fresh address.
    if (hits.size > MAX_KEYS) {
      for (const [k, v] of hits) if (now > v.resetAt && v.blockedUntil < now) hits.delete(k);
      // Prefer to evict an IP that is NOT currently serving a block; that is the
      // one entry an attacker would want dropped.
      for (const [k, v] of hits) {
        if (hits.size <= MAX_KEYS) break;
        if (v.blockedUntil <= now && k !== key) hits.delete(k);
      }
      // A preference, not a veto. Making it a veto left MAX_KEYS still not
      // binding, because in a spray EVERY entry is blocked: 20,000 addresses at
      // four requests each all tripped the block, nothing was evictable, and the
      // first address was still held at 4x the cap. The map has to be bounded
      // whatever is in it — and dropping an attacker's block costs nothing they
      // could not already get by moving to a fresh address, which is what filled
      // the map in the first place.
      for (const [k] of hits) {
        if (hits.size <= MAX_KEYS) break;
        if (k !== key) hits.delete(k);
      }
    }

    next();
  };
}

module.exports = { rateLimit };
