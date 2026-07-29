import { api, setToken, onUnauthorized } from './api.js';
import { setEnergyUnit } from './utils/energy.js';
import { installErrorCapture } from './utils/bugReport.js';
import { renderToday }    from './views/today.js';
import { renderHistory }  from './views/history.js';
import { renderTrends }   from './views/trends.js';
import { renderFoods }    from './views/foods.js';
import { renderSettings } from './views/settings.js';

// Capture uncaught errors / rejections and forward to Orbit (best-effort).
installErrorCapture();

// ─── State ─────────────────────────────────────────────────
let currentView = 'today';
let cleanupFn   = null;

// ─── Toast ─────────────────────────────────────────────────
// opts: { actionLabel, onAction, duration } — an action (e.g. Undo) keeps the
// toast up longer and runs onAction once when tapped.
export function showToast(msg, type = 'info', opts = {}) {
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = msg;   // textContent = no HTML injection

  const dismiss = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  let timer;

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement('button');
    btn.textContent = opts.actionLabel;
    btn.style.cssText = 'margin-left:auto;flex-shrink:0;color:var(--accent);font-size:13px;font-weight:700;padding:2px 8px';
    let used = false;
    btn.addEventListener('click', () => {
      if (used) return;
      used = true;
      clearTimeout(timer);
      dismiss();
      opts.onAction();
    });
    el.appendChild(btn);
    el.style.pointerEvents = 'auto';   // container is pointer-events:none
  }

  container.appendChild(el);
  timer = setTimeout(dismiss, opts.duration || (opts.actionLabel ? 6000 : 3000));
}

// ─── Bottom Sheet ───────────────────────────────────────────
export function showSheet(renderFn) {
  const overlay = document.getElementById('sheet-overlay');
  const sheet   = document.getElementById('sheet');
  const content = document.getElementById('sheet-content');

  content.innerHTML = '';
  renderFn(content);

  overlay.classList.remove('hidden');
  sheet.classList.remove('hidden');
  // Force reflow
  sheet.getBoundingClientRect();
  overlay.classList.add('visible');
  sheet.classList.add('open');

  const close = () => hideSheet();
  overlay.addEventListener('click', close, { once: true });
}

export function hideSheet() {
  const overlay = document.getElementById('sheet-overlay');
  const sheet   = document.getElementById('sheet');
  overlay.classList.remove('visible');
  sheet.classList.remove('open');
  setTimeout(() => {
    overlay.classList.add('hidden');
    sheet.classList.add('hidden');
    document.getElementById('sheet-content').innerHTML = '';
  }, 300);
}

// ─── Text prompt sheet ──────────────────────────────────────
// A themed stand-in for window.prompt(), which in an installed PWA renders as
// a bare system dialog dropped into an otherwise fully custom UI (and on iOS
// can be suppressed entirely). onSave(value) may return a promise — throwing
// shows the message and keeps the sheet open so the input isn't lost.
export function showPrompt({ title, label, value = '', placeholder = '', cta = 'Save', inputMode, maxLength }, onSave) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title"></span>
        <button class="sheet-close" id="pr-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <label class="form-label" id="pr-label"></label>
        <input class="input" id="pr-input" style="margin:6px 0 16px"/>
        <button class="btn btn-primary btn-full" id="pr-save"></button>
      </div>`;
    // textContent throughout — these strings can carry user-entered names.
    content.querySelector('.sheet-title').textContent = title;
    content.querySelector('#pr-label').textContent = label;
    const input = content.querySelector('#pr-input');
    input.value = value;
    input.placeholder = placeholder;
    if (inputMode) input.inputMode = inputMode;
    if (maxLength) input.maxLength = maxLength;
    const btn = content.querySelector('#pr-save');
    btn.textContent = cta;
    content.querySelector('#pr-close').addEventListener('click', hideSheet);

    const submit = async () => {
      btn.disabled = true;
      try { await onSave(input.value.trim()); hideSheet(); }
      catch (err) { showToast(err.message, 'error'); btn.disabled = false; }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => { input.focus(); input.select(); }, 150);
  });
}

// ─── Navigation ─────────────────────────────────────────────
const views = { today: renderToday, history: renderHistory, trends: renderTrends, foods: renderFoods, settings: renderSettings };

export function navigateTo(view) {
  if (view === currentView && document.getElementById('view-container').children.length > 0) return;
  currentView = view;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Cleanup previous view
  if (cleanupFn) { cleanupFn(); cleanupFn = null; }

  // Render new view
  const container = document.getElementById('view-container');
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'view-enter';
  container.appendChild(wrapper);

  const cleanup = views[view]?.(wrapper);
  if (typeof cleanup === 'function') cleanupFn = cleanup;
}

// ─── Service Worker + update prompt ──────────────────────────
let updateAccepted = false; // set only when the user taps "Refresh"
if ('serviceWorker' in navigator) {
  // Reload once the new worker takes control — but ONLY after the user accepted
  // the update. First install also fires controllerchange, and reloading then
  // would bounce the page on the very first load.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateAccepted || reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // A new version may already be waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        // "installed" while a controller already exists = an update (not the
        // first install). Prompt instead of swapping silently.
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });
    // Actively check for a new worker whenever the app is reopened — installed
    // PWAs (esp. iOS) stay warm and rarely check on their own.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(console.warn);
}

function showUpdateBanner(worker) {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span>A new version is available</span>
    <button id="update-refresh">Refresh</button>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('visible'));
  banner.querySelector('#update-refresh').onclick = () => {
    updateAccepted = true;
    worker.postMessage({ type: 'skip-waiting' });
    banner.remove();
  };
}

// ─── Offline indicator ───────────────────────────────────────
let offlineBanner = null;
function ensureOfflineBanner() {
  if (!offlineBanner) {
    offlineBanner = document.createElement('div');
    offlineBanner.className = 'offline-banner';
    offlineBanner.textContent = 'You are offline — some features unavailable';
    document.body.prepend(offlineBanner);
  }
}
window.addEventListener('offline', () => {
  ensureOfflineBanner();
  offlineBanner.classList.add('visible');
});
window.addEventListener('online', () => {
  offlineBanner?.classList.remove('visible');
});

// ─── Profiles / Auth ─────────────────────────────────────────
const TOKEN_KEY = 'plated_token';
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export const ACCENTS = ['#c8b8ff', '#7ee7c7', '#ffb8d2', '#ffd98e', '#8ec5ff', '#ff9e7a'];

let currentProfile = null;
export function getProfile() { return currentProfile; }

function saveToken(t) {
  setToken(t);
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
}
function clearToken() {
  setToken(null);
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

// Profile name pill at the top of every screen
export function renderProfileBar() {
  const bar = document.getElementById('profile-bar');
  if (!bar) return;
  if (!currentProfile) { bar.innerHTML = ''; return; }
  const c = currentProfile.accent_color || '#c8b8ff';
  bar.innerHTML = `<span class="profile-pill" style="background:${c}1f;color:${c};border-color:${c}66">${esc(currentProfile.name)}</span>`;
}

// Called by Settings after rename / colour change so the pill stays in sync
export function applyProfile(profile) {
  currentProfile = { ...currentProfile, ...profile };
  renderProfileBar();
}

function showScreen(which) {
  document.getElementById('lock-screen').classList.toggle('hidden', which !== 'lock');
  document.getElementById('create-screen').classList.toggle('hidden', which !== 'create');
  document.getElementById('app').classList.toggle('hidden', which !== 'app');
}

async function enterApp(profile) {
  currentProfile = profile;
  renderProfileBar();
  showScreen('app');
  await reloadEnergyUnit();
  currentView = null;
  navigateTo('today');
}

// Exported for Settings: end session / after deleting profile → back to lock
export function logoutToLock() {
  clearToken();
  currentProfile = null;
  renderProfileBar();
  showLock();
}

// ─── Lock screen (numpad login) ──────────────────────────────
let passcode = '';

function setDots(len, state = 'normal') {
  document.querySelectorAll('#lock-dots .dot').forEach((d, i) => {
    d.classList.remove('filled', 'error');
    if (i < len) d.classList.add(state === 'error' ? 'error' : 'filled');
  });
}
function shakeDots() {
  const dots = document.getElementById('lock-dots');
  dots.style.animation = 'none';
  dots.getBoundingClientRect();
  dots.style.animation = 'shake 300ms ease';
  setTimeout(() => { dots.style.animation = ''; }, 350);
}

function showLock() {
  passcode = '';
  setDots(0);
  document.getElementById('lock-subtitle').textContent = 'Enter your passcode';
  showScreen('lock');
}

async function submitLogin() {
  const code = passcode;
  try {
    const { token, profile } = await api.post('/api/auth/login', { passcode: code });
    saveToken(token);
    enterApp(profile);
  } catch (err) {
    if (String(err.message).toLowerCase().includes('no profile')) {
      showCreate(code);          // offer to create a profile with this code
    } else {
      setDots(code.length, 'error');
      shakeDots();
    }
    setTimeout(() => { passcode = ''; setDots(0); }, 500);
  }
}

function pushDigit(d) {
  if (passcode.length >= 4) return;
  passcode += d;
  setDots(passcode.length);
  if (passcode.length === 4) submitLogin();
}

function setupNumpad() {
  document.querySelectorAll('.numpad-key[data-digit]').forEach(btn =>
    btn.addEventListener('click', () => pushDigit(btn.dataset.digit)));
  document.getElementById('numpad-back').addEventListener('click', () => {
    passcode = passcode.slice(0, -1);
    setDots(passcode.length);
  });
  document.getElementById('lock-create-link').addEventListener('click', () => showCreate(''));

  window.addEventListener('keydown', e => {
    if (document.getElementById('lock-screen').classList.contains('hidden')) return;
    if (/^\d$/.test(e.key)) pushDigit(e.key);
    else if (e.key === 'Backspace') { passcode = passcode.slice(0, -1); setDots(passcode.length); }
  });
}

// ─── Create-profile screen ───────────────────────────────────
let chosenAccent = ACCENTS[0];

function renderAccentPicker() {
  const row = document.getElementById('create-accents');
  row.innerHTML = ACCENTS.map(c =>
    `<button type="button" class="accent-swatch${c === chosenAccent ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>`
  ).join('');
  row.querySelectorAll('.accent-swatch').forEach(b =>
    b.addEventListener('click', () => { chosenAccent = b.dataset.color; renderAccentPicker(); }));
}

function showCreate(prefillCode = '') {
  chosenAccent = ACCENTS[0];
  showScreen('create');
  document.getElementById('create-name').value = '';
  document.getElementById('create-code').value = prefillCode;
  renderAccentPicker();
  setTimeout(() => document.getElementById('create-name').focus(), 150);
}

function setupCreate() {
  document.getElementById('create-cancel').addEventListener('click', showLock);
  document.getElementById('create-submit').addEventListener('click', async () => {
    const name = document.getElementById('create-name').value.trim();
    const code = document.getElementById('create-code').value.trim();
    if (!name) { showToast('Enter a name', 'error'); return; }
    if (!/^\d{4}$/.test(code)) { showToast('Passcode must be 4 digits', 'error'); return; }
    const btn = document.getElementById('create-submit');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { token, profile } = await api.post('/api/auth/profiles', { name, passcode: code, accent_color: chosenAccent });
      saveToken(token);
      enterApp(profile);
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Create profile';
    }
  });
}

// ─── Init ────────────────────────────────────────────────────
onUnauthorized(() => { clearToken(); currentProfile = null; renderProfileBar(); showLock(); });

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.view));
});
setupNumpad();
setupCreate();

// Boot: resume an existing session, else show the lock screen
(async () => {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      setToken(stored);
      const profile = await api.get('/api/auth/me');  // throws on expired/invalid
      await enterApp(profile);
      return;
    }
  } catch (err) {
    // Only wipe the stored token on an actual auth rejection (api.js throws
    // this exact message on a 401). A network failure here just means
    // "offline right now" — clearing the token on that would force someone
    // who opens the app with no signal to re-enter their passcode once back
    // online, even though their session was never actually invalid.
    if (err.message === 'Session expired') clearToken();
  }

  try {
    const { hasProfiles } = await api.get('/api/auth/status');
    if (hasProfiles) showLock();
    else showCreate('');          // first run — go straight to create
  } catch {
    showLock();
  }
})();

// Load energy unit preference once logged in (called by settings view on save too)
export async function reloadEnergyUnit() {
  try {
    const s = await api.get('/api/settings');
    setEnergyUnit(s.energy_unit || 'kcal');
  } catch { /* use default */ }
}

// Shake animation for the passcode dots
const _shakeStyle = document.createElement('style');
_shakeStyle.textContent = `@keyframes shake {0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}`;
document.head.appendChild(_shakeStyle);
