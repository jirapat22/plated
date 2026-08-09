// Shared "today" fallback for routes whose caller didn't supply an explicit
// local date. The frontend always sends its own localDate() explicitly for
// user-driven writes; this only matters for any other/future caller. Pinned
// to a fixed zone (DST-aware via Intl) rather than the server's UTC day —
// new Date().toISOString() alone put a UTC+12/+13 user's "today" a day
// behind for roughly half of every 24 hours. Override with APP_TZ.
const APP_TZ = process.env.APP_TZ?.trim() || 'Pacific/Auckland';

function todayLocal(tz = APP_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// The calendar day an instant falls on, locally. A plain YYYY-MM-DD passes
// through untouched — it is already a local day and has no time to convert.
//
// IronLog sends ISO instants, and `String(x).split('T')[0]` takes the UTC day
// off them. A 7am NZ weigh-in is ~19:00 UTC the day BEFORE, so that filed 74%
// of one user's weigh-ins a day early. Returns null on anything unparseable so
// callers can skip rather than store a wrong date.
function localDayOf(value, tz = APP_TZ) {
  const s = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
}

// Is this a zone Intl actually knows? Guards the setting at the trust boundary
// — an unknown name makes DateTimeFormat throw, and it would throw from
// whichever route next asked what day it was, not from the write that stored it.
function isValidTz(name) {
  const s = String(name ?? '').trim();
  if (!s) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); return true; }
  catch { return false; }
}

// The zone to reckon THIS profile's days in. APP_TZ was a single global, which
// is right up until the second person lives somewhere else: their "today"
// started hours before or after the server's, so a day boundary landed in the
// middle of their afternoon and IronLog weigh-ins were filed onto the wrong
// calendar day — the same defect already fixed once for UTC-vs-NZ, reappearing
// as NZ-vs-everyone.
//
// db is passed in rather than required, so this file stays a leaf and can't
// form a cycle with db.js.
// ponytail: a per-request lookup, not cached. It's one indexed read on a
// primary key; cache it if a profile-settings hot path ever shows up in a
// profile.
function tzFor(db, profileId) {
  try {
    const v = db.prepare(
      "SELECT value FROM profile_settings WHERE profile_id = $p AND key = 'timezone'"
    ).get({ p: profileId })?.value;
    return isValidTz(v) ? String(v).trim() : APP_TZ;
  } catch {
    return APP_TZ;
  }
}

module.exports = { todayLocal, localDayOf, isValidTz, tzFor, APP_TZ };
