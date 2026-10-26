# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hosting (since 22/10/2026): read this first

Production runs on Pat's home **Mac mini** (at Lily's), **not Railway**: Docker Compose in `~/Projects/mac-server`
(repo jirapat22/mac-server, compose service `plated`), public at https://plated.jirapat.dev through a Cloudflare tunnel.

- **Deploy:** push to `master`, then on the Mac run `cd ~/Projects/mac-server && bash scripts/update.sh`
  (or `docker compose up -d --build plated`). **Pushing alone no longer deploys anything.**
- **Settings/secrets:** `~/Projects/mac-server/env/plated.env` (never committed). **Data:** SQLite `~/Projects/mac-server/data/plated/plated.db` (in the container: `/data/plated.db`).
- **Logs:** `docker compose logs -f plated`. Server health: https://status.jirapat.dev
- **Railway** is a stopped cold backup (deployment removed, GitHub auto-deploy disconnected). Railway-specific
  notes elsewhere in this file are history; App Sleeping no longer applies, so the app is always on.
- **Never write the SQLite file from macOS while the container runs.** WAL locking can't coordinate across the OrbStack VM, and doing it once made Plated report "database disk image is malformed". Stop the container first, or work inside it with `docker compose exec plated ...`.
- Full runbook: `~/Projects/mac-server/README.md`.

## Commands

```bash
npm start                       # or npm run dev — identical; node --experimental-sqlite server.js
npm test                        # whole suite, a few seconds

# one file
node --experimental-sqlite --test test/batch-stock.test.mjs
# one test by name
node --experimental-sqlite --test --test-name-pattern "exhausted batch" test/http.test.mjs
```

`--experimental-sqlite` is **not optional** — `node:sqlite` is behind the flag on
Node 22/23 and the process dies on import without it. Any script you write
against the DB needs it too. No build step, no bundler, no linter: the browser
loads `public/js/**` as native ES modules and the server is CommonJS.

Local runs put the database in `./data/plated.db`; `DATA_DIR` overrides (tests
use a throwaway temp dir), and production uses the Railway volume at `/data`.

## Architecture

Express API + a vanilla-JS PWA, one process, one SQLite file.

```
server.js            route mounting, CORS, error handler, graceful shutdown
src/db.js            schema + migrations + food seeding, all on every boot
src/routes/*.js      one router per resource, mounted under /api/<name>
src/utils/*.js       shared rules — leaf modules, no route-to-route requires
src/middleware/      requireProfile (Bearer token), rateLimit (per-IP, in-memory)
public/js/app.js     shell: nav, bottom sheets, toasts, lock screen, SW update
public/js/api.js     the only fetch wrapper; token injection, offline cache, wake retry
public/js/views/     5 tab views + 3 shared sheet modules (see below)
public/js/utils/     stats, offline store, write queue, food icons, energy units
public/sw.js         precache + network-first API, hand-versioned
```

**Views vs sheet modules.** `app.js` registers exactly five tabs —
`today, history, trends, foods, settings`. `views/log.js`, `views/batches.js`
and `views/presets.js` are *not* tabs: they export sheet openers
(`openFoodEntry`, `openPortion`, `openPresetLog`, …) that the tabs call. `log.js`
is the biggest file in the app and the one every logging path goes through.

**The database is one synchronous connection.** `node:sqlite`'s `DatabaseSync`
has no async API, so every route handler is straight-line code with no `await`.
Several invariants depend on that (see Idempotency). If you ever add an `await`
to a route that touches stock or idempotency, those guarantees die and need a
real lock.

**`initDb()` is the whole migration system.** It runs on every boot: `CREATE
TABLE IF NOT EXISTS`, then `migrateSchema()` (additive `ALTER TABLE`s guarded by
`tableHasColumn`), then indexes, then seeding. It is also *destructively*
idempotent — `migrateSchema` unconditionally `DROP TABLE IF EXISTS`es tables for
removed features (`water_log`, `meal_templates`, `notes`). **Never name a new
table after a dropped one**; it would be deleted on the next deploy. There is no
migration file, no version table, no down-migrations.

**Food seeding.** ~4,800 rows from NZFCD + AUSNUT are seeded once, gated on
`SEED_VERSION` in `src/db.js`. Changing the seed lists means bumping that string
or nothing re-seeds. First boot on an empty volume takes a few seconds, which is
why `test/http.test.mjs` polls rather than sleeps.

## Rules that bite

**Bump `CACHE_NAME` in `public/sw.js` on every `public/` change.** It is
hand-maintained (`plated-vNNN`) and it is the entire update mechanism: the worker
does not `skipWaiting()`, so a new version sits waiting until the user taps the
banner. Every client module must also be listed in `STATIC_ASSETS` —
`test/precache-manifest.test.mjs` fails the build both ways, because a stale
entry fails the install (and then no update ever lands again) and a missing one
breaks the app only when opened offline.

**Idempotency is keyed on `(route-tag, client_id)`.** `src/utils/idempotency.js`
— `keyFor(tag, clientId)`. The tag must distinguish *intents*, not just routes:
`meal-copy:${dest}` includes the destination because copying the same meal to two
days is two intents, not a retry. A shared tag replays one route's response as
another's. Writes that move batch stock must use this; a duplicate looks like one
extra entry but has silently taken the grams twice.

**Nullable numbers.** `round1(null)` is `0`, which is a different claim from "not
recorded". Use `r1n = n => (n == null ? null : round1(n))` wherever a macro can
legitimately be absent (see `src/routes/batches.js`).

**Dates are local calendar days, never UTC.** `String(x).split('T')[0]` on an ISO
instant is wrong in NZ for half of every day. Use `src/utils/tz.js`:
`tzFor(db, pid)` for the profile's zone (per-profile, not global),
`localDayOf(value, tz)` to get a day from an instant, `isRealDate()` to validate
(the shape regex alone accepts `2026-02-30`), `todayLocal(tz)` as a fallback only.

**Food visibility.** `source IN ('quick','batch','leftover')` rows are private
notes, not library entries. Any route taking a food id **from the request** must
go through `usableFood(db, id, pid)` or `VISIBLE_SQL` in
`src/utils/foodAccess.js`; ids read back out of the profile's own rows are theirs
by construction and must not be gated. Deleting a food uses `UNREFERENCED_SQL` —
`foreign_keys` is ON, so an unguarded delete *throws* rather than skipping.

**Validation lives in `src/utils/validate.js`, not in routes.** Three writers hit
the same columns with different failure modes: the settings form (reject), backup
restore (skip the row, count it), IronLog sync (drop the field, report it). Add
bounds there, once.

**Batch stock moves only through `adjustBatchStock()`** (`src/utils/batchStock.js`).
It deliberately has no floor: a negative `remaining_g` means the log says more
came out than went in, which is true and worth knowing. Display floors at 0 and
reports `overdrawn_g` separately. A portion deducts stock at *portion* time, not
eat time — that is intended, don't "fix" it.

**Pointer geometry has to go through `elementFromPoint`, not through rects.**
The scroll container runs `zoom: var(--ui-scale)`, so pointer coordinates are
viewport px while an element's own CSS box is 1/scale of what
`getBoundingClientRect()` reports. Hand-comparing the two is right at 100% and
silently wrong at 150%, which is where real users run it. Anything that
has to float above the page (`public/js/views/log.js`'s drag ghost) belongs on
`<body>`, outside both the zoom and `.meal-session`'s `overflow: hidden`, laid
out unzoomed and scaled back up (`utils/dragIntent.js`'s `unzoom`).

**A listener that outlives its subject is a bug, not a leak.** The drag keeps
`pointermove`/`pointerup` on `document` rather than on the row, because
removing a `setPointerCapture` target releases the capture silently and the
teardown never runs — which left a scroll-blocking listener installed for the
rest of the session. `navigateTo(currentView, true)` replaces every card
whenever the offline write queue flushes, so "the element is still there" is
not an assumption any gesture may make.

**Snapshot goals after any goal write.** `snapshotGoals(db, pid, today)` from
`src/utils/goals.js`; `profile_settings` holds one value per key, so without the
history table changing a goal silently rewrites what past days were judged
against.

## Testing

`node:test` + `node:assert`, files are `test/*.test.mjs`. Most are unit tests
against an exported function; `test/http.test.mjs` spawns the real server as a
child process on a random port with a temp `DATA_DIR` and drives it over HTTP —
that is the only shape that catches bugs living in the *order* of two statements
inside a handler. Frontend utils are imported directly as ES modules, so
`public/js/utils/*` should stay free of DOM access at module scope.

There are no mocks and no fixtures framework. Tests that need a DB call
`initDb()` against a temp dir.

## Deploy

Railway, from `master`, nixpacks, `healthcheckPath = /health`. **App Sleeping is
on**: the container stops after ~5 minutes with no traffic and Railway's docs say
the first request to a sleeping service may return 502. `public/js/api.js` retries
GETs once after 1.2s for exactly this reason — a wake must not render as
"offline", and with few users every launch is a cold one.

Env: `DATA_DIR`, `PORT`, `NODE_ENV`, `APP_TZ` (default `Pacific/Auckland`),
`ORBIT_URL` + `INGEST_SECRET` (bug-report forwarding; disabled when unset),
`ORBIT_API_KEY` (gates `/api/orbit*`, **fails closed** when unset), `ORBIT_TZ`,
`IRONLOG_API_URL` / `IRONLOG_API_KEY` (only inherited by the first profile; the
live values are per-profile in `profile_settings`).

## Accessibility is a hard constraint

Real users run the UI at up to 150% text scale. Every
dimension in `style.css` is in `px` and scaling goes through
`zoom: var(--ui-scale)` on `.view-container` / `.sheet-content` — **not** root
font-size. Elements outside those subtrees (nav, toasts, profile pill, lock
screen) carry `calc(… * var(--ui-scale))` individually because `position: fixed`
resolves percentages against the unzoomed viewport. If you add a fixed-position
element, scale it by hand and check it at 150%.

Settings are per profile (`ui_scale`, `bold_text`, `high_contrast`,
`big_targets`), applied by `applyA11y()`; `index.html` has an inline pre-paint
script mirroring theme and scale from `localStorage` so the app doesn't flash.

## Decisions already made

Don't re-propose these; they were decided deliberately.

- **The passcode stays 4 digits.** No longer codes, no escalating lockouts — the
  per-IP limiter (10 failures / 15 min, then a 15-min block) is the accepted
  mitigation. Every version of that hardening is paid for by the users who need large text.
- **No logging reminders or push nags.** Rejected.
- **No micronutrient tracking.** Rejected 2026-07-23.
- **`isSafeExternalUrl` must not be weakened for testability.** It is the line
  that decides where the server sends a request; extract a pure predicate instead.
- **Auto-adjust** (writing Trends' measured maintenance into the `tdee` setting)
  is parked as a maybe-todo. Don't build it unasked.

## Comment style

This codebase comments *why*, at length, and usually names the bug that made the
rule necessary — with the measured evidence ("production had ten of these above
900", "74% of one user's weigh-ins a day early"). Match that density. A
`ponytail:` prefix marks a deliberate simplification and names its ceiling and
upgrade path. Keep both conventions; they are how the non-obvious invariants
above survive.
