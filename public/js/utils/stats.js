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

// Weeks until `targetWeight` at the current pace, or null when there's no
// honest answer. `working` is the verdict itself: if the app is telling you the
// plan isn't working, it has no business projecting an arrival date.
//
// The old floor was |rate| > 0.02 kg/wk, which is well inside the noise. A
// -0.025 kg/wk fit — displayed, rounded, as "-0.02" — printed a confident
// "~115w to 73 kg" directly beside OFF TRACK, and -0.019 would have shown
// nothing at all. 0.1 kg/wk is the smallest pace a 4-week trend can actually
// distinguish from a flat line.
export function etaWeeks({ curWeight, targetWeight, weeklyRate, working }) {
  if (!working || curWeight == null || targetWeight == null || weeklyRate == null) return null;
  if (Math.abs(weeklyRate) < 0.1) return null;
  const w = (curWeight - targetWeight) / -weeklyRate;   // <0 = moving away
  return w > 0 && w < 104 ? w : null;                   // ponytail: 2y ceiling, past that "at this pace" means nothing
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
// Mifflin-St Jeor resting burn × an activity multiplier. Lives here rather than
// inline in the settings view so it can be imported and tested directly — it was
// previously exported from a view nothing imports, which meant the tests
// exercised a copy of the formula instead of the shipped one.
// Null until every input it needs is present, which is what disables the button.
// Activity multipliers for Mifflin-St Jeor. Lives here beside estimateTdee
// rather than in a view, so the Settings estimator and the first-run flow can
// both use one copy.
export const ACTIVITY = [
  { k: '1.2',   label: 'Sedentary',    hint: 'desk job, little exercise' },
  { k: '1.375', label: 'Light',        hint: 'training 1–3×/week' },
  { k: '1.55',  label: 'Moderate',     hint: 'training 3–5×/week' },
  { k: '1.725', label: 'Very active',  hint: 'training 6–7×/week' },
  { k: '1.9',   label: 'Athlete',      hint: 'twice a day, or physical job' },
];

// Mifflin-St Jeor resting burn — what you'd spend doing nothing at all.
function bmr({ weightKg, heightCm, age, sex }) {
  if (!(weightKg > 0) || !(heightCm > 0) || !(age > 0)) return null;
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'female' ? -161 : 5);
}

export function estimateTdee({ weightKg, heightCm, age, sex, activity }) {
  const rest = bmr({ weightKg, heightCm, age, sex });
  return rest != null && activity > 0 ? Math.round(rest * activity) : null;
}

// Measured maintenance is derived from logged intake, so it inherits that
// intake's honesty. Against what your size and your OWN stated training load
// predict, a large shortfall is the one signal separating "TDEE set too high"
// from "under-logging" — otherwise indistinguishable in this data.
//
// Deliberately not a bare BMR × 1.2 "below sedentary" floor: that lands within
// ~50 kcal of a real user here, so a centimetre of height would flip a
// confident accusation on and off. Mifflin is a population average and
// individuals vary ~±10%, so this stays silent under 300 kcal rather than
// crying wolf on estimate error.
export function maintenanceShortfall(realTDEE, body) {
  const predicted = estimateTdee(body);
  if (realTDEE == null || predicted == null) return null;
  const gap = Math.round(predicted - realTDEE);
  return gap >= 300 ? { predicted, gap } : null;
}

export function weeklyTrendChange(entries, monday, win = 7) {
  const end  = trendAsOf(entries, shift(monday, 6),  monday, win);
  const prev = trendAsOf(entries, shift(monday, -1), shift(monday, -7), win);
  return end != null && prev != null ? end - prev : null;
}
