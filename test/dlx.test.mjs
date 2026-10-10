// The counter: Algorithm X over a dancing-links matrix, tested on boards whose answers were
// proved on paper (test/fixture.mjs) and on the failure modes that turn a counter into a liar.
//
// The published rectangle figures are asserted in test/anchor.test.mjs, not here: this suite is
// the cheap half — bookkeeping, limits, and the cases a hand can enumerate.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  packProblem, compile, matrixDigest, isMatrixClean, searchCount,
  countSolutions, solveLevel, collectSolutions,
} from '../js/core/dlx.js';
import { validatePlacements, placementMask, fullRect } from '../js/core/board.js';
import { PIECES, cellsKey, norm } from '../js/core/pieces.js';
import { X_PLUS, HOOK_LP, HOOK_PLUS_UNION, PLUS_ONLY } from './fixture.mjs';

function maskString(mask) {
  let s = '';
  for (let i = 0; i < mask.length; i++) s += mask[i] ? '1' : '0';
  return s;
}
const snapshot = (spec) => [maskString(spec.mask), spec.pieces.join('')];

test('the matrix is the board: five cell columns and one column per piece', () => {
  const p = packProblem(X_PLUS);
  eq(p.numCells, 5, 'the plus board has five cells to cover');
  eq(p.numCols, 6, 'plus one column demanding that X be used');
  eq(p.rows.length, 1, 'X has one fixed form and exactly one anchor fits — so one row');
  eq(p.lists[0], [0, 1, 2, 3, 4, 5], 'the row names its five cell columns (board order) then the piece column');
  const hook = packProblem(HOOK_LP);
  eq([hook.numCells, hook.numCols], [10, 12], 'ten cells plus L and P');
  assert(hook.rows.length > 2, 'and plenty of poses to try, which is why the count is a search');
});

test('node 0 is a root sentinel that is never covered', () => {
  // If the root doubled as a column header, covering that column would splice it out of the
  // header ring, R[0] === 0 would never become true again, and "choose a column" would spin.
  const p = packProblem(X_PLUS);
  eq(p.matrix.headers, p.numCols + 1, 'one header slot ahead of every column');
  eq([p.matrix.R[0], p.matrix.L[0]], [1, p.matrix.headers - 1], 'the ring closes through the root');
  eq(p.matrix.size[0], 0, 'and the root is not a column with rows in it');
  countSolutions(p, Infinity);
  eq(p.matrix.R[0], 1, 'after a full sweep the root still heads the ring');
});

test('the four hand-proved boards return the four hand-proved numbers', () => {
  eq(countSolutions(X_PLUS), 1, 'the plus: X is forced by its own centre — 1');
  eq(countSolutions(HOOK_LP), 2, 'the hook: the L-or-P split at (4,2) — 2');
  eq(countSolutions(PLUS_ONLY), 1, 'the plus alone in the wide frame — 1');
  eq(countSolutions(HOOK_PLUS_UNION), 2, 'the two regions side by side — 2 x 1');
});

test('two regions separated by an empty column multiply, and nothing leaks between them', () => {
  const a = countSolutions(HOOK_LP);
  const b = countSolutions(PLUS_ONLY);
  const union = collectSolutions(HOOK_PLUS_UNION);
  eq(union.count, a * b, 'the product identity holds on the same counter');
  eq(union.truncated, false, 'and it was not truncated');
  // Every solution of the union keeps each piece inside its own region: pieces are connected, and
  // columns 5 and 6 of the frame carry no cells.
  for (const sol of union.solutions) {
    for (const part of sol) {
      const xs = part.cells.map((i) => i % 10);
      const span = Math.max(...xs) - Math.min(...xs);
      ok(span <= 4, `a five-cell piece never spans the empty columns (xs ${xs.join(',')})`);
    }
  }
});

test('a counting limit truncates, and never invents or loses a solution below it', () => {
  const one = searchCount(HOOK_LP, { limit: 1 });
  eq([one.count, one.truncated, one.capped], [1, true, false], 'stopped at the first cover');
  const two = searchCount(HOOK_LP, { limit: 2 });
  eq([two.count, two.truncated], [2, true], 'the second cover is the refutation the generator needs');
  const all = searchCount(HOOK_LP, { limit: Infinity });
  eq([all.count, all.truncated], [2, false], 'with no limit, the sweep finishes and says so');
  ok(one.nodes <= all.nodes, 'and the bounded walk is no longer than the full one');
  eq(countSolutions(HOOK_LP, 2), 2, 'the countSolutions wrapper is the same search');
  eq(countSolutions(X_PLUS, 2), 1, 'on a unique board limit=2 comes back with 1 and no truncation');
});

test('a board with no exact cover returns zero, from five different reasons', () => {
  // 1. the piece cannot reach the shape: the plus board given I, whose only poses are straight bars.
  eq(countSolutions({ ...X_PLUS, pieces: ['I'] }), 0, 'no straight bar lies on a cross');
  // 2. the frame is too narrow for the piece: X's box is 3x3.
  eq(countSolutions({ w: 1, h: 5, mask: fullRect(1, 5), pieces: ['X'] }), 0, 'a 1x5 strip cannot hold a 3x3 box');
  // 3. the arithmetic: sixteen cells cannot be covered by three pieces of five cells each.
  eq(countSolutions({ w: 4, h: 4, mask: fullRect(4, 4), pieces: ['I', 'L', 'P'] }), 0,
    'three pieces cover fifteen cells; the board has sixteen');
  // 4. the duplicate: two X columns, five cells between them.
  eq(countSolutions({ ...X_PLUS, pieces: ['X', 'X'] }), 0, 'ten cells of X on a five-cell board');
  // 5. a piece with nowhere to go: the hook's longest straight run is four cells (column 1 and
  //    row 2), and I needs five in a line, so I has no legal pose on it at all.
  eq(countSolutions({ ...HOOK_LP, pieces: ['I', 'L'] }), 0, 'a piece with zero legal placements kills the board');
});

test('cover and uncover are exact inverses: the matrix comes back byte-identical', () => {
  const p = packProblem(HOOK_PLUS_UNION);
  const before = matrixDigest(p);
  countSolutions(p, Infinity);
  eq(isMatrixClean(p, before), true, 'a full sweep leaves nothing covered');
  collectSolutions(p, { max: 40 });
  eq(matrixDigest(p), before, 'enumerating the covers leaves it just as still');
  searchCount(p, { limit: 2 });
  eq(matrixDigest(p), before, 'so does stopping early');
  // The fingerprint has to be sensitive or the three lines above prove nothing.
  p.matrix.size[2] += 1;
  ok(matrixDigest(p) !== before, 'a one-cell change in a column size moves the digest');
  p.matrix.size[2] -= 1;
  eq(matrixDigest(p), before, 'and undoing it moves it back');
});

test('the node cap reports a runaway as capped, not as a wrong count', () => {
  const p = packProblem(HOOK_PLUS_UNION);
  const tight = searchCount(p, { limit: Infinity, maxNodes: 1 });
  eq([tight.capped, tight.count, tight.truncated], [true, 0, false], 'it stopped because it was told to');
  const loose = searchCount(p, { limit: Infinity, maxNodes: 1000000 });
  eq([loose.capped, loose.count], [false, 2], 'with room, the same board counts 2');
  const sweep = collectSolutions(p, { maxNodes: 1 });
  eq([sweep.truncated, sweep.solutions.length], [true, 0], 'collectSolutions has the same guard');
});

test('collectSolutions honours its cap and returns covers as cell sets', () => {
  const all = collectSolutions(HOOK_LP, { max: 40000 });
  eq([all.count, all.solutions.length, all.truncated], [2, 2, false], 'both covers, no truncation');
  for (const sol of all.solutions) {
    eq(sol.length, 2, 'two pieces, two parts');
    eq(sol.map((s) => s.piece).sort(), [0, 1], 'each piece exactly once');
    for (const part of sol) {
      eq(part.cells.length, 5, 'five cells per piece');
      eq(part.cells, part.cells.slice().sort((a, b) => a - b), 'in ascending index order');
    }
  }
  eq(new Set(all.solutions.map((s) => JSON.stringify(s))).size, 2, 'and the two covers differ');
  const one = collectSolutions(HOOK_LP, { max: 1 });
  eq([one.solutions.length, one.truncated], [1, true], 'ask for one and you get one, marked truncated');
});

test('solveLevel turns a unique cover back into placements, and refuses to guess at the rest', () => {
  const plus = solveLevel(X_PLUS);
  eq(plus.count, 1, 'unique');
  eq(plus.placements.length, 1, 'one placement');
  eq(plus.placements, [{ piece: 0, variant: 0, x: 0, y: 0 }], 'the only pose of X at the only anchor');
  eq(validatePlacements(X_PLUS, plus.placements), { ok: true, code: null }, 'and it is geometrically legal');
  const hook = solveLevel(HOOK_LP, 2);
  eq([hook.count, hook.placements, hook.truncated], [2, null, true], 'not unique, so no placements');
  const impossible = solveLevel({ ...X_PLUS, pieces: ['I'] });
  eq([impossible.count, impossible.placements], [0, null], 'zero solutions is an answer too');
});

test('the counter is a function of its input: no mutation, no memory between calls', () => {
  const spec = { w: 8, h: 4, mask: Uint8Array.from(HOOK_LP.mask), pieces: ['L', 'P'] };
  const before = snapshot(spec);
  const viaSpec = countSolutions(spec);
  const problem = compile(spec);
  const viaProblem = countSolutions(problem);
  eq([viaSpec, viaProblem], [2, 2], 'the raw spec and the compiled problem answer alike');
  eq(snapshot(spec), before, 'the spec was never written to');
  eq(spec.mask instanceof Uint8Array, true, 'and it is still the same kind of object');
  eq(compile(problem), problem, 'compile passes a packed problem straight through');
  eq(countSolutions(spec), viaSpec, 'counting twice gives the same number');
  const placements = solveLevel(X_PLUS).placements;
  const pose = PIECES.X.variants[0];
  eq(cellsKey(norm(pose)), '1,0;0,1;1,1;2,1;1,2', 'the plus pose used above is X itself');
  eq(placementMask(X_PLUS, pose, placements[0].x, placements[0].y).cells, [1, 3, 4, 5, 7],
    'and the placement the counter returned covers exactly those cells');
});

test('the same problem object can be asked repeatedly without degrading', () => {
  const p = packProblem(HOOK_PLUS_UNION);
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(searchCount(p, { limit: Infinity }).count);
  eq(seen, [2, 2, 2, 2, 2], 'five sweeps, one number, and it is the hand-proved one');
});

process.exitCode = run();
