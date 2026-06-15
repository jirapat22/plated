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
export function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 3000);
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

// ─── Service Worker ──────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.warn);
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
  } catch { clearToken(); }

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
