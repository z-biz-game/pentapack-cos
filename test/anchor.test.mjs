// The external anchor: the number of ways to pack all twelve pentominoes into a rectangle.
//
//   3x20 = 2    4x15 = 368    5x12 = 1010    6x10 = 2339
//
// These four numbers are published combinatorial data — they were in the literature long before
// this repository existed, nobody here computed them, and js/core/dlx.js is the thing being
// graded against them. They are counts **up to the four symmetries of a non-square rectangle**,
// which is why the raw enumeration is quotiented by frameSymmetries() below; the raw count of any
// non-square rectangle is a multiple of four, so 2339 being odd already proves the published
// figures are orbits. A piece set that is wrong in one place cannot produce all four: swap V for
// a second N and 3x20 stops matching (the assertion at the bottom of this file).
//
// COST AND THE ONE-PASS RULE. A full sweep costs 67ms / 1.8s / 4.9s / 8.3s measured on this
// machine, so the four boards are enumerated **once**, into the module-level `measured` map, and
// every assertion below reads that memo. This file is the only suite that pays for it; the rest
// of `node --test` stays in milliseconds. `tools/proof.mjs` prints the same four measurements
// with a second sweep for the human reading along — see proveRect's recount note.
//
// CI: all four boards run here. The measured wall time of this file is ~16s, inside the 60s
// budget SPEC.md 2 allows, so nothing had to be moved behind FULL=1.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import { FULL_SET, variantCount } from '../js/core/pieces.js';
import { fullRect, frameSymmetries, countOrbits, validateLevel } from '../js/core/board.js';
import { packProblem, collectSolutions, searchCount, matrixDigest, isMatrixClean } from '../js/core/dlx.js';

// Hand-typed from the literature, in the order SPEC.md 0 quotes them.
const PUBLISHED = { '3x20': 2, '4x15': 368, '5x12': 1010, '6x10': 2339 };
const BOARDS = [[3, 20], [4, 15], [5, 12], [6, 10]];

const measured = new Map(); // `${w}x${h}` -> everything this file can say about that board

// One sweep per board. Also the only place `collectSolutions` is run without a counting limit.
function measure(w, h) {
  const key = `${w}x${h}`;
  if (measured.has(key)) return measured.get(key);
  const spec = { w, h, mask: fullRect(w, h), pieces: FULL_SET.slice() };
  const problem = packProblem(spec);
  const before = matrixDigest(problem);
  const t0 = Date.now();
  const sweep = collectSolutions(problem, { max: 40000 });
  const syms = frameSymmetries(w, h);
  const tally = countOrbits(syms, sweep.solutions);
  const ms = Date.now() - t0;
  const clean = isMatrixClean(problem, before);
  // The generator's uniqueness gate, on the same board: it must say "not unique" and say it early.
  const bounded = searchCount(problem, { limit: 2 });
  const record = {
    key, spec, problem, sweep, syms, ms, clean, bounded,
    truncated: sweep.truncated, nodes: sweep.nodes, raw: tally.raw, orbits: tally.orbits,
  };
  process.stdout.write(`  anchor ${key}: orbits ${tally.orbits} raw ${tally.raw} nodes ${record.nodes} in ${ms}ms\n`);
  measured.set(key, record);
  return record;
}

test('the anchor boards are the twelve pentominoes on a full rectangle', () => {
  for (const [w, h] of BOARDS) {
    const r = measure(w, h);
    eq(r.spec.pieces.length, 12, `${w}x${h}: twelve pieces`);
    eq(w * h, 60, `${w}x${h}: sixty cells, and the twelve have exactly sixty`);
    ok(w !== h, `${w}x${h}: not a square, so the frame has four symmetries and not eight`);
    eq(validateLevel(r.spec), null, `${w}x${h}: the fixture the literature uses is a legal level`);
  }
});

for (const [w, h] of BOARDS) {
  const board = `${w}x${h}`;
  test(`${board} has exactly ${PUBLISHED[board]} solutions up to the rectangle's symmetries`, () => {
    const r = measure(w, h);
    eq(r.truncated, false, `${board}: the sweep was not capped, so the number is a count`);
    eq(r.orbits, PUBLISHED[board], `${board}: the published figure, from this repository's counter`);
  });

  test(`${board}: raw covers are four times the published orbits`, () => {
    const r = measure(w, h);
    eq(r.raw, r.orbits * 4, `${board}: every orbit has all four of its images`);
    eq(r.raw, PUBLISHED[board] * 4, `${board}: and that is the raw number the sweep found`);
    eq(r.sweep.solutions.length, r.raw, `${board}: one entry per cover, none dropped`);
    // Reaching orbits == raw/4 also proves no cover of this board is fixed by a non-trivial
    // symmetry of the frame; had one been, countOrbits would have returned fewer orbits.
    eq(countOrbits(r.syms, r.sweep.solutions).orbits, r.orbits, `${board}: the quotient is stable`);
  });

  test(`${board}: the sweep leaves the dancing-links matrix byte-identical`, () => {
    const r = measure(w, h);
    eq(r.clean, true, `${board}: cover and uncover are inverses over ${r.nodes} column selections`);
  });

  test(`${board}: limit=2 rejects this board early instead of counting it all`, () => {
    const r = measure(w, h);
    eq(r.bounded.count, 2, `${board}: two covers is a refutation, and it is all the gate needs`);
    eq(r.bounded.truncated, true, `${board}: it stopped because it was told to`);
    ok(r.bounded.nodes * 10 < r.nodes,
      `${board}: ${r.bounded.nodes} nodes against a full sweep of ${r.nodes} — cheap enough to be a filter`);
  });
}

test('the published figures are orbits: 2339 is odd, a raw count cannot be', () => {
  eq(PUBLISHED['6x10'] % 2, 1, 'odd');
  eq(measure(6, 10).raw % 4, 0, 'and the raw enumeration is a multiple of four');
  eq(measure(6, 10).raw / 4, PUBLISHED['6x10'], 'the two are the same fact divided by the frame group');
  // The same must hold on every board, or the quotient would be hiding an invariant cover.
  for (const [w, h] of BOARDS) eq(measure(w, h).raw % 4, 0, `${w}x${h} raw is a multiple of four`);
});

test('the sweep really walks the tree it claims', () => {
  // Nodes counted must grow with board size, or "nodes" would be a constant someone typed.
  const a = measure(3, 20).nodes;
  const b = measure(4, 15).nodes;
  const c = measure(5, 12).nodes;
  const d = measure(6, 10).nodes;
  ok(a < b && b < c && c < d, `column selections ascend: ${a} < ${b} < ${c} < ${d}`);
  ok(a > 1000, `even the cheapest board is a search, not a lookup (${a} nodes)`);
  for (const [w, h] of BOARDS) {
    const r = measure(w, h);
    ok(r.ms > 0, `${w}x${h} was timed, and it took ${r.ms}ms`);
  }
});

test('a set that is not the twelve cannot reproduce the table', () => {
  // The exact bug from SPEC.md 0: a draft with two Ns and no V. It is still twelve pieces and
  // still sixty cells, so nothing about the level looks wrong — only the count betrays it.
  const wrong = ['F', 'I', 'L', 'P', 'N', 'N', 'T', 'U', 'W', 'X', 'Y', 'Z'];
  eq(wrong.length, 12, 'twelve letters, as it looks in the data file');
  const sum = wrong.reduce((a, n) => a + variantCount(n), 0);
  eq(sum, 67, 'and 67 fixed forms instead of 63, because N was counted twice and V never');
  const spec = { w: 3, h: 20, mask: fullRect(3, 20), pieces: wrong };
  const sweep = collectSolutions(spec, { max: 40000 });
  const tally = countOrbits(frameSymmetries(3, 20), sweep.solutions);
  eq(sweep.truncated, false, 'the wrong board is small enough to count exactly');
  ok(tally.orbits !== PUBLISHED['3x20'], `3x20 with the wrong set gives ${tally.orbits} orbits, not 2`);
  eq(searchCount(spec, { limit: 2 }).count, 2, 'and the uniqueness gate rejects it without enumerating it');
  // The duplicate is also illegal at the model level: two pieces that are the same physical tile.
  assert(/appears twice/.test(String(validateLevel(spec))), 'validateLevel names the duplicate');
});

process.exitCode = run();
