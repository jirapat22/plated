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
    // Same language as the calorie ring: overflow expressed as % of goal,
    // drawn as an --over overlay on top of the base fill rather than
    // recolouring the whole bar — otherwise every over-goal macro turns the
    // same generic amber and you can't tell Protein's bar from Fat's.
    const overPct   = over ? Math.min(((consumed - goal) / goal) * 100, 100) : 0;

    const rightLabel = (showRemaining && goal > 0)
      ? over
        ? `<span style="color:var(--over);font-weight:600">+${consumed - goal}g over</span>`
        : `<span style="color:var(--text-faint)">${remaining}g left</span>`
      : '';

    return `
      <div style="margin-bottom:11px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:13px;font-weight:700;color:${m.color}">${m.label}</span>
          <span style="font-size:13px;font-variant-numeric:tabular-nums">
            <strong style="color:${over ? 'var(--over)' : 'var(--text)'}">${consumed}</strong><span style="color:var(--text-faint)">${goal > 0 ? ` / ${goal}g` : 'g'}</span>${rightLabel ? ` · ${rightLabel}` : ''}
          </span>
        </div>
        <div style="height:9px;background:var(--surface-2);border-radius:999px;overflow:hidden;position:relative">
          <div style="height:100%;width:${pct}%;background:${m.color};border-radius:999px;transition:width 600ms ease-out"></div>
          ${over ? `<div style="position:absolute;top:0;left:0;height:100%;width:${overPct}%;background:var(--over);border-radius:999px 0 0 999px"></div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
