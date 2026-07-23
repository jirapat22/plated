import { api }                        from '../api.js';
import { showToast, showSheet, hideSheet, reloadEnergyUnit, getProfile, applyProfile, logoutToLock, ACCENTS } from '../app.js';
import { setEnergyUnit }             from '../utils/energy.js';
import { submitReport }              from '../utils/bugReport.js';
import { parsePhaseSettings, phaseCalorieGoal } from '../utils/phase.js';
import { localDate }                 from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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
      const el = document.getElementById('settings-body');   // may be gone if tab switched
      if (el) el.innerHTML =
        `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(s) {
    const body = document.getElementById('settings-body');
    if (!body) return;   // view torn down before render

    const prof = getProfile() || { name: '', accent_color: ACCENTS[0] };
    body.innerHTML = `
      <!-- Profile -->
      <div class="card sec" style="margin-bottom:12px;padding:0">
        <div class="sec-head">👤 Profile<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <label class="form-label">Display name</label>
          <input class="input" id="pf-name" value="${esc(prof.name)}" maxlength="24" style="margin-bottom:12px"/>
          <label class="form-label">Accent colour</label>
          <div class="accent-row" id="pf-accents" style="margin-bottom:14px">
            ${ACCENTS.map(c => `<button type="button" class="accent-swatch${c === prof.accent_color ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
          </div>
          <button class="btn btn-primary btn-full" id="pf-save" style="margin-bottom:8px">Save profile</button>
          <div style="display:flex;gap:8px">
            <button class="btn btn-secondary" id="pf-passcode" style="flex:1">Change passcode</button>
            <button class="btn btn-secondary" id="pf-logout" style="flex:1">Log out</button>
          </div>
          <button class="btn btn-danger btn-full" id="pf-delete" style="margin-top:8px;font-size:13px">Delete this profile</button>
        </div>
      </div>

      <!-- Connections -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">🔗 Connections<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5">
            Connect with someone to view their Today and History from the History tab. Weight and Trends stay private either way. Share your code with them, or enter theirs below.
          </div>
          <label class="form-label">Your code</label>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
            <div id="conn-my-code" class="input" style="flex:1;font-weight:700;letter-spacing:.1em;text-align:center;display:flex;align-items:center;justify-content:center">…</div>
            <button class="btn btn-secondary" id="conn-regen" title="Get a new code" style="height:40px;padding:0 12px">⟳</button>
          </div>
          <label class="form-label">Enter someone's code</label>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <input class="input" id="conn-code-input" placeholder="e.g. K7M3QX9P" maxlength="8" style="flex:1;text-transform:uppercase" />
            <button class="btn btn-primary" id="conn-connect-btn" style="height:40px;padding:0 16px;white-space:nowrap">Connect</button>
          </div>
          <div id="conn-list"><div style="font-size:12px;color:var(--text-faint)">Loading…</div></div>
        </div>
      </div>

      ${prof.is_admin ? `
      <!-- Admin -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">🛡️ Admin · Profiles<span class="sec-chevron">▾</span></div>
        <div style="padding:8px 16px 14px" id="admin-list">
          <div class="skeleton skel-line" style="margin:8px 0"></div>
        </div>
      </div>` : ''}

      <!-- Phase Selector -->
      <div class="card sec" style="margin-bottom:12px;padding:0">
        <div class="sec-head">🎯 Goal Phase<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <!-- 1. Maintenance / TDEE — the basis everything is derived from -->
          <label class="form-label">① Maintenance (TDEE)</label>
          <div style="font-size:11px;color:var(--text-faint);margin:2px 0 6px">Calories you burn per day. Synced from IronLog, or set it manually.</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            <input class="input settings-row-input" type="text" inputmode="decimal" value="${s.tdee || ''}"
              data-key="tdee" placeholder="e.g. 2700" style="height:40px;flex:1;width:auto" />
            <span style="font-size:12px;color:var(--text-muted)">kcal</span>
            <button class="btn btn-secondary" id="manual-tdee-apply" style="height:40px;padding:0 14px;font-size:13px">Apply</button>
          </div>
          <button class="btn btn-secondary btn-full" id="ironlog-sync" style="height:36px;font-size:12px;margin-bottom:4px">⟳ Sync from IronLog</button>
          <div id="tdee-sync-status" style="font-size:11px;color:var(--text-muted);margin-bottom:16px"></div>

          <!-- 2. Phase -->
          <label class="form-label">② Phase</label>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:6px 0 16px">
            ${phaseBtn('cut',      '🔻 Cut',      s.phase)}
            ${phaseBtn('maintain', '⚖️ Maintain', s.phase)}
            ${phaseBtn('bulk',     '📈 Bulk',     s.phase)}
          </div>

          <!-- 3. Adjustment -->
          <label class="form-label">③ Adjustment</label>
          <div class="form-row" style="margin:6px 0 8px">
            ${goalRow('cut_deficit',  'Cut deficit',   s.cut_deficit,  'kcal', true)}
            ${goalRow('bulk_surplus', 'Bulk surplus',  s.bulk_surplus, 'kcal', true)}
          </div>
          <div id="rate-row" style="margin-bottom:16px"></div>

          <!-- 4. Resulting daily calorie goal -->
          <div id="phase-goal" class="phase-goal">${goalResult(s)}</div>

          <!-- 5. Target weight — powers the Trends verdict ETA -->
          <label class="form-label" style="margin-top:16px;display:block">④ Target weight <span style="font-weight:400;color:var(--text-faint)">(optional)</span></label>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input class="input settings-row-input" type="text" inputmode="decimal" value="${s.target_weight_kg || ''}"
              data-key="target_weight_kg" placeholder="e.g. 75" style="height:40px;flex:1;width:auto" />
            <span style="font-size:12px;color:var(--text-muted)">kg</span>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Used on Trends to project when you'll get there.</div>
        </div>
      </div>

      <!-- Goals -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">🍎 Daily Goals<span class="sec-chevron">▾</span></div>
        <div class="settings-row">
          <span class="settings-row-label">Energy unit</span>
          <div style="display:flex;gap:6px">
            <button class="unit-btn${s.energy_unit !== 'kj' ? ' active' : ''}" data-unit="kcal"
              style="height:34px;padding:0 14px;border-radius:var(--radius-full);font-size:13px;font-weight:700;border:1.5px solid ${s.energy_unit !== 'kj' ? 'var(--accent)' : 'var(--border)'};background:${s.energy_unit !== 'kj' ? 'var(--accent-dim)' : 'var(--surface-2)'};color:${s.energy_unit !== 'kj' ? 'var(--accent)' : 'var(--text-muted)'}">
              kcal
            </button>
            <button class="unit-btn${s.energy_unit === 'kj' ? ' active' : ''}" data-unit="kj"
              style="height:34px;padding:0 14px;border-radius:var(--radius-full);font-size:13px;font-weight:700;border:1.5px solid ${s.energy_unit === 'kj' ? 'var(--accent)' : 'var(--border)'};background:${s.energy_unit === 'kj' ? 'var(--accent-dim)' : 'var(--surface-2)'};color:${s.energy_unit === 'kj' ? 'var(--accent)' : 'var(--text-muted)'}">
              kJ
            </button>
          </div>
        </div>
        ${goalRow('calorie_goal',      'Calories',      s.calorie_goal,      'kcal')}
        <div id="msplit-box"></div>
        ${goalRow('protein_goal',      'Protein',       s.protein_goal,      'g')}
        ${goalRow('carb_goal',         'Carbs',         s.carb_goal,         'g')}
        ${goalRow('fat_goal',          'Fat',           s.fat_goal,          'g')}
        ${goalRow('fiber_goal',        'Fiber',         s.fiber_goal,        'g')}
        ${goalRow('protein_multiplier','Protein × BW',  s.protein_multiplier,'×')}
        <div style="padding:10px 16px 14px;font-size:11px;color:var(--text-faint)">These update automatically when you sync from IronLog.</div>
      </div>

      <!-- IronLog -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">⚡ IronLog Integration<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">
            <strong>How to connect:</strong> in IronLog, go to <em>Settings → API Key</em>, tap Copy, then paste it below.
            The URL is your IronLog web address (e.g. https://ironlog-production-….up.railway.app). Each person uses their own IronLog key.
          </div>
          <label class="form-label">IronLog API URL</label>
          <input class="input" id="ironlog-url" value="${s.ironlog_api_url || ''}" placeholder="https://ironlog.railway.app" style="margin-bottom:10px"/>
          <label class="form-label">IronLog API Key</label>
          <input class="input" id="ironlog-key" type="password" autocomplete="off" value="${esc(s.ironlog_api_key || '')}" placeholder="paste API key" style="margin-bottom:10px"/>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="ironlog-save" style="flex:1;min-width:100px">Save</button>
            <button class="btn btn-secondary" id="ironlog-test" style="flex:1;min-width:100px">Test</button>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:6px">Pulling fresh goals from IronLog happens in Goal Phase above (① Maintenance).</div>
          <button class="btn btn-secondary btn-full" id="ironlog-inspect" style="margin-top:8px;font-size:12px;height:36px">
            🔍 Inspect raw IronLog data
          </button>
          <div id="ironlog-status" style="margin-top:10px;font-size:12px;color:var(--text-muted);user-select:text;-webkit-user-select:text"></div>
          <pre id="ironlog-raw-box" style="display:none;margin-top:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;user-select:text;-webkit-user-select:text;max-height:300px;overflow-y:auto"></pre>
        </div>
      </div>

      <!-- Ideas & Bugs — report to the team dashboard -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">💡 Ideas &amp; Bugs<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5">
            Report a bug or share an idea — sent to the team dashboard.
          </div>
          <div class="search-tabs" id="fb-type" style="padding:0;margin-bottom:10px">
            <button class="search-tab active" data-fb="bug_report">🐞 Bug</button>
            <button class="search-tab" data-fb="idea">💡 Idea</button>
          </div>
          <textarea class="input" id="fb-text" rows="3" placeholder="Describe the bug or idea…" style="margin-bottom:10px;resize:vertical"></textarea>
          <button class="btn btn-primary btn-full" id="fb-send">Send</button>
          <div id="fb-status" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
        </div>
      </div>

      <!-- Export -->
      <div class="card sec collapsed" style="margin-bottom:12px;padding:0">
        <div class="sec-head">📦 Data &amp; Export<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <button class="btn btn-secondary btn-full" id="open-report" style="margin-bottom:8px">📋 Detailed nutrition report</button>
          <button class="btn btn-secondary btn-full" id="export-csv" style="margin-bottom:8px">📊 Export meals as CSV</button>
          <button class="btn btn-secondary btn-full" id="export-json" style="margin-bottom:8px">📦 Export all data as JSON</button>
          <button class="btn btn-secondary btn-full" id="import-backup">📥 Restore from backup</button>
          <input type="file" id="import-file" accept="application/json" style="display:none">
        </div>
      </div>

      <!-- Danger zone -->
      <div class="card sec collapsed" style="margin-bottom:20px;padding:0;border-color:rgba(255,107,107,.3)">
        <div class="sec-head danger">⚠️ Danger Zone<span class="sec-chevron">▾</span></div>
        <div style="padding:14px 16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5">
            Permanently deletes all logged meals, weight entries, templates, and meal-prep batches. Your food database and goal settings are kept.
          </div>
          <button class="btn btn-danger btn-full" id="reset-data-btn">🗑 Clear all logged data</button>
        </div>
      </div>
    `;

    // Collapsible sections — tap a header to expand/collapse
    body.querySelectorAll('.sec-head').forEach(h =>
      h.addEventListener('click', () => h.closest('.card').classList.toggle('collapsed')));

    // ── Profile ──────────────────────────────────────────────
    let pfAccent = prof.accent_color || ACCENTS[0];
    body.querySelectorAll('#pf-accents .accent-swatch').forEach(b => {
      b.addEventListener('click', () => {
        pfAccent = b.dataset.color;
        body.querySelectorAll('#pf-accents .accent-swatch').forEach(x =>
          x.classList.toggle('selected', x === b));
      });
    });

    document.getElementById('pf-save').addEventListener('click', async () => {
      const name = document.getElementById('pf-name').value.trim();
      if (!name) { showToast('Name cannot be empty', 'error'); return; }
      try {
        const updated = await api.patch('/api/auth/me', { name, accent_color: pfAccent });
        applyProfile(updated);
        showToast('Profile saved', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('pf-passcode').addEventListener('click', async () => {
      const code = prompt('Enter a new 4-digit passcode:');
      if (code == null) return;
      if (!/^\d{4}$/.test(code.trim())) { showToast('Passcode must be 4 digits', 'error'); return; }
      try {
        await api.post('/api/auth/me/passcode', { newPasscode: code.trim() });
        showToast('Passcode updated', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('pf-logout').addEventListener('click', async () => {
      try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
      logoutToLock();
    });

    document.getElementById('pf-delete').addEventListener('click', async () => {
      if (!confirm('Delete this profile and ALL its meals, weight, goals and templates?\n\nThis cannot be undone.')) return;
      const typed = prompt('Type DELETE to confirm:');
      if (typed !== 'DELETE') { showToast('Cancelled', 'info'); return; }
      try {
        await api.delete('/api/auth/me');
        showToast('Profile deleted', 'success');
        logoutToLock();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // ── Connections: view someone's Today/History via a shared code ──
    async function loadMyCode() {
      const el = document.getElementById('conn-my-code');
      if (!el) return;
      try {
        const { connect_code } = await api.get('/api/connections/code');
        el.textContent = connect_code;
      } catch { el.textContent = '—'; }
    }
    loadMyCode();

    document.getElementById('conn-regen').addEventListener('click', async () => {
      if (!confirm("Get a new code? Anyone with your old code won't be able to connect with it anymore — existing connections are unaffected.")) return;
      try {
        const { connect_code } = await api.post('/api/connections/code/regenerate');
        document.getElementById('conn-my-code').textContent = connect_code;
        showToast('New code generated', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('conn-connect-btn').addEventListener('click', async () => {
      const input = document.getElementById('conn-code-input');
      const code = input.value.trim();
      if (!code) return;
      try {
        const connected = await api.post('/api/connections', { code });
        input.value = '';
        showToast(`Connected with ${connected.name}`, 'success');
        loadConnections();
      } catch (err) { showToast(err.message, 'error'); }
    });

    async function loadConnections() {
      const box = document.getElementById('conn-list');
      if (!box) return;
      try {
        const conns = await api.get('/api/connections');
        box.innerHTML = conns.length ? conns.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${p.accent_color}"></span>
              <span style="font-size:14px">${esc(p.name)}</span>
            </span>
            <button class="btn btn-secondary conn-disconnect" data-id="${p.id}" data-name="${esc(p.name)}"
              style="height:32px;padding:0 12px;font-size:12px">Disconnect</button>
          </div>
        `).join('') : `<div style="font-size:12px;color:var(--text-faint)">No connections yet</div>`;
        box.querySelectorAll('.conn-disconnect').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm(`Disconnect from ${btn.dataset.name}?`)) return;
            try {
              await api.delete(`/api/connections/${btn.dataset.id}`);
              loadConnections();
            } catch (err) { showToast(err.message, 'error'); }
          });
        });
      } catch (err) {
        box.innerHTML = `<div style="font-size:12px;color:var(--error)">${err.message}</div>`;
      }
    }
    loadConnections();

    // ── Admin: grant/revoke admin per profile ────────────────
    if (prof.is_admin) loadAdminList();
    async function loadAdminList() {
      const box = document.getElementById('admin-list');
      if (!box) return;
      try {
        const profiles = await api.get('/api/auth/admin/profiles');
        box.innerHTML = profiles.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${p.accent_color}"></span>
              <span style="font-size:14px">${esc(p.name)}</span>
              ${p.is_admin ? '<span class="food-tag tag-custom">Admin</span>' : ''}
            </span>
            <button class="btn btn-secondary admin-toggle" data-id="${p.id}" data-next="${p.is_admin ? 0 : 1}"
              style="height:32px;padding:0 12px;font-size:12px">${p.is_admin ? 'Revoke' : 'Make admin'}</button>
          </div>
        `).join('');
        box.querySelectorAll('.admin-toggle').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              await api.post('/api/auth/admin/set', { profileId: parseInt(btn.dataset.id), is_admin: btn.dataset.next === '1' });
              loadAdminList();
            } catch (err) { showToast(err.message, 'error'); }
          });
        });
      } catch (err) {
        box.innerHTML = `<div style="font-size:12px;color:var(--error)">${esc(err.message)}</div>`;
      }
    }

    // Energy unit toggle
    body.querySelectorAll('.unit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const unit = btn.dataset.unit;
        try {
          await api.patch('/api/settings', { energy_unit: unit });
          setEnergyUnit(unit);
          window.dispatchEvent(new CustomEvent('plated:settings-changed'));
          showToast(`Energy unit set to ${unit}`, 'success');
          setTimeout(() => load(), 200);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // Recompute + persist the daily calorie goal from TDEE + phase + adjustment,
    // and refresh the result box.
    async function refreshGoal() {
      const goalEl = document.getElementById('phase-goal');
      const { tdee, phase, deficit, surplus } = parsePhaseSettings(s);
      const goal = phaseCalorieGoal(tdee, phase, deficit, surplus);
      if (goal != null) {
        const cal = Math.round(goal);
        s.calorie_goal = String(cal);
        try { await api.patch('/api/settings', { calorie_goal: s.calorie_goal }); } catch { /* non-fatal */ }
        const ci = body.querySelector('[data-key="calorie_goal"]');
        if (ci) ci.value = cal;
      }
      if (goalEl) goalEl.innerHTML = goalResult(s);
      renderRateRow();
      renderMacroSplit();
    }

    // Rate-of-change goal input — an alternate way to fill in ③ Adjustment:
    // type a target kg/week and it back-calculates the kcal deficit/surplus
    // (1 kg ≈ 7,700 kcal), synced with whichever kcal field is active for the
    // current phase. Hidden at maintenance — there's no adjustment to set.
    function renderRateRow() {
      const box = document.getElementById('rate-row');
      if (!box) return;
      if (s.phase === 'maintain') { box.innerHTML = ''; return; }
      const key  = s.phase === 'bulk' ? 'bulk_surplus' : 'cut_deficit';
      const verb = s.phase === 'bulk' ? 'gain' : 'lose';
      box.innerHTML = rateRowHtml(s[key], verb);
      document.getElementById('rate-input').addEventListener('change', async e => {
        const r = parseFloat(e.target.value);
        if (!r || r <= 0) { showToast('Enter a rate above 0', 'error'); return; }
        const kcalVal = Math.round(r * 7700 / 7);
        s[key] = String(kcalVal);
        const kcalInput = body.querySelector(`[data-key="${key}"]`);
        if (kcalInput) kcalInput.value = kcalVal;
        try {
          await api.patch('/api/settings', { [key]: String(kcalVal) });
          showToast(`Target set: ${r} kg/week`, 'success');
          refreshGoal();
        } catch (err) { showToast(err.message, 'error'); }
      });
    }
    function rateRowHtml(kcalVal, verb) {
      const kcal = parseFloat(kcalVal) || 0;
      const rate = kcal ? (kcal * 7 / 7700).toFixed(2) : '';
      return `
        <label class="form-label">Or by target rate</label>
        <div style="display:flex;gap:8px;align-items:center;margin:6px 0 0">
          <input class="input" id="rate-input" type="text" inputmode="decimal" value="${rate}" placeholder="e.g. 0.5" style="height:40px;flex:1"/>
          <span style="font-size:12px;color:var(--text-muted)">kg / week to ${verb}</span>
        </div>`;
    }
    renderRateRow();

    // Macro split by % — protein & fat set, carbs fills the rest (never > 100%).
    // Re-render (not just re-wire) on every call — calorie_goal changes via
    // TDEE apply / phase / rate-of-change / a direct edit all update `s` in
    // place without a full reload, so this must re-read s.calorie_goal fresh
    // each time rather than trusting a `cal` captured once at initial render.
    function renderMacroSplit() {
      const box = document.getElementById('msplit-box');
      if (!box) return;
      box.innerHTML = macroSplitBox(s);

      const msP = document.getElementById('msplit-p');
      const msF = document.getElementById('msplit-f');
      if (!msP || !msF) return;

      const cal = parseFloat(s.calorie_goal) || 0;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const draw = (p, f) => {
        const c = 100 - p - f;
        document.getElementById('msplit-c').textContent  = c;
        document.getElementById('msplit-pg').textContent = Math.round(cal * p / 100 / 4) + ' g';
        document.getElementById('msplit-fg').textContent = Math.round(cal * f / 100 / 9) + ' g';
        document.getElementById('msplit-cg').textContent = Math.round(cal * c / 100 / 4) + ' g';
        document.getElementById('msplit-total').textContent = '= 100%';
      };
      // Single clamp pass, reused by both inputs and the Apply handler: protein
      // 0-100, fat capped to whatever protein leaves — so the pair can never
      // total over 100 regardless of which field the user is typing in.
      const read = () => {
        const p = clamp(parseInt(msP.value) || 0, 0, 100);
        const f = clamp(parseInt(msF.value) || 0, 0, 100 - p);
        return { p, f };
      };
      msP.addEventListener('input', () => {
        const { p, f } = read();
        if (parseInt(msP.value) > p) msP.value = p;   // reject an over-100 keystroke
        if (parseInt(msF.value) !== f) msF.value = f;  // squeeze fat when protein grows
        draw(p, f);
      });
      msF.addEventListener('input', () => {
        const { p, f } = read();
        if (parseInt(msF.value) !== f) msF.value = f;  // can't exceed the remainder
        draw(p, f);
      });
      document.getElementById('msplit-apply').addEventListener('click', async () => {
        const { p, f } = read();
        const c  = 100 - p - f;
        const pG = Math.round(cal * p / 100 / 4);
        const fG = Math.round(cal * f / 100 / 9);
        const cG = Math.round(cal * c / 100 / 4);
        try {
          await api.patch('/api/settings', { protein_goal: String(pG), carb_goal: String(cG), fat_goal: String(fG) });
          s.protein_goal = String(pG); s.carb_goal = String(cG); s.fat_goal = String(fG);
          ['protein_goal', 'carb_goal', 'fat_goal'].forEach(k => {
            const el = body.querySelector(`[data-key="${k}"]`);
            if (el) el.value = { protein_goal: pG, carb_goal: cG, fat_goal: fG }[k];
          });
          showToast(`Macros set — ${pG}g P · ${cG}g C · ${fG}g F`, 'success');
          window.dispatchEvent(new CustomEvent('plated:settings-changed'));
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
    renderMacroSplit();

    // Goal inputs — save on blur
    body.querySelectorAll('.settings-row-input').forEach(input => {
      input.addEventListener('change', async () => {
        try {
          await api.patch('/api/settings', { [input.dataset.key]: input.value });
          if (input.dataset.key) s[input.dataset.key] = input.value;
          showToast('Saved', 'success');
          if (input.dataset.key === 'cut_deficit' || input.dataset.key === 'bulk_surplus') refreshGoal();
          else if (input.dataset.key === 'calorie_goal') renderMacroSplit();
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
          s.phase = phase;
          if (result.tdee != null)         s.tdee = String(result.tdee);
          if (result.calorie_goal != null) s.calorie_goal = String(result.calorie_goal);
          const goalEl = document.getElementById('phase-goal');
          if (goalEl) goalEl.innerHTML = goalResult(s);
          renderRateRow();
          renderMacroSplit();
          if (result.calorie_goal) {
            const calInput = body.querySelector('[data-key="calorie_goal"]');
            if (calInput) calInput.value = result.calorie_goal;
            showToast(`Phase set to ${phase} — goal updated to ${result.calorie_goal} kcal`, 'success');
          } else {
            showToast(`Phase set to ${phase} — set your TDEE to compute the goal`, 'info');
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
      const { phase, deficit, surplus } = parsePhaseSettings(s);
      const calGoal = phaseCalorieGoal(tdee, phase, deficit, surplus);
      try {
        await api.patch('/api/settings', { tdee: String(tdee), calorie_goal: String(calGoal) });
        s.tdee = String(tdee);
        s.calorie_goal = String(calGoal);
        const calInput = body.querySelector('[data-key="calorie_goal"]');
        if (calInput) calInput.value = calGoal;
        const goalEl = document.getElementById('phase-goal');
        if (goalEl) goalEl.innerHTML = goalResult(s);
        renderMacroSplit();
        showToast(`TDEE saved · goal → ${calGoal} kcal`, 'success');
        window.dispatchEvent(new CustomEvent('plated:settings-changed'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Sync from IronLog (lives in Goal Phase — pulls TDEE + macro goals)
    document.getElementById('ironlog-sync').addEventListener('click', async () => {
      const statusEl = document.getElementById('tdee-sync-status');
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
        btn.textContent = '⟳ Sync from IronLog';
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
      const key = document.getElementById('ironlog-key').value.trim();
      try {
        await api.patch('/api/settings', { ironlog_api_url: url, ironlog_api_key: key });
        showToast('Saved', 'success');
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

    // Reset all data
    document.getElementById('reset-data-btn').addEventListener('click', async () => {
      if (!confirm('This will permanently delete all logged meals, weight, and templates.\n\nThis cannot be undone. Continue?')) return;
      const typed = prompt('Type DELETE to confirm:');
      if (typed !== 'DELETE') { showToast('Cancelled', 'info'); return; }
      try {
        await api.delete('/api/settings/data');
        showToast('All logged data cleared', 'success');
        window.dispatchEvent(new CustomEvent('plated:settings-changed'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Ideas & bugs checklist
    // Ideas & Bugs (bug / idea) → Orbit
    let fbType = 'bug_report';
    document.getElementById('fb-type').addEventListener('click', e => {
      const btn = e.target.closest('[data-fb]');
      if (!btn) return;
      fbType = btn.dataset.fb;
      document.querySelectorAll('#fb-type .search-tab').forEach(b => b.classList.toggle('active', b === btn));
    });
    document.getElementById('fb-send').addEventListener('click', async () => {
      const ta = document.getElementById('fb-text');
      const text = ta.value.trim();
      const status = document.getElementById('fb-status');
      if (!text) { showToast('Write something first', 'error'); return; }
      const btn = document.getElementById('fb-send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await submitReport({ type: fbType, message: text });
        ta.value = '';
        status.textContent = '✓ Thanks! Your ' + (fbType === 'idea' ? 'idea' : 'bug report') + ' was sent.';
        showToast('Feedback sent', 'success');
      } catch {
        status.textContent = 'Saved locally — will reach the team when back online.';
      } finally {
        btn.disabled = false; btn.textContent = 'Send';
      }
    });

    document.getElementById('open-report').addEventListener('click', openReportSheet);

    document.getElementById('export-csv').addEventListener('click', async () => {
      try {
        const text = await api.get('/api/settings/export-csv');
        downloadBlob(text, `plated-meals-${localDate()}.csv`, 'text/csv');
      } catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('export-json').addEventListener('click', async () => {
      try {
        const data = await api.get('/api/settings/export');
        downloadBlob(JSON.stringify(data, null, 2), `plated-export-${localDate()}.json`, 'application/json');
      } catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('import-backup').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = ''; // allow re-selecting the same file later
      if (!file) return;

      let data;
      try { data = JSON.parse(await file.text()); }
      catch { return showToast("That file isn't valid JSON", 'error'); }
      if (!data.exported_at || !Array.isArray(data.meal_sessions)) {
        return showToast("That doesn't look like a Plated export file", 'error');
      }

      const exportedDate = new Date(data.exported_at).toLocaleDateString();
      const summary = `Backup from ${exportedDate}:\n`
        + `${data.meal_sessions.length} meals, ${(data.meal_entries || []).length} food entries, `
        + `${(data.weight_log || []).length} weigh-ins.\n\n`
        + `This REPLACES your current meal history and weight log. `
        + `Your food database and other profiles aren't touched.\n\nContinue?`;
      if (!confirm(summary)) return;
      if (prompt('Type RESTORE to confirm:') !== 'RESTORE') return showToast('Cancelled', 'info');

      const btn = document.getElementById('import-backup');
      btn.disabled = true; btn.textContent = 'Restoring…';
      try {
        const result = await api.post('/api/settings/import', data);
        showToast(`Restored ${result.imported.entries} food entries, ${result.imported.weight} weigh-ins`, 'success');
        window.dispatchEvent(new CustomEvent('plated:settings-changed'));
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = '📥 Restore from backup';
      }
    });

  }

  load();
}

// Downloads use api.get() (carries the Authorization bearer token) rather
// than a plain <a href> — a bare link to an /api/settings/export* route sends
// no auth header at all, so the server 401s and the "download" is just a
// `{"error":"Not logged in"}` blob.
function downloadBlob(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Detailed nutrition report ──────────────────────────────────
function openReportSheet() {
  showSheet(content => {
    const today = localDate();
    const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
    let range = '7';
    let fmt = 'html';

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Nutrition report</span>
        <button class="sheet-close" id="rp-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">A readable day-by-day breakdown of what you ate — meals, macros, and daily averages. Good for sharing with a doctor or coach.</div>
        <label class="form-label">Date range</label>
        <div id="rp-ranges" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 4px;-webkit-overflow-scrolling:touch">
          <button type="button" class="fs-chip rp-range active" data-range="7">Last 7 days</button>
          <button type="button" class="fs-chip rp-range" data-range="30">Last 30 days</button>
          <button type="button" class="fs-chip rp-range" data-range="month">This month</button>
          <button type="button" class="fs-chip rp-range" data-range="all">All time</button>
        </div>
        <button type="button" id="rp-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:12px">Pick a custom range…</button>
        <div id="rp-custom" style="display:none;gap:8px;margin-bottom:14px">
          <input class="input" id="rp-from" type="date" max="${today}" style="flex:1"/>
          <input class="input" id="rp-to" type="date" max="${today}" style="flex:1"/>
        </div>
        <label class="form-label">Format</label>
        <div style="display:flex;gap:6px;margin-bottom:18px">
          <button type="button" class="fs-chip rp-fmt active" data-fmt="html" style="flex:1">🖨️ View / print</button>
          <button type="button" class="fs-chip rp-fmt" data-fmt="md" style="flex:1">📝 Markdown</button>
          <button type="button" class="fs-chip rp-fmt" data-fmt="csv" style="flex:1">📊 CSV</button>
        </div>
        <button class="btn btn-primary btn-full" id="rp-go">Generate report</button>
      </div>`;

    const rangesBox  = document.getElementById('rp-ranges');
    const customBox  = document.getElementById('rp-custom');
    const customToggle = document.getElementById('rp-custom-toggle');
    const fromInput  = document.getElementById('rp-from');
    const toInput    = document.getElementById('rp-to');

    rangesBox.querySelectorAll('.rp-range').forEach(btn => {
      btn.addEventListener('click', () => {
        range = btn.dataset.range;
        rangesBox.querySelectorAll('.rp-range').forEach(b => b.classList.toggle('active', b === btn));
        customBox.style.display = 'none';
      });
    });
    customToggle.addEventListener('click', () => {
      const opening = customBox.style.display === 'none';
      customBox.style.display = opening ? 'flex' : 'none';
      if (opening) {
        range = 'custom';
        rangesBox.querySelectorAll('.rp-range').forEach(b => b.classList.remove('active'));
        if (!fromInput.value) fromInput.value = addDays(today, -6);
        if (!toInput.value) toInput.value = today;
      }
    });

    document.querySelectorAll('.rp-fmt').forEach(btn => {
      btn.addEventListener('click', () => {
        fmt = btn.dataset.fmt;
        document.querySelectorAll('.rp-fmt').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    document.getElementById('rp-close').addEventListener('click', hideSheet);
    document.getElementById('rp-go').addEventListener('click', async () => {
      let from, to = today;
      if (range === '7') from = addDays(today, -6);
      else if (range === '30') from = addDays(today, -29);
      else if (range === 'month') from = today.slice(0, 8) + '01';
      else if (range === 'all') from = null;
      else {
        if (!fromInput.value || !toInput.value) return showToast('Pick both dates', 'error');
        from = fromInput.value; to = toInput.value;
      }

      const params = new URLSearchParams({ format: fmt, to });
      if (from) params.set('from', from);
      const path = `/api/settings/export-report?${params}`;

      // Open the tab synchronously (inside the click handler) so it isn't
      // treated as a popup — window.open() after an await gets blocked.
      const win = fmt === 'html' ? window.open('', '_blank') : null;
      const btn = document.getElementById('rp-go');
      btn.disabled = true; btn.textContent = 'Generating…';
      try {
        const text = await api.get(path);
        if (fmt === 'html') {
          win.document.write(text); win.document.close();
        } else {
          const mime = fmt === 'csv' ? 'text/csv' : 'text/markdown';
          downloadBlob(text, `plated-report-${from || 'all'}_to_${to}.${fmt === 'csv' ? 'csv' : 'md'}`, mime);
        }
        hideSheet();
      } catch (err) {
        win?.close();
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Generate report';
      }
    });
  });
}

function goalRow(key, label, value, unit, compact = false) {
  if (compact) {
    return `
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">${label}</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input class="input settings-row-input" type="text" inputmode="decimal" value="${value || ''}" data-key="${key}" step="1" style="height:40px;flex:1" />
          <span style="font-size:12px;color:var(--text-muted)">${unit}</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="settings-row">
      <span class="settings-row-label">${label}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <input class="settings-row-input" type="text" inputmode="decimal" value="${value || ''}" data-key="${key}" step="${unit === '×' ? '0.1' : '1'}" />
        <span style="font-size:12px;color:var(--text-muted)">${unit}</span>
      </div>
    </div>
  `;
}

// Enter macro goals as a % of the calorie goal. Protein & fat are set; carbs
// fills the rest, so the split can never exceed 100%. Converts to grams
// (protein/carbs 4 kcal/g, fat 9 kcal/g) and writes the gram goals on Apply.
function macroSplitBox(s) {
  const cal = parseFloat(s.calorie_goal) || 0;
  if (!cal) {
    return `<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-faint)">Set a calorie goal above to enter macros by %.</div>`;
  }
  let pPct = Math.round((parseFloat(s.protein_goal) || 0) * 4 / cal * 100);
  let fPct = Math.round((parseFloat(s.fat_goal) || 0) * 9 / cal * 100);
  pPct = Math.max(0, Math.min(100, pPct));
  fPct = Math.max(0, Math.min(100 - pPct, fPct));
  const cPct = 100 - pPct - fPct;
  const g = (pct, kpg) => Math.round(cal * pct / 100 / kpg);
  return `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div class="form-label" style="margin-bottom:2px">Macro split · % of calories</div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">Of your ${Math.round(cal)} kcal goal. Set protein &amp; fat — carbs fill the rest.</div>
      ${splitRow('p', 'Protein', 'var(--protein)', pPct, g(pPct, 4), true)}
      ${splitRow('f', 'Fat',     'var(--fat)',     fPct, g(fPct, 9), true)}
      ${splitRow('c', 'Carbs',   'var(--carbs)',   cPct, g(cPct, 4), false)}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
        <span id="msplit-total" style="font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums">= 100%</span>
        <button id="msplit-apply" class="btn btn-primary" style="height:34px;padding:0 16px;font-size:13px">Apply to goals</button>
      </div>
    </div>`;
}

function splitRow(id, label, color, pct, grams, editable) {
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
      <span style="width:54px;font-size:13px;color:${color};font-weight:600">${label}</span>
      ${editable
        ? `<input id="msplit-${id}" type="text" inputmode="numeric" maxlength="3" value="${pct}" style="width:52px;height:36px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none"/>`
        : `<span id="msplit-${id}" style="width:52px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-muted)">${pct}</span>`}
      <span style="font-size:13px;color:var(--text-muted)">%</span>
      ${editable ? '' : '<span style="font-size:10px;color:var(--text-faint)">auto</span>'}
      <span id="msplit-${id}g" style="margin-left:auto;font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums">${grams} g</span>
    </div>`;
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

// Prominent "your daily calorie goal" result for the Goal Phase section.
// Computes live from TDEE + phase + adjustment; falls back to the synced goal.
function goalResult(s) {
  const { tdee, phase, deficit, surplus } = parsePhaseSettings(s);
  const goal = phaseCalorieGoal(tdee, phase, deficit, surplus) ?? (parseFloat(s.calorie_goal) || null);
  if (goal == null) {
    return `<div class="phase-goal-empty">Enter your TDEE above (or sync IronLog) to see your daily calorie goal.</div>`;
  }
  const math = tdee != null
    ? (phase === 'cut'  ? `${Math.round(tdee)} TDEE − ${deficit} deficit`
     : phase === 'bulk' ? `${Math.round(tdee)} TDEE + ${surplus} surplus`
     : `at maintenance · ${Math.round(tdee)} TDEE`)
    : 'from your synced goal';
  return `
    <div class="phase-goal-label">Your daily calorie goal</div>
    <div class="phase-goal-num">${Math.round(goal)}<span> kcal</span></div>
    <div class="phase-goal-sub">${math}</div>`;
}
