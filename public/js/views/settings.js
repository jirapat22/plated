import { api }           from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';

export function renderSettings(container) {
  container.innerHTML = `
    <div class="today-header"><div class="today-date">Settings</div></div>
    <div id="settings-body" style="padding:0 16px">
      <div class="skeleton skel-line" style="height:200px;border-radius:14px"></div>
    </div>
  `;

  async function load() {
    try {
      const settings = await api.get('/api/settings');
      render(settings);
    } catch (err) {
      document.getElementById('settings-body').innerHTML =
        `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(s) {
    const body = document.getElementById('settings-body');
    body.innerHTML = `
      <!-- Phase Selector -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">GOAL PHASE</div>
        <div style="padding:14px 16px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
            ${phaseBtn('cut',      '🔻 Cut',      s.phase)}
            ${phaseBtn('maintain', '⚖️ Maintain', s.phase)}
            ${phaseBtn('bulk',     '📈 Bulk',     s.phase)}
          </div>
          <div id="phase-description" style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${phaseDesc(s.phase, s.tdee, s.cut_deficit, s.bulk_surplus)}</div>
          <div class="form-row" style="margin-bottom:10px">
            ${goalRow('cut_deficit',  'Cut deficit',   s.cut_deficit,  'kcal', true)}
            ${goalRow('bulk_surplus', 'Bulk surplus',  s.bulk_surplus, 'kcal', true)}
          </div>
          <div style="margin-top:10px">
            <label class="form-label">TDEE (manual override if IronLog doesn't send it)</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="input settings-row-input" type="number" value="${s.tdee || ''}"
                data-key="tdee" placeholder="e.g. 2400" style="height:40px;flex:1;width:auto" />
              <span style="font-size:12px;color:var(--text-muted)">kcal</span>
              <button class="btn btn-secondary" id="manual-tdee-apply" style="height:40px;padding:0 14px;font-size:13px">Apply</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Goals -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">DAILY GOALS</div>
        ${goalRow('calorie_goal',      'Calories',      s.calorie_goal,      'kcal')}
        ${goalRow('protein_goal',      'Protein',       s.protein_goal,      'g')}
        ${goalRow('carb_goal',         'Carbs',         s.carb_goal,         'g')}
        ${goalRow('fat_goal',          'Fat',           s.fat_goal,          'g')}
        ${goalRow('fiber_goal',        'Fiber',         s.fiber_goal,        'g')}
        ${goalRow('water_goal_ml',     'Water',         s.water_goal_ml,     'ml')}
        ${goalRow('protein_multiplier','Protein × BW',  s.protein_multiplier,'×')}
        <div style="padding:10px 16px 14px;font-size:11px;color:var(--text-faint)">These update automatically when you sync from IronLog.</div>
      </div>

      <!-- IronLog -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">IRONLOG INTEGRATION</div>
        <div style="padding:14px 16px">
          <label class="form-label">IronLog API URL</label>
          <input class="input" id="ironlog-url" value="${s.ironlog_api_url || ''}" placeholder="https://ironlog.railway.app" style="margin-bottom:10px"/>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="ironlog-save" style="flex:1;min-width:100px">Save URL</button>
            <button class="btn btn-secondary" id="ironlog-test" style="flex:1;min-width:100px">Test</button>
            <button class="btn btn-primary"   id="ironlog-sync" style="flex:1;min-width:120px">⟳ Sync Goals</button>
          </div>
          <button class="btn btn-secondary btn-full" id="ironlog-inspect" style="margin-top:8px;font-size:12px;height:36px">
            🔍 Inspect raw IronLog data
          </button>
          <div id="ironlog-status" style="margin-top:10px;font-size:12px;color:var(--text-muted);user-select:text;-webkit-user-select:text"></div>
          <pre id="ironlog-raw-box" style="display:none;margin-top:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;user-select:text;-webkit-user-select:text;max-height:300px;overflow-y:auto"></pre>
        </div>
      </div>

      <!-- Passcode -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">SECURITY</div>
        <div style="padding:14px 16px">
          <button class="btn btn-secondary btn-full" id="change-passcode-btn">Change Passcode</button>
        </div>
      </div>

      <!-- Weight Log -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">WEIGHT LOG</div>
        <div style="padding:14px 16px">
          <div style="display:flex;gap:10px;margin-bottom:14px">
            <input class="input" id="weight-input" type="number" step="0.1" placeholder="e.g. 75.5" style="flex:1"/>
            <span style="align-self:center;color:var(--text-muted);font-weight:600">kg</span>
            <button class="btn btn-primary" id="weight-log-btn">Log</button>
          </div>
          <div id="weight-list"></div>
        </div>
      </div>

      <!-- Export -->
      <div class="card" style="margin-bottom:20px;padding:0">
        <div style="padding:14px 16px;font-size:13px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">DATA</div>
        <div style="padding:14px 16px">
          <a class="btn btn-secondary btn-full" href="/api/settings/export" download>Export all data as JSON</a>
        </div>
      </div>
    `;

    // Goal inputs — save on blur
    body.querySelectorAll('.settings-row-input').forEach(input => {
      input.addEventListener('change', async () => {
        try {
          await api.patch('/api/settings', { [input.dataset.key]: input.value });
          showToast('Saved', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // Phase selector
    body.querySelectorAll('.phase-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const phase = btn.dataset.phase;
        body.querySelectorAll('.phase-btn').forEach(b => b.classList.toggle('active', b === btn));
        try {
          const result = await api.post('/api/ironlog/phase', { phase });
          document.getElementById('phase-description').textContent =
            phaseDesc(phase, result.tdee, s.cut_deficit, s.bulk_surplus);
          if (result.calorie_goal) {
            const calInput = body.querySelector('[data-key="calorie_goal"]');
            if (calInput) calInput.value = result.calorie_goal;
            showToast(`Phase set to ${phase} — calorie goal updated to ${result.calorie_goal} kcal`, 'success');
          } else {
            showToast(`Phase set to ${phase} — sync from IronLog to auto-set calorie goal`, 'info');
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // Manual TDEE apply
    document.getElementById('manual-tdee-apply').addEventListener('click', async () => {
      const tdee = parseFloat(body.querySelector('[data-key="tdee"]')?.value);
      if (!tdee || tdee < 500) { showToast('Enter a valid TDEE (e.g. 2400)', 'error'); return; }
      const phase   = s.phase || 'maintain';
      const deficit = parseInt(s.cut_deficit)  || 500;
      const surplus = parseInt(s.bulk_surplus) || 300;
      const calGoal = phase === 'cut'  ? tdee - deficit
                    : phase === 'bulk' ? tdee + surplus : tdee;
      try {
        await api.patch('/api/settings', { tdee: String(tdee), calorie_goal: String(calGoal) });
        body.querySelector('[data-key="calorie_goal"]').value = calGoal;
        document.getElementById('phase-description').textContent =
          phaseDesc(phase, tdee, s.cut_deficit, s.bulk_surplus);
        showToast(`TDEE saved · Calorie goal → ${calGoal} kcal`, 'success');
        window.dispatchEvent(new CustomEvent('plated:settings-changed'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // IronLog sync
    document.getElementById('ironlog-sync').addEventListener('click', async () => {
      const statusEl = document.getElementById('ironlog-status');
      const btn = document.getElementById('ironlog-sync');
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      statusEl.textContent = '';
      try {
        const result = await api.post('/api/ironlog/sync');
        const u = result.updates;
        const lines = [`✓ Synced from IronLog at ${new Date().toLocaleTimeString()}`];
        if (u.phase)        lines.push(`Phase: ${u.phase}`);
        if (u.tdee)         lines.push(`TDEE: ${u.tdee} kcal`);
        if (u.calorie_goal) lines.push(`Calories: ${u.calorie_goal} kcal`);
        if (u.protein_goal) lines.push(`Protein: ${u.protein_goal}g`);
        if (u.carb_goal)    lines.push(`Carbs: ${u.carb_goal}g`);
        if (u.fat_goal)     lines.push(`Fat: ${u.fat_goal}g`);
        if (u.fiber_goal)   lines.push(`Fiber: ${u.fiber_goal}g`);
        statusEl.style.color = 'var(--success)';
        statusEl.innerHTML = lines.join('<br/>');

        // Immediately update every visible goal input
        const patch = (key, val) => {
          const el = body.querySelector(`[data-key="${key}"]`);
          if (el && val != null) el.value = val;
        };
        patch('calorie_goal', u.calorie_goal);
        patch('protein_goal', u.protein_goal);
        patch('carb_goal',    u.carb_goal);
        patch('fat_goal',     u.fat_goal);
        patch('fiber_goal',   u.fiber_goal);
        patch('tdee',         u.tdee);

        // Tell Today view to refresh its data
        window.dispatchEvent(new CustomEvent('plated:settings-changed'));

        // Full settings reload to sync everything else
        setTimeout(() => load(), 1200);
      } catch (err) {
        statusEl.style.color = 'var(--error)';
        // Try to parse the error body for profile_raw hint
        let detail = err.message;
        try {
          const raw = JSON.parse(err.message.match(/\{.*\}/s)?.[0] || '{}');
          if (raw.profile_raw) {
            detail = `IronLog profile fields: ${Object.keys(raw.profile_raw).join(', ')}`;
          }
        } catch { /* ignore */ }
        statusEl.innerHTML = `✕ ${err.message}<br/><span style="color:var(--text-faint);font-size:11px">${detail}<br/>Enter TDEE manually above instead.</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '⟳ Sync Goals';
      }
    });

    // IronLog inspect — shows raw JSON, stays on screen, fully selectable
    document.getElementById('ironlog-inspect').addEventListener('click', async () => {
      const box = document.getElementById('ironlog-raw-box');
      const btn = document.getElementById('ironlog-inspect');
      if (box.style.display !== 'none') {
        box.style.display = 'none';
        btn.textContent = '🔍 Inspect raw IronLog data';
        return;
      }
      btn.textContent = 'Loading…';
      try {
        const data = await api.get('/api/ironlog/raw');
        box.textContent = JSON.stringify(data, null, 2);
        box.style.display = 'block';
        btn.textContent = '✕ Hide raw data';
      } catch (err) {
        box.textContent = err.message;
        box.style.display = 'block';
        btn.textContent = '✕ Hide';
      }
    });

    // IronLog
    document.getElementById('ironlog-save').addEventListener('click', async () => {
      const url = document.getElementById('ironlog-url').value.trim();
      try {
        await api.patch('/api/settings', { ironlog_api_url: url });
        showToast('URL saved', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('ironlog-test').addEventListener('click', async () => {
      const statusEl = document.getElementById('ironlog-status');
      statusEl.textContent = 'Testing…';
      try {
        const result = await api.get('/api/ironlog/test');
        statusEl.style.color = result.connected ? 'var(--success)' : 'var(--error)';
        statusEl.textContent = result.connected
          ? '✓ Connected'
          : `✕ ${result.error}`;
      } catch (err) {
        statusEl.style.color = 'var(--error)';
        statusEl.textContent = `✕ ${err.message}`;
      }
    });

    // Passcode change
    document.getElementById('change-passcode-btn').addEventListener('click', () => {
      openChangePasscode();
    });

    // Weight log
    loadWeights();
    document.getElementById('weight-log-btn').addEventListener('click', async () => {
      const val = parseFloat(document.getElementById('weight-input').value);
      if (!val || val <= 0) { showToast('Enter a valid weight', 'error'); return; }
      try {
        await api.post('/api/weight', { weight_kg: val });
        document.getElementById('weight-input').value = '';
        showToast('Weight logged', 'success');
        loadWeights();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function loadWeights() {
    try {
      const weights = await api.get('/api/weight?limit=10');
      const list = document.getElementById('weight-list');
      if (!list) return;
      if (weights.length === 0) {
        list.innerHTML = '<div class="muted" style="font-size:13px">No entries yet</div>';
        return;
      }
      list.innerHTML = weights.map(w => `
        <div class="weight-entry">
          <div>
            <div class="weight-val">${w.weight_kg} kg</div>
            <div class="weight-date">${w.date}</div>
          </div>
          <button class="weight-del" data-id="${w.id}">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      `).join('');
      list.querySelectorAll('.weight-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api.delete(`/api/weight/${btn.dataset.id}`);
            loadWeights();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });
    } catch { /* non-fatal */ }
  }

  function openChangePasscode() {
    showSheet(content => {
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">Change Passcode</span>
          <button class="sheet-close" id="pc-close">✕</button>
        </div>
        <div style="padding:0 16px">
          <div class="form-group">
            <label class="form-label">Current passcode</label>
            <input class="input" id="pc-current" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="Current 4-digit code" />
          </div>
          <div class="form-group">
            <label class="form-label">New passcode</label>
            <input class="input" id="pc-new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="New 4-digit code" />
          </div>
          <div class="form-group">
            <label class="form-label">Confirm new passcode</label>
            <input class="input" id="pc-confirm" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="Confirm new code" />
          </div>
          <button class="btn btn-primary btn-full" id="pc-save">Update Passcode</button>
        </div>
      `;
      document.getElementById('pc-close').addEventListener('click', hideSheet);
      document.getElementById('pc-save').addEventListener('click', async () => {
        const current = document.getElementById('pc-current').value;
        const next    = document.getElementById('pc-new').value;
        const confirm = document.getElementById('pc-confirm').value;
        if (next !== confirm) { showToast('Passcodes do not match', 'error'); return; }
        if (!/^\d{4}$/.test(next)) { showToast('Passcode must be exactly 4 digits', 'error'); return; }
        try {
          await api.post('/api/auth/change', { currentPasscode: current, newPasscode: next });
          hideSheet();
          showToast('Passcode updated', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  load();
}

function goalRow(key, label, value, unit, compact = false) {
  if (compact) {
    return `
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">${label}</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input class="input settings-row-input" type="number" value="${value || ''}" data-key="${key}" step="1" style="height:40px;flex:1" />
          <span style="font-size:12px;color:var(--text-muted)">${unit}</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="settings-row">
      <span class="settings-row-label">${label}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <input class="settings-row-input" type="number" value="${value || ''}" data-key="${key}" step="${unit === '×' ? '0.1' : '1'}" />
        <span style="font-size:12px;color:var(--text-muted)">${unit}</span>
      </div>
    </div>
  `;
}

function phaseBtn(phase, label, current) {
  const colors = { cut: 'var(--error)', maintain: 'var(--success)', bulk: 'var(--accent)' };
  const active = phase === current;
  return `
    <button class="phase-btn${active ? ' active' : ''}" data-phase="${phase}"
      style="padding:10px 6px;border-radius:var(--radius-sm);border:1.5px solid ${active ? colors[phase] : 'var(--border)'};
             background:${active ? 'rgba(0,0,0,.2)' : 'var(--surface-2)'};
             color:${active ? colors[phase] : 'var(--text-muted)'};
             font-size:12px;font-weight:700;transition:all .15s">
      ${label}
    </button>
  `;
}

function phaseDesc(phase, tdee, deficit, surplus) {
  const d = parseInt(deficit) || 500;
  const s = parseInt(surplus) || 300;
  const t = parseFloat(tdee)  || null;
  if (phase === 'cut')
    return `Eating ${d} kcal below TDEE${t ? ` = ${Math.round(t - d)} kcal/day` : ''}. ~${(d / 7700 * 7).toFixed(2)} kg/week loss.`;
  if (phase === 'bulk')
    return `Eating ${s} kcal above TDEE${t ? ` = ${Math.round(t + s)} kcal/day` : ''}. Lean muscle gain phase.`;
  return `Eating at TDEE${t ? ` = ${Math.round(t)} kcal/day` : ''}. Weight maintenance.`;
}
