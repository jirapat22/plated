import { api }                            from '../api.js';
import { showToast, accentInk }            from '../app.js';
import { openFoodEntry, openQuickLog, renderMealCard, lazySession } from './log.js';
import { renderMacroBar }                  from '../components/macroBar.js';
import { fmtE, unitLabel } from '../utils/energy.js';
import { localDate }                       from '../utils/date.js';
import { classifyDay, isFlagged, LOG_STRONG } from '../utils/logCheck.js';
import { assert } from '../utils/bugReport.js';
import { movingAvg } from '../utils/stats.js';
import { openOnboarding } from '../components/onboarding.js';

const CIRC = 2 * Math.PI * 60;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Line icons (match the bottom-nav's hand-drawn stroke style) ───────────
// valign: only needed where the icon sits inline next to text in a non-flex
// container (label spans, ring-center divs) — flex parents already center
// their children and ignore vertical-align, so omit it there.
function icon(path, size = 16, valign = null) {
  const style = valign != null ? `vertical-align:${valign}px;flex-shrink:0` : 'flex-shrink:0';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="${style}">${path}</svg>`;
}
const ICON_SCALE       = '<rect x="3" y="9" width="18" height="12" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M8 9a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.7"/><path d="M12 12v3.2M12 12l2.6 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
const ICON_BOLT        = '<path d="M13 2 5 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>';
const ICON_FLAME       = '<path d="M12 2.5c1.2 3.6-3.4 5-3.4 8.7a3.4 3.4 0 0 0 6.8 0c0-1-.5-1.8-.5-1.8s.3 1.6-.8 2c.9-2.6-1.7-3.4-2.1-8.9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
const ICON_CHART       = '<path d="M4 19V9M9.5 19V5M15 19v-7M20 19V3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
const ICON_TREND_DOWN  = '<path d="M5 6l14 14M19 13v7h-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_TREND_UP    = '<path d="M5 18 19 4M12 4h7v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';

// Graduation ticks around the ring track — a bezel detail (à la a kitchen
// scale's dial), drawn just outside the stroke band so they read as markings
// rather than competing with the progress arc.
function ringTicks(count = 12) {
  let marks = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    const x1 = 70 + 66 * Math.cos(a), y1 = 70 + 66 * Math.sin(a);
    const x2 = 70 + 70 * Math.cos(a), y2 = 70 + 70 * Math.sin(a);
    marks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return marks;
}

// Build one calorie ring SVG. variant: '' (goal, accent) | 'workout' | 'target'.
// overflowPct (0-100): the exceeded portion, drawn on top in the darker --over
// colour so only the slice past the goal is dark, not the whole ring.
// ticks: draw the dial-bezel graduations — reserved for the primary ring so
// the two side rings stay clean at their smaller physical size.
function calRingSvg(pct, variant = '', small = false, overflowPct = 0, ticks = false) {
  const base = (Math.min(pct, 100) / 100) * CIRC;
  const over = (Math.min(Math.max(overflowPct, 0), 100) / 100) * CIRC;
  return `
    <svg class="calorie-ring${small ? ' ring-sm' : ''}" viewBox="0 0 140 140">
      ${ticks ? ringTicks() : ''}
      <circle class="ring-bg" cx="70" cy="70" r="60"/>
      <circle class="ring-fill ${variant}" cx="70" cy="70" r="60"
        style="stroke-dasharray:${base} ${CIRC}"/>
      ${over > 0 ? `<circle class="ring-fill ${variant} ring-over" cx="70" cy="70" r="60"
        style="stroke-dasharray:${over} ${CIRC}"/>` : ''}
    </svg>`;
}

function timeAgo(iso) {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function fetchIronLog(dateStr) {
  try {
    const data = await api.get(`/api/ironlog/today?date=${dateStr}&tz=${new Date().getTimezoneOffset()}`);
    if (data.connected) return data;
    return data.last_synced ? { ...data, _stale: true } : null;
  } catch { return null; }
}

// ── Main render ──────────────────────────────────────────────
export function renderToday(container) {
  container.classList.add('today-view');
  // Today is always today. Other days live in History — no day-switching here,
  // which also kills the accidental swipe-to-change-day. viewDate is re-read
  // from localDate() on every load so it rolls over correctly past midnight.
  let viewDate      = localDate();
  let ironlogExpanded = false;
  let loadGen = 0;             // increments on each load; stale responses discarded
  let onboardingShown = false; // first-run sheet fires at most once per mount

  async function load() {
    viewDate = localDate();
    const myGen = ++loadGen;
    try {
      const [mealData, settings, todayWeight, weightHistory] = await Promise.all([
        api.get(`/api/meals/day/${viewDate}`),
        api.get('/api/settings'),
        api.get(`/api/weight/day/${viewDate}`).catch(() => null),
        api.get('/api/weight?limit=10').catch(() => []),
      ]);
      if (myGen !== loadGen) return;            // a newer load() superseded us
      // Paint your own data now. Awaiting IronLog here made it a SECOND
      // sequential round trip from the phone — the four calls above finish, then
      // Today sits on its skeleton for another full trip before showing meals it
      // already holds. IronLog itself measures 20-94ms from Railway, so this
      // isn't about a slow service: it's the extra serialised leg over mobile
      // data, bounded only by the route's 6s timeout when the other end stalls.
      render(mealData, settings, null, todayWeight, weightHistory);

      // First run. Fired after the first paint so the app is visibly there
      // behind the sheet rather than a wizard over a blank screen. Once only —
      // the flow writes onboarded='1' whether it's completed or skipped.
      //
      // This MUST stay above the IronLog await. It used to sit below, after the
      // `!ironlog` guard — and fetchIronLog returns null whenever IronLog isn't
      // configured, which is true of every brand-new profile by definition. So
      // the guard returned first and the first-run flow never ran for a single
      // one of the users it exists for.
      if (settings.onboarded === '0' && !onboardingShown) {
        onboardingShown = true;
        openOnboarding(() => load());
      }

      const ironlog = await fetchIronLog(viewDate);   // always today — fetch fresh
      if (myGen !== loadGen || !ironlog) return;      // superseded, or nothing to add
      // ponytail: a second full render rather than patching just the IronLog
      // panel — one extra paint on the slow path. Make it surgical if it ever
      // interrupts a scroll.
      render(mealData, settings, ironlog, todayWeight, weightHistory);
    } catch (err) {
      if (myGen !== loadGen) return;
      container.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(mealData, settings, ironlog, todayWeight, weightHistory = []) {
    const today  = localDate();
    const isToday = viewDate === today;
    const ul     = unitLabel();
    const goals  = {
      cal:    parseFloat(settings.calorie_goal)  || 2000,
      protein:parseFloat(settings.protein_goal)  || 150,
      carbs:  parseFloat(settings.carb_goal)      || 250,
      fat:    parseFloat(settings.fat_goal)        || 65,
      fiber:  parseFloat(settings.fiber_goal)      || 30,
    };
    const t         = mealData.totals;

    // ── "Did you fully log this day?" check (past days only) ──
    const mealCount = (mealData.sessions || []).filter(s => (s.entries?.length || 0) > 0).length;
    const dayStatus = classifyDay(
      { date: viewDate, calories: t.calories, meal_count: mealCount, log_status: mealData.log_status },
      goals.cal, today
    );
    const showLogCheck = isFlagged(dayStatus);   // never true for today/future

    // Foods logged without calorie data add 0 kcal — they make the total look
    // low even though you logged them. Estimate the missing kcal from macros.
    const noCalNames = [];
    let missingKcalEst = 0;
    for (const sess of (mealData.sessions || [])) {
      for (const e of (sess.entries || [])) {
        const macros = (e.protein || 0) + (e.carbs || 0) + (e.fat || 0);
        if ((e.calories || 0) === 0 && macros > 0) {
          noCalNames.push(e.food_name);
          missingKcalEst += Math.round(4 * (e.protein || 0) + 4 * (e.carbs || 0) + 9 * (e.fat || 0));
        }
      }
    }
    const showNoCal = noCalNames.length > 0;

    // ── Calorie rings ────────────────────────────────────────
    // Middle = base goal; right = workout earned; left = goal + workout.
    // Eaten fills the base goal first, then spills into the workout ring.
    const burned      = ironlog?.calories_burned ?? 0;
    const baseGoal    = goals.cal;                  // phase calorie goal (e.g. 2207)
    const combined    = baseGoal + burned;          // eat target incl. workout
    const hasWorkout  = burned > 0;
    const eaten       = t.calories;
    const net         = eaten - burned;

    // Sanity invariants — surface "impossible state" data bugs (NaN totals,
    // bad IronLog values) that wouldn't otherwise throw.
    assert(Number.isFinite(eaten) && eaten >= 0, "today's calorie total isn't a valid number", { eaten });
    assert(Number.isFinite(burned) && burned >= 0, 'IronLog burned is not a valid number', { burned });

    const midPct   = Math.min(eaten / baseGoal, 1) * 100;            // middle: eaten vs goal
    const rightFill= Math.max(0, Math.min(eaten - baseGoal, burned)); // overflow into workout
    const rightPct = burned > 0 ? (rightFill / burned) * 100 : 0;     // right: overflow vs burned
    const leftPct  = Math.min(eaten / combined, 1) * 100;            // left: eaten vs combined
    // Exceeded slices — only this portion of the ring is drawn dark.
    const midOver  = baseGoal > 0 ? Math.max(0, (eaten - baseGoal) / baseGoal) * 100 : 0;
    const leftOver = combined > 0 ? Math.max(0, (eaten - combined) / combined) * 100 : 0;

    // Hint speaks to the real budget (combined when a workout exists)
    const budget    = hasWorkout ? combined : baseGoal;
    const remaining = budget - eaten;
    const hintText  = eaten === 0 ? 'nothing yet'
      : remaining > 50  ? `${fmtE(remaining)} left`
      : remaining < -50 ? `+${fmtE(-remaining)} over`
      : '✓ goal hit';
    // "N left" used to render in --text-faint, the dimmest token there is —
    // quieter than the goal printed above it, for the one number on the card
    // you actually act on. Full contrast now; over/hit keep their own colours
    // because those carry meaning. The empty state stays muted: "nothing yet"
    // isn't a number to act on, and it shouldn't shout next to a big 0.
    const hintColor = eaten === 0      ? 'var(--text-muted)'
                    : remaining < -50  ? 'var(--over)'
                    : remaining < 50   ? 'var(--success)'
                    : 'var(--text)';

    // ── Concerns: one glanceable row of "what needs attention" ──
    // Protein is a floor you're trying to reach, not a ceiling to stay under —
    // flagging "Protein +12g" as a warning meant the row lit up on the days you
    // ate best, which trains you to ignore it. So: short on protein late in the
    // day is worth saying; over is not. Carbs/fat over the split is already
    // covered by the calorie chip — three more chips restating it is noise.
    const lateInDay = new Date().getHours() >= 19;
    const proteinShort = Math.round(goals.protein - t.protein);
    const concerns = [];
    if (showNoCal)        concerns.push({ t: `${noCalNames.length} food${noCalNames.length === 1 ? '' : 's'} no calories`, kind: 'bad' });
    if (eaten > combined) concerns.push({ t: `+${fmtE(eaten - combined)} ${ul} over`, kind: 'warn' });
    if (lateInDay && eaten > 0 && proteinShort >= 10) {
      concerns.push({ t: `Protein ${proteinShort}g short`, kind: 'warn' });
    }
    const showConcernRow = concerns.length > 0 || eaten > 0;

    // IronLog summary for the collapsed row.
    // This used to recompute its own target as tdee − deficit, which put a
    // second, different calorie number on the same screen as the ring whenever
    // an IronLog sync had written calorie_goal directly (it doesn't go through
    // the phase math). One target now: calorie_goal, same as the ring and
    // everything downstream. Settings flags a divergence and offers the fix.
    const diff       = net - baseGoal;
    const onTrack    = Math.abs(diff) <= 150;
    const phaseLabel = eaten === 0
      ? (settings.phase || 'maintain').toUpperCase()
      : onTrack ? 'On track ✓' : diff > 0 ? `+${fmtE(diff)} ${ul} over` : `${fmtE(-diff)} ${ul} under`;

    // Trend weight — 7-day smoothed average as of today (same movingAvg used
    // on the Trends weight chart), an optional alternate to the raw logged
    // value. weight_display in Settings ('raw' default, 'trend') picks which
    // one leads on the collapsed card; the other is still one tap away.
    // Dedupe to one value per date (same approach as Trends) before averaging,
    // so a same-day re-log doesn't double-count that day in the window.
    const weightByDate = {};
    for (const w of weightHistory) weightByDate[w.date] = w.weight_kg;
    const weightsAsc  = Object.keys(weightByDate).sort().map(d => weightByDate[d]);
    const trendSeries = weightsAsc.length >= 2 ? movingAvg(weightsAsc, 7) : null;
    const trendWeight = trendSeries ? trendSeries[trendSeries.length - 1] : null;
    // Trend leads by default now; 'raw' only when explicitly chosen. A single
    // weigh-in swings ~2kg on water — this user went 77.2 → 75.25 in two days —
    // and the headline number is what gets reacted to. The trend is the one
    // worth reacting to, so it's the one shown big.
    const weightDisplay = settings.weight_display === 'raw' || trendWeight == null ? 'raw' : 'trend';
    const rawToday = todayWeight?.weight_kg
      ?? (isToday && ironlog?.bodyweight?.is_today ? ironlog.bodyweight.weight_kg : null);
    const weightBigHtml = weightDisplay === 'trend'
      ? `${trendWeight.toFixed(1)} <span style="font-size:11px;color:var(--accent);font-weight:400">kg · 7d trend</span>`
      : todayWeight
        ? `${todayWeight.weight_kg} <span style="font-size:11px;color:var(--text-muted);font-weight:400">kg · today ✓</span>`
        : (isToday && ironlog?.bodyweight)
          ? `${ironlog.bodyweight.weight_kg} <span style="font-size:11px;color:var(--accent);font-weight:400">kg ${icon(ICON_BOLT, 10, -1)} ${ironlog.bodyweight.is_today ? 'today' : ironlog.bodyweight.date}</span>`
          : '';
    const weightToggleHtml = trendWeight != null ? `
      <div style="display:flex;gap:4px;margin-top:10px">
        <button class="eunit-btn wt-display-btn${weightDisplay !== 'trend' ? ' active' : ''}" data-display="raw" style="height:26px;padding:0 10px;font-size:10px">Raw</button>
        <button class="eunit-btn wt-display-btn${weightDisplay === 'trend' ? ' active' : ''}" data-display="trend" style="height:26px;padding:0 10px;font-size:10px">Trend (${trendWeight.toFixed(1)} kg)</button>
      </div>` : '';

    container.innerHTML = `
      <!-- Header -->
      <div class="today-header" style="padding-bottom:4px">
        <div>
          <div class="today-date">Today</div>
          <div class="today-day">${new Date(viewDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${phaseBadge(settings.phase)}
        </div>
      </div>

      <!-- Concerns: at-a-glance "what to be aware of" -->
      ${showConcernRow ? `
      <div style="padding:0 16px 6px">
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          ${concerns.length
            ? concerns.map(c => `<span class="concern-chip ${c.kind}">${c.kind === 'bad' ? '⚠ ' : ''}${esc(c.t)}</span>`).join('')
            : `<span class="concern-chip good">✓ Nothing to flag</span>`}
        </div>
        ${showNoCal ? `<div style="font-size:11px;color:var(--text-faint);margin-top:6px">${noCalNames.slice(0, 3).map(esc).join(', ')}${noCalNames.length > 3 ? ` +${noCalNames.length - 3}` : ''} — add calories in Foods (~${fmtE(missingKcalEst)} ${ul} uncounted).</div>` : ''}
      </div>` : ''}

      <!-- "Did you forget to log?" check -->
      ${showLogCheck ? `
      <div style="padding:0 16px 10px">
        <div class="logcheck-banner">
          <div class="logcheck-text">
            <div class="logcheck-title">${dayStatus === LOG_STRONG ? '⚠️ This day looks under-logged' : '🤔 Did you log everything?'}</div>
            <div class="logcheck-sub">Only ${mealCount} meal${mealCount === 1 ? '' : 's'} · ${fmtE(t.calories)} ${ul} — that's low for your goal. Forgot something, or just a light day?</div>
          </div>
          <div class="logcheck-actions">
            <button class="btn btn-secondary logcheck-add">Add a meal</button>
            <button class="btn btn-ghost logcheck-light">I ate light</button>
          </div>
        </div>
      </div>` : ''}

      <!-- Calorie ring(s) -->
      <div style="padding:0 16px 14px">
        <div class="card">
          <div class="tri-rings">
            <div class="ring-col">
              <div class="ring-title">Eat Target</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(leftPct, 'target', true, leftOver)}
                <div class="ring-center">
                  <div class="num ring-kcal-sm">${fmtE(eaten)}</div>
                  <div class="ring-goal-sm">/ ${fmtE(combined)}</div>
                </div>
              </div>
            </div>
            <div class="ring-col">
              <div class="ring-title">Daily Goal</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(midPct, '', false, midOver, true)}
                <div class="ring-center">
                  <div class="num ring-kcal">${fmtE(eaten)}</div>
                  <div class="ring-goal muted">/ ${fmtE(baseGoal)} ${ul}</div>
                  <div class="ring-hint" style="color:${hintColor}">${hintText}</div>
                </div>
              </div>
            </div>
            <div class="ring-col">
              <div class="ring-title">Workout</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(rightPct, 'workout', true, 0)}
                <div class="ring-center">
                  <div class="num ring-kcal-sm">${fmtE(burned)} ${icon(ICON_FLAME, 12, -2)}</div>
                  <div class="ring-goal-sm">${hasWorkout ? 'burned' : 'rest day'}</div>
                </div>
              </div>
            </div>
          </div>
          <div id="macro-bar-root" style="margin-top:12px"></div>
        </div>
      </div>

      <!-- Bodyweight — collapses to a slim row whenever there's a value to show
           (manual weigh-in, IronLog, or a computed trend); the logger and the
           raw/trend toggle sit behind the chevron. Full logger only when
           there's nothing to show at all. -->
      <div style="padding:0 16px 14px">
        ${weightBigHtml ? `
        <details class="card nl-details">
          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="label">${icon(ICON_SCALE, 13, -3)} Bodyweight</span>
            <span class="num" style="margin-left:auto;font-size:15px;font-weight:700">${weightBigHtml}</span>
            <span class="nl-chev" style="font-size:9px;color:var(--text-faint)">▾</span>
          </summary>
          ${weightDisplay === 'trend' && rawToday != null
            ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Today's reading ${rawToday} kg${
                Math.abs(rawToday - trendWeight) >= 0.6
                  ? ` · <span style="color:var(--text-faint)">${(rawToday - trendWeight > 0 ? '+' : '')}${(rawToday - trendWeight).toFixed(1)} vs trend, mostly water</span>`
                  : ''}</div>`
            : ''}
          ${weightToggleHtml}
          <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:12px">
            ${!todayWeight ? `<span style="font-size:11px;color:var(--warning);margin-right:auto;font-weight:600">Not weighed today — log it here</span>` : ''}
            <input id="wt-inline" type="text" inputmode="decimal" placeholder="kg"
              style="width:74px;height:40px;text-align:center;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--surface-2);border:1.5px solid ${todayWeight ? 'var(--border)' : 'var(--accent)'};border-radius:var(--radius-sm);color:var(--text);outline:none"/>
            <button id="wt-inline-save" class="btn btn-primary" style="height:40px;padding:0 14px;font-size:13px">${todayWeight ? 'Update' : 'Log'}</button>
          </div>
        </details>` : `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="min-width:0">
            <div class="label">${icon(ICON_SCALE, 13, -3)} Bodyweight</div>
            <div style="font-size:12px;color:var(--warning);margin-top:3px;font-weight:600">Not weighed today — log it here →</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
            <input id="wt-inline" type="text" inputmode="decimal" placeholder="kg"
              style="width:74px;height:40px;text-align:center;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--surface-2);border:1.5px solid var(--accent);border-radius:var(--radius-sm);color:var(--text);outline:none"/>
            <button id="wt-inline-save" class="btn btn-primary" style="height:40px;padding:0 14px;font-size:13px">Log</button>
          </div>
        </div>`}
      </div>

      <!-- IronLog (collapsible) -->
      ${ironlog ? `
      <div style="padding:0 16px 14px">
        <button id="ironlog-toggle" class="card" style="width:100%;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
            ${ironlog ? `<span style="color:var(--accent)">${icon(ICON_BOLT, 13)}</span>` : `<span style="color:var(--text-faint)">${icon(ICON_CHART, 13)}</span>`}
            <span style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${burned > 0 ? `Burned ${fmtE(burned)} ${ul} · ` : ''}${phaseLabel}
            </span>
          </div>
          <span class="il-chevron" style="color:var(--text-faint);font-size:13px;flex-shrink:0">${ironlogExpanded ? '▲' : '▼'}</span>
        </button>
        <div id="ironlog-details" style="display:${ironlogExpanded ? 'block' : 'none'}">
          <div class="card ironlog-panel" style="margin-top:4px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span class="label">${icon(ICON_BOLT, 13, -3)} IronLog</span>
              ${ironlog.last_synced ? `<span style="font-size:11px;color:var(--text-faint)">${ironlog._stale ? '⚠ cached · ' : ''}${timeAgo(ironlog.last_synced)}</span>` : ''}
            </div>
            <div class="ironlog-row">
              <span class="muted">Burned</span>
              <span class="num">${fmtE(burned)} ${ul}</span>
            </div>
            <div class="ironlog-row">
              <span class="muted">Net</span>
              <span class="num">${fmtE(net)} ${ul}</span>
            </div>
          </div>
        </div>
      </div>` : ''}

      <!-- Meals -->
      <div class="section-header">
        <h2>Meals</h2>
      </div>
      <div id="meals-list"></div>
      <div style="display:flex;gap:8px;margin:8px 16px 16px">
        <button class="new-meal-btn" id="new-meal-btn" style="margin:0;flex:1">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          New Meal
        </button>
        <button class="new-meal-btn" id="quick-log-standalone" style="margin:0;flex:1;color:var(--carbs);border-color:var(--carbs)44">
          ${icon(ICON_BOLT, 14)} Quick Log
        </button>
      </div>

      <button class="fab-log" id="fab-log" aria-label="Log food">
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        Log
      </button>
    `;

    // Render macro bar
    renderMacroBar(document.getElementById('macro-bar-root'), t, goals);

    // Render sessions
    const mealsList = document.getElementById('meals-list');
    if (mealData.sessions.length === 0) {
      mealsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🍽</div><div class="empty-text">No meals yet</div></div>';
    } else {
      mealData.sessions.forEach(session => {
        mealsList.appendChild(renderMealCard(session, viewDate, {
          showTime: true,
          showMoveToday: false,   // always today — nothing to "move to today"
          showPullIn: true,
          showQuickLog: true,
        }, () => load()));
      });
    }

    // Log-check banner: add a meal, or confirm "I ate light"
    document.querySelector('.logcheck-add')?.addEventListener('click', () =>
      openFoodEntry(lazySession(viewDate), () => load()));
    document.querySelector('.logcheck-light')?.addEventListener('click', async () => {
      try {
        await api.post('/api/meals/log-status', { date: viewDate, status: 'confirmed' });
        showToast('Got it — counted as a light day', 'success');
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });

    // IronLog toggle
    document.getElementById('ironlog-toggle')?.addEventListener('click', () => {
      ironlogExpanded = !ironlogExpanded;
      const det = document.getElementById('ironlog-details');
      const chev = document.getElementById('ironlog-toggle').querySelector('.il-chevron');
      if (det) det.style.display = ironlogExpanded ? 'block' : 'none';
      if (chev) chev.textContent = ironlogExpanded ? '▲' : '▼';
    });

    // Weight — inline save (Enter or tap). Always logs to today's local date.
    // If today already has an entry, PATCH it instead of POSTing a new one —
    // POST always inserts (no unique constraint on date), so re-tapping
    // "Update" used to create a second row for the same day, which then
    // showed as a phantom duplicate in Trends' weigh-ins list and made the
    // trend/verdict math read from whichever duplicate SQLite happened to
    // return first (undefined for same-date ties).
    const wtInput = document.getElementById('wt-inline');
    const saveWeight = async () => {
      const weight_kg = parseFloat(wtInput.value);
      if (!weight_kg || weight_kg <= 0) { showToast('Enter a valid weight', 'error'); wtInput.focus(); return; }
      const btn = document.getElementById('wt-inline-save');
      btn.disabled = true; btn.textContent = '…';
      try {
        if (todayWeight) await api.patch(`/api/weight/${todayWeight.id}`, { weight_kg });
        else             await api.post('/api/weight', { weight_kg, date: viewDate });
        showToast('Weight logged', 'success');
        load();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = todayWeight ? 'Update' : 'Log';
      }
    };
    document.getElementById('wt-inline-save').addEventListener('click', saveWeight);
    wtInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveWeight(); });

    // Raw / trend display toggle — a per-profile preference, not a one-off UI
    // flip, so it stays put across visits and other views could read it too.
    document.querySelectorAll('.wt-display-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.patch('/api/settings', { weight_display: btn.dataset.display });
          load();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    // The floating button and Quick Log defer creating the meal until something
    // actually goes into it (see lazySession), so dismissing leaves nothing.
    document.getElementById('fab-log').addEventListener('click', () =>
      openFoodEntry(lazySession(viewDate), () => load()));
    document.getElementById('quick-log-standalone').addEventListener('click', () =>
      openQuickLog(lazySession(viewDate), () => load()));

    // "New Meal" is the one button whose job IS to create the meal, so it does
    // it eagerly and you get a real card to name and fill over the day. It also
    // opens the food sheet straight away rather than making you find the card's
    // own Add Food button, which was the original complaint.
    document.getElementById('new-meal-btn').addEventListener('click', async () => {
      try {
        const session = await api.post('/api/meals/sessions', { date: viewDate });
        openFoodEntry(session.id, () => load(), { sessionName: session.name });
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });

    // The FAB is right-aligned and fixed, and the New Meal / Quick Log row is
    // the last thing on the page — so scrolling to the bottom parked "+ Log"
    // directly on top of "Quick Log", covering a button with a button that
    // does nearly the same thing. The FAB earns its place while you're scrolled
    // up, past the rings and cards; down here that row already is the answer.
    // So it tucks away while the row is on screen and comes back when it isn't.
    fabObserver?.disconnect();
    const row = document.getElementById('new-meal-btn')?.parentElement;
    const fab = document.getElementById('fab-log');
    if (row && fab && 'IntersectionObserver' in window) {
      fabObserver = new IntersectionObserver(
        ([e]) => fab.classList.toggle('tucked', e.isIntersecting),
        { root: document.getElementById('view-container'), threshold: 0.15 },
      );
      fabObserver.observe(row);
    }
  }

  let fabObserver = null;
  const onSettingsChanged = () => load();
  window.addEventListener('plated:settings-changed', onSettingsChanged);
  container.innerHTML = buildSkeleton();
  load();

  return () => {
    window.removeEventListener('plated:settings-changed', onSettingsChanged);
    fabObserver?.disconnect();   // it holds a node from a view that's being torn down
  };
}

function phaseBadge(phase) {
  const map = {
    cut:      { glyph: ICON_TREND_DOWN, color: '#ff6b6b' },
    maintain: { glyph: ICON_SCALE,      color: '#5dca8a' },
    bulk:     { glyph: ICON_TREND_UP,   color: '#c8b8ff' },
  };
  const { glyph, color } = map[phase] || map.maintain;
  // Tint and border stay at the raw hex (they're 9%/27% washes, fine on either
  // ground); only the text runs through accentInk so it darkens in light mode.
  return `<span style="font-size:11px;font-weight:700;color:${accentInk(color)};background:${color}18;padding:3px 10px;border-radius:999px;border:1px solid ${color}44;display:inline-flex;align-items:center;gap:4px">${icon(glyph, 12)} ${(phase||'maintain').toUpperCase()}</span>`;
}

// phaseProgressCard lived here: net-vs-target with its own progress bar. It was
// the same comparison the "Eat Target" ring already draws (eaten vs goal+burned
// ≡ net vs goal), against a target it recomputed itself — so the two could and
// did disagree. Deleted rather than reconciled; one ring says it once.

function buildSkeleton() {
  return `
    <div style="padding:20px 16px 8px"><div class="skeleton skel-line" style="width:160px;height:24px"></div></div>
    <div style="padding:0 16px 8px"><div class="card">
      <div class="skeleton" style="width:140px;height:140px;border-radius:50%;margin:0 auto 16px"></div>
      <div class="skeleton skel-line"></div><div class="skeleton skel-line" style="width:70%;margin-top:6px"></div>
    </div></div>`;
}
