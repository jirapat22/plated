import { api } from './api.js';
import { setEnergyUnit } from './utils/energy.js';
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

// ─── Init ────────────────────────────────────────────────────

// Bottom nav routing
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.view));
});

reloadEnergyUnit().then(() => navigateTo('today'));

// Load energy unit preference once logged in (called by settings view on save too)
export async function reloadEnergyUnit() {
  try {
    const s = await api.get('/api/settings');
    setEnergyUnit(s.energy_unit || 'kcal');
  } catch { /* use default */ }
}
