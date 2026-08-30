// What a value is allowed to be, in one place.
//
// These rules used to live in whichever route first needed them, which meant
// they applied at the form and nowhere else. Every one of them was then found
// bypassable through a second door writing the same column: a backup file
// restored a 1e9 g entry and "70abc" into a REAL column; IronLog's sync wrote a
// 999,999 kcal TDEE and a 700 kg bodyweight straight past the ranges the
// settings form enforces; and an imported settings block pointed
// ironlog_api_url at 127.0.0.1, which the PATCH handler refuses, turning
// /api/ironlog/raw into an SSRF read oracle.
//
// A leaf module on purpose — it requires nothing, so every route can require it
// without the route-to-route chains that the first round of these fixes grew.

// ── quantities ──────────────────────────────────────────────────────────────
// One sitting, in grams. There was a floor but no ceiling, so quantity_g
// 1000000000 was accepted and wrote a 5,189,000,000 kcal entry — which then
// counted in the day total, the 7-day average, the real-maintenance estimate
// behind Trends' verdict, and every chart, with nothing to say where it came
// from. 20 kg is far past any real portion and well short of a slipped decimal
// point, which is the mistake this catches.
const MAX_QTY_G = 20000;
function qtyError(value) {
  const q = parseFloat(value);
  if (!(q > 0)) return 'quantity_g > 0 required';
  if (q > MAX_QTY_G) return `That's over ${MAX_QTY_G.toLocaleString('en-NZ')} g in one go — check the decimal point`;
  return null;
}

// ── bodyweight ──────────────────────────────────────────────────────────────
// 20–400 kg. The measurements route already guarded its input this way ("catch
// inches typed into a cm field"); weight never got the same treatment despite
// being the more expensive mistake — it feeds recalcMacroGoals, so entering 700
// for 70.0 silently rewrote the protein goal to ~1540 g and nothing on screen
// explained where that came from. Can't catch lb-typed-as-kg (300 lb reads as a
// legitimate 300) — only the decimal slips, which are the common ones.
function badWeight(v) {
  const w = parseFloat(v);
  return Number.isFinite(w) && w >= 20 && w <= 400
    ? null
    : 'Weight must be between 20 and 400 kg — check the decimal point';
}

// ── outbound URLs ───────────────────────────────────────────────────────────
// ironlog_api_url is fetched server-side (src/routes/ironlog.js) and its raw
// response is echoed back verbatim via GET /api/ironlog/raw — without this
// check, any profile could point it at an internal address (cloud metadata,
// localhost, another service on the private network) and use that route as
// an SSRF read oracle. Blocks the obvious cases (literal internal
// hosts/IPs); doesn't defend against DNS rebinding, which is out of scope
// for this app's threat model (household members, not remote attackers).
function isSafeExternalUrl(str) {
  let u;
  try { u = new URL(str); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  // URL.hostname keeps the brackets on an IPv6 literal — 'http://[::1]:3000'
  // gives '[::1]', not '::1' — so the comparison below could never match and
  // every loopback form walked straight through. http://[::1]:PORT reached the
  // app's own port; so did [0:0:0:0:0:0:0:1] and [::ffff:127.0.0.1].
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0') return false;
  // Any IPv6 literal is judged by the one rule that is short and complete:
  // globally routable IPv6 is 2000::/3. Loopback (::1), unspecified (::),
  // unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped
  // (::ffff:7f00:1) all fall outside it, so one test covers forms that would
  // each otherwise need their own case — and anything new does too.
  if (host.includes(':')) return /^[23]/.test(host);
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return false;             // loopback, 10.0.0.0/8, "this" network
    if (a === 172 && b >= 16 && b <= 31) return false;               // 172.16.0.0/12
    if (a === 192 && b === 168) return false;                       // 192.168.0.0/16
    if (a === 169 && b === 254) return false;                       // link-local incl. cloud metadata (169.254.169.254)
  }
  return true;
}

// ── profile settings ────────────────────────────────────────────────────────
// Sane ranges for the settings that are numbers.
//
// Weight and waist have had bounds (and a "check the decimal point" message)
// since someone could type 700 kg. These never did: PATCH /api/settings took
// calorie_goal -500 and calorie_goal 1000000000 without comment, wrote them,
// and — because snapshotGoals runs after every goal write — recorded them into
// goal_history, where they permanently describe what you were "aiming at" on
// that day. A negative goal makes every ring, every "left" figure and every
// history comparison nonsense, with no way to tell where it came from.
//
// Bounds are wide on purpose: they exist to catch a slipped decimal point or a
// probe, not to have an opinion about anyone's diet.
// [min, max, unit] — the unit is appended to the message rather than left in
// the key, so it reads "between 20 and 400 kg" and not "target weight kg".
const NUMERIC_RANGE = {
  calorie_goal:        [200, 20000, 'kcal'],
  protein_goal:        [0, 2000, 'g'],
  carb_goal:           [0, 2000, 'g'],
  fat_goal:            [0, 2000, 'g'],
  fiber_goal:          [0, 500, 'g'],
  protein_multiplier:  [0, 10],
  fat_multiplier:      [0, 10],
  tdee:                [500, 20000, 'kcal'],
  cut_deficit:         [0, 5000, 'kcal'],
  bulk_surplus:        [0, 5000, 'kcal'],
  target_weight_kg:    [20, 400, 'kg'],
  bodyweight_kg:       [20, 400, 'kg'],
  height_cm:           [50, 260, 'cm'],
  birth_year:          [1900, 2100],
  activity_level:      [1, 3],
  ui_scale:            [100, 150, '%'],
};

// Whether ONE setting may hold this value: an error message, or null.
//
// Per-key rather than per-body because the three writers need different failure
// modes from the same rule. The form rejects the request; a restore skips the
// row and counts it; an IronLog sync drops the field and reports it.
//
// isValidTz is injected rather than imported so this file stays a leaf: tz.js
// is the only module that knows about zones and it has its own reasons to touch
// db. A caller that doesn't pass it simply doesn't get the timezone check.
function badSetting(key, value, isValidTz = null) {
  // Blank is allowed throughout — several of these are legitimately "not set
  // yet" (tdee, target_weight_kg), and clearing one is not the same as setting
  // it to zero.
  if (value === '' || value === null || value === undefined) return null;
  if (key === 'ironlog_api_url' && !isSafeExternalUrl(value)) {
    return 'IronLog URL must be a public http(s) address';
  }
  // An unknown zone has to be rejected at the write: every date the server
  // derives for this profile would otherwise throw from a route that looks
  // unrelated to the write that caused it.
  if (key === 'timezone' && isValidTz && !isValidTz(value)) return 'Unknown timezone';
  const range = NUMERIC_RANGE[key];
  if (!range) return null;
  const [min, max, unit] = range;
  const v = parseFloat(value);
  if (Number.isFinite(v) && v >= min && v <= max) return null;
  // Reads like the weight and waist messages rather than naming the column:
  // "Protein multiplier must be between 0 and 10", not "protein_multiplier".
  const label = key.replace(/_(kg|cm)$/, '').replace(/_/g, ' ');
  // Separators above four digits only, so a year stays 1900 and not 1,900.
  const n = x => (x >= 10000 ? x.toLocaleString('en-NZ') : String(x));
  return `${label[0].toUpperCase()}${label.slice(1)} must be between ${n(min)} and ${n(max)}${unit ? ' ' + unit : ''}`;
}

// The first thing wrong with a whole body, or null. What a form wants.
function settingsError(body, isValidTz = null) {
  for (const [k, v] of Object.entries(body)) {
    const bad = badSetting(k, v, isValidTz);
    if (bad) return bad;
  }
  return null;
}

// ── names ───────────────────────────────────────────────────────────────────
// Profile names render on the lock screen and in the switcher chips, and had no
// ceiling at all — create and rename both stored whatever was sent, so a
// 5,000-character name was accepted by both. Escaped everywhere it is drawn, so
// this is layout, not injection.
const MAX_NAME_LEN = 40;
const trimName = s => String(s ?? '').trim().slice(0, MAX_NAME_LEN);

module.exports = {
  MAX_QTY_G, qtyError,
  badWeight,
  isSafeExternalUrl,
  NUMERIC_RANGE, badSetting, settingsError,
  MAX_NAME_LEN, trimName,
};
