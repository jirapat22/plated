import { api, setToken, setProfileId, onUnauthorized } from './api.js';
import { clearProfile } from './utils/offlineStore.js';
import { startQueue } from './utils/writeQueue.js';
import { setEnergyUnit } from './utils/energy.js';
import { installErrorCapture, submitReport } from './utils/bugReport.js';
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
  // 10s, not 6, when there is something to tap. Six is the usual default, but
  // this app's reader has to notice the toast, read it, and hit a small target
  // near the bottom edge — and the thing being undone is usually a delete.
  timer = setTimeout(dismiss, opts.duration || (opts.actionLabel ? 10000 : 3000));
}

// ─── Bottom Sheet ───────────────────────────────────────────
// hideSheet's teardown runs 300ms later, to let the slide-out finish. Nothing
// used to cancel it, so closing a sheet and opening another inside that window
// — two taps under 300ms apart, which is inside normal double-tap range — let
// the OLD timer fire against the NEW sheet: it re-added `hidden`, wiped
// #sheet-content, and left `hidden` and `open` both set. The sheet appeared and
// then silently vanished. Reproduced: content "Add Food / Recent / Favourites /
// Batches" at open, empty string 300ms later.
let sheetTeardown = null;

export function showSheet(renderFn) {
  const overlay = document.getElementById('sheet-overlay');
  const sheet   = document.getElementById('sheet');
  const content = document.getElementById('sheet-content');

  clearTimeout(sheetTeardown);
  sheetTeardown = null;

  content.innerHTML = '';
  renderFn(content);

  hideUpdateBanner();          // it would sit on top of this sheet's buttons
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
  clearTimeout(sheetTeardown);
  sheetTeardown = setTimeout(() => {
    sheetTeardown = null;
    overlay.classList.add('hidden');
    sheet.classList.add('hidden');
    document.getElementById('sheet-content').innerHTML = '';
    renderUpdateBanner();      // deferred while the sheet was up
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

// force=true re-renders even if you're already on the view. The wrapper div is
// appended synchronously, so children.length is always 1 after a navigation —
// meaning a view that loaded blank or errored could never be retried by tapping
// its own tab, and the only way out was switching tabs and back. Tapping the
// active tab now reloads it, which is the usual idiom anyway.
export function navigateTo(view, force = false) {
  if (!force && view === currentView && document.getElementById('view-container').children.length > 0) return;
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

// The waiting worker, held from the moment one is found until the user either
// accepts it or reloads for some other reason.
let updateWorker = null;

function showUpdateBanner(worker) {
  updateWorker = worker;
  renderUpdateBanner();
}

// Never render over a bottom sheet. The banner is position:fixed at z-index
// 1100 and the sheet is 201, so it landed squarely on top of whatever button
// you were reaching for — mid Quick Log, that's the Log button. The only way
// past it was Refresh, which reloads the page and throws away everything you
// had typed, so you got to enter the meal twice. Held until the sheet closes.
function renderUpdateBanner() {
  if (!updateWorker || document.getElementById('update-banner')) return;
  if (!document.getElementById('sheet').classList.contains('hidden')) return;

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
    updateWorker.postMessage({ type: 'skip-waiting' });
    banner.remove();
  };
}

// The other order of the same collision: banner already up, then you open a
// sheet. Pulled off screen, not forgotten — updateWorker still holds it, so it
// comes back when the sheet closes.
function hideUpdateBanner() {
  document.getElementById('update-banner')?.remove();
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

// Send anything logged while offline, as soon as there is a connection and
// again whenever the app comes back to the foreground — a phone regaining
// signal in a pocket never fires 'online'. Every queued write carries a
// client_id the server recognises, so firing this more often than necessary
// costs a wasted request and never a duplicate meal.
const runQueue = startQueue(() => currentProfile?.id ?? null, ({ sent, failed }) => {
  if (sent) {
    showToast(sent === 1 ? 'Synced the meal you logged offline' : `Synced ${sent} offline entries`, 'success');
    if (currentView) navigateTo(currentView, true);
  }
  // Said out loud rather than swallowed. A write that can never succeed —
  // the food was deleted, the day was rejected — has to be visible, or the
  // queue becomes a place meals quietly go missing.
  if (failed) {
    showToast(failed === 1 ? "One offline entry couldn't be saved" : `${failed} offline entries couldn't be saved`, 'error');
  }
});

// ─── Theme ───────────────────────────────────────────────────
// The <head> script in index.html already applied the stored theme before
// paint; these two only exist so Settings can read and change it. Everything
// visual hangs off the token block in style.css, so flipping one attribute is
// the whole switch — no re-render, no reload.
const THEME_KEY = 'plated_theme';
export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
export function setTheme(mode) {
  const light = mode === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6f5f9' : '#0d0d0f');
  try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch {}
}

// ─── Accessibility (text size, weight, contrast, tap targets) ─
// Per profile, not per device: on a shared phone one person can run everything
// at 150% while the other stays at 100%. The scale is ALSO mirrored to
// localStorage — not as a second setting, but so the first paint after launch
// is already the right size instead of snapping from 100% a moment later. That
// flash is worst for exactly the person who needs the scale. Cleared on logout
// so the next person at the lock screen doesn't inherit it.
const SCALE_CACHE = 'plated_ui_scale';
const SCALES = ['100', '115', '130', '150'];

export function applyA11y(s = {}) {
  const r = document.documentElement;
  const scale = SCALES.includes(String(s.ui_scale)) ? String(s.ui_scale) : '100';
  r.style.setProperty('--ui-scale', String(Number(scale) / 100));
  r.setAttribute('data-bold',     s.bold_text     === '1' ? '1' : '0');
  r.setAttribute('data-contrast', s.high_contrast === '1' ? '1' : '0');
  r.setAttribute('data-targets',  s.big_targets   === '1' ? '1' : '0');
  try { localStorage.setItem(SCALE_CACHE, scale); } catch {}
}

function clearA11y() {
  const r = document.documentElement;
  r.style.removeProperty('--ui-scale');
  for (const a of ['data-bold', 'data-contrast', 'data-targets']) r.setAttribute(a, '0');
  try { localStorage.removeItem(SCALE_CACHE); } catch {}
}

// ─── Profiles / Auth ─────────────────────────────────────────
const TOKEN_KEY = 'plated_token';
// Who was last signed in on this device: id, name, accent. Enough to open the
// app while offline, when /api/auth/me cannot be reached to ask. localStorage
// rather than the IndexedDB cache because it has to be readable synchronously
// at boot, before we know whose cache to open — and it holds nothing the token
// sitting beside it doesn't already imply.
const LAST_PROFILE_KEY = 'plated_last_profile';
function saveLastProfile(p) {
  try {
    if (p) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify({ id: p.id, name: p.name, accent_color: p.accent_color, is_admin: p.is_admin }));
    else localStorage.removeItem(LAST_PROFILE_KEY);
  } catch { /* private mode */ }
}
function readLastProfile() {
  try { return JSON.parse(localStorage.getItem(LAST_PROFILE_KEY) || 'null'); } catch { return null; }
}
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export const ACCENTS = ['#c8b8ff', '#7ee7c7', '#ffb8d2', '#ffd98e', '#8ec5ff', '#ff9e7a'];

// Every accent above is picked to glow on near-black, so used as TEXT on a
// light background they're all but invisible. Wrapping them in color-mix with
// the --ink-mix token darkens them only in light mode (100% = unchanged in
// dark), which beats storing a second accent per profile.
// ponytail: if a profile ever wants a genuinely different colour per theme,
// that's a second column — this covers the case where it's the same hue.
export const accentInk = c => `color-mix(in srgb, ${c} var(--ink-mix), #000)`;

let currentProfile = null;
export function getProfile() { return currentProfile; }

// Keep api.js's notion of "who is this" in step with ours. The offline cache is
// keyed on it, so getting this wrong would mean one profile reading another's
// cached day on a shared phone — the whole reason that cache lives in the page
// and not in the service worker.
function setCurrentProfile(p) {
  currentProfile = p;
  setProfileId(p?.id ?? null);
  if (p) saveLastProfile(p);
}

function saveToken(t) {
  setToken(t);
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
}
function clearToken() {
  setToken(null);
  // The remembered profile goes with the token. Leaving it behind would let the
  // offline-boot path above walk straight back into an account that had just
  // been signed out of, on a phone the family shares.
  saveLastProfile(null);
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

// Profile name pill at the top of every screen
export function renderProfileBar() {
  const bar = document.getElementById('profile-bar');
  if (!bar) return;
  if (!currentProfile) { bar.innerHTML = ''; return; }
  const c = currentProfile.accent_color || '#c8b8ff';
  // 1f/66 was a 12% fill behind a 40% border — on a phone, under the Dynamic
  // Island's black mass, the whole chip read as absent ("the name tag is kinda
  // gone"). It sits in the hardest place on the screen to see anything, so it
  // gets a fill you can actually find: 20% behind a 60% border.
  bar.innerHTML = `<span class="profile-pill" style="background:${c}33;color:${accentInk(c)};border-color:${c}99">${esc(currentProfile.name)}</span>`;
}

// Called by Settings after rename / colour change so the pill stays in sync
export function applyProfile(profile) {
  setCurrentProfile({ ...currentProfile, ...profile });
  renderProfileBar();
}

function showScreen(which) {
  // Close any open sheet before leaving the app. #sheet and #sheet-overlay are
  // siblings of #app, not children, so hiding #app does not hide them — and
  // since the lock screen dropped to z-index 150 (so it stops burying the
  // toasts and the passcode-recovery sheet) the sheet at 201 now paints OVER
  // it. Without this, a session that expires while a sheet is open — or
  // another device signing this one out — leaves the previous profile's meal
  // data sitting on top of a locked screen, with the numpad unreachable behind
  // the overlay. The lock screen is the one place where "still mounted" and
  // "still visible" stopped being the same thing.
  if (which !== 'app') hideSheet();
  document.getElementById('lock-screen').classList.toggle('hidden', which !== 'lock');
  document.getElementById('create-screen').classList.toggle('hidden', which !== 'create');
  document.getElementById('app').classList.toggle('hidden', which !== 'app');
}

async function enterApp(profile) {
  setCurrentProfile(profile);
  renderProfileBar();
  showScreen('app');
  await reloadProfilePrefs();
  currentView = null;
  navigateTo('today');
  runQueue();          // anything held from a previous session goes now
}

// Exported for Settings: end session / after deleting profile → back to lock
export function logoutToLock() {
  // Wipe this profile's cached reads and queued writes before forgetting who
  // they were. Logging out on a shared phone has to leave nothing readable
  // behind, and a queued write has no one to flush it under any more.
  const leaving = currentProfile?.id ?? null;
  if (leaving != null) clearProfile(leaving);
  clearToken();
  clearA11y();
  setCurrentProfile(null);
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

// A forgotten 4-digit code used to mean the data was gone: nothing could reach
// pass_hash without already being logged in. This raises a reset request on the
// admin's Orbit dashboard, which is the same pipeline bug reports already use —
// public (it has to work from the lock screen), rate limited, and it queues
// offline. Deliberately does NOT confirm whether the name exists: an unlocked
// lock screen should not become a way to enumerate who has an account.
function openForgotPasscode() {
  showPrompt({
    title: 'Request a reset',
    label: 'Your profile name, and anything that identifies you',
    placeholder: 'e.g. Sam — the account I set up last Tuesday',
    cta: 'Send request',
    maxLength: 300,
  }, async text => {
    const detail = String(text || '').trim();
    if (!detail) return;
    try {
      await submitReport({
        type: 'passcode_reset',
        message: `Passcode reset requested — ${detail}`,
        context: { kind: 'passcode_reset', stated_name: detail, requested_at: new Date().toISOString() },
      });
      showToast("Sent. The admin will get in touch — they can reset it for you.", 'success', { duration: 6000 });
    } catch {
      showToast("Saved — it'll send once you're back online.", 'info', { duration: 6000 });
    }
  });
}

async function submitLogin() {
  const code = passcode;
  try {
    const { token, profile } = await api.post('/api/auth/login', { passcode: code });
    saveToken(token);
    enterApp(profile);
  } catch (err) {
    // An unrecognised code used to drop you straight onto the "New profile"
    // screen with your typo already filled in. That reads as "your account is
    // gone, make another" — and tapping through it hands you a second, empty
    // profile while your real data sits behind the code you fat-fingered.
    // Wrong code now says so, and creating a profile stays a deliberate act via
    // the "+ New profile" button that is already right there on this screen.
    const sub = document.getElementById('lock-subtitle');
    // A lockout (429) looks identical to a wrong code otherwise — same shake,
    // no explanation — so say what happened rather than letting someone keep
    // retrying a code that's actually correct.
    sub.textContent = err.status === 429
      ? err.message
      : String(err.message).toLowerCase().includes('no profile')
        ? "That code isn't recognised — try again"
        : err.message;
    setDots(code.length, 'error');
    shakeDots();
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
  document.getElementById('lock-create-link').addEventListener('click', () => showCreate());
  document.getElementById('lock-forgot-link').addEventListener('click', openForgotPasscode);

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

// No prefill parameter any more: its only caller was the failed-login handler,
// which used to seed this screen with the code you just got wrong.
function showCreate() {
  chosenAccent = ACCENTS[0];
  showScreen('create');
  document.getElementById('create-name').value = '';
  document.getElementById('create-code').value = '';
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
onUnauthorized(() => { clearToken(); setCurrentProfile(null); renderProfileBar(); showLock(); });

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.view, true));
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
    // ...and if we ARE just offline, go in anyway. Keeping the token but still
    // showing the lock screen was the worst of both: a day's meals sitting
    // cached on the device, a valid session in hand, and a passcode prompt that
    // could not be satisfied because checking it needs the server. Offline
    // reads exist precisely for this moment and were unreachable.
    //
    // Optimistic, not a bypass: nothing here trusts the client. The token is
    // still sent on every request and still rejected server-side if it is bad —
    // onUnauthorized bounces straight back to lock the moment a real reply
    // says so. The passcode was never the thing being verified offline; the
    // stored session token is, and only the server can do that.
    else if (err.offline && localStorage.getItem(TOKEN_KEY)) {
      const last = readLastProfile();
      if (last) { await enterApp(last); return; }
    }
  }

  try {
    const { hasProfiles } = await api.get('/api/auth/status');
    if (hasProfiles) showLock();
    else showCreate();            // first run — go straight to create
  } catch {
    showLock();
  }
})();

// Load energy unit preference once logged in (called by settings view on save too)
// One settings fetch at login, feeding both the energy unit and the
// accessibility attributes. Settings re-applies these itself on change, so this
// only has to be right at entry.
export async function reloadProfilePrefs() {
  try {
    // getCached, so an offline launch keeps the unit and the accessibility
    // settings it had. Falling back to defaults would silently flip a kJ user
    // to kcal and drop the text scale and contrast — for the person those
    // settings exist for, at the exact moment they can least afford it.
    const { data: s } = await api.getCached('/api/settings');
    setEnergyUnit(s.energy_unit || 'kcal');
    applyA11y(s);
    syncTimezone(s.timezone);
  } catch { /* no cached copy either — use defaults */ }
}

// The server derives "today" for a few things it can't get from the client:
// the Trends window anchor, the IronLog import's calendar day. That used to be
// one hardcoded zone for everybody, which is fine until the second person lives
// somewhere else — then their day rolls over hours early or late, and IronLog
// weigh-ins land on the wrong date. This tells the server where this profile
// actually is. Fire-and-forget: a failure just means the server keeps using the
// zone it already had.
function syncTimezone(stored) {
  let tz;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return; }
  if (!tz || tz === stored) return;
  api.patch('/api/settings', { timezone: tz }).catch(() => {});
}

// Shake animation for the passcode dots
const _shakeStyle = document.createElement('style');
_shakeStyle.textContent = `@keyframes shake {0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}`;
document.head.appendChild(_shakeStyle);
