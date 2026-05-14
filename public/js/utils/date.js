/** Returns YYYY-MM-DD in the user's LOCAL timezone (not UTC) */
export function localDate(d = new Date()) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
