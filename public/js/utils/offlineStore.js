// On-device store for reading the app without a connection, and for holding
// writes made while there isn't one.
//
// IndexedDB rather than the Cache API, and driven by the page rather than the
// service worker, for one decisive reason: the session token travels in the
// Authorization header, not the URL, so a service worker matching on URL would
// serve one family member's day to another on the same phone. The page knows
// which profile it is; the worker would have to be taught, and a cache that is
// wrong about whose data it holds is worse than no cache.
//
// Everything here is keyed by profile id and wiped on logout. The service
// worker stays a dumb static-asset cache.

const DB_NAME = 'plated-offline';
const DB_VERSION = 1;
const READS = 'reads';
const QUEUE = 'queue';

let dbPromise = null;

function openDb() {
  // A private window, a browser with site data blocked, or an iOS quirk can all
  // make this throw or never settle. Every caller treats a rejection as "no
  // offline support" and carries on, so a hostile storage environment costs the
  // feature and nothing else.
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(READS)) db.createObjectStore(READS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(QUEUE)) {
        const q = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
        q.createIndex('profile', 'profileId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexeddb blocked'));
  }).catch(err => { dbPromise = null; throw err; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  }));
}

const readKey = (profileId, path) => `${profileId}|${path}`;

// ── Cached reads ────────────────────────────────────────────────────────────

export async function putRead(profileId, path, data) {
  if (profileId == null) return;
  try {
    await tx(READS, 'readwrite', s =>
      s.put({ key: readKey(profileId, path), profileId, path, data, at: Date.now() }));
  } catch { /* caching is an optimisation; never break a successful request */ }
}

// The last copy of this path we saw, with WHEN we saw it. The timestamp is the
// point: a number with no date on it is indistinguishable from live data, and
// showing yesterday's calories as though they were today's is worse than
// showing nothing.
export async function getRead(profileId, path) {
  if (profileId == null) return null;
  try {
    const row = await tx(READS, 'readonly', s => s.get(readKey(profileId, path)));
    return row ? { data: row.data, at: row.at } : null;
  } catch { return null; }
}

// ── Queued writes ───────────────────────────────────────────────────────────

// 22 chars of [A-Za-z0-9_-], which is what the server's isValidClientId accepts.
// crypto.randomUUID would do, but it is absent in some older mobile WebViews and
// this needs no uniqueness guarantee beyond "not the other rows in this queue".
export function newClientId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function enqueue(profileId, entry) {
  const row = { profileId, ...entry, at: Date.now(), tries: 0 };
  await tx(QUEUE, 'readwrite', s => s.add(row));
  return row;
}

// Only this profile's writes. A queued meal must never be flushed under whoever
// happens to be logged in when the connection returns — on a shared phone that
// files one person's dinner into another person's day.
export async function queued(profileId) {
  try {
    const all = await tx(QUEUE, 'readonly', s => s.getAll());
    return (all || []).filter(r => r.profileId === profileId).sort((a, b) => a.id - b.id);
  } catch { return []; }
}

export async function dequeue(id) {
  try { await tx(QUEUE, 'readwrite', s => s.delete(id)); } catch { /* nothing to do */ }
}

export async function bumpTries(id, tries) {
  try {
    await tx(QUEUE, 'readwrite', s => {
      const g = s.get(id);
      g.onsuccess = () => { if (g.result) s.put({ ...g.result, tries }); };
    });
  } catch { /* nothing to do */ }
}

// Wipe everything belonging to a profile. Called on logout so the next person
// to use this phone cannot read the last one's day out of the cache.
export async function clearProfile(profileId) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction([READS, QUEUE], 'readwrite');
      for (const name of [READS, QUEUE]) {
        const cur = t.objectStore(name).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          if (c.value.profileId === profileId) c.delete();
          c.continue();
        };
      }
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch { /* best effort */ }
}
