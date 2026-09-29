// Level generator: put pieces down first, then *prove* the result has one solution.
//
// Why this direction and not the other way round. The classic alternative — carve a random
// board and then search for a packing that fits it — can produce an unsolvable level, and an
// unsolvable level shipped by accident is the classic way a puzzle game dies. Here the board
// is literally the union of a packing that was just performed, so solvability holds by
// construction and the only thing left to test is whether that packing is *unique*. That
// makes the generator's yield a probability with an obvious meaning:
//
//     acceptance rate = P(the random packing is the only one)
//
// which tools/balance.mjs (`npm run balance`) measures over hundreds of draws and prints.
//
// Three filters, applied in order of cost, each with its own counter so the reported rate is
// not a blur:
//   1. packing must succeed (it can get stuck: 7 pieces of the hand in a corner)
//   2. the board must be exactly 1x-connected (4-neighbour) so the 匣 reads as one object
//   3. DLX must report exactly one exact cover — `countSolutions(spec, 2)`, which stops at
//      the second solution instead of enumerating the whole tree
//   4. the reasoning solver (js/core/logic.js) must land inside the band's depth window
//
// The board is scattered on an 8x8 frame and placements are *weighted toward touching what is
// already down* (adjacency bias). Uniform-random placement produces long thin snake boards
// that are almost never unique; adjacency-biased placement produces compact lumps, which both
// look like a box of parts and constrain the remaining pieces enough to be unique.
//
// Pure: no DOM, no clock. Determinism is total — same seed, same level, on every device and
// in every run — which is what lets `#/daily`, a shared link and the baked js/data/lots.js
// agree. Wall-clock protection is available to callers through `opts.deadlineFn` (an injected
// monotone predicate) so this file never calls Date itself; plus every loop is capped.

import { rngFrom } from './rng.js';
import { FULL_SET, VARIANTS } from './pieces.js';
import { cellIndex, cellX, cellY, maskCells, validateLevel } from './board.js';
import { solveLevel } from './dlx.js';
import { logicSolve } from './logic.js';

export const FRAME_W = 8;
export const FRAME_H = 8;

// Difficulty bands: (piece count) x (reasoning depth). Band membership is decided by the two
// numbers that are *measurements* of a level, never by how long the generator took and never
// by how much the player moved (the move counter is an economy, see js/core/game.js).
// The windows below are not aspirations: they were read off the measured depth histogram of
// unique random levels, which `node tools/balance.mjs` prints as its "window-free" block (300
// one-attempt draws per (bias, k) cell, depth window opened to [0, Infinity] so the sample is not
// pre-filtered by the very windows being chosen). This machine, bias 2, 2026-09-30:
//   k=4  269 unique  {0:111, 1:95, 2:50, 3:13}
//   k=5  256 unique  {0:65,  1:75, 2:69, 3:35, 4:12}
//   k=6  240 unique  {0:20,  1:34, 2:63, 3:73, 4:44, 5:6}
//   k=7  223 unique  {0:1,   1:4,  2:20, 3:61, 4:74, 5:57, 6:6}
//   k=8  172 unique  {0:1,   1:2,  2:6,  3:25, 4:62, 5:53, 6:20, 7:3}
// So an 8x8 scatter frame really spans depth 0..7, and `node tools/balance.mjs --check` asserts
// the one thing these rows are used for — that the mean measured depth rises with k at every bias
// — as an integer fact on every CI run, not as a number frozen in this comment. Each window below
// holds a healthy share of its column, so a seed needs only a few attempts; test/make.test.mjs
// asserts every band is inhabited and monotone in depth.
export const BANDS = [
  { id: 1, key: 'taster', name: '上手匣', k: [4, 4], depth: [0, 1] },
  { id: 2, key: 'easy', name: '常匣', k: [5, 5], depth: [1, 3] },
  { id: 3, key: 'mid', name: '中匣', k: [6, 6], depth: [2, 4] },
  { id: 4, key: 'hard', name: '硬匣', k: [7, 7], depth: [3, 5] },
  { id: 5, key: 'iron', name: '铁匣', k: [8, 8], depth: [4, 7] },
];

export function bandOf(idOrKey) {
  return BANDS.find((b) => b.id === idOrKey || b.key === idOrKey) || null;
}

// The band a *measured* level belongs to, asked of the pair (piece count, reasoning depth)
// rather than of a label someone typed. js/main.js prints its band through this function, so the
// word on screen is derived from the two numbers under it and cannot drift away from them;
// test/make.test.mjs asserts the five windows partition the (k, depth) plane it measures.
export function bandName(k, depth) {
  return BANDS.find((b) => k >= b.k[0] && k <= b.k[1] && depth >= b.depth[0] && depth <= b.depth[1]) || null;
}

// ---------------------------------------------------------------------------
// candidate placement enumeration on the packing frame
// ---------------------------------------------------------------------------

// Every way `name` can be dropped on an empty-cell grid `occ` (1 = taken) inside the frame.
// Returns [{ piece, variant, x, y, cells, touch }] where `touch` is how many of the new
// piece's cells sit against already-occupied ground — the score the weighting below uses.
export function packCandidates(name, occ, w, h, requireTouch) {
  const out = [];
  const variants = VARIANTS[name];
  // A letter outside the twelve has no pose at all, so it has no candidate either. Answering
  // with the empty list is what js/core/pieces.js does for the same question (`variantCount`
  // gives 0, `getPiece` gives null), and it keeps a typo in a level's piece list a *refused
  // level* rather than a crash inside the generator.
  if (!variants) return out;
  for (let v = 0; v < variants.length; v++) {
    const pose = variants[v].cells;
    const vb = variants[v].bbox;
    for (let y = 0; y + vb.h <= h; y++) {
      for (let x = 0; x + vb.w <= w; x++) {
        const cells = [];
        let bad = false;
        for (const [dx, dy] of pose) {
          const i = cellIndex(w, x + dx, y + dy);
          if (occ[i]) { bad = true; break; }
          cells.push(i);
        }
        if (bad) continue;
        let touch = 0;
        for (const i of cells) {
          const cx = cellX(w, i);
          const cy = cellY(w, i);
          const nb = [
            cx > 0 ? i - 1 : -1,
            cx + 1 < w ? i + 1 : -1,
            cy > 0 ? i - w : -1,
            cy + 1 < h ? i + w : -1,
          ];
          for (const n of nb) if (n >= 0 && occ[n] && !cells.includes(n)) touch++;
        }
        if (requireTouch && touch === 0) continue;
        out.push({ piece: name, variant: v, x, y, cells, touch });
      }
    }
  }
  return out;
}

// Weighted draw. `(touch + 1) ** bias` makes compact boards: bias 0 is uniform, bias 4 is a
// tight clump. Kept as a function of (candidate, index) so a test can pin the weighting by
// handing in its own rng and checking that a touching candidate wins far more often.
export function weightedPick(cands, bias, rng) {
  let total = 0;
  for (const c of cands) total += Math.pow(c.touch + 1, bias);
  if (total <= 0) return cands[rng.int(cands.length)];
  let t = rng() * total;
  for (const c of cands) {
    t -= Math.pow(c.touch + 1, bias);
    if (t <= 0) return c;
  }
  return cands[cands.length - 1];
}

// One packing attempt: drop k distinct pieces, each touching the ones already down.
// Returns { pieces, placements, occ } or null when the attempt dead-ends.
export function packOnce(opts = {}) {
  const w = opts.w || FRAME_W;
  const h = opts.h || FRAME_H;
  const k = opts.k || 5;
  const bias = opts.bias === undefined ? 2 : opts.bias;
  const rng = opts.rng || rngFrom(String(w) + h + k);
  const pool = (opts.pool || FULL_SET).slice();
  if (k > pool.length) throw new Error(`cannot place ${k} pieces from a pool of ${pool.length}`);
  const chosen = rng.shuffle(pool).slice(0, k).sort();
  const order = chosen.slice();
  rng.shuffle(order);

  const occ = new Uint8Array(w * h);
  const placements = [];
  for (let step = 0; step < k; step++) {
    const name = order[step];
    const cands = packCandidates(name, occ, w, h, step > 0);
    if (!cands.length) return null; // dead end: this piece cannot touch what is already down
    const pick = weightedPick(cands, bias, rng);
    for (const i of pick.cells) occ[i] = 1;
    placements.push({ piece: name, variant: pick.variant, x: pick.x, y: pick.y, cells: pick.cells });
  }
  return { w, h, pieces: chosen, occ, placements, candidates: k };
}

// 4-connected? The board is a single 匣 only if every cell is reachable from every other one
// over shared edges.
export function isConnected(mask, w, h) {
  const on = maskCells(mask);
  if (!on.length) return false;
  const seen = new Uint8Array(mask.length);
  const stack = [on[0]];
  seen[on[0]] = 1;
  let n = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = cellX(w, i);
    const y = cellY(w, i);
    const nb = [
      x > 0 ? i - 1 : -1,
      x + 1 < w ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y + 1 < h ? i + w : -1,
    ];
    for (const q of nb) {
      if (q < 0 || !mask[q] || seen[q]) continue;
      seen[q] = 1;
      n++;
      stack.push(q);
    }
  }
  return n === on.length;
}

// ---------------------------------------------------------------------------
// the full pipeline
// ---------------------------------------------------------------------------

// makeLevel(opts) -> { spec, solution, depth, stats, seed } | { ok: false, stats, seed }
//   opts: {
//     seed        string|number   required for reproducibility
//     k | band                    piece count, or a band (id/key) whose k window is used
//     maxAttempts number          cap on packing attempts (default 400)
//     bias        number          adjacency exponent (default 2)
//     deadlineFn  () => boolean   injected "we ran out of time" predicate
//     maxNodes    number          forwarded to dlx.js: the uniqueness proof's hang guard, so a
//                                 caller (or a test) can force the `capped` branch
//     pool        string[]        piece pool (default the twelve)
//   }
// `stats` reports every gate the candidate failed, so the acceptance rate is auditable:
//   stats.attempts        packings started
//   stats.deadEnds        packings that could not place all k pieces
//   stats.evaluated       packings that reached the uniqueness proof  <- the denominator
//   stats.notUnique       proven >= 2 solutions
//   stats.disconnected    board fell apart into islands
//   stats.bandRejects     unique, but reasoning depth outside the window
//   stats.logicTruncated  unique, but the reasoning solver hit its frame cap
//   stats.timeOut         the loop stopped because the injected deadline said so
//   stats.maxDlxNodes     the deepest column-selection count any candidate cost (search state
//                         high-water mark: this is what a click would pay at worst)
//   stats.maxLogicFrames  the same for the reasoning solver's assumption frames
// P(unique) itself is `unique / evaluated`, which tools/balance.mjs computes and prints over
// hundreds of independent draws; a single makeLevel() call cannot report a rate honestly.
export function makeLevel(opts = {}) {
  if (opts.seed === undefined || opts.seed === null) throw new Error('makeLevel needs a seed');
  const band = typeof opts.band === 'object' ? opts.band : (bandOf(opts.band) || null);
  let k = opts.k;
  if (k === undefined) {
    if (!band) throw new Error('makeLevel needs either k or a known band');
    k = band.k[0] === band.k[1] ? band.k[0] : rngFrom(`${opts.seed}#k`).range(band.k[0], band.k[1]);
  }
  // `depthWindow`, never `window`: this module is imported by the browser through
  // js/core/library.js -> js/main.js, and a `const window` at the top of a function body is
  // legal but is exactly the shadow that makes a later "does window exist?" check in here lie.
  const depthWindow = opts.depth || (band ? band.depth : [0, Infinity]);
  const maxAttempts = opts.maxAttempts || 400;
  const stats = {
    attempts: 0, deadEnds: 0, evaluated: 0, notUnique: 0, disconnected: 0,
    bandRejects: 0, logicTruncated: 0, timeOut: false, accepted: 0,
    maxDlxNodes: 0, maxLogicFrames: 0,
  };
  const rng = rngFrom(opts.seed);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.deadlineFn && opts.deadlineFn()) { stats.timeOut = true; break; }
    stats.attempts++;
    const packed = packOnce({
      k, bias: opts.bias, rng, w: opts.w, h: opts.h, pool: opts.pool,
    });
    if (!packed) { stats.deadEnds++; continue; }
    const spec = {
      w: packed.w, h: packed.h, mask: Uint8Array.from(packed.occ), pieces: packed.pieces,
    };
    const err = validateLevel(spec);
    if (err) throw new Error(`generator produced an invalid level: ${err}`);
    if (!isConnected(spec.mask, spec.w, spec.h)) { stats.disconnected++; continue; }
    const index = new Map(packed.pieces.map((n, i) => [n, i]));
    const baked = packed.placements.map((p) => ({
      piece: index.get(p.piece), variant: p.variant, x: p.x, y: p.y,
    }));
    stats.evaluated++;
    const verdict = solveLevel(spec, 2, opts.maxNodes); // 2, not Infinity: stop at the first refutation
    if (verdict.nodes > stats.maxDlxNodes) stats.maxDlxNodes = verdict.nodes;
    if (verdict.capped) throw new Error('DLX hit its node cap while proving uniqueness');
    if (verdict.count !== 1) { stats.notUnique++; continue; }
    // The packing that built the board must BE the unique solution. If it is not, either the
    // generator or the counter is lying, and there is no room for "probably fine".
    if (!sameSet(baked, verdict.placements)) {
      throw new Error('the build placement is not the unique solution');
    }
    const logic = logicSolve(verdict.problem, { maxFrames: opts.maxFrames || 60000 });
    if (logic.frames > stats.maxLogicFrames) stats.maxLogicFrames = logic.frames;
    if (logic.truncated || !logic.solved) { stats.logicTruncated++; continue; }
    if (logic.depth < depthWindow[0] || logic.depth > depthWindow[1]) { stats.bandRejects++; continue; }
    if (!sameSet(logic.placements, verdict.placements)) {
      throw new Error('logic solver and DLX disagree on a unique level');
    }
    stats.accepted++;
    return {
      ok: true,
      seed: String(opts.seed),
      k,
      spec,
      solution: verdict.placements,
      depth: logic.depth,
      logic,
      band: band ? band.key : null,
      stats,
    };
  }
  return { ok: false, seed: String(opts.seed), k, stats, band: band ? band.key : null };
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const key = (l) => l.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`).sort().join('|');
  return key(a) === key(b);
}

// Convenience for the UI: a level from a seed, with a bounded number of attempts and a
// fallback that is *still* a real level (band 1 window) instead of a broken one.
//
// `makePlayable` used to live here. It is gone, and the reason is this file's own invariant: its
// fallback retried the same band with `depth: [0, Infinity]`, i.e. it returned a level stamped
// with a band whose depth window it had just been told to ignore. Every consumer of `lot.band`
// (the band ladder in js/core/library.js, the printed 推理深度, tools/bake.mjs's gate) assumes the
// stamp and the measurement agree, so a "always give me something" wrapper was not a safety net
// but a way to ship a lying label. Callers that can fail must say so: js/core/library.js's
// dailyLot/randomLot throw with the attempt count, and js/main.js turns that into a line of text.

// The arithmetic behind the headline number, in one place so the balance rig and the
// acceptance test cannot disagree about what the denominator was:
//   uniquenessRate = P(the random packing is the only one) = unique / evaluated
//   yieldRate      = P(a packing attempt becomes an accepted band level) = accepted / attempts
// `tools/balance.mjs` (npm run balance) folds hundreds of independent draws through this and
// prints the result, which is where the acceptance rate quoted in README.md comes from. A single
// makeLevel() call cannot report a rate honestly, so it does not try to.
export function yieldOf(total) {
  const evaluated = total.evaluated || 0;
  const unique = evaluated - total.notUnique;
  return {
    attempts: total.attempts || 0,
    evaluated,
    unique,
    uniquenessRate: evaluated ? unique / evaluated : 0,
    accepted: total.accepted || 0,
    yieldRate: total.attempts ? (total.accepted || 0) / total.attempts : 0,
  };
}
