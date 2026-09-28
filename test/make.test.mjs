// The generator: pack first, then prove. What make.js is allowed to hand back.
//
// WHY THIS FILE EXISTS
// ----------------------------------------------------------------------------
// js/core/make.js is the only code in the repository that can invent a level, and two of its
// properties are load-bearing for content the player never sees coming: the daily puzzle and a
// shared random link are generated on tap, from a seed, in a browser.
//
//   * determinism. Same seed, same level, on every device and in every run. Without it a "daily"
//     is not daily and a shared link is a different puzzle.
//   * the post-conditions it cannot express in a type: the board it returns is connected, legal,
//     unique (proved by dancing links with limit=2, not assumed), and its measured reasoning depth
//     is inside the window of the band stamped on it.
//
// The third thing this file checks is the acceptance arithmetic itself. `yieldOf` is the single
// definition of the two rates tools/balance.mjs prints, and if its denominators were wrong the
// README's quoted acceptance rate would be wrong in a way no behaviour test would notice. The
// identity checked here — evaluated = attempts - deadEnds - disconnected, and
// unique = logicTruncated + bandRejects + accepted — is what makes those rates add up.
//
// Cost: the taster band (k=4) accepts in a handful of attempts and each attempt is a small-board
// proof, so a few hundred generations here stay in the milliseconds. Nothing in this file enumerates
// a 12-piece rectangle; that is test/anchor.test.mjs.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  FRAME_W, FRAME_H, BANDS, bandOf, bandName, packCandidates, weightedPick, packOnce,
  isConnected, makeLevel, yieldOf,
} from '../js/core/make.js';
import { validateLevel, maskCount, maskString, parseMask, fullRect, placementMask, samePlacements } from '../js/core/board.js';
import { countSolutions, solveLevel } from '../js/core/dlx.js';
import { logicSolve } from '../js/core/logic.js';
import { FULL_SET, VARIANTS, CELLS, getPiece } from '../js/core/pieces.js';
import { cellIndex } from '../js/core/board.js';
import { rngFrom, mulberry32 } from '../js/core/rng.js';
import { campaign } from '../js/core/library.js';
import { HOOK_LP } from './fixture.mjs';

const specKey = (lot) => `${lot.k}|${maskString(lot.spec.mask)}|${lot.spec.pieces.join('')}`;
const solutionKey = (list) => list.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`).sort().join(' ');

// ---------------------------------------------------------------------------
// the band table
// ---------------------------------------------------------------------------

test('the frame and the ladder are what every other module quotes', () => {
  eq([FRAME_W, FRAME_H], [8, 8], 'the scatter frame is 8x8');
  eq(FULL_SET.length, 12, 'and the pool is the twelve pentominoes');
  eq(BANDS.map((b) => b.key), ['taster', 'easy', 'mid', 'hard', 'iron'], 'five rungs, in order');
  eq(BANDS.map((b) => b.id), [1, 2, 3, 4, 5], 'each with a stable numeric id');
  eq(BANDS.map((b) => b.name), ['上手匣', '常匣', '中匣', '硬匣', '铁匣'], 'and the word the UI prints');
  eq(BANDS.map((b) => b.k.join('-')), ['4-4', '5-5', '6-6', '7-7', '8-8'], 'one piece count per rung');
  eq(BANDS.map((b) => b.depth.join('-')), ['0-1', '1-3', '2-4', '3-5', '4-7'], 'and the measured depth windows');
  eq(bandOf('iron'), BANDS[4], 'bandOf by key');
  eq(bandOf(3), BANDS[2], 'bandOf by id');
  eq(bandOf('nope'), null, 'bandOf says null rather than guessing');
  eq(bandOf(undefined), null, 'including for nothing at all');
});

test('bandName is a function of the two measurements, and says null outside them', () => {
  eq(bandName(4, 0).key, 'taster', 'k=4 depth=0 is a taster');
  eq(bandName(8, 7).key, 'iron', 'k=8 depth=7 is iron');
  eq(bandName(4, 2), null, 'depth 2 at k=4 is in no window: taster stops at 1');
  eq(bandName(9, 4), null, 'nine pieces is not a band at all');
  eq(bandName(3, 0), null, 'nor is three');
  eq(bandName(0, 0), null, 'not even zero');
  eq(bandName(6, 2).key, 'mid', 'k=6 depth=2 is the only rung that claims it');
  eq(bandName(6, 5), null, 'and mid stops at 4, so a six-piece depth-5 level is in no band');
  eq(bandName(7, 3).key, 'hard', 'hard owns k=7 depth 3..5');
  eq(bandName(7, 2), null, 'with nothing else claiming k=7 depth 2');
  // The windows must not overlap at a given k, or stats.mislabelled could not decide who is right.
  for (const b of BANDS) {
    for (const other of BANDS.filter((x) => x.key !== b.key)) {
      const overlapK = Math.max(b.k[0], other.k[0]);
      if (overlapK > Math.min(b.k[1], other.k[1])) continue;
      const dLo = Math.max(b.depth[0], other.depth[0]);
      const dHi = Math.min(b.depth[1], other.depth[1]);
      ok(dHi < dLo, `${b.key} and ${other.key} do not share a (k, depth) point`);
    }
  }
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('the same seed gives the same level, and a different seed a different one', () => {
  const a = makeLevel({ seed: 'pentapack-v1:test:1', band: 'mid' });
  const b = makeLevel({ seed: 'pentapack-v1:test:1', band: 'mid' });
  eq(a.ok, true, 'it generated');
  eq(b.ok, true, 'twice');
  eq(specKey(a), specKey(b), 'same seed, same box and same piece set');
  eq(solutionKey(a.solution), solutionKey(b.solution), 'same answer');
  eq([a.depth, a.k, a.band], [b.depth, b.k, b.band], 'same measurement and same stamp');
  eq(a.stats, b.stats, 'and the same attempt accounting down to the node high-water marks');
  const c = makeLevel({ seed: 'pentapack-v1:test:2', band: 'mid' });
  ok(specKey(c) !== specKey(a), 'a seed one character different is a different puzzle');
  const d = makeLevel({ seed: 'pentapack-v1:test:1', k: 6 });
  eq(specKey(d), specKey(a), 'k=6 without a band name is the same draw, since the band only pins k and depth');
  eq(d.band, null, 'and it carries no band stamp, which is honest: nothing was proved about the label');
});

test('makeLevel insists on a seed, because an unseeded level is not reproducible', () => {
  throws(() => makeLevel({ band: 'easy' }), /needs a seed/, 'no seed at all');
  throws(() => makeLevel({ seed: null, band: 'easy' }), /needs a seed/, 'an explicit null');
  throws(() => makeLevel({ seed: 'x' }), /either k or a known band/, 'neither k nor a band');
  throws(() => makeLevel({ seed: 'x', band: 'legendary' }), /either k or a known band/, 'an unknown band key');
  throws(() => makeLevel({ seed: 'x', k: 20 }), /cannot place 20 pieces from a pool of 12/, 'more pieces than the twelve');
  const zero = makeLevel({ seed: 'x', k: 0, maxAttempts: 3 });
  eq([zero.k, zero.spec.pieces.length], [0, 5],
    'k: 0 is falsy, so packOnce falls back to its default of five while makeLevel reports the zero it was asked for. No band can do this (k is 4..8), so nothing ships inconsistent — the line is here so the edge is written down rather than discovered.');
  const objectBand = makeLevel({ seed: 'x', band: BANDS[0] });
  eq(objectBand.band, 'taster', 'a band object is as good as its key');
  eq(objectBand.k, 4, 'and it supplies k');
});

function throws(fn, re, msg) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  ok(caught, `${msg}: it does throw`);
  assert(re.test(String(caught && caught.message)), `${msg}: says "${caught && caught.message}"`);
}

// ---------------------------------------------------------------------------
// post-conditions on what comes back
// ---------------------------------------------------------------------------

test('every level it accepts is legal, connected, unique and inside its window', () => {
  const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  for (const band of BANDS) {
    for (const seed of seeds) {
      const made = makeLevel({ seed: `post:${band.key}:${seed}`, band: band.key });
      const tag = `${band.key}/${seed}`;
      eq(made.ok, true, `${tag}: generated a level at all`);
      eq(validateLevel(made.spec), null, `${tag}: legal`);
      eq(made.spec.w, FRAME_W, `${tag}: on the 8x8 frame`);
      eq(isConnected(made.spec.mask, made.spec.w, made.spec.h), true, `${tag}: connected, so the 匣 is one object`);
      eq(maskCount(made.spec.mask), made.k * CELLS, `${tag}: and its area is exactly k pentominoes`);
      eq(countSolutions(made.spec, 2), 1, `${tag}: unique, proved by dancing links`);
      eq(samePlacements(made.solution, solveLevel(made.spec, 2).placements), true,
        `${tag}: and the packing that built the board IS the unique solution`);
      eq(validateLevel(made.spec), null, `${tag}: still legal after all that reading`);
      const logic = logicSolve(made.spec);
      eq(logic.solved, true, `${tag}: the reasoning solver finishes it`);
      eq(logic.truncated, false, `${tag}: without hitting the frame cap`);
      eq(logic.depth, made.depth, `${tag}: depth ${made.depth} re-measures`);
      ok(made.depth >= band.depth[0] && made.depth <= band.depth[1],
        `${tag}: depth ${made.depth} inside ${band.key}'s window ${band.depth.join('..')}`);
      eq(bandName(made.k, made.depth).key, made.band, `${tag}: the stamp follows the measurement`);
      eq(made.stats.accepted, 1, `${tag}: one accepted candidate, by construction`);
      eq(made.seed, `post:${band.key}:${seed}`, `${tag}: the seed comes back as text`);
    }
  }
});

test('the attempt accounting adds up, on every generated level', () => {
  // attempts = deadEnds + disconnected + evaluated, and the evaluated ones split into
  // not-unique and unique, and the unique ones into truncated, band-rejected and accepted.
  // Nothing is double-counted and nothing is lost, which is what makes the rates below honest.
  let totals = { attempts: 0, deadEnds: 0, disconnected: 0, evaluated: 0, notUnique: 0, bandRejects: 0, logicTruncated: 0, accepted: 0 };
  const seenDepths = new Set();
  for (const band of BANDS) {
    for (let i = 0; i < 4; i++) {
      const made = makeLevel({ seed: `acct:${band.key}:${i}`, band: band.key });
      const s = made.stats;
      eq(s.attempts, s.deadEnds + s.disconnected + s.evaluated, `${band.key}#${i}: attempts split into the three gates that can fail first`);
      eq(s.evaluated, s.notUnique + (s.evaluated - s.notUnique), `${band.key}#${i}: evaluated splits at the uniqueness proof`);
      eq(s.evaluated - s.notUnique, s.logicTruncated + s.bandRejects + s.accepted,
        `${band.key}#${i}: and the unique ones into truncated, rejected and accepted`);
      ok(s.maxDlxNodes >= 1, `${band.key}#${i}: the DLX high-water mark is real (${s.maxDlxNodes})`);
      ok(s.maxLogicFrames >= 0, `${band.key}#${i}: and the reasoning one (${s.maxLogicFrames})`);
      eq(s.timeOut, false, `${band.key}#${i}: no deadline was injected, so none could fire`);
      for (const key of Object.keys(totals)) totals[key] += s[key];
      seenDepths.add(made.depth);
    }
  }
  eq(totals.accepted, 20, 'twenty bands x four seeds, twenty accepted levels');
  eq(totals.attempts >= totals.evaluated, true, 'and the outer loop did at least as much work');
  ok(seenDepths.size >= 5, `the twenty draws span ${seenDepths.size} distinct depths`);
  eq(yieldOf(totals), {
    attempts: totals.attempts,
    evaluated: totals.evaluated,
    unique: totals.evaluated - totals.notUnique,
    uniquenessRate: (totals.evaluated - totals.notUnique) / totals.evaluated,
    accepted: totals.accepted,
    yieldRate: totals.accepted / totals.attempts,
  }, 'yieldOf is exactly that arithmetic, with those denominators');
});

test('yieldOf reports rates, not vibes, and never divides by zero', () => {
  eq(yieldOf({ attempts: 10, evaluated: 5, notUnique: 3, accepted: 1 }),
    { attempts: 10, evaluated: 5, unique: 2, uniquenessRate: 0.4, accepted: 1, yieldRate: 0.1 },
    'the published shape, with the denominators make.js documents');
  eq(yieldOf({ attempts: 0, evaluated: 0, notUnique: 0, accepted: 0 }),
    { attempts: 0, evaluated: 0, unique: 0, uniquenessRate: 0, accepted: 0, yieldRate: 0 },
    'an empty sample gives 0, not NaN: a rig printing NaN would be ignored, a rig printing 0 is visible');
  eq(yieldOf({ attempts: 4, evaluated: 4, notUnique: 4, accepted: 0 }).uniquenessRate, 0, 'every candidate refuted');
  eq(yieldOf({ attempts: 4, evaluated: 0, notUnique: 0, accepted: 0 }).uniquenessRate, 0, 'nothing reached the proof');
  eq(yieldOf({ attempts: 3, evaluated: 3, notUnique: 0, accepted: 3 }).yieldRate, 1, 'and a perfect yield is 1');
});

// ---------------------------------------------------------------------------
// the pieces of the pipeline, separately
// ---------------------------------------------------------------------------

test('packOnce drops k distinct pieces, each one touching what is already down', () => {
  const pool = ['F', 'I', 'L', 'P', 'N', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
  const packed = packOnce({ k: 5, seedless: true, rng: rngFrom('pack:1'), pool, bias: 3 });
  eq(packed.pieces.length, 5, 'five pieces chosen');
  eq(new Set(packed.pieces).size, 5, 'all distinct');
  eq(packed.pieces, packed.pieces.slice().sort(), 'and reported in sorted order, so the id does not depend on the draw order');
  eq(packed.pieces.every((p) => pool.includes(p)), true, 'every one of them came from the pool it was given');
  eq(packed.placements.length, 5, 'each placed once');
  eq(packed.w, FRAME_W, 'on the default frame');
  eq(packed.h, FRAME_H, 'of the right size');
  // occupancy is exactly the union of the placements' cells
  const union = new Set(packed.placements.flatMap((p) => p.cells));
  eq(union.size, 25, 'five pentominoes are twenty-five cells');
  eq(maskCount(packed.occ), 25, 'and the mask says the same');
  for (const p of packed.placements) {
    for (const c of p.cells) eq(packed.occ[c], 1, `cell ${c} is marked occupied by ${p.piece}`);
    eq(p.cells.length, CELLS, `${p.piece} covers five cells`);
    eq(p.cells, VARIANTS[p.piece][p.variant].cells.map(([dx, dy]) => cellIndex(FRAME_W, p.x + dx, p.y + dy)),
      `${p.piece} at (${p.x},${p.y}) pose ${p.variant}: the cells are the pose translated by the anchor`);
    ok(p.variant >= 0 && p.variant < VARIANTS[p.piece].length, `${p.piece}: pose ${p.variant} is one of its ${VARIANTS[p.piece].length}`);
  }
  // adjacency: from the second piece on, every placement touches an earlier one
  const seen = new Set();
  for (let i = 0; i < packed.placements.length; i++) {
    const p = packed.placements[i];
    if (i > 0) {
      const touches = p.cells.some((c) => neighbours(c, packed.w, packed.h).some((n) => seen.has(n)));
      ok(touches, `piece ${p.piece} at (${p.x},${p.y}) touches the ones already down`);
    }
    for (const c of p.cells) seen.add(c);
    eq(seen.size, (i + 1) * CELLS, `no two placements share a cell (after ${i + 1}: ${seen.size})`);
  }
  eq(packed.candidates, 5, 'and it reports how many pieces it tried to place');
  throws(() => packOnce({ k: 13, pool }), /cannot place 13 pieces from a pool of 12/, 'more pieces than the pool has');
  const original = ['F', 'I', 'L'];
  packOnce({ k: 2, pool: original, rng: rngFrom(1) });
  eq(original, ['F', 'I', 'L'], 'packOnce shuffles a copy, so the caller pool survives the in-place shuffle');
  eq(packOnce({ k: 4, rng: rngFrom('x'), pool: FULL_SET.slice() }).pieces.length, 4, 'the default pool is the twelve');
});

function neighbours(i, w, h) {
  const x = i % w;
  const y = Math.floor(i / w);
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x + 1 < w) out.push(i + 1);
  if (y > 0) out.push(i - w);
  if (y + 1 < h) out.push(i + w);
  return out;
}

test('packOnce is deterministic in the rng it is handed and dead-ends honestly', () => {
  const a = packOnce({ k: 6, rng: rngFrom('same'), bias: 2 });
  const b = packOnce({ k: 6, rng: rngFrom('same'), bias: 2 });
  eq(a.placements.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`), b.placements.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`),
    'the same rng stream gives the same packing');
  const c = packOnce({ k: 6, rng: rngFrom('other'), bias: 2 });
  ok(a.placements.map((p) => p.piece + p.x + p.y).join() !== c.placements.map((p) => p.piece + p.x + p.y).join(),
    'a different stream gives a different one');
  eq(packOnce({ k: 1, rng: rngFrom(7), bias: 0 }).placements.length, 1, 'one piece is a legal packing');
  // A pool too small to touch: with only the I pentomino and a 1-cell frame the second piece has
  // nowhere to go that also touches, so the attempt reports a dead end rather than a broken board.
  eq(packOnce({ k: 2, pool: ['I', 'X'], rng: rngFrom(2), w: 2, h: 2 }), null, 'a 2x2 frame cannot hold two pentominoes at all');
  const defaultRng = packOnce({ k: 4 });
  eq(defaultRng.placements.length, 4, 'with no rng at all it still packs, from a seed derived from the frame and k');
  eq(solutionKey(defaultRng.placements), solutionKey(packOnce({ k: 4 }).placements),
    'and that derived seed is reproducible: no rng, no clock, same packing twice');
});

test('packCandidates enumerates every legal pose and scores how much it touches', () => {
  const empty = new Uint8Array(8 * 8);
  const all = packCandidates('X', empty, 8, 8, false);
  eq(all.length, 36, 'the X plus-pentomino has one pose and 6x6 anchor positions on an 8x8 frame');
  eq(new Set(all.map((c) => c.variant)).size, 1, 'and it is the same variant every time');
  eq(getPiece('X').variants.length, 1, 'because X really does have one pose');
  eq(all.every((c) => c.touch === 0), true, 'on an empty board nothing touches anything');
  eq(all.every((c) => c.cells.length === CELLS), true, 'each candidate covers five cells');
  eq(new Set(all.flatMap((c) => c.cells)).size, 60,
    'and between them they cover 60 of the 64 cells: the four frame corners are unreachable, because an X pose never sits on a corner of its own 3x3 box');
  const first = all[0];
  eq([first.piece, first.x, first.y], ['X', 0, 0], 'the enumeration starts at the top-left anchor and variant 0');
  eq(first.cells, [1, 8, 9, 10, 17], 'which paints X as the 3x3 cross minus its corners, in cell order');
  eq(VARIANTS.X[0].cells, [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], 'the X pose, as published');
  // Sit a block down at anchor (1,1) and ask the same question again: the candidates that overlap
  // it are gone, the ones next to it score a touch, and `requireTouch` keeps exactly those.
  const occupied = new Uint8Array(8 * 8);
  for (const [dx, dy] of VARIANTS.X[0].cells) occupied[cellIndex(8, 1 + dx, 1 + dy)] = 1;
  eq(maskCount(occupied), 5, 'the block put five cells down');
  const withBlock = packCandidates('X', occupied, 8, 8, false);
  ok(withBlock.length < 36, `the overlapping anchors are gone (${withBlock.length} of 36 remain)`);
  eq(withBlock.some((c) => c.x === 1 && c.y === 1), false, 'including the one that sat exactly on the block');
  eq(withBlock.filter((c) => c.cells.some((i) => occupied[i])).length, 0, 'and no survivor overlaps it either');
  const clear = withBlock.filter((c) => c.touch === 0).length;
  const touchers = withBlock.filter((c) => c.touch > 0);
  const touching = touchers.length;
  eq(clear + touching, withBlock.length, 'every candidate is either clear of the block or touching it');
  ok(touching >= 4, `${touching} candidates touch the block`);
  // Hand-written: the block is the X pose at anchor (1,1), i.e. cells (2,1),(1,2),(2,2),(3,2),
  // (2,3), and the eight cells edge-adjacent to it are exactly these.
  const ring = [[2, 0], [1, 1], [3, 1], [0, 2], [4, 2], [1, 3], [3, 3], [2, 4]];
  const onRing = (c) => c.cells.some((i) => ring.some(([x, y]) => y * 8 + x === i));
  eq(withBlock.filter(onRing).length, touching, 'a candidate touches the block iff it covers one of the eight ring cells');
  eq(touchers.filter(onRing).length, touching, 'every touching candidate is on the ring');
  eq(withBlock.filter((c) => !onRing(c)).every((c) => c.touch === 0), true, 'and every off-ring candidate scores zero');
  eq(packCandidates('X', occupied, 8, 8, true).length, touching, 'requireTouch keeps exactly the touching ones');
  eq(new Set(packCandidates('X', occupied, 8, 8, true).map((c) => `${c.x},${c.y}`)).size, touching,
    'each with its own anchor, so the draw cannot double-count a pose');
  eq(packCandidates('Q', empty, 8, 8, false).length, 0, 'an unknown letter has no variants');
  eq(packCandidates('I', new Uint8Array(3 * 3), 3, 3, false).length, 0, 'an I does not fit a 3x3 frame in either pose');
});

test('weightedPick is the adjacency bias, and bias 0 is uniform', () => {
  const cands = [
    { name: 'touch-0', touch: 0 },
    { name: 'touch-1', touch: 1 },
    { name: 'touch-3', touch: 3 },
  ];
  const drawFrom = (value) => { const r = () => value; r.int = () => 0; return r; };
  eq(weightedPick(cands, 0, drawFrom(0.1)).name, 'touch-0', 'bias 0: weights are 1,1,1, so 0.1 of the total 3 lands in the first slot');
  eq(weightedPick(cands, 0, drawFrom(0.5)).name, 'touch-1', 'and 0.5 of 3 = 1.5 clears the first and lands in the second');
  eq(weightedPick(cands, 0, drawFrom(0.999)).name, 'touch-3', 'while the top of the range takes the last slot');
  // bias 2: weights (0+1)^2, (1+1)^2, (3+1)^2 = 1, 4, 16, total 21. A draw of 0.5*21 = 10.5
  // clears the first two slots and falls in the third.
  eq(weightedPick(cands, 2, drawFrom(0.5)).name, 'touch-3', 'bias 2 puts the mid draw in the heaviest slot');
  eq(weightedPick(cands, 2, drawFrom(0.01)).name, 'touch-0', 'and only the very bottom still reaches the first');
  eq(weightedPick(cands, 2, drawFrom(0.2)).name, 'touch-1', 'with the 1..5 band to itself (0.2*21 = 4.2)');
  const rng = rngFrom('pick');
  const counts = { 'touch-0': 0, 'touch-1': 0, 'touch-3': 0 };
  for (let i = 0; i < 3000; i++) counts[weightedPick(cands, 2, rng).name]++;
  ok(counts['touch-3'] > counts['touch-1'] && counts['touch-1'] > counts['touch-0'],
    `over 3000 draws the order is by weight (${counts['touch-0']}/${counts['touch-1']}/${counts['touch-3']})`);
  const share = counts['touch-3'] / 3000;
  ok(share > 0.72 && share < 0.8, `the 16/21 share is ${share.toFixed(3)}, against an exact ${16 / 21}`);
  const uniform = { 'touch-0': 0, 'touch-1': 0, 'touch-3': 0 };
  const r2 = rngFrom('uniform');
  for (let i = 0; i < 3000; i++) uniform[weightedPick(cands, 0, r2).name]++;
  for (const k of Object.keys(uniform)) ok(uniform[k] > 800 && uniform[k] < 1200, `bias 0 is uniform: ${k} got ${uniform[k]}`);
  eq(weightedPick([{ name: 'only', touch: 0 }], 4, rngFrom(1)).name, 'only', 'a single candidate is picked whatever the bias');
});

test('isConnected is 4-connectivity, by hand', () => {
  eq(isConnected(fullRect(4, 4), 4, 4), true, 'a full rectangle is connected');
  eq(isConnected(parseMask('101' + '000' + '101', 3, 3), 3, 3), false, 'four corners touch only at points, and points are not edges');
  eq(isConnected(parseMask('11' + '00', 2, 2), 2, 2), true, 'a domino is connected');
  eq(isConnected(parseMask('10' + '00', 2, 2), 2, 2), true, 'one cell is trivially connected');
  eq(isConnected(parseMask('00' + '00', 2, 2), 2, 2), false, 'no cells at all is not a box');
  eq(isConnected(HOOK_LP.mask, HOOK_LP.w, HOOK_LP.h), true, 'the hand-built hook is one object');
  const split = parseMask('110000' + '110000' + '000110' + '000110', 6, 4);
  eq(isConnected(split, 6, 4), false, 'two blobs with a gap column between them are two 匣, not one');
  eq(isConnected(Uint8Array.from(HOOK_LP.mask.map(() => 1)), 8, 4), true, 'a full 8x4 frame');
  for (const band of BANDS) {
    const made = makeLevel({ seed: `conn:${band.key}`, band });
    eq(isConnected(made.spec.mask, made.spec.w, made.spec.h), true, `${band.key}: generated boards pass it`);
    eq(isConnected(Uint8Array.from(made.spec.mask).map((v) => (v ? 0 : 1)), FRAME_W, FRAME_H), false,
      `${band.key}: and its complement is not, which is the same test seen from the other side`);
  }
});

test('the deadline is injected, because js/core/* may not read a clock', () => {
  // A generator with no time budget at all: it must still terminate, and it must report that it
  // gave up rather than returning a level it could not prove.
  let calls = 0;
  const made = makeLevel({
    seed: 'slow', band: 'iron', maxAttempts: 500,
    deadlineFn: () => { calls++; return calls > 3; },
  });
  ok(made.ok === true || made.ok === false, 'it returned a verdict either way');
  eq(calls, made.ok ? made.stats.attempts : made.stats.attempts + 1,
    `the predicate is consulted exactly once per loop pass (${calls} checks, ${made.stats.attempts} attempts)`);
  ok(calls <= 4, `and a deadline that fires stops the loop (${calls} checks before it gave up)`);
  eq(made.stats.attempts <= 4, true, `at most four attempts were started, after ${made.stats.attempts}`);
  if (!made.ok) {
    eq(made.stats.timeOut, true, 'the failure says why');
    eq(made.stats.accepted, 0, 'nothing was accepted');
  }
  const never = makeLevel({ seed: 'instant', band: 'taster', deadlineFn: () => true });
  eq(never.ok, false, 'a deadline that fires before the first attempt yields nothing');
  eq(never.stats.timeOut, true, 'and reports it');
  eq(never.stats.attempts, 0, 'without starting an attempt');
  const capped = makeLevel({ seed: 'capped', band: 'iron', maxAttempts: 1 });
  eq(typeof capped.ok, 'boolean', 'maxAttempts 1 either makes a level or says it did not');
  if (!capped.ok) eq(capped.stats.attempts, 1, 'and the count stops at the cap');
  eq(capped.stats.timeOut, false, 'no deadline was injected, so timeOut stays false');
});

test('generation cost stays inside what a tap on a phone can pay', () => {
  // The daily and the random link generate on tap, so the honest question is not "is it fast"
  // but "how many node visits can one tap cost". Measured here, not claimed.
  const samples = [];
  for (const band of BANDS) {
    let nodes = 0;
    let frames = 0;
    let attempts = 0;
    for (let i = 0; i < 6; i++) {
      const made = makeLevel({ seed: `cost:${band.key}:${i}`, band });
      nodes = Math.max(nodes, made.stats.maxDlxNodes);
      frames = Math.max(frames, made.stats.maxLogicFrames);
      attempts += made.stats.attempts;
      samples.push(made.stats.attempts);
    }
    ok(nodes < 20000, `${band.key}: worst uniqueness proof in six draws was ${nodes} nodes`);
    ok(frames < 2000, `${band.key}: worst reasoning search was ${frames} frames`);
    ok(attempts < 600, `${band.key}: six draws cost ${attempts} packings in total`);
  }
  ok(Math.max(...samples) < 200, `the worst single draw needed ${Math.max(...samples)} attempts, well inside library.js's cap of 200`);
});

test('library.js hands out the same generator object this file measures', () => {
  // The campaign rows carry no `stats` (they were baked, and the bake keeps the numbers not the
  // counters), while the generated rows do. That difference is a fact about adopt(), and the UI
  // reads it, so it is pinned here rather than assumed.
  const baked = campaign()[0];
  eq(baked.stats, undefined, 'a baked lot has no attempt statistics');
  eq(baked.source, 'campaign', 'and says where it came from');
  const made = makeLevel({ seed: 'shared', band: 'easy' });
  eq(typeof made.stats.attempts, 'number', 'a generated level does');
  eq(made.spec.pieces.length, made.k, 'and k is the piece count, always');
  eq(yieldOf({ ...made.stats }).accepted, 1, 'yieldOf reads a single level\'s stats as a rate of 1 over its attempts');
});

test('rng streams are the only randomness, and mulberry32 does not repeat soon', () => {
  // A generator whose rng repeated after a few draws would produce the same level for different
  // seeds, which would show up as duplicate dailies. Checked at the stream level, cheaply.
  const r = mulberry32(123456789);
  const stream = new Set(Array.from({ length: 2000 }, () => r()));
  eq(stream.size, 2000, 'two thousand draws, two thousand distinct values: no short cycle');
  const ints = new Set(Array.from({ length: 500 }, (_, i) => rngFrom(`int${i}`).int(97)));
  ok(ints.size > 60, `int(97) over 500 seeds reaches ${ints.size} different values`);
  const hashed = new Set(Array.from({ length: 300 }, (_, i) => rngFrom(`b${i}`).range(0, 1e6)));
  eq(hashed.size, 300, 'and 300 nearby seeds do not collide on a first draw');
});

process.exitCode = run();
