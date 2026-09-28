// The twelve free pentominoes and their variant groups.
//
// HARD SELF-CHECK, and the reason this file exists on its own: the twelve free five-ominoes
// are F I L P N T U V W X Y Z — there is no S, and N appears exactly once. Their numbers of
// fixed variants (rotations + reflections, deduplicated per piece) are
//
//   F8 I2 L8 P8 N8 T4 U4 V4 W4 X1 Y8 Z4   ->  63 fixed pentominoes
//
// A draft of this game used a set with two Ns and no V, which totals 61 variants and made
// every rectangle count wrong while still looking plausible (3x20 -> 0, 4x15 -> 2712). The
// 63 total is therefore asserted in test/pieces.test.mjs *before* anything else is trusted,
// and reconciled again against the published rectangle counts in test/anchor.test.mjs.
//
// No DOM, no randomness, no I/O: everything below is a pure function of the shape tables.

// Cell lists in a piece's own local frame, (0,0) at the top-left of the bounding box.
// They are only a *starting pose*: variants are derived, not hand-typed, so a typo in one
// pose cannot silently create or destroy a variant.
export const SHAPES = {
  F: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  I: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  L: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
  P: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
  N: [[1, 0], [2, 0], [3, 0], [0, 1], [1, 1]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],
  U: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  V: [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]],
  W: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
  X: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  Y: [[1, 0], [0, 1], [1, 1], [2, 1], [3, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
};

export const NAMES = ['F', 'I', 'L', 'P', 'N', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

// The authoritative per-piece variant table (also see the header comment: X is 1 and Z is 4;
// a set with Z=8 would total 67 and cannot tile any of the published rectangles).
export const VARIANT_COUNT = {
  F: 8, I: 2, L: 8, P: 8, N: 8, T: 4, U: 4, V: 4, W: 4, X: 1, Y: 8, Z: 4,
};

export const TOTAL_VARIANTS = 63;

export const CELLS = 5;

// All twelve, in the canonical order. A level's piece list is a subset of this with no
// repeats: the pieces are physically distinct, so an F is distinguishable from a P at a
// glance and no level ever needs two of the same letter.
export const FULL_SET = NAMES.slice();

export function cellsKey(cells) {
  return cells.map(([x, y]) => `${x},${y}`).join(';');
}

// Canonical pose: sorted by row then column, shifted so the top-left occupied cell is (0,0).
export function norm(cells) {
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const mx = Math.min(...xs);
  const my = Math.min(...ys);
  const shifted = cells.map(([x, y]) => [x - mx, y - my]);
  shifted.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
  return shifted;
}

export function bboxOf(cells) {
  let w = 0;
  let h = 0;
  for (const [x, y] of cells) {
    if (x + 1 > w) w = x + 1;
    if (y + 1 > h) h = y + 1;
  }
  return { w, h };
}

// Rotation by 90 degrees clockwise inside the piece's bounding box, then re-canonicalised.
// `norm` re-anchors the pose, so the box size used here only has to be consistent.
function rotateCW(cells) {
  const { h } = bboxOf(cells);
  return norm(cells.map(([x, y]) => [h - 1 - y, x]));
}

function reflect(cells) {
  const { w } = bboxOf(cells);
  return norm(cells.map(([x, y]) => [w - 1 - x, y]));
}

// buildVariants(name) -> { cells, rot, mirror, byKey }
//   cells[i]  = the i-th distinct fixed variant, ordered by canonical key so the numbering
//               never depends on how the traversal happened to run
//   rot[i]    = the variant index after one clockwise quarter turn
//   mirror[i] = the variant index after one reflection
//
// The set is closed by construction: the loop below keeps applying rotate/reflect until no
// new pose appears, so `rot` and `mirror` are total over the variant list. That the closure
// has exactly VARIANT_COUNT[name] elements (and 63 over the whole set) is asserted in
// test/pieces.test.mjs, not assumed.
export function buildVariants(name) {
  const start = norm(SHAPES[name]);
  const collected = [];
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const pose = queue.pop();
    const k = cellsKey(pose);
    if (seen.has(k)) continue;
    if (collected.length > 16) throw new Error(`${name}: variant closure did not terminate`);
    seen.add(k);
    collected.push(pose);
    queue.push(rotateCW(pose), reflect(pose));
  }
  collected.sort((a, b) => (cellsKey(a) < cellsKey(b) ? -1 : 1));
  const byKey = new Map();
  collected.forEach((c, i) => byKey.set(cellsKey(c), i));
  const rot = Int32Array.from(collected.map((c) => byKey.get(cellsKey(rotateCW(c)))));
  const mirror = Int32Array.from(collected.map((c) => byKey.get(cellsKey(reflect(c)))));
  return { cells: collected, rot, mirror, byKey };
}

export const PIECES = {};
export const VARIANTS = {};
for (const name of NAMES) {
  const v = buildVariants(name);
  PIECES[name] = { name, shape: norm(SHAPES[name]), variants: v.cells, rot: v.rot, mirror: v.mirror, byKey: v.byKey };
  VARIANTS[name] = v.cells.map((cells, index) => ({ index, cells, bbox: bboxOf(cells) }));
}

// The gate, not the footnote. SPEC.md 1 calls the variant tally a "硬性自检断言" because a set
// with two Ns and no V totals 61, still looks like a pentomino set, and turns every rectangle
// count into garbage (3x20 -> 0, 4x15 -> 2712) without throwing once. An assertion that only
// lives in a test file is a statement about the test run; this one runs when the *page* imports
// the module, so a shipped bundle cannot contain a wrong set at all. test/pieces.test.mjs
// re-reads the same tables and pins the per-piece numbers, and the four published rectangle
// counts in test/anchor.test.mjs are the external proof that this particular 63 is the right one.
{
  let total = 0;
  const wrong = [];
  for (const name of NAMES) {
    const got = variantCount(name);
    total += got;
    if (got !== VARIANT_COUNT[name]) wrong.push(`${name}: closure gave ${got}, table says ${VARIANT_COUNT[name]}`);
    for (const cells of PIECES[name].variants) {
      if (cells.length !== CELLS) wrong.push(`${name}: a variant has ${cells.length} cells, not ${CELLS}`);
    }
  }
  if (NAMES.length * CELLS !== 60) wrong.push(`${NAMES.length} pieces x ${CELLS} cells is not the 60 cells the twelve pentominoes have`);
  if (total !== TOTAL_VARIANTS) wrong.push(`variant total is ${total}, not ${TOTAL_VARIANTS}`);
  if (wrong.length) throw new Error(`js/core/pieces.js: the twelve-pentomino self-check failed — ${wrong.join('; ')}`);
}

export function getPiece(name) {
  return PIECES[name] || null;
}

export function variantCells(name, variant) {
  const p = PIECES[name];
  if (!p) return null;
  const v = ((variant % p.variants.length) + p.variants.length) % p.variants.length;
  return p.variants[v];
}

export function variantCount(name) {
  const p = PIECES[name];
  return p ? p.variants.length : 0;
}

// Which variant index results from a clockwise quarter turn.
export function rotatedIndex(name, variant) {
  const p = PIECES[name];
  if (!p) return -1;
  return p.rot[((variant % p.variants.length) + p.variants.length) % p.variants.length];
}

// Which variant index results from a mirror flip. For the achiral variants this is the same
// index — the UI must still report "flipped" honestly, so callers compare indices.
export function mirroredIndex(name, variant) {
  const p = PIECES[name];
  if (!p) return -1;
  return p.mirror[((variant % p.variants.length) + p.variants.length) % p.variants.length];
}
