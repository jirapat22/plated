import { api, setToken, onUnauthorized } from './api.js';
import { renderToday }    from './views/today.js';
import { renderHistory }  from './views/history.js';
import { renderTrends }   from './views/trends.js';
import { renderFoods }    from './views/foods.js';
import { renderSettings } from './views/settings.js';

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

// ─── Auth / Lock Screen ──────────────────────────────────────
let passcode = '';
let isSetup  = false;

function setDots(len, state = 'normal') {
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.remove('filled', 'error');
    if (i < len) d.classList.add(state === 'error' ? 'error' : 'filled');
  });
}

function shakeNumpad() {
  const dots = document.getElementById('lock-dots');
  dots.style.animation = 'none';
  dots.getBoundingClientRect();
  dots.style.animation = 'shake 300ms ease';
  setTimeout(() => { dots.style.animation = ''; }, 350);
}

async function submitPasscode() {
  if (passcode.length < 4) return;
  try {
    let data;
    if (isSetup) {
      data = await api.post('/api/auth/setup', { passcode });
    } else {
      data = await api.post('/api/auth/verify', { passcode });
    }
    setToken(data.token);
    showApp();
  } catch {
    setDots(passcode.length, 'error');
    shakeNumpad();
    setTimeout(() => {
      passcode = '';
      setDots(0);
    }, 600);
  }
}

function setupNumpad() {
  document.querySelectorAll('.numpad-key[data-digit]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (passcode.length >= 6) return;
      passcode += btn.dataset.digit;
      setDots(passcode.length);
      if (passcode.length >= 6) submitPasscode();
    });
  });

  document.getElementById('numpad-back').addEventListener('click', () => {
    passcode = passcode.slice(0, -1);
    setDots(passcode.length);
  });

  document.getElementById('lock-action').addEventListener('click', submitPasscode);
}

function showLock(setup = false) {
  isSetup = setup;
  passcode = '';
  setDots(0);
  document.getElementById('lock-subtitle').textContent = setup
    ? 'Choose a 4–6 digit passcode'
    : 'Enter passcode';
  document.getElementById('lock-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('lock-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  navigateTo('today');
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

// ─── Shake animation (inline) ────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%,100%{transform:translateX(0)}
    20%{transform:translateX(-8px)}
    40%{transform:translateX(8px)}
    60%{transform:translateX(-6px)}
    80%{transform:translateX(6px)}
  }
`;
document.head.appendChild(style);

// ─── Init ────────────────────────────────────────────────────
onUnauthorized(() => showLock(false));

// Bottom nav routing
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.view));
});

setupNumpad();

// Check auth status on load
(async () => {
  try {
    const { hasPasscode } = await api.get('/api/auth/status');
    showLock(!hasPasscode);
  } catch {
    showLock(false);
  }
})();
