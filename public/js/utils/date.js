/** Returns YYYY-MM-DD in the user's LOCAL timezone (not UTC) */
export function localDate(d = new Date()) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Shifts a YYYY-MM-DD string by n days, staying in local time throughout.
 * The 'T00:00:00' suffix matters: without it the string parses as UTC midnight
 * and anyone west of Greenwich lands on the previous day. Formatting back
 * through localDate rather than toISOString closes the same hole at the other
 * end. Lived in log.js; trends.js needs the same arithmetic to cut chart ranges
 * by date, and this is not a wheel worth reinventing per view.
 */
export function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}
