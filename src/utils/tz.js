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

module.exports = { todayLocal, APP_TZ };
