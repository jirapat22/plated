// `partial` names the macros whose total is a LOWER BOUND rather than a
// measurement, because something in the day didn't record that macro (a Quick
// Log with calories only is the usual reason). Optional: callers that don't
// pass it get exactly the old behaviour.
//
// What changes when a macro is partial:
//   • the number reads "202+", the ordinary way of writing "at least".
//   • "21g left" disappears. It is the one claim that cannot survive an unknown
//     — the missing grams could close the gap or blow past it.
//   • "+36g over" STAYS. A floor that is already past the goal proves you are
//     over; only the size of the excess is a minimum, which the + already says.
// opts.minInHeader: the caller already prints the protein minimum above the
// card (Today's "Macros" header does), so the row drops its "(min 120)" rather
// than say it twice on a 390px line. History has no such header and keeps it.
export function renderMacroBar(container, totals, goals, showRemaining = true, partial = null, opts = {}) {
  const macros = [
    { key: 'protein', label: 'Protein', color: 'var(--protein)' },
    { key: 'carbs',   label: 'Carbs',   color: 'var(--carbs)'   },
    { key: 'fat',     label: 'Fat',     color: 'var(--fat)'     },
    { key: 'fiber',   label: 'Fiber',   color: 'var(--fiber)'   },
  ];

  const rows = macros.map(m => {
    const consumed = Math.round(totals[m.key] ?? 0);   // whole grams — easier to read
    const goal     = Math.round(goals[m.key]  ?? 0);
    const pct      = goal > 0 ? Math.min((consumed / goal) * 100, 100) : 0;
    const remaining = goal - consumed;
    const over      = goal > 0 && consumed > goal;
    const unsure    = !!partial?.[m.key];
    // Bar is always the macro's own colour, un-touched. Once over goal, only
    // the excess SLICE of the (now fully-filled) bar glows — not the whole
    // thing — sized to how much of what's on the bar is the over-goal part.
    // e.g. 220g/191g goal → the last ~13% of the bar (29 of 220g) glows.
    const overSegPct = over ? ((consumed - goal) / consumed) * 100 : 0;

    // Protein can carry a MINIMUM under the goal (settings 'protein_min'): the
    // floor to hit every day, with the goal as the aim. Drawn as a tick on the
    // bar at the minimum's spot, and the label says which zone the day is in:
    //   under the min  -> "12g to min"   (the number that matters most)
    //   min..goal      -> "min ✓ · 20g to aim"
    //   over the goal  -> "+8g over", same as without a minimum.
    // Only when the min sits below the goal; otherwise it means nothing.
    const min = m.key === 'protein' ? Math.round(goals.proteinMin ?? 0) : 0;
    const hasMin = min > 0 && goal > 0 && min < goal;
    const minPct = hasMin ? (min / goal) * 100 : 0;
    const minLabel = !hasMin || over || unsure ? null
      : consumed < min
        ? `<span class="mb-warn">${min - consumed}g to min</span>`
        : `<span class="mb-hit">min ✓</span> · <span class="mb-rest">${remaining}g to aim</span>`;

    const rightLabel = (showRemaining && minLabel) ? minLabel
      : (showRemaining && goal > 0)
      ? over
        ? `<span class="mb-hit">+${consumed - goal}g over</span>`
        : unsure
          ? ''
          : `<span class="mb-rest">${remaining}g left</span>`
      : '';

    // Calm redesign (20/11/2026): the look lives in style.css (.mb-*) rather
    // than inline, so light/dark/high-contrast all come from the theme tokens
    // and History and Today stay identical. The TEXT is unchanged on purpose:
    // the tests read it with the tags stripped ("Protein 99 / 166g · 67g left").
    // Only the colours that mean "which macro" stay inline, via --mb.
    return `
      <div class="mb-row" style="--mb:${m.color}">
        <div class="mb-head">
          <span class="mb-name">${m.label}</span>
          <span class="mb-val">
            <strong>${consumed}${unsure ? '+' : ''}</strong><span class="mb-goal">${goal > 0 ? ` / ${goal}g` : 'g'}${hasMin && !opts.minInHeader ? ` (min ${min})` : ''}</span>${rightLabel ? ` · ${rightLabel}` : ''}
          </span>
        </div>
        <div class="mb-track">
          <div class="mb-fill" style="width:${pct}%"></div>
          ${hasMin ? `<div class="mb-tick" title="Minimum ${min}g" style="left:calc(${minPct}% - 1px)"></div>` : ''}
          ${over ? `<div class="mb-over" style="width:${overSegPct}%"></div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // One line for the whole card rather than a repeated caveat on every row —
  // the reason is the same for all of them, and four copies of it would crowd a
  // 390px screen without saying anything the first one didn't.
  //
  // "the day's meals", not "today": History renders this same component for any
  // past day, where "a meal today" is simply the wrong day. Wording that is true
  // on both surfaces beats a parameter telling it which one it is on.
  const anyPartial = macros.some(m => partial?.[m.key]);
  const note = anyPartial
    ? `<div class="mb-note">+ means at least this much: one of the day's meals didn't record every macro.</div>`
    : '';

  container.innerHTML = rows + note;
}
