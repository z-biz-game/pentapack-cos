// The level library: what ships, what the routes mean, and how a level is turned back into
// data. Three kinds of content, deliberately different:
//
//   campaign   baked into js/data/lots.js by tools/bake.mjs. Fixed, reviewable, and every
//              number in it was re-proved at bake time (解数 == 1, 推理深度 == printed).
//              `#/lot/<id>` addresses exactly this table.
//   daily      generated on the fly from the calendar key. No download, no state, and still
//              the same puzzle for everyone on a given day, because generation is a pure
//              function of a seed string (js/core/make.js).
//   random     generated from a link seed, so `#/random?seed=...` is reproducible too.
//
// Generation is ~1 ms per level measured (`node tools/balance.mjs`), which is why the last
// two can afford to run on tap in a browser instead of being pre-baked.
//
// Pure lookup + pure generation. No DOM here; storage of unlocks lives in js/core/storage.js.

import { LOTS, META } from '../data/lots.js';
import { validateLevel, maskString, parseMask } from './board.js';
import { makeLevel, bandName, BANDS, bandOf, FRAME_W, FRAME_H } from './make.js';
import { hashSeed } from './rng.js';
import { RULE_SET_VERSION } from './logic.js';

export const LOT_VERSION = 1;
// `bandOf` is re-exported because js/main.js asks the library, never the generator, for level
// facts. META, BANDS and RULE_SET_VERSION are *not*: this module already reports them through
// stats(), and a second name for the same fact is how a re-export and its source drift apart.
export { bandOf };

// --- row shape ------------------------------------------------------------
// A baked row is compact tuples so the generated file stays greppable:
//   solution: [[pieceIndex, variantIndex, x, y], ...]
export function expandSolution(row) {
  return row.solution.map(([piece, variant, x, y]) => ({ piece, variant, x, y }));
}

export function specOf(row) {
  return { w: row.w, h: row.h, mask: parseMask(row.mask, row.w, row.h), pieces: row.pieces.split('') };
}

function prepare(row) {
  const spec = specOf(row);
  const err = validateLevel(spec);
  // Loud, not silent: a malformed baked row is a shipping bug and should break the boot.
  if (err) throw new Error(`lot ${row.id} is invalid: ${err}`);
  return {
    id: row.id,
    band: row.band,
    k: row.k,
    depth: row.depth,
    source: 'campaign',
    spec,
    solution: expandSolution(row),
    row,
  };
}

export const ALL = LOTS.map(prepare);

export function byId(id) {
  return ALL.find((l) => l.id === id) || null;
}

export function indexById(id) {
  return ALL.findIndex((l) => l.id === id);
}

export function campaign() {
  return ALL;
}

export function bands() {
  return BANDS;
}

export function lotsIn(bandKey) {
  return ALL.filter((l) => l.band === bandKey);
}

// The campaign is ordered band-ascending, so "next" is just the next row.
export function nextOf(id) {
  const i = indexById(id);
  if (i < 0) return ALL[0] || null;
  return ALL[Math.min(i + 1, ALL.length - 1)];
}

export function prevOf(id) {
  const i = indexById(id);
  if (i <= 0) return null;
  return ALL[i - 1];
}

// ---------------------------------------------------------------------------
// generated content
// ---------------------------------------------------------------------------

// Turn a makeLevel() result into the same object shape a baked row gets, so nothing
// downstream has to know which kind it is holding.
function adopt(seed, made, source) {
  if (!made || !made.ok) return null;
  return {
    id: `${source}-${seed}`,
    band: made.band,
    k: made.k,
    depth: made.depth,
    source,
    seed: String(seed),
    spec: made.spec,
    solution: made.solution.map((p) => ({ ...p })),
    stats: made.stats,
  };
}

const DAILY_BAND_CYCLE = BANDS.map((b) => b.key);

export function bandForDay(dateKey) {
  const parts = String(dateKey).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return DAILY_BAND_CYCLE[0];
  const dayOfYear = Math.round((Date.UTC(parts[0], parts[1] - 1, parts[2]) - Date.UTC(parts[0], 0, 1)) / 86400000) + 1;
  return DAILY_BAND_CYCLE[dayOfYear % DAILY_BAND_CYCLE.length];
}

// One puzzle per calendar day, identical on every device: the band rotates over the year and
// the seed *is* the date.
export function dailyLot(dateKey) {
  const band = bandForDay(dateKey);
  const made = makeLevel({ seed: `daily:${dateKey}`, band, maxAttempts: 200 });
  const lot = adopt(`daily-${dateKey}`, made, 'daily');
  if (!lot) throw new Error(`no daily level for ${dateKey} (band ${band}) in ${made.stats.attempts} attempts`);
  lot.title = `每日匣 · ${dateKey}`;
  lot.dateKey = String(dateKey);
  return lot;
}

// Endless play: a link seed chooses the band unless the caller pins one.
export function randomLot(seed, bandKey) {
  const key = bandKey || DAILY_BAND_CYCLE[hashSeed(`band|${seed}`) % DAILY_BAND_CYCLE.length];
  const made = makeLevel({ seed: `random:${seed}`, band: key, maxAttempts: 200 });
  const lot = adopt(String(seed), made, 'rand');
  if (!lot) throw new Error(`no random level for seed ${seed} (band ${key})`);
  lot.title = `随机匣 · ${key}`;
  return lot;
}

// ---------------------------------------------------------------------------
// routes. `#/lot/b1-03`, `#/daily`, `#/random/<seed>`, `#/random/<seed>?band=hard`
// ---------------------------------------------------------------------------

export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = {};
  for (const kv of String(query || '').split('&')) {
    if (!kv) continue;
    const [k, v] = kv.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return { parts, params };
}

// resolveRoute(hash, todayKeyText) -> { lot, kind, missing? } — never throws on a bad link.
// `todayKeyText` is the calendar key the *caller* read: a date-less `#/daily` still has to be
// today's puzzle, and js/core/* may not read a clock (js/core/rng.js:todayKey refuses to).
export function resolveRoute(hash, todayKeyText = '') {
  const { parts, params } = parseRoute(hash);
  const [head, arg] = parts;
  if (!head) return { kind: 'campaign', lot: ALL[0] || null };
  if (head === 'lot') {
    const lot = byId(arg);
    if (lot) return { kind: 'lot', lot };
    const daily = /^(\d{4})-(\d{2})-(\d{2})$/.test(arg || '');
    if (daily) return { kind: 'lot', lot: dailyLot(arg) };
    return { kind: 'lot', lot: null, missing: arg || '' };
  }
  if (head === 'daily') return { kind: 'daily', lot: dailyLot(params.date || arg || todayKeyText || '') };
  if (head === 'random') {
    const seed = params.seed || arg || 'first';
    return { kind: 'random', lot: randomLot(seed, params.band) };
  }
  return { kind: 'unknown', lot: null, missing: head };
}

// ---------------------------------------------------------------------------
// serialisation — a lot in, JSON out, and back to the *same* level. Used by tools/bake.mjs
// to write the data file and pinned by test/library.test.mjs.
// ---------------------------------------------------------------------------

export function serialiseLot(lot) {
  return JSON.stringify({
    v: LOT_VERSION,
    id: lot.id,
    band: lot.band,
    k: lot.k,
    depth: lot.depth,
    w: lot.spec.w,
    h: lot.spec.h,
    mask: maskString(lot.spec.mask),
    pieces: lot.spec.pieces.join(''),
    solution: lot.solution.map((p) => [p.piece, p.variant, p.x, p.y]),
  });
}

export function deserialiseLot(text) {
  const row = typeof text === 'string' ? JSON.parse(text) : text;
  if (!row || row.v !== LOT_VERSION) throw new Error(`lot version ${row && row.v} unsupported`);
  return prepare(row);
}

// What the shipped campaign actually looks like, measured rather than claimed. The harness
// prints this so a re-bake that quietly flattens the difficulty curve shows up as a changed
// line instead of a surprise for a player, and README.md's band table is copied from its output.
//
// `mislabelled` is the row that earns its keep: each stored band key is re-derived from the two
// measurements beside it with make.js:bandName, so a bake that stamped a level with a band whose
// depth window it does not satisfy shows up as a number here instead of as a pleasant label.
export function stats() {
  const byBand = {};
  let mislabelled = 0;
  for (const lot of ALL) {
    const derived = bandName(lot.k, lot.depth);
    if (!derived || derived.key !== lot.band) mislabelled++;
    const b = (byBand[lot.band] = byBand[lot.band] || { n: 0, min: Infinity, max: -Infinity, sum: 0, ks: {} });
    b.n++;
    b.min = Math.min(b.min, lot.depth);
    b.max = Math.max(b.max, lot.depth);
    b.sum += lot.depth;
    b.ks[lot.k] = (b.ks[lot.k] || 0) + 1;
  }
  for (const key of Object.keys(byBand)) {
    const b = byBand[key];
    b.avg = Math.round((b.sum / b.n) * 100) / 100;
    delete b.sum;
  }
  const depths = ALL.map((l) => l.depth).sort((a, b) => a - b);
  return {
    lots: ALL.length,
    version: META.version,
    ruleSet: RULE_SET_VERSION,
    frame: [FRAME_W, FRAME_H],
    mislabelled,
    bands: byBand,
    depth: {
      min: depths[0], max: depths[depths.length - 1],
      med: depths[Math.floor(depths.length / 2)],
    },
  };
}
