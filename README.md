# Plated

A mobile-first food diary for logging meals, calories and macros, built on New Zealand's official food database. It also checks whether a cut is actually working, from real weigh-ins rather than guesses.

**Live overview with screenshots:** [jirapat.dev/#plated](https://jirapat.dev/#plated) (the app itself is private, with a few real users)

<p>
  <img src="https://jirapat.dev/shots/plated-1-today.webp" width="240" alt="Today's calorie ring and macro bars">
  <img src="https://jirapat.dev/shots/plated-2-trends.webp" width="240" alt="Trends card saying the cut is on track">
  <img src="https://jirapat.dev/shots/plated-3-history.webp" width="240" alt="A past day's meals and totals">
</p>

<sub>Screenshots use made-up sample data.</sub>

## What it does

- **Fast logging** from about 4,800 foods (the NZ Food Composition Database plus Australia's AUSNUT), with presets for meals you eat often.
- **Batch cooking:** log a pot of chilli once, then eat it over several days. Plated tracks how much is left, so leftovers are counted correctly.
- **Trends:** calorie and macro averages, weigh-in trend lines and goal tracking.
- **Works offline:** it installs to the home screen (PWA), and meals logged with no signal are queued and sent when the connection returns.
- **Accessible:** built around a low-vision user, with text scaling up to 150%, bold text, high contrast and big tap targets, set per person.
- **Multi-user:** each person has a private profile.
- **Talks to my gym app:** body weight and activity sync with [Ironlog](https://github.com/jirapat22/ironlog) through a per-user API key.

## Interesting problems solved

- **No double-logged meals.** Phones retry requests on bad signal, so every write carries an ID, and the server ignores a repeat of the same ID ("idempotency"). Batch stock only ever moves through one function, so a retry can never take a portion twice.
- **Offline without data loss.** A service worker caches the app, and a write queue keeps unsent logs. Expired logins hold the queue instead of dropping it, and errors that can never succeed are dropped instead of retried forever.
- **One small, fast database.** SQLite through Node's built-in `node:sqlite`, so there are no native modules to compile and backups are a single file.

## Tech

Node.js 22 · Express · SQLite (`node:sqlite`) · vanilla JavaScript (ES modules, no build step) · service worker / PWA · Docker

## Testing

**250 automated tests** using Node's built-in test runner, covering the API, batch stock, idempotency, the offline write queue, imports/exports and the Ironlog sync.

```bash
npm test
```

## How it was built

Built with [Claude Code](https://claude.com/claude-code) (an AI coding assistant). I decided the features, directed the design and tested every change; Claude wrote most of the code.

## Run it yourself

Needs Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env    # optional: Ironlog integration settings
npm start               # http://localhost:3000
```

The database is created at `./data/plated.db` on first run (set `DATA_DIR` to put it elsewhere) and seeded with the food database.

In production it runs in Docker on a self-hosted home server, behind a Cloudflare Tunnel.
