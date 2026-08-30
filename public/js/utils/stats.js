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

// Your trend weight RIGHT NOW: the mean of up to `win` weigh-ins, counting
// only those inside `maxAgeDays`. Null when nothing is recent enough, because
// "no recent data" and "you weigh X" are different claims and only one of them
// is safe to print next to a goal.
//
// movingAvg alone cannot answer this. It slices by array INDEX, and the array
// holds one entry per weigh-in, not per day — so six readings from January plus
// one from today averages all seven and calls the result a 7-day trend. Worked:
// 80.0 ×6 in January, 74.2 today, gives 79.2 kg. That number led the Today card,
// fed etaWeeks (20.6 weeks to target instead of 4.0) and inflated the
// maintenance estimate by ~50 kcal. The server twin has guarded this all along
// with TREND_MAX_AGE_DAYS in src/utils/macros.js, and trendAsOf above guards it
// with windowStart; these two call sites were the pair that never got it.
//
// `entries` is [[isoDate, kg]] ascending, one row per date.
export function trendWeightNow(entries, { win = 7, maxAgeDays = 30, today } = {}) {
  if (!entries?.length || !today) return null;
  const cutoff = shift(today, -maxAgeDays);
  const recent = entries.filter(([d]) => d >= cutoff);
  if (!recent.length) return null;
  const slice = recent.slice(-win);
  return slice.reduce((s, [, v]) => s + v, 0) / slice.length;
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
// `hint` is the compact version Settings shows; `long` anchors the same level to
// things you can actually check — steps and the shape of your day — because
// almost everyone reads their own training as more than it is. Overshooting here
// is the expensive direction: it inflates TDEE, inflates the goal, and the
// deficit you think you have never arrives.
export const ACTIVITY = [
  { k: '1.2',   label: 'Sedentary',   hint: 'desk job, little exercise',
    long: 'Desk or study most of the day, car or bus, evenings sitting. Under ~5,000 steps. Pick this even if you train a few times a week — the training is the exception, not the day.' },
  { k: '1.375', label: 'Light',       hint: 'training 1–3×/week',
    long: 'On your feet a fair bit, or 1–3 real sessions a week. Roughly 5–8,000 steps. This is where most desk workers who go to the gym actually land.' },
  { k: '1.55',  label: 'Moderate',    hint: 'training 3–5×/week',
    long: '3–5 sessions a week AND a day that keeps moving — walking commute, stairs, rarely sitting for hours. Roughly 8–12,000 steps.' },
  { k: '1.725', label: 'Very active', hint: 'training 6–7×/week',
    long: 'Hard training 6–7 days a week, or a job on your feet all day plus regular sessions. 12,000+ steps.' },
  { k: '1.9',   label: 'Athlete',     hint: 'twice a day, or physical job',
    long: 'Two sessions most days, or manual labour on top of training. Genuinely rare — if you are choosing between this and the one below, choose below.' },
];

// Plausible human ranges. Anything outside is a typo, not a person: a decimal
// slip (765 for 76.5), height in millimetres, an age with a stray digit. The
// bounds match the weigh-in route's 20-400 kg so the two can't disagree about
// what counts as a weight.
// Not caught, and not catchable here: pounds typed as kilos. 165 lb reads as a
// perfectly legitimate 165 kg.
export const LIMITS = {
  weightKg: [20, 400],
  heightCm: [100, 250],
  age:      [13, 100],
};
export function outOfRange({ weightKg, heightCm, age }) {
  const bad = ([lo, hi], v) => !(Number.isFinite(v) && v >= lo && v <= hi);
  if (bad(LIMITS.weightKg, weightKg)) return 'Weight should be between 20 and 400 kg';
  if (bad(LIMITS.heightCm, heightCm)) return 'Height should be between 100 and 250 cm';
  if (bad(LIMITS.age,      age))      return 'Age should be between 13 and 100';
  return null;
}

// Mifflin-St Jeor resting burn — what you'd spend doing nothing at all.
function bmr({ weightKg, heightCm, age, sex }) {
  if (!(weightKg > 0) || !(heightCm > 0) || !(age > 0)) return null;
  // An unknown sex is unknown, not male. This read `sex === 'female' ? -161 : 5`,
  // so every value that wasn't the string 'female' — including '', undefined and
  // a profile that never answered — silently took the male constant. That is
  // 166 kcal of BMR, which the activity multiplier turns into ~228 kcal/day of
  // TDEE: measured 2085 vs 1857 maintenance on one profile. Onboarding no longer
  // pre-selects a sex, and this is the layer that makes the omission visible
  // instead of guessing behind it — callers already handle null by showing
  // nothing rather than a number.
  const sexOffset = sex === 'female' ? -161 : sex === 'male' ? 5 : null;
  if (sexOffset == null) return null;
  return 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
}

// Null rather than a number whenever the inputs aren't a plausible person.
// The formula is linear and unbounded, so it answered anything asked of it:
// age 500 returned a NEGATIVE 899, which onboarding wrote out as a calorie
// goal of -1149, and a height typed in millimetres returned 15,740. Both were
// stored and displayed as ordinary targets.
export function estimateTdee({ weightKg, heightCm, age, sex, activity }) {
  if (outOfRange({ weightKg, heightCm, age })) return null;
  const rest = bmr({ weightKg, heightCm, age, sex });
  if (rest == null || !(activity > 0)) return null;
  const tdee = Math.round(rest * activity);
  return tdee > 0 ? tdee : null;
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
