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
