export function renderMacroBar(container, totals, goals, showRemaining = true) {
  const macros = [
    { key: 'protein', label: 'Protein', color: 'var(--protein)' },
    { key: 'carbs',   label: 'Carbs',   color: 'var(--carbs)'   },
    { key: 'fat',     label: 'Fat',     color: 'var(--fat)'     },
    { key: 'fiber',   label: 'Fiber',   color: 'var(--fiber)'   },
  ];

  container.innerHTML = macros.map(m => {
    const consumed = Math.round(totals[m.key] ?? 0);   // whole grams — easier to read
    const goal     = Math.round(goals[m.key]  ?? 0);
    const pct      = goal > 0 ? Math.min((consumed / goal) * 100, 100) : 0;
    const remaining = goal - consumed;
    const over      = goal > 0 && consumed > goal;
    // Over goal = the SAME macro colour, unchanged, plus a glow — no filter.
    // brightness()/saturate() pushed every colour toward white, and since
    // Carbs (#FFA726) and Fat (#FFCA28) start out close in hue, boosted they
    // both clipped to the same washed-out yellow. A glow doesn't touch the
    // fill colour at all, so hues stay distinct and the "whole bar" doesn't
    // turn into one big bright block — just gets an edge that pops.
    const glow = over ? `box-shadow:0 0 5px 1px ${m.color};` : '';

    const rightLabel = (showRemaining && goal > 0)
      ? over
        ? `<span style="color:${m.color};font-weight:700">+${consumed - goal}g over</span>`
        : `<span style="color:var(--text-faint)">${remaining}g left</span>`
      : '';

    return `
      <div style="margin-bottom:11px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:13px;font-weight:700;color:${m.color}">${m.label}</span>
          <span style="font-size:13px;font-variant-numeric:tabular-nums">
            <strong style="color:${m.color}">${consumed}</strong><span style="color:var(--text-faint)">${goal > 0 ? ` / ${goal}g` : 'g'}</span>${rightLabel ? ` · ${rightLabel}` : ''}
          </span>
        </div>
        <div style="height:9px;background:var(--surface-2);border-radius:999px">
          <div style="height:100%;width:${pct}%;background:${m.color};border-radius:999px;transition:width 600ms ease-out;${glow}"></div>
        </div>
      </div>
    `;
  }).join('');
}
