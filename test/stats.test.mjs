import { test } from 'node:test';
import assert from 'node:assert';
import { trendWeightNow, movingAvg, etaWeeks, estimateTdee , tCrit95 } from '../public/js/utils/stats.js';

const shift = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = '2026-08-28';

// The reported scenario: six weigh-ins around 80kg last January, one today at
// 74.2. The old index-based average returned the mean of all seven.
const stale = [
  ...Array.from({ length: 6 }, (_, i) => [shift(TODAY, -220 + i * 3), 80.0]),
  [TODAY, 74.2],
];

test('a run of months-old weigh-ins does not drag the current trend', () => {
  const old = movingAvg(stale.map(([, v]) => v), 7).at(-1);
  assert.ok(Math.abs(old - 79.2) < 0.05, `old logic should give ~79.2, gave ${old}`);

  const now = trendWeightNow(stale, { today: TODAY });
  assert.strictEqual(now, 74.2, 'only the in-window reading should count');
});

test('the stale trend is what made the ETA wrong', () => {
  const args = { targetWeight: 73, weeklyRate: -0.3, working: true };
  const oldEta = etaWeeks({ ...args, curWeight: 79.2 });
  const newEta = etaWeeks({ ...args, curWeight: 74.2 });
  assert.ok(oldEta > 20, `stale weight gave ${oldEta}w`);
  assert.ok(newEta < 5,  `real weight gives ${newEta}w`);
});

test('nothing recent returns null, not a stale number', () => {
  const ancient = [[shift(TODAY, -200), 80], [shift(TODAY, -190), 79]];
  assert.strictEqual(trendWeightNow(ancient, { today: TODAY }), null);
});

test('a normal run of daily weigh-ins is unchanged by the fix', () => {
  const daily = Array.from({ length: 10 }, (_, i) => [shift(TODAY, -9 + i), 75 + i * 0.1]);
  const old = movingAvg(daily.map(([, v]) => v), 7).at(-1);
  assert.strictEqual(trendWeightNow(daily, { today: TODAY }), old,
    'dense recent data must give exactly what it always did');
});

test('the boundary day is inside the window', () => {
  const edge = [[shift(TODAY, -30), 90], [shift(TODAY, -31), 50]];
  assert.strictEqual(trendWeightNow(edge, { today: TODAY }), 90, 'day 30 in, day 31 out');
});

// ── an unknown sex is unknown, not male ─────────────────────────────────────
// bmr read `sex === 'female' ? -161 : 5`, so '', undefined and a profile that
// never answered all silently took the male constant. Onboarding pre-selected
// Male too, so the guess was invisible from both ends. 166 kcal of BMR becomes
// ~228 kcal/day of TDEE once the activity multiplier is applied — measured on
// one profile as 2085 vs 1857 maintenance, which is about half of a "steady"
// cut's entire deficit.
test('an estimate is refused rather than guessed when sex is missing', () => {
  const body = { weightKg: 79, heightCm: 165, age: 62, activity: 1.375 };
  assert.strictEqual(estimateTdee({ ...body }), null, 'undefined sex produced a number');
  assert.strictEqual(estimateTdee({ ...body, sex: '' }), null, "'' produced a number");
  assert.strictEqual(estimateTdee({ ...body, sex: 'unspecified' }), null);
});

test('both answers still work, and differ by the Mifflin sex constant', () => {
  const body = { weightKg: 79, heightCm: 165, age: 62, activity: 1.375 };
  const male   = estimateTdee({ ...body, sex: 'male' });
  const female = estimateTdee({ ...body, sex: 'female' });
  assert.strictEqual(male, 2085);
  assert.strictEqual(female, 1857);
  // 166 kcal of BMR x the activity multiplier, which is the whole point.
  assert.strictEqual(male - female, Math.round(166 * 1.375));
});

// The multiplier behind the "steady · ±N" band in Trends.
//
// It was 1.96 — the normal value — against a fit with n-2 degrees of freedom.
// That is fine on a month of daily weigh-ins and wrong on a sparse one, in the
// direction that matters: a band reported tighter than the data supports makes
// the app say "steady" and invite a goal change off a figure that had not
// earned it.
test('the maintenance band widens when there are few weigh-ins to fit', () => {
  // Five weigh-ins -> df 3. The band must be ~62% wider than the normal value,
  // not equal to it.
  assert.strictEqual(tCrit95(3), 3.182);
  assert.ok(tCrit95(3) > 1.96 * 1.6, 'a sparse fit is barely wider than normal');
  // A month of near-daily weigh-ins -> df 26, where the difference is small
  // and the old constant was defensible.
  assert.ok(tCrit95(26) > 1.96 && tCrit95(26) < 2.1, `df 26 gave ${tCrit95(26)}`);
});

test('the band stops shrinking once t and normal agree', () => {
  assert.strictEqual(tCrit95(29), 2.045);
  assert.strictEqual(tCrit95(30), 1.96);
  assert.strictEqual(tCrit95(500), 1.96);
});

test('too little data gets no critical value rather than a flattering one', () => {
  // Trends never asks below df 1 (slopeSE is null under three weigh-ins), but a
  // silent 0 or undefined here would print a band of +/-0 and read as certainty.
  assert.strictEqual(tCrit95(0), null);
  assert.strictEqual(tCrit95(-1), null);
  assert.strictEqual(tCrit95(NaN), null);
  assert.strictEqual(tCrit95(undefined), null);
});

test('the multiplier is monotonic — more data never widens the band', () => {
  for (let df = 2; df <= 29; df++) {
    assert.ok(tCrit95(df) <= tCrit95(df - 1),
      `df ${df} (${tCrit95(df)}) is wider than df ${df - 1} (${tCrit95(df - 1)})`);
  }
});

test('a fractional df never yields undefined, which would read as certainty', () => {
  // T95[3.5] is undefined. Returned as-is it multiplies to 0, and a band of
  // +/-0 both reads as certainty and passes the "steady" threshold that invites
  // a goal change. Floored, so it errs wide.
  assert.strictEqual(tCrit95(3.5), tCrit95(3));
  assert.strictEqual(tCrit95(29.9), tCrit95(29));
  for (const df of [1, 1.5, 3.7, 10.2, 28.8, 29.5, 30.1, 1000]) {
    const v = tCrit95(df);
    assert.ok(Number.isFinite(v) && v >= 1.96, `df ${df} gave ${v}`);
  }
});
