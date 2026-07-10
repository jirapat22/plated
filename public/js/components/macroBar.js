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
    // Bar is always the macro's own colour, un-touched. Once over goal, only
    // the excess SLICE of the (now fully-filled) bar glows — not the whole
    // thing — sized to how much of what's on the bar is the over-goal part.
    // e.g. 220g/191g goal → the last ~13% of the bar (29 of 220g) glows.
    const overSegPct = over ? ((consumed - goal) / consumed) * 100 : 0;

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
        <div style="height:9px;background:var(--surface-2);border-radius:999px;position:relative">
          <div style="height:100%;width:${pct}%;background:${m.color};border-radius:999px;transition:width 600ms ease-out"></div>
          ${over ? `<div style="position:absolute;top:0;right:0;height:100%;width:${overSegPct}%;background:${m.color};filter:brightness(1.3) saturate(1.3);box-shadow:0 0 8px 2px ${m.color};border-left:2px solid rgba(255,255,255,.6);border-radius:0 999px 999px 0"></div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
