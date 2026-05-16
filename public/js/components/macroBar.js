export function renderMacroBar(container, totals, goals, showRemaining = true) {
  const macros = [
    { key: 'protein', label: 'Protein', color: 'var(--protein)' },
    { key: 'carbs',   label: 'Carbs',   color: 'var(--carbs)'   },
    { key: 'fat',     label: 'Fat',     color: 'var(--fat)'     },
    { key: 'fiber',   label: 'Fiber',   color: 'var(--fiber)'   },
  ];

  container.innerHTML = macros.map(m => {
    const consumed = totals[m.key]  ?? 0;
    const goal     = goals[m.key]   ?? 0;
    const pct      = goal > 0 ? Math.min((consumed / goal) * 100, 100) : 0;
    const remaining = goal - consumed;
    const over      = goal > 0 && consumed > goal;

    const rightLabel = (showRemaining && goal > 0)
      ? over
        ? `<span style="color:var(--warning)">+${(consumed - goal).toFixed(1)}g over</span>`
        : `<span style="color:var(--text-faint)">${remaining.toFixed(1)}g left</span>`
      : '';

    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:12px;font-weight:600;color:${m.color}">${m.label}</span>
          <span style="font-size:12px;font-variant-numeric:tabular-nums">
            <strong style="color:${m.color}">${consumed.toFixed(1)}g</strong>
            ${goal > 0 ? `<span style="color:var(--text-faint)"> / ${goal}g</span>` : ''}
            ${rightLabel ? ` · ${rightLabel}` : ''}
          </span>
        </div>
        <div style="height:7px;background:var(--surface-2);border-radius:999px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${m.color};border-radius:999px;transition:width 600ms ease-out"></div>
        </div>
      </div>
    `;
  }).join('');
}
