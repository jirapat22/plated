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

module.exports = { todayLocal, localDayOf, APP_TZ };
