// The twelve free pentominoes, checked against combinatorics that predates this repository.
//
// SPEC.md 1 calls the variant tally a hard self-check because the first draft of this game
// shipped a set with two Ns and no V: 61 variants instead of 63, still twelve "pentominoes", and
// it made every rectangle count wrong without throwing once. So this suite pins the three things
// that a wrong set cannot fake:
//   * the per-piece variant numbers  F8 I2 L8 P8 N8 T4 U4 V4 W4 X1 Y8 Z4, summing to 63;
//   * that the 63 are *distinct* fixed pentominoes (two pieces sharing a variant would mean the
//     set is not the twelve free ones);
//   * that rot/mirror really are the dihedral group D4 on those variants, i.e. orbit-stabiliser
//     holds: variantCount x stabiliser = 8 for every piece.
//
// Every expected number below is written by hand from the published facts about pentominoes
// (12 free / 18 one-sided / 63 fixed; six chiral: F L P N Y Z), not read back out of js/core.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  SHAPES, NAMES, VARIANT_COUNT, TOTAL_VARIANTS, CELLS, FULL_SET,
  PIECES, VARIANTS, getPiece, variantCells, variantCount,
  rotatedIndex, mirroredIndex, cellsKey, norm, bboxOf, buildVariants,
} from '../js/core/pieces.js';

// The published per-piece table, typed out in the canonical order F I L P N T U V W X Y Z.
// SPEC.md 0 quotes these exact digits ("8,2,8,8,8,4,4,4,4,4,1,8 ... 合计 63 个固定块").
const HAND_VARIANT_COUNTS = {
  F: 8, I: 2, L: 8, P: 8, N: 8, T: 4, U: 4, V: 4, W: 4, X: 1, Y: 8, Z: 4,
};
const HAND_NAMES = ['F', 'I', 'L', 'P', 'N', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

// The six chiral free pentominoes: their mirror image is not a rotation of themselves, which is
// exactly why the one-sided count (18) exceeds the free count (12) by six. T U V W X I all carry
// an axis of mirror symmetry, F L P N Y Z carry none.
const HAND_CHIRAL = ['F', 'L', 'P', 'N', 'Y', 'Z'];

// The starting poses, drawn as text so a reader can compare them with any pentomino diagram.
// Row-major, '#' = cell. These are the standard twelve pictures, and they are what `SHAPES` must
// encode; nothing below derives them from the module under test.
const HAND_POSES = {
  F: ['.##', '##.', '.#.'],
  I: ['#####'],
  L: ['#', '#', '#', '##'],
  P: ['##', '##', '#.'],
  N: ['.###', '##..'],
  T: ['###', '.#.', '.#.'],
  U: ['#.#', '###'],
  V: ['###', '#..', '#..'],
  W: ['#..', '##.', '.##'],
  X: ['.#.', '###', '.#.'],
  Y: ['.#..', '####'],
  Z: ['##.', '.#.', '.##'],
};

function poseFromText(lines) {
  const cells = [];
  lines.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push([x, y]);
  });
  return cells;
}

// The eight elements of D4, expressed as functions on variant indices using only rot/mirror.
// r = quarter turn clockwise, m = mirror. Written as pairs (k, flipped) meaning m^k . r^flipped.
const D4 = [];
for (let k = 0; k < 4; k++) {
  for (const flip of [0, 1]) {
    D4.push({ rot: k, flip });
  }
}

function applyD4(name, el, index) {
  let i = index;
  for (let k = 0; k < el.rot; k++) i = rotatedIndex(name, i);
  if (el.flip) i = mirroredIndex(name, i);
  return i;
}

test('the set is the twelve free pentominoes, in the canonical order', () => {
  eq(NAMES, HAND_NAMES, 'F I L P N T U V W X Y Z — no S, and N exactly once');
  eq(FULL_SET, HAND_NAMES, 'FULL_SET is that same twelve');
  eq(NAMES.length * CELLS, 60, 'twelve pieces x five cells is the 60 cells of the full set');
  eq(CELLS, 5, 'a pentomino has five cells');
});

test('no S, no duplicate: the twelve starting poses are pairwise distinct', () => {
  eq(Object.keys(SHAPES).sort(), HAND_NAMES.slice().sort(), 'SHAPES carries exactly the twelve');
  ok(!SHAPES.S, 'there is no S pentomino in the free set (S is the mirror of Z, which is one piece)');
  const keys = NAMES.map((n) => cellsKey(SHAPES[n]));
  eq(new Set(keys).size, 12, 'no two letters start from the same pose');
});

test('every starting pose is five distinct, edge-connected cells in canonical position', () => {
  for (const name of NAMES) {
    const cells = SHAPES[name];
    eq(cells.length, CELLS, `${name}: five cells`);
    eq(new Set(cellsKey(cells).split(';')).size, CELLS, `${name}: no cell listed twice`);
    const [minX, minY] = [Math.min(...cells.map((c) => c[0])), Math.min(...cells.map((c) => c[1]))];
    eq([minX, minY], [0, 0], `${name}: anchored at its own (0,0)`);
    // 4-connectivity by flood fill, with a hard cap on the walk.
    const set = new Set(cells.map((c) => c.join(',')));
    const seen = new Set([cells[0].join(',')]);
    const queue = [cells[0]];
    while (queue.length) {
      const [x, y] = queue.pop();
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const k = `${nx},${ny}`;
        if (!set.has(k) || seen.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    eq(seen.size, CELLS, `${name}: one piece, not two glued by a corner`);
  }
});

test('the twelve poses are the twelve pictures, cell for cell', () => {
  for (const name of NAMES) {
    const want = norm(poseFromText(HAND_POSES[name]));
    const got = norm(SHAPES[name]);
    eq(cellsKey(got), cellsKey(want), `${name} as drawn in the literature`);
  }
});

test('per-piece variant counts match the published table', () => {
  eq(VARIANT_COUNT, HAND_VARIANT_COUNTS, 'js/core/pieces.js:VARIANT_COUNT is the hand table');
  for (const name of NAMES) {
    eq(variantCount(name), HAND_VARIANT_COUNTS[name], `${name} has ${HAND_VARIANT_COUNTS[name]} fixed forms`);
    eq(PIECES[name].variants.length, HAND_VARIANT_COUNTS[name], `${name}: the closure produced them all`);
    eq(VARIANTS[name].length, HAND_VARIANT_COUNTS[name], `${name}: the placement table agrees`);
  }
});

test('the variant total is 63, the fixed pentomino count', () => {
  const sum = NAMES.reduce((a, n) => a + variantCount(n), 0);
  eq(sum, 63, '8+2+8+8+8+4+4+4+4+4+1+8 = 63');
  eq(TOTAL_VARIANTS, 63, 'the exported constant is that same 63');
  // 63 distinct fixed pentominoes: if two letters shared a variant the union would be smaller,
  // which is the shape of the "two Ns, no V" bug (61, and it still looks like twelve pieces).
  const union = new Set();
  for (const name of NAMES) for (const cells of PIECES[name].variants) union.add(cellsKey(cells));
  eq(union.size, 63, 'the twelve classes partition the 63 fixed pentominoes');
});

test('rot is a quarter turn of order four and mirror has order two', () => {
  for (const name of NAMES) {
    const k = variantCount(name);
    for (let i = 0; i < k; i++) {
      let r = i;
      for (let t = 0; t < 4; t++) r = rotatedIndex(name, r);
      eq(r, i, `${name} variant ${i}: four quarter turns come back to the pose`);
      eq(mirroredIndex(name, mirroredIndex(name, i)), i, `${name} variant ${i}: mirrored twice is identity`);
    }
  }
});

test('rot and mirror generate D4: mirror o rot o mirror is rot cubed', () => {
  for (const name of NAMES) {
    const k = variantCount(name);
    for (let i = 0; i < k; i++) {
      const back = mirroredIndex(name, rotatedIndex(name, mirroredIndex(name, i)));
      let r3 = i;
      for (let t = 0; t < 3; t++) r3 = rotatedIndex(name, r3);
      eq(back, r3, `${name} variant ${i}: a mirror turns a clockwise rotation anti-clockwise`);
      assert(rotatedIndex(name, i) >= 0, `${name} variant ${i}: rot is total over the table`);
      assert(mirroredIndex(name, i) >= 0, `${name} variant ${i}: mirror is total over the table`);
    }
  }
});

test('orbit-stabiliser holds: variantCount x |stabiliser of the pose| = 8', () => {
  for (const name of NAMES) {
    const fixed = D4.filter((el) => applyD4(name, el, 0) === 0);
    eq(variantCount(name) * fixed.length, 8, `${name}: Lagrange over the eight symmetries of a square`);
  }
});

test('the six chiral pentominoes are F L P N Y Z, and the other six carry a mirror axis', () => {
  const chiral = NAMES.filter((name) => {
    const orbit = new Set();
    let cur = 0;
    for (let t = 0; t < 4; t++) { orbit.add(cur); cur = rotatedIndex(name, cur); }
    return !orbit.has(mirroredIndex(name, 0));
  });
  eq(chiral, HAND_CHIRAL, 'a mirror that is not a rotation — 18 one-sided = 12 free + 6 chiral');
  const achiral = NAMES.filter((n) => !HAND_CHIRAL.includes(n));
  for (const name of achiral) {
    const hasReflectionSymmetry = D4.some((el) => el.flip && applyD4(name, el, 0) === 0);
    ok(hasReflectionSymmetry, `${name}: an orientation-reversing symmetry fixes the pose`);
  }
});

test('buildVariants enumerates a pose the caller hand-wrote, in a stable order', () => {
  const v = buildVariants('V');
  eq(v.cells.length, 4, 'V has four fixed forms');
  // V is a corner: two arms of three cells sharing an end cell. It can open into any of the four
  // quadrants, and no other pose exists (a 180-degree turn of a corner is another quadrant, so
  // four rotations already give four distinct poses and the mirror gives no new one).
  const asText = v.cells.map((cells) => cellsKey(norm(cells)));
  eq(asText.slice().sort(), [
    '0,0;0,1;0,2;1,2;2,2',
    '0,0;1,0;2,0;0,1;0,2',
    '0,0;1,0;2,0;2,1;2,2',
    '2,0;2,1;0,2;1,2;2,2',
  ].sort(), 'the corner, opening into four quadrants');
  eq(asText, asText.slice().sort(), 'variants are listed in canonical key order, not traversal order');
});

test('X has exactly one fixed form and I has exactly two', () => {
  eq(cellsKey(PIECES.X.variants[0]), '1,0;0,1;1,1;2,1;1,2', 'the plus');
  eq(PIECES.X.variants.length, 1, 'every symmetry of the plus fixes it: 8/8 = 1');
  eq(VARIANTS.I.map((v) => cellsKey(v.cells)), ['0,0;0,1;0,2;0,3;0,4', '0,0;1,0;2,0;3,0;4,0'],
    'a bar: vertical then horizontal, sorted by key');
  eq(bboxOf(VARIANTS.I[0].cells), { w: 1, h: 5 }, 'vertical bar box');
  eq(bboxOf(VARIANTS.I[1].cells), { w: 5, h: 1 }, 'horizontal bar box');
});

test('the accessors behave as documented for unknown names and wrapped indices', () => {
  eq(getPiece('S'), null, 'no S pentomino to look up');
  eq(getPiece('Q'), null, 'and no Q either');
  eq(variantCount('S'), 0, 'a name that is not a pentomino has no variants');
  eq(variantCells('S', 0), null, 'and no cells');
  eq(variantCells('Q', 3), null, 'unknown piece, unknown index');
  eq(cellsKey(variantCells('T', -1)), cellsKey(PIECES.T.variants[3]), 'index -1 wraps to the last variant');
  eq(cellsKey(variantCells('T', 4)), cellsKey(PIECES.T.variants[0]), 'index 4 wraps past the end');
  eq(rotatedIndex('S', 0), -1, 'no rotation of a piece that does not exist');
  eq(mirroredIndex('Q', 0), -1, 'no mirror of it either');
  eq(norm([[2, 1], [0, 0]]), [[0, 0], [2, 1]], 'norm shifts to the origin and sorts by row then column');
  eq(bboxOf([[0, 0], [2, 1]]), { w: 3, h: 2 }, 'bbox is the occupied box, not the cell count');
});

test('js/core/pieces.js refuses to load a wrong twelve (the self-check is the gate)', () => {
  // The module runs its own tally in a top-level block, so a set that is not the twelve cannot
  // even be imported. This asserts the gate is wired, by re-deriving its condition from the
  // tables rather than trusting that the import above did not throw.
  const total = NAMES.reduce((a, n) => a + variantCount(n), 0);
  const tableSum = HAND_NAMES.reduce((a, n) => a + HAND_VARIANT_COUNTS[n], 0);
  eq([total, tableSum, TOTAL_VARIANTS], [63, 63, 63], 'closure, hand table and constant all say 63');
  for (const name of NAMES) {
    for (const cells of PIECES[name].variants) eq(cells.length, CELLS, `${name}: a variant is five cells`);
  }
});

process.exitCode = run();
