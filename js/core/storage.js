// Save state. One versioned key, one JSON payload, and two monotonicity rules that a player
// can feel:
//
//   best[id].moves  only ever goes DOWN  — you cannot un-learn a tidy solve
//   unlock          only ever goes UP   — finishing level 7 cannot re-lock level 8
//
// Both are enforced *here*, in the writer, rather than at the call sites, so no code path can
// forget. The same function also has to survive a localStorage that is missing (node tests,
// privacy mode, a webview without a profile) and one that contains garbage from an old build:
// neither is allowed to throw, and neither is allowed to silently resurrect a cleared game.
//
// Wiping asks for confirmation at the UI level and records `clearArm` in the save itself, so
// the "press twice" window survives a reload — a wipe that can be undone by refreshing is not
// a wipe.

const KEY = 'pentapack.save.v1';

export const SAVE_KEY = KEY;
export const SAVE_VERSION = 1;

export function defaultSave() {
  return { v: SAVE_VERSION, best: {}, unlock: 0, done: {}, settings: { hint: true }, clearArm: 0 };
}

// Memory fallback: used when `window` or `localStorage` is unavailable. Deliberately module
// level, so a node test that pokes the store twice sees its own writes.
let memory = defaultSave();

function readRaw() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(KEY);
  } catch (err) {
    return null; // Safari private mode throws on *access*, not only on write
  }
}

function writeRaw(text) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      memoryPending = text;
      return false;
    }
    window.localStorage.setItem(KEY, text);
    return true;
  } catch (err) {
    return false; // quota, private mode, disabled storage: the game keeps playing
  }
}

let memoryPending = null;

// Sanitising on the way in is what lets an old or hand-edited file be *upgraded* instead of
// crashing the boot. Unknown keys are dropped, numbers must be finite and non-negative.
export function sanitise(input) {
  const out = defaultSave();
  if (!input || typeof input !== 'object') return out;
  if (input.v === SAVE_VERSION) out.v = SAVE_VERSION;
  if (input.best && typeof input.best === 'object') {
    for (const [id, rec] of Object.entries(input.best)) {
      if (!rec || typeof rec !== 'object') continue;
      const moves = Number(rec.moves);
      const seconds = Number(rec.seconds);
      if (!Number.isFinite(moves) || moves < 0) continue;
      out.best[id] = {
        moves: Math.round(moves),
        seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
        date: typeof rec.date === 'string' ? rec.date : '',
      };
    }
  }
  const unlock = Number(input.unlock);
  out.unlock = Number.isFinite(unlock) && unlock > 0 ? Math.floor(unlock) : 0;
  if (input.done && typeof input.done === 'object') {
    for (const id of Object.keys(input.done)) {
      if (input.done[id]) out.done[id] = 1;
    }
  }
  if (input.settings && typeof input.settings === 'object') {
    for (const [k, v] of Object.entries(input.settings)) {
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') out.settings[k] = v;
    }
  }
  const arm = Number(input.clearArm);
  out.clearArm = Number.isFinite(arm) ? arm : 0;
  return out;
}

export function decode(text) {
  if (text === null || text === undefined) return defaultSave();
  try {
    return sanitise(JSON.parse(text));
  } catch (err) {
    return defaultSave(); // garbage in the slot is a fresh start, never a crash
  }
}

export function encode(save) {
  return JSON.stringify(sanitise(save));
}

export const store = {
  load() {
    const raw = readRaw();
    if (raw === null) return sanitise(memory);
    return decode(raw);
  },
  save(patch) {
    const cur = store.load();
    const next = sanitise({ ...cur, ...patch });
    // Re-assert the invariants after the merge, because `patch` may carry a regression.
    next.unlock = Math.max(cur.unlock, Number(patch.unlock) || 0);
    for (const [id, rec] of Object.entries(next.best)) {
      const old = cur.best[id];
      if (old && old.moves <= rec.moves) next.best[id] = old;
    }
    memory = next;
    // `encode`, not a bare JSON.stringify: the one place that decides what the slot's bytes look
    // like has to be the same place test/storage.test.mjs and @save compare against.
    writeRaw(encode(next));
    return next;
  },
  // record(lotId, { moves, seconds, date }) -> { save, improved, first }
  record(lotId, run) {
    if (!lotId) throw new Error('record needs a level id');
    const cur = store.load();
    const prev = cur.best[lotId] || null;
    const moves = Math.max(0, Math.round(Number(run && run.moves) || 0));
    const seconds = Math.max(0, Math.round(Number(run && run.seconds) || 0));
    const improved = !prev || moves < prev.moves || (moves === prev.moves && seconds < prev.seconds);
    const rec = {
      moves: prev ? Math.min(prev.moves, moves) : moves,
      seconds: prev && prev.moves < moves ? prev.seconds : seconds,
      date: (run && run.date) || (prev && prev.date) || '',
    };
    const best = { ...cur.best, [lotId]: rec };
    const done = { ...cur.done, [lotId]: 1 };
    const next = store.save({ best, done });
    return { save: next, improved, first: !prev, previous: prev ? { ...prev } : null };
  },
  // unlockTo(i): open campaign index i and everything before it, never closing anything.
  unlockTo(i) {
    const target = Math.max(0, Math.floor(Number(i) || 0));
    return store.save({ unlock: target });
  },
  setSetting(key, value) {
    const cur = store.load();
    const settings = { ...cur.settings, [key]: value };
    return store.save({ settings });
  },
  // Two-click wipe. First call arms and returns { armed: true }; the second one within the
  // window clears. Anything in between (a reload, another click elsewhere) must disarm.
  armClear(now) {
    const cur = store.load();
    const t = Number(now) || 0;
    if (cur.clearArm && t - cur.clearArm < 5000 && t >= cur.clearArm) {
      memory = defaultSave();
      if (writeRaw('') === false) memoryPending = '';
      try {
        if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(KEY);
      } catch (err) { /* nothing else to do */ }
      return { cleared: true, armed: false };
    }
    store.save({ clearArm: t || 1 });
    return { cleared: false, armed: true };
  },
  disarmClear() {
    const cur = store.load();
    if (!cur.clearArm) return cur;
    return store.save({ clearArm: 0 });
  },
  // Test/CI hook: pretend the slot never existed.
  resetForTest() {
    memory = defaultSave();
    memoryPending = null;
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(KEY);
    } catch (err) { /* ignored on purpose */ }
    return memory;
  },
  rawText() {
    return readRaw() === null ? memoryPending : readRaw();
  },
};
