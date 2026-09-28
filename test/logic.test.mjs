// The difficulty oracle: what the pencil-and-paper solver in js/core/logic.js is allowed to say.
//
// WHY THIS FILE EXISTS
// ----------------------------------------------------------------------------
// 推理深度 k is the only number in this game that rates a level, and it is a measurement of one
// specific program: two rules to a fixpoint, then a guess on the most-constrained cell, and k is
// the deepest assumption frame the *successful* route entered. Two consequences are load-bearing,
// and neither is checked by the level's own uniqueness proof:
//
//   * depth 0 means no guess was needed. Every commit propagate() makes is present in every
//     remaining cover (a piece with one legal placement must use it; a cell with one candidate row
//     must be covered by it), so a fixpoint that finishes the board has produced the only cover.
//     That is a theorem about this program, and it is what lets a depth-0 level be called 上手匣
//     without anyone re-examining it.
//   * the contrapositive is the refutation direction: a level with two covers cannot be depth 0.
//     A solver that always reported 0 would rate every puzzle trivially easy and every band label
//     in the game would be decoration.
//
// The expectations below are hand-derived: the fixture boards in test/fixture.mjs carry their
// hand-proved cover counts, and the campaign's counts are re-proved by test/library.test.mjs.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import { RULES, RULE_SET_VERSION, logicSolve } from '../js/core/logic.js';
import { compile, countSolutions, solveLevel } from '../js/core/dlx.js';
import { validatePlacements, maskCount, validateLevel } from '../js/core/board.js';
import { CELLS, VARIANTS } from '../js/core/pieces.js';
import { X_PLUS, HOOK_LP, HOOK_PLUS_UNION, PLUS_ONLY, HAND_FIXTURES } from './fixture.mjs';
import { campaign, bandForDay } from '../js/core/library.js';
import { BANDS } from '../js/core/make.js';

const TILED = { ok: true, code: null };
const name = (fx) => fx.pieces.join('+') + `@${fx.w}x${fx.h}`;
// A board with no cover at all: the hand-proved hook shape, but asked to hold an I pentomino.
// HOOK_LP's proof enumerates its runs — the longest are four cells — so no pose of I (5x1 or 1x5)
// fits anywhere, and there is nothing to place.
const HOOK_WITH_I = {
  why: 'hook with I and L: no 5-run exists, so no cover',
  w: HOOK_LP.w, h: HOOK_LP.h, mask: Uint8Array.from(HOOK_LP.mask), pieces: ['I', 'L'],
};

// ---------------------------------------------------------------------------
// the rule set, as a contract
// ---------------------------------------------------------------------------

test('the rule pair is two rules, named, versioned, and nothing else', () => {
  eq(RULES.map((r) => r.key), ['cell-naked', 'piece-naked'], 'exactly the two published rule keys');
  eq(RULES.every((r) => typeof r.text === 'string' && r.text.length > 6), true, 'each rule carries the sentence the UI quotes');
  eq(new Set(RULES.map((r) => r.key)).size, 2, 'no rule is listed twice');
  eq(RULE_SET_VERSION, 1, 'version 1: the depths in js/data/lots.js are statements about these rules');
  eq(RULES.length, 2, 'and the array is the whole rule set, so adding a rule is a visible edit');
});

test('depth 0 is a proof of uniqueness, not a rating', () => {
  // The theorem, on the fixture whose cover count is proved on paper: one piece, one pose that
  // fits, forced by R2 the moment the board is looked at.
  const plus = logicSolve(PLUS_ONLY);
  eq(plus.depth, 0, `${name(PLUS_ONLY)} needs no guess`);
  eq(plus.guesses, 0, 'and the measurement says so explicitly: zero frames entered');
  eq(plus.frames, 0, 'zero states allocated for a guess');
  eq(plus.contradictions, 0, 'nothing was refuted, because nothing was assumed');
  eq(countSolutions(PLUS_ONLY, 3), 1, 'and dancing links independently agrees it is unique');
  const x = logicSolve(X_PLUS);
  eq([x.depth, x.guesses, x.forced], [0, 0, 1], `${name(X_PLUS)}: one commit, no guess`);
  // ...and on every depth-0 lot in the shipped campaign.
  const shallow = campaign().filter((l) => l.depth === 0);
  ok(shallow.length >= 2, `the campaign has depth-0 lots to test with (${shallow.length})`);
  for (const lot of shallow) {
    const l = logicSolve(lot.spec);
    eq(l.depth, 0, `${lot.id}: re-measured at depth 0`);
    eq(l.guesses, 0, `${lot.id}: no guess`);
    eq(l.forced, lot.k, `${lot.id}: every one of its ${lot.k} pieces was committed by a rule`);
    eq(countSolutions(lot.spec, 2), 1, `${lot.id}: therefore exactly one cover — and there is exactly one`);
  }
});

test('a level with two covers cannot be read as depth 0', () => {
  // HOOK_LP has exactly two covers, proved by hand in test/fixture.mjs and re-counted in
  // test/dlx.test.mjs. So no guess-free route exists, so the solver must enter a frame.
  eq(countSolutions(HOOK_LP, 3), 2, 'the board really has two covers');
  const l = logicSolve(HOOK_LP);
  eq(l.solved, true, 'it does find one of them');
  eq(l.truncated, false, 'without hitting the frame cap');
  ok(l.depth >= 1, `so depth is at least 1, and it is ${l.depth}`);
  ok(l.guesses >= 1, `and at least one frame was entered (${l.guesses})`);
  eq(validatePlacements(HOOK_LP, l.placements), TILED, 'the cover it found is a real tiling');
  eq(countSolutions(HOOK_PLUS_UNION, 3), 2, 'the disjoint-union board also has two (2 x 1 by hand)');
  ok(logicSolve(HOOK_PLUS_UNION).depth >= 1, 'and is therefore also not depth 0');
  // The two fixture boards differ by exactly one connected chunk of board; the counter moves 1->2
  // across that gap, which is the sensitivity the generator's uniqueness filter depends on.
  eq(countSolutions(PLUS_ONLY, 3), 1, 'same code path, one region, back to one cover');
});

// ---------------------------------------------------------------------------
// the measurement, property by property
// ---------------------------------------------------------------------------

test('it finishes what is finishable and says so about what is not', () => {
  const dead = logicSolve(HOOK_WITH_I);
  eq(dead.solved, false, 'the hook cannot hold an I, and the solver does not invent one');
  eq(dead.placements, null, 'so there is no answer list to hand back');
  eq(dead.depth, -1, 'and depth is -1: "never finished" is not the same number as "trivial"');
  eq(dead.truncated, false, 'it stopped because it had to, not because it was capped');
  eq(dead.guesses, 0, 'propagate spots the stranded piece before any guess is needed');
  eq(dead.contradictions, 1, 'one contradiction, reported');
  eq(countSolutions(HOOK_WITH_I, 2), 0, 'dancing links agrees there is nothing');
  eq(validateLevel(HOOK_WITH_I), null, 'and it is a perfectly legal level, which is the point: legality is not solvability');
});

test('the answer it prints is a cover, in commit order', () => {
  for (const fx of HAND_FIXTURES) {
    const l = logicSolve(fx);
    eq(l.solved, true, `${name(fx)}: solved`);
    eq(l.placements.length, fx.pieces.length, `${name(fx)}: one placement per piece`);
    eq(validatePlacements(fx, l.placements), TILED, `${name(fx)}: and the list tiles the box`);
    eq(new Set(l.placements.map((p) => p.piece)).size, fx.pieces.length, `${name(fx)}: no piece placed twice`);
    eq(maskCount(fx.mask), fx.pieces.length * CELLS, `${name(fx)}: the area adds up`);
    eq(l.passes >= l.forced, true, `${name(fx)}: ${l.forced} forced commits cost at least ${l.passes} propagation passes`);
  }
});

test('the two solvers agree on every unique level they are both asked about', () => {
  // Independent programs over the same matrix: one searches exhaustively with dancing links, the
  // other reasons with two rules and a guess. On a unique level they must agree cell for cell, or
  // one of them is wrong about the level.
  let compared = 0;
  for (const lot of campaign()) {
    const dlx = solveLevel(lot.spec, 2);
    eq(dlx.count, 1, `${lot.id}: unique, which is what makes the comparison meaningful`);
    const l = logicSolve(lot.spec);
    const key = (list) => list.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`).sort().join('|');
    eq(key(l.placements), key(dlx.placements), `${lot.id}: the same ${lot.k} placements`);
    eq(l.depth, lot.depth, `${lot.id}: and the printed depth re-measures`);
    compared++;
  }
  eq(compared, 30, 'all thirty shipped lots');
});

test('the search is a pure function of the level, and leaves it alone', () => {
  const lot = campaign()[20];
  const snapshot = JSON.stringify({ w: lot.spec.w, h: lot.spec.h, mask: Array.from(lot.spec.mask), pieces: lot.spec.pieces });
  const a = logicSolve(lot.spec);
  const b = logicSolve(lot.spec);
  eq(snapshot, JSON.stringify({ w: lot.spec.w, h: lot.spec.h, mask: Array.from(lot.spec.mask), pieces: lot.spec.pieces }),
    `${lot.id}: the spec came back untouched from the first call`);
  eq(a, b, 'two calls give identical numbers, including the order of the commits');
  eq(logicSolve(compile(lot.spec)), a, 'a compiled problem and its spec are the same input');
  const copy = { w: lot.spec.w, h: lot.spec.h, mask: Uint8Array.from(lot.spec.mask), pieces: lot.spec.pieces.slice() };
  eq(logicSolve(copy), a, 'and a rebuilt copy measures the same, so nothing is cached on the object');
});

test('maxFrames caps the search, and the cap is reported instead of hidden', () => {
  const deepest = campaign().slice().sort((x, y) => y.depth - x.depth)[0];
  assert(deepest.depth >= 4, `the campaign has a deep lot to starve (${deepest.id} at depth ${deepest.depth})`);
  const full = logicSolve(deepest.spec);
  eq(full.truncated, false, `${deepest.id}: with the default cap it finishes at depth ${full.depth}`);
  const starved = logicSolve(deepest.spec, { maxFrames: 1 });
  eq(starved.truncated, true, `${deepest.id}: with one frame it hits the cap`);
  eq(starved.solved, false, `${deepest.id}: and reports that it did not finish`);
  eq(starved.placements, null, `${deepest.id}: no answer, rather than a partial one`);
  eq(starved.depth, -1, `${deepest.id}: depth -1, so a caller cannot read starvation as an easy level`);
  eq(starved.frames, 2, `${deepest.id}: maxFrames admits that many entries, and the extra one is where it notices the cap`);
  eq(logicSolve(deepest.spec, { maxFrames: 0 }).truncated, true, 'a budget of zero stops before the first guess');
  // make.js counts this outcome as stats.logicTruncated and rejects the candidate, which is only
  // safe because the flag exists and is set.
  eq(logicSolve(deepest.spec, { maxFrames: 1000000 }).solved, true, 'a generous budget changes nothing but the cap');
});

test('depth, guesses, frames and contradictions are consistent with each other', () => {
  // depth is the deepest frame on the winning route, guesses counts frames entered in total, so
  // depth <= guesses, and forced commits plus guesses must account for every piece placed.
  const rows = campaign().map((lot) => ({ id: lot.id, k: lot.k, lot, l: logicSolve(lot.spec) }));
  for (const { id, k, l } of rows) {
    eq(l.solved, true, `${id}: finished`);
    eq(l.truncated, false, `${id}: uncapped`);
    ok(l.depth >= 0, `${id}: depth is a real measurement, not the -1 starvation marker`);
    ok(l.guesses >= l.depth, `${id}: ${l.guesses} guesses entered, deepest winning route ${l.depth}`);
    ok(l.forced >= k - l.guesses, `${id}: ${l.forced} forced commits plus ${l.guesses} guesses account for ${k} pieces`);
    ok(l.frames >= l.depth, `${id}: frames ${l.frames} at least as deep as the route it won`);
    ok(l.forced + l.guesses >= k, `${id}: ${l.forced} rule commits plus ${l.guesses} guesses cover ${k} pieces`);
  }
  const histogram = {};
  for (const { l } of rows) histogram[l.depth] = (histogram[l.depth] || 0) + 1;
  const keys = Object.keys(histogram).map(Number).sort((a, b) => a - b);
  ok(keys.length >= 5, `the campaign spans ${keys.length} distinct depths: ${keys.join(', ')}`);
  ok(keys[0] === 0, 'starting at 0, which is what the taster band is allowed to print');
  ok(keys[keys.length - 1] >= 5, `and reaching ${keys[keys.length - 1]}, which is what iron is for`);
  ok(Math.max(...Object.values(histogram)) < 30, 'no single depth owns the whole campaign');
});

test('a relaxed level is still a level, and the measurement responds', () => {
  // Take one lot, lift its last piece off the board and delete the cells it covered. The cover
  // that remains is the lot's own solution minus that placement, which this test supplies by
  // hand, so both oracles have something true to find.
  const lot = campaign()[0];
  const drop = lot.solution[lot.solution.length - 1];
  const mask = Uint8Array.from(lot.spec.mask);
  for (const [dx, dy] of VARIANTS[lot.spec.pieces[drop.piece]][drop.variant].cells) {
    mask[(drop.y + dy) * lot.spec.w + drop.x + dx] = 0;
  }
  const cut = { w: lot.spec.w, h: lot.spec.h, mask, pieces: lot.spec.pieces.filter((_, i) => i !== drop.piece) };
  eq(validateLevel(cut), null, `${lot.id}: the de-clued board is a legal level`);
  const rest = lot.solution.filter((p) => p.piece !== drop.piece);
  eq(validatePlacements(cut, rest), TILED, `${lot.id}: the placements left behind tile it`);
  const before = logicSolve(lot.spec);
  const after = logicSolve(cut);
  eq(after.solved, true, `${lot.id}: and the solver finishes the relaxed one`);
  eq(validatePlacements(cut, after.placements), TILED, `${lot.id}: with a real cover`);
  eq(countSolutions(cut, 2) >= 1, true, `${lot.id}: dancing links finds a cover as well`);
  ok(after.depth <= before.depth + 2, `${lot.id}: removing a piece does not blow the measurement apart (${before.depth} -> ${after.depth})`);
  eq(after.placements.length, cut.pieces.length, `${lot.id}: one placement per remaining piece`);
});

test('the band windows are stated in units this solver actually produces', () => {
  // A band whose depth window sat above anything logicSolve ever returns could never be filled,
  // and the generator would loop to maxAttempts in silence.
  const depths = campaign().map((l) => l.depth);
  const max = Math.max(...depths);
  for (const b of BANDS) {
    ok(b.depth[0] <= max, `${b.key}: window floor ${b.depth[0]} is inside the measured range (max ${max})`);
    ok(b.depth[1] >= b.depth[0], `${b.key}: and the window is not inverted`);
    eq(campaign().filter((l) => l.band === b.key).every((l) => l.depth >= b.depth[0] && l.depth <= b.depth[1]), true,
      `${b.key}: every lot stamped with it sits inside it`);
  }
  eq(BANDS.map((b) => b.depth[1]), [1, 3, 4, 5, 7], 'the published ladder of depth ceilings');
  eq(typeof bandForDay('2026-03-01'), 'string', 'and a calendar day picks a rung by the same table');
});

process.exitCode = run();
