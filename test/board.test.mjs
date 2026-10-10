// The level model and its symmetries: what a board *is*, which levels are legal, and how a
// solution list is quotiented by the frame's own symmetries.
//
// Two kinds of expected values live here. The level/validator ones are hand-written from the
// fixture proofs in test/fixture.mjs. The symmetry ones are hand-computed on a 2x3 frame, small
// enough to write every orbit out: indices are y*2+x, so (0,0)=0 (1,0)=1 (0,1)=2 (1,1)=3
// (0,2)=4 (1,2)=5.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  MAX_FRAME, cellIndex, cellX, cellY, parseMask, maskString, maskCells, maskCount, fullRect,
  normaliseSpec, validateLevel, placementMask, validatePlacements, samePlacements, renderMask,
  frameSymmetries, applySymmetry, solutionKey, canonicalSolutionKey, countOrbits,
} from '../js/core/board.js';
import { SHAPES, cellsKey, norm, PIECES } from '../js/core/pieces.js';
import {
  FIXTURES, HOOK_SHAPE_ROWS, INVALID_FIXTURES, VALID_FIXTURES,
  X_PLUS, HOOK_LP, PLUS_ONLY,
} from './fixture.mjs';

// A relative pose written out by hand, resolved to the variant index the piece table gives it.
// The geometry is the hand part; this only translates it into the module's numbering.
function variantOf(name, cells) {
  const key = cellsKey(norm(cells));
  const i = PIECES[name].byKey.get(key);
  assert(i !== undefined, `the hand pose ${key} is not a variant of ${name}`);
  return i;
}

// The hook's two covers, spelled out with coordinates from test/fixture.mjs:
//   L on row 2 with its tail in (1,3); P as the 2x2 block at (1,0) with the tail (3,1).
const L_ROW = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1]];
const P_BLOCK = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1]];

test('the frame arithmetic is row-major and invertible', () => {
  eq(cellIndex(5, 2, 1), 7, 'row 1, column 2 of a width-5 frame');
  eq([cellX(5, 13), cellY(5, 13)], [3, 2], '13 is (3,2) when the row pitch is 5');
  for (let w = 1; w <= 6; w++) {
    for (let h = 1; h <= 4; h++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = cellIndex(w, x, y);
          eq([cellX(w, i), cellY(w, i)], [x, y], `roundtrip in ${w}x${h}`);
        }
      }
    }
  }
});

test('mask text parses, prints back identical, and refuses anything else', () => {
  const m = parseMask('11100' + '01110', 5, 2);
  eq(maskString(m), '1110001110', 'the string form is lossless');
  eq(maskCells(m), [0, 1, 2, 6, 7, 8], 'the set form is in ascending index order');
  eq(maskCount(m), 6, 'and the count agrees with both');
  eq(fullRect(2, 3), new Uint8Array([1, 1, 1, 1, 1, 1]), 'a full frame is all ones');
  eq(maskCount(fullRect(4, 15)), 60, 'the 4x15 anchor board has 60 cells, twelve pentominoes worth');
  throws(() => parseMask('101', 5, 2), /mask length 3 != 10/, 'a short mask is a typo, not a small board');
  throws(() => parseMask('1020000000', 5, 2), /mask char 2 is '2'/, 'only 0 and 1 are cells');
});

test('normaliseSpec takes either serialisation form and never aliases the caller', () => {
  const fromText = normaliseSpec({ w: 8, h: 4, mask: '1'.repeat(32), pieces: 'LP' });
  eq([fromText.w, fromText.h, fromText.pieces], [8, 4, ['L', 'P']], 'pieces as a bare string split');
  const source = { w: 3, h: 3, mask: parseMask('010111010', 3, 3), pieces: ['X'] };
  const copy = normaliseSpec(source);
  copy.mask[0] = 1;
  copy.pieces.push('Z');
  eq(source.mask[0], 0, 'the caller mask is a copy, not the same bytes');
  eq(source.pieces, ['X'], 'and so is the caller piece list');
  eq(normaliseSpec(copy).pieces, ['X', 'Z'], 'a Uint8Array mask is accepted as-is too');
  throws(() => normaliseSpec(null), /spec must be an object/, 'no spec, no level');
  throws(() => normaliseSpec({ w: 0, h: 3, mask: '', pieces: ['X'] }), /positive w and h/, 'a zero-width frame');
});

test('a legal level is one whose area is exactly the pieces it names', () => {
  for (const fixture of VALID_FIXTURES) {
    eq(validateLevel(fixture), null, `${fixture.w}x${fixture.h} ${fixture.pieces.join('')} is well formed`);
  }
  eq(validateLevel({ w: 4, h: 15, mask: fullRect(4, 15), pieces: 'FILPNTUVWXYZ'.split('') }), null,
    'the 4x15 anchor board is a legal level: 60 cells, twelve pieces');
});

test('each invalid fixture is rejected by the rule it was written for', () => {
  eq(INVALID_FIXTURES.length, 6, 'six ways a hand-written data file goes wrong');
  for (const fixture of INVALID_FIXTURES) {
    const err = validateLevel(fixture);
    ok(err, `${fixture.id || fixture.rule}: rejected`);
    eq(err, fixture.invalid, `${fixture.rule}: the message the fixture promises`);
  }
  // Distinct rules, distinct messages: one error string per failure mode, or the negative tests
  // would not tell which gate closed.
  const msgs = INVALID_FIXTURES.map((f) => validateLevel(f));
  eq(new Set(msgs).size, INVALID_FIXTURES.length, 'no two invalid fixtures share a reason');
});

test('the validator also refuses shapes that are not a level at all', () => {
  eq(validateLevel(null), 'spec is not an object', 'no spec');
  eq(validateLevel({ w: 1.5, h: 4, mask: '1', pieces: ['X'] }), 'w and h must be positive integers', 'fractional frame');
  eq(validateLevel({ w: 21, h: 1, mask: '1'.repeat(21), pieces: ['I'] }),
    `frame 21x1 exceeds the ${MAX_FRAME} limit`, 'a frame longer than MAX_FRAME is a typo');
  eq(validateLevel({ w: 5, h: 1, mask: '11111', pieces: [] }), 'no pieces', 'an empty tray is not a puzzle');
  eq(validateLevel({ w: 5, h: 1, mask: '11110', pieces: ['I'] }),
    'area 4 is not a multiple of 5', 'four cells cannot be a pentomino level');
});

test('placementMask reports the cells of a pose, or the first rule it broke', () => {
  const plus = X_PLUS;
  const m = placementMask(plus, PIECES.X.variants[0], 0, 0);
  eq(m.ok, true, 'the plus sits exactly on the plus board');
  eq(m.cells, [1, 3, 4, 5, 7], 'centre (4) with the four arms — hand-written, ascending');
  // The order the pose's cells are walked in decides which rule is reported first, so each
  // expectation below names the cell it reaches before any other.
  eq(placementMask(plus, PIECES.X.variants[0], 1, 0).code, 'off', 'the first arm (2,0) is outside the匣');
  eq(placementMask(plus, PIECES.X.variants[0], 0, 1).code, 'off', 'slide it down and (0,2) is unmasked ground');
  eq(placementMask(plus, PIECES.X.variants[0], 0, 2).code, 'out', 'one row lower and the arm leaves the frame');
  // On the hook: L's horizontal run needs (5,2), which the mask does not have.
  const l = variantOf('L', L_ROW);
  const off = placementMask(HOOK_LP, PIECES.L.variants[l], 2, 2);
  eq([off.ok, off.code], [false, 'off'], 'the run would cover the unmasked (5,2)');
  eq(placementMask(HOOK_LP, PIECES.L.variants[l], 1, 4).code, 'out', 'a run started below the last row is out, not off');
});

test('validatePlacements accepts the hand cover of the hook', () => {
  const l = variantOf('L', L_ROW);
  const p = variantOf('P', P_BLOCK);
  const cover = [
    { piece: 0, variant: l, x: 1, y: 2 }, // L: (1,2)(2,2)(3,2)(4,2) + tail (1,3)
    { piece: 1, variant: p, x: 1, y: 0 }, // P: the block at (1,0) + tail (3,1)
  ];
  eq(validatePlacements(HOOK_LP, cover), { ok: true, code: null }, 'ten cells, two pieces, no overlap');
  eq(validatePlacements(HOOK_LP, cover.slice().reverse()), { ok: true, code: null }, 'order of writing is irrelevant');
});

test('every way a placement list can be wrong gets its own code', () => {
  const l = variantOf('L', L_ROW);
  const p = variantOf('P', P_BLOCK);
  const good = { piece: 0, variant: l, x: 1, y: 2 };
  eq(validatePlacements(HOOK_LP, [good]).code, 'count', 'one placement for a two-piece level');
  eq(validatePlacements(HOOK_LP, [good, good]).code, 'duplicate', 'the same piece put down twice');
  eq(validatePlacements(HOOK_LP, [{ piece: 5, variant: 0, x: 1, y: 2 }, good]).code, 'unknown-piece',
    'a piece index the level does not have');
  eq(validatePlacements(HOOK_LP, [{ piece: 0, variant: 99, x: 1, y: 2 }, good]).code, 'bad-variant',
    'a variant index outside the piece');
  eq(validatePlacements(HOOK_LP, [{ piece: 0, variant: l, x: 1, y: 4 }, good]).code, 'out',
    'a pose that leaves the frame');
  eq(validatePlacements(HOOK_LP, [{ piece: 0, variant: l, x: 2, y: 2 }, good]).code, 'off',
    'a pose inside the frame but on unmasked ground');
  // The second cover of the hook moves P one row down; combined with the L above it shares
  // (2,2) and (3,2), and cell 2*8+2 = 18 is the first one written twice.
  const clash = validatePlacements(HOOK_LP, [good, { piece: 1, variant: p, x: 2, y: 1 }]);
  eq([clash.ok, clash.code, clash.cell], [false, 'overlap', 18], 'two pieces cannot own the same cell');
  eq(validatePlacements(X_PLUS, [{ piece: 0, variant: 0, x: 0, y: 0 }]).ok, true, 'the plus is its own cover');
  eq(validatePlacements(INVALID_FIXTURES[0], []).code, 'level', 'an invalid level never reaches placement checks');
});

test('the gap check cannot fire on a well-formed level, and says why', () => {
  // Area is exactly 5 x pieces, so any complete list of legal, mutually non-overlapping
  // placements covers every cell by counting alone. A short list therefore reports 'count', not
  // 'gap' — pinned here because the branch is unreachable *given* the validator, and a future
  // change that lets it fire means one of those two invariants broke.
  const l = variantOf('L', L_ROW);
  const p = variantOf('P', P_BLOCK);
  eq(validatePlacements(HOOK_LP, [{ piece: 0, variant: l, x: 1, y: 2 }]).code, 'count',
    'missing placements are counted, not mistaken for holes');
  eq(validatePlacements(HOOK_LP, [{ piece: 0, variant: l, x: 1, y: 2 }, { piece: 1, variant: p, x: 1, y: 0 }]).ok, true,
    'a complete legal list is automatically gapless');
});

test('samePlacements compares arrangements, not the order they were written in', () => {
  const a = [{ piece: 0, variant: 1, x: 2, y: 3 }, { piece: 1, variant: 0, x: 0, y: 1 }];
  const b = [{ piece: 1, variant: 0, x: 0, y: 1 }, { piece: 0, variant: 1, x: 2, y: 3 }];
  ok(samePlacements(a, b), 'same three facts per piece, reordered');
  ok(!samePlacements(a, [{ piece: 0, variant: 2, x: 2, y: 3 }, b[1]]), 'a turned piece is a different arrangement');
  ok(!samePlacements(a, [{ piece: 0, variant: 1, x: 2, y: 4 }, b[1]]), 'and so is a slid one');
  ok(!samePlacements(a, a.slice(0, 1)), 'a partial list is not the same list');
  ok(!samePlacements(null, b), 'and null is handled without throwing');
});

test('renderMask prints the board the fixture was written as', () => {
  eq(renderMask(HOOK_LP), HOOK_SHAPE_ROWS.join('\n'), 'the hook, row by row');
  eq(renderMask(X_PLUS), '.#.\n###\n.#.', 'the plus');
  eq(renderMask(PLUS_ONLY).split('\n').length, 4, 'the frame height, blank rows included');
});

test('a non-square frame has exactly four symmetries and they form a group', () => {
  const syms = frameSymmetries(2, 3);
  eq(syms.map((s) => s.name), ['identity', 'mirror-x', 'mirror-y', 'turn-180'], 'the four of a rectangle');
  for (const s of syms) {
    eq(new Set(Array.from(s.map)).size, 6, `${s.name}: a bijection on the six cells`);
    const twice = syms[0].map.slice();
    for (let i = 0; i < 6; i++) twice[i] = s.map[s.map[i]];
    eq(Array.from(twice), Array.from(syms[0].map), `${s.name} applied twice is identity — every one is its own inverse`);
  }
  // mirror-x then mirror-y must be the half turn.
  const composed = new Int32Array(6);
  for (let i = 0; i < 6; i++) composed[i] = syms[2].map[syms[1].map[i]];
  eq(Array.from(composed), Array.from(syms[3].map), 'mirror in x, then in y, is a 180 turn');
});

test('the 2x3 orbit arithmetic, worked out on paper', () => {
  const syms = frameSymmetries(2, 3);
  // A solution is a list of {piece, cells}, exactly the shape js/core/dlx.js:collectSolutions
  // returns. These four one-piece solutions are the images of {(0,0),(1,0),(0,1)} = {0,1,2}.
  const solution = (piece, cells) => [{ piece, cells }];
  const orbit = [
    solution(0, [0, 1, 2]),
    solution(0, [0, 1, 3]),
    solution(0, [2, 4, 5]),
    solution(0, [3, 4, 5]),
  ];
  orbit.forEach((sol, i) => {
    const keys = syms.map((s) => solutionKey(applySymmetry(s, sol)));
    eq(new Set(keys).size, 4, `member ${i}: no symmetry of a 2x3 frame fixes it`);
    eq(canonicalSolutionKey(syms, sol), '0:0.1.2', `member ${i}: every image lands on the same representative`);
  });
  eq(countOrbits(syms, orbit), { raw: 4, orbits: 1 }, 'four raw covers, one orbit');
  // Top row plus bottom row is invariant under all four, so it is its own orbit of size one.
  const invariant = solution(1, [0, 1, 4, 5]);
  eq(solutionKey(applySymmetry(syms[1], invariant)), '1:0.1.4.5', 'mirror-x leaves it where it is');
  eq(solutionKey(applySymmetry(syms[3], invariant)), '1:0.1.4.5', 'and so does the half turn');
  eq(countOrbits(syms, orbit.concat([invariant])), { raw: 5, orbits: 2 },
    'the invariant pattern adds one orbit, not four');
});

test('orbits of the published kind: raw must be four times orbits', () => {
  const syms = frameSymmetries(3, 20);
  eq(syms.length, 4, 'a 3x20 frame is not square, so four symmetries');
  eq(new Set(syms.map((s) => Array.from(s.map).join(','))).size, 4, 'and all four maps are different');
  const fake = [];
  for (const cells of [[0, 1, 2], [0, 1, 3]]) {
    for (const s of syms) fake.push(applySymmetry(s, [{ piece: 0, cells }]));
  }
  eq(countOrbits(syms, fake), { raw: 8, orbits: 2 }, 'two hand orbits written out eight ways');
  eq(FIXTURES.HOOK_LP.solutions, 2, 'the fixture table is reachable from this suite too');
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

process.exitCode = run();
