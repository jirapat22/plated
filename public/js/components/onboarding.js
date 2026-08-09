import { api }                      from '../api.js';
import { showSheet, hideSheet, showToast } from '../app.js';
import { estimateTdee, ACTIVITY }   from '../utils/stats.js';
import { fmtE, unitLabel }          from '../utils/energy.js';
import { localDate }                from '../utils/date.js';

// First run. A new profile is seeded with a 2,000 kcal goal and 150/250/65 g of
// macros — figures that belong to nobody, presented with the same confidence as
// a number you chose. Worse, they're incoherent: everywhere else in the app
// calorie_goal = tdee − deficit, but the seed ships a goal with no TDEE at all.
//
// Three steps, because that's the minimum that produces a real number: who you
// are (Mifflin-St Jeor needs all four), how much you move, and what you're
// trying to do. Everything it writes is editable afterwards in Goal Phase —
// this only exists so nobody's first screen is a stranger's plan.
//
// ponytail: one sheet, re-rendered per step. No router, no step components.

const PHASES = [
  { k: 'cut',      label: 'Lose fat',   hint: 'eat under maintenance' },
  { k: 'maintain', label: 'Maintain',   hint: 'hold where you are' },
  { k: 'bulk',     label: 'Build',      hint: 'eat over maintenance' },
];

// kcal/day → roughly kg/week (7,700 kcal ≈ 1 kg).
const RATES = {
  cut:  [{ v: 250, label: 'Steady',   hint: '~0.23 kg/wk' },
         { v: 400, label: 'Moderate', hint: '~0.36 kg/wk' },
         { v: 550, label: 'Fast',     hint: '~0.50 kg/wk' }],
  bulk: [{ v: 200, label: 'Lean',     hint: '~0.18 kg/wk' },
         { v: 350, label: 'Steady',   hint: '~0.32 kg/wk' },
         { v: 500, label: 'Fast',     hint: '~0.45 kg/wk' }],
};

export function openOnboarding(onDone) {
  const d = { kg: '', cm: '', age: '', sex: 'male', act: '1.375', phase: 'cut', rate: 250 };
  let step = 1;

  const tdee = () => estimateTdee({
    weightKg: parseFloat(d.kg), heightCm: parseFloat(d.cm),
    age: parseFloat(d.age), sex: d.sex, activity: parseFloat(d.act),
  });
  const goal = () => {
    const t = tdee();
    if (t == null) return null;
    return d.phase === 'cut' ? t - d.rate : d.phase === 'bulk' ? t + d.rate : t;
  };

  showSheet(content => {
    const chip = (on, label, hint) =>
      `<span style="display:block;font-weight:700;font-size:13px">${label}</span>
       <span style="display:block;font-size:10px;opacity:.75;margin-top:1px">${hint}</span>`;

    const draw = () => {
      const t = tdee();
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">${step === 1 ? '👋 Welcome to Plated' : step === 2 ? 'How much do you move?' : "What's the goal?"}</span>
          ${step === 1 ? '<button class="sheet-close" id="ob-skip">Skip</button>' : ''}
        </div>
        <div style="padding:0 16px 4px">
          <div style="display:flex;gap:4px;margin-bottom:14px">
            ${[1, 2, 3].map(i => `<div style="height:3px;flex:1;border-radius:2px;background:${i <= step ? 'var(--accent)' : 'var(--surface-2)'}"></div>`).join('')}
          </div>

          ${step === 1 ? `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
              Your goals start as generic placeholders. Four numbers and they become yours instead.
            </div>
            <div class="form-row" style="margin-bottom:12px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Weight</label>
                <div style="position:relative">
                  <input class="input" id="ob-kg" type="text" inputmode="decimal" value="${d.kg}" placeholder="76" style="height:42px;padding-right:30px"/>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text-muted)">kg</span>
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Height</label>
                <div style="position:relative">
                  <input class="input" id="ob-cm" type="text" inputmode="decimal" value="${d.cm}" placeholder="173" style="height:42px;padding-right:32px"/>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text-muted)">cm</span>
                </div>
              </div>
            </div>
            <div class="form-row" style="margin-bottom:16px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Age</label>
                <input class="input" id="ob-age" type="text" inputmode="decimal" value="${d.age}" placeholder="26" style="height:42px"/>
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Sex</label>
                <div style="display:flex;gap:6px">
                  ${['male', 'female'].map(x =>
                    `<button type="button" class="fs-chip ob-sex${d.sex === x ? ' active' : ''}" data-v="${x}" style="flex:1;height:42px">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}
                </div>
              </div>
            </div>
            <div style="font-size:11px;color:var(--text-faint);margin-bottom:14px">Used for the Mifflin-St Jeor estimate. Stored on your device's profile only.</div>
          ` : step === 2 ? `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5">
              Your whole day, not just the gym. Judge it by the hours you're
              <i>not</i> training — that's most of them.
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
              ${ACTIVITY.map(a =>
                `<button type="button" class="fs-chip ob-act${d.act === a.k ? ' active' : ''}" data-v="${a.k}" style="text-align:left;padding:11px 12px;height:auto;white-space:normal">
                   <span style="display:block;font-weight:700;font-size:13px">${a.label}</span>
                   <span style="display:block;font-size:11px;opacity:.8;margin-top:3px;line-height:1.45">${a.long}</span>
                 </button>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--warning);line-height:1.5;margin-bottom:14px">
              Most people pick one level too high. <b>If you're between two, take the lower one.</b>
              Guess low and you lose slightly faster than planned; guess high and your goal is too
              generous, the deficit never shows up, and it looks like nothing is working.
              Trends measures the real figure from your own logs within a few weeks either way.
            </div>
          ` : `
            <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:${d.phase === 'maintain' ? '16' : '12'}px">
              ${PHASES.map(p =>
                `<button type="button" class="fs-chip ob-phase${d.phase === p.k ? ' active' : ''}" data-v="${p.k}" style="text-align:left;padding:10px 12px;height:auto">
                   ${chip(d.phase === p.k, p.label, p.hint)}
                 </button>`).join('')}
            </div>
            ${d.phase !== 'maintain' ? `
              <label class="form-label">How fast?</label>
              <div style="display:flex;gap:6px;margin:6px 0 16px">
                ${RATES[d.phase].map(r =>
                  `<button type="button" class="fs-chip ob-rate${d.rate === r.v ? ' active' : ''}" data-v="${r.v}" style="flex:1;padding:8px 4px;height:auto">
                     ${chip(d.rate === r.v, r.label, r.hint)}
                   </button>`).join('')}
              </div>` : ''}
            <div style="background:var(--surface-2);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);gap:10px">
                <span>Maintenance</span><span class="num" style="color:var(--text);font-weight:700">${t != null ? fmtE(t) + ' ' + unitLabel() : '—'}</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-top:6px;gap:10px">
                <span>Daily goal</span><span class="num" style="color:var(--accent)">${goal() != null ? fmtE(Math.round(goal())) + ' ' + unitLabel() : '—'}</span>
              </div>
              <div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.45">
                An estimate from your size, not a measurement. Trends works out your real
                maintenance from what you actually log, and you can change any of this later.
              </div>
            </div>
          `}

          <div style="display:flex;gap:8px;margin-bottom:16px">
            ${step > 1 ? '<button class="btn btn-secondary" id="ob-back" style="height:44px;padding:0 16px">Back</button>' : ''}
            <button class="btn btn-primary" id="ob-next" style="height:44px;flex:1">${step === 3 ? 'Start tracking' : 'Continue'}</button>
          </div>
        </div>`;

      // Step 1 keeps its typed values across re-renders (the sex chips redraw).
      const read = () => {
        const g = id => document.getElementById(id);
        if (step === 1) { d.kg = g('ob-kg')?.value ?? d.kg; d.cm = g('ob-cm')?.value ?? d.cm; d.age = g('ob-age')?.value ?? d.age; }
      };
      const pick = (cls, key, cast = String) =>
        content.querySelectorAll(cls).forEach(b => b.addEventListener('click', () => {
          read(); d[key] = cast(b.dataset.v);
          if (key === 'phase' && d.phase !== 'maintain') d.rate = RATES[d.phase][0].v;
          draw();
        }));
      pick('.ob-sex', 'sex');
      pick('.ob-act', 'act');
      pick('.ob-phase', 'phase');
      pick('.ob-rate', 'rate', Number);

      document.getElementById('ob-skip')?.addEventListener('click', async () => {
        // Skipping still counts as the wizard having had its turn.
        try { await api.patch('/api/settings', { onboarded: '1' }); } catch { /* non-fatal */ }
        hideSheet();
        onDone?.();
      });
      document.getElementById('ob-back')?.addEventListener('click', () => { read(); step--; draw(); });

      document.getElementById('ob-next').addEventListener('click', async () => {
        read();
        if (step === 1) {
          if (tdee() == null) {
            showToast('Fill in weight, height and age to continue', 'error');
            return;
          }
          step = 2; draw(); return;
        }
        if (step === 2) { step = 3; draw(); return; }

        const t = Math.round(tdee());
        const g = Math.round(goal());
        const btn = document.getElementById('ob-next');
        btn.disabled = true; btn.textContent = 'Setting up…';
        try {
          await api.patch('/api/settings', {
            tdee: String(t),
            calorie_goal: String(g),
            phase: d.phase,
            ...(d.phase === 'cut'  ? { cut_deficit:  String(d.rate) } : {}),
            ...(d.phase === 'bulk' ? { bulk_surplus: String(d.rate) } : {}),
            height_cm: String(parseFloat(d.cm)),
            birth_year: String(new Date().getFullYear() - Math.round(parseFloat(d.age))),
            sex: d.sex,
            activity_level: d.act,
            bodyweight_kg: String(parseFloat(d.kg)),
            // g/kg from the start: protein and fat then follow bodyweight
            // instead of freezing at whatever today's number happened to be.
            macro_mode: 'gkg', protein_multiplier: '2.0', fat_multiplier: '0.8',
            onboarded: '1',
          });
          // The weigh-in they just typed is real data — log it rather than
          // making them enter the same number again on Today.
          try { await api.post('/api/weight', { weight_kg: parseFloat(d.kg), date: localDate() }); } catch { /* non-fatal */ }
          hideSheet();
          showToast(`You're set — ${fmtE(g)} ${unitLabel()} a day`, 'success');
          onDone?.();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Start tracking';
        }
      });
    };

    draw();
  });
}
