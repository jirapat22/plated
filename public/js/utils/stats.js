// Trailing moving average — a smooth trend line over `win` points. Shared by
// Trends (chart trend lines) and Today (trend bodyweight) so both read the
// same smoothed value instead of two independent implementations.
export function movingAvg(arr, win = 7) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - win + 1);
    const slice = arr.slice(start, i + 1).filter(v => v != null);
    if (!slice.length) return null;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

// Shift an ISO date by whole days. UTC throughout so the result depends only on
// the string, never on the machine's timezone.
const shift = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Trend weight as of `iso`: mean of the last up-to-`win` weigh-ins on or before
// it. Null unless at least one weigh-in falls within windowStart..iso — without
// that guard a week you never stepped on the scale inherits a stale average and
// reports "no change", which is a different claim from "no data".
function trendAsOf(entries, iso, windowStart, win) {
  if (!entries.some(([d]) => d >= windowStart && d <= iso)) return null;
  const upto = entries.filter(([d]) => d <= iso).slice(-win);
  return upto.length ? upto.reduce((s, [, kg]) => s + kg, 0) / upto.length : null;
}

// How much trend weight moved across the Mon–Sun week beginning `monday`,
// measured against the end of the previous CALENDAR week (not the previous row
// of whatever list is being rendered — weeks with no logged meals are missing
// from that list, so consecutive rows can straddle a gap).
// Smoothed rather than raw on purpose: a raw Monday-to-Sunday diff reports a
// salty last meal as fat gained. `entries`: [[isoDate, kg], …] ascending, one
// per date. Returns null when either endpoint has no weigh-in to stand on.
export function weeklyTrendChange(entries, monday, win = 7) {
  const end  = trendAsOf(entries, shift(monday, 6),  monday, win);
  const prev = trendAsOf(entries, shift(monday, -1), shift(monday, -7), win);
  return end != null && prev != null ? end - prev : null;
}
