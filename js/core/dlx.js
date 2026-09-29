// Exact-cover packing: Algorithm X with Knuth's dancing links.
//
// The model is a binary matrix:
//   columns = one per board cell + one per piece in the level
//   rows    = one per legal (piece, variant, anchor) placement, covering the piece's own
//             column plus the five cell columns it occupies
// A solution is a set of rows covering every column exactly once, i.e. every cell filled
// and every piece used once. That is the *only* difficulty oracle in this game: it is an
// exact counter, so "解数 = 1" is a proof rather than an opinion.
//
// Why it can be trusted: the count for "all 12 pentominoes in a rectangle" is published
// combinatorial data (3x20 = 2, 4x15 = 368, 5x12 = 1010, 6x10 = 2339), and test/anchor.test.mjs
// reconciles this file against those numbers. A wrong piece set or a broken cover/uncover
// pair fails there, not silently in the generator.

import { VARIANTS } from './pieces.js';
import { normaliseSpec, placementMask } from './board.js';

// The cell width of a placement is a fact owned by js/core/pieces.js (CELLS = 5), and this file
// reaches it through the rows it builds. It used to re-export its own CELLS_PER_PIECE = 5, which
// is how a constant goes stale: two names for one number, free to disagree.

// Placement identity: piece index (into problem.spec.pieces) + variant + anchor cell.
// `cells` are board cell indices in ascending order.
function enumeratePlacements(spec) {
  const { w, h, mask, pieces } = spec;
  const rows = [];
  for (let p = 0; p < pieces.length; p++) {
    const variants = VARIANTS[pieces[p]];
    for (let v = 0; v < variants.length; v++) {
      const vb = variants[v].bbox;
      for (let y = 0; y + vb.h <= h; y++) {
        for (let x = 0; x + vb.w <= w; x++) {
          const m = placementMask(spec, variants[v].cells, x, y);
          if (!m.ok) continue;
          rows.push({ piece: p, variant: v, x, y, cells: m.cells });
        }
      }
    }
  }
  return rows;
}

// packProblem(spec) -> problem. `spec` is { w, h, mask, pieces } (mask = Uint8Array of
// w*h). The returned object owns the compiled matrix; the spec is never written to.
export function packProblem(spec) {
  const rows = enumeratePlacements(spec);
  const cellCol = new Int32Array(spec.w * spec.h).fill(-1);
  let c = 0;
  for (let i = 0; i < cellCol.length; i++) if (spec.mask[i]) cellCol[i] = c++;
  const pieceCol = spec.pieces.map((_, p) => c + p);
  const numCols = c + spec.pieces.length;
  const lists = rows.map((r) => {
    const cols = r.cells.map((i) => cellCol[i]);
    cols.push(pieceCol[r.piece]);
    return cols;
  });
  const problem = {
    spec,
    rows,
    numCols,
    numCells: c,
    lists,
    matrix: buildMatrix(numCols, lists),
  };
  return problem;
}

// The matrix is stored as Knuth's dancing links, with one subtlety that is easy to get
// wrong and catastrophic when you do: node 0 is a **root sentinel that is never covered**.
// Column c's header is node c+1. If the root were also a column header, covering that
// column would splice the root out of the header ring, `R[0] === 0` would never become
// true again and the "choose a column" loop would spin forever — a hang that looks exactly
// like "the counter is slow". test/dlx.test.mjs pins this down.
function buildMatrix(numCols, rowLists) {
  const headers = numCols + 1;
  let total = headers;
  for (const l of rowLists) total += l.length;
  const L = new Int32Array(total);
  const R = new Int32Array(total);
  const U = new Int32Array(total);
  const D = new Int32Array(total);
  const C = new Int32Array(total);
  const ROW = new Int32Array(total);
  const size = new Int32Array(headers);
  for (let i = 0; i < headers; i++) {
    L[i] = i === 0 ? headers - 1 : i - 1;
    R[i] = (i + 1) % headers;
    U[i] = D[i] = i;
  }
  let node = headers;
  for (let r = 0; r < rowLists.length; r++) {
    const cols = rowLists[r];
    if (!cols.length) continue;
    const first = node;
    let prev = -1;
    for (const c of cols) {
      const h = c + 1;
      const id = node++;
      C[id] = h; ROW[id] = r;
      D[id] = h; U[id] = U[h]; D[U[h]] = id; U[h] = id;
      size[h]++;
      if (prev >= 0) { L[id] = prev; R[prev] = id; }
      prev = id;
    }
    L[first] = prev; R[prev] = first;
  }
  return { L, R, U, D, C, ROW, size, headers, used: node, numCols };
}

// A cheap fingerprint of the live matrix. cover/uncover are exact inverses, so a full or
// partial search must leave the matrix byte-identical: test/dlx.test.mjs asserts this, which
// is what makes "dancing links restored correctly" a checked fact instead of a hope.
export function matrixDigest(problem) {
  const m = problem.matrix;
  let h1 = 0x811c9dc5;
  const mix = (v) => {
    h1 ^= v & 0xff; h1 = Math.imul(h1, 0x01000193);
    h1 ^= (v >>> 8) & 0xff; h1 = Math.imul(h1, 0x01000193);
    h1 ^= (v >>> 16) & 0xff; h1 = Math.imul(h1, 0x01000193);
    h1 ^= (v >>> 24) & 0xff; h1 = Math.imul(h1, 0x01000193);
  };
  for (let i = 0; i < m.used; i++) { mix(m.L[i]); mix(m.R[i]); mix(m.U[i]); mix(m.D[i]); }
  for (let i = 0; i < m.headers; i++) mix(m.size[i]);
  return h1 >>> 0;
}

export function isMatrixClean(problem, digest) {
  return matrixDigest(problem) === digest;
}

// searchCount(problem, opts) -> { count, nodes, truncated, capped, solution }
//   opts: { limit = Infinity, wantFirst = false, maxNodes = 20_000_000 }
//   nodes  = column selections made, i.e. how much of the tree was actually walked.
//   limit  = stop counting here. With limit = 2 a 2339-solution board is rejected as
//            "not unique" after the second solution, without enumerating the other 2337.
//   maxNodes = the hang guard: a runaway is reported as `capped`, never as a wrong number.
export function searchCount(target, opts = {}) {
  const problem = compile(target);
  const limit = opts.limit === undefined ? Infinity : opts.limit;
  const wantFirst = !!opts.wantFirst;
  const maxNodes = opts.maxNodes === undefined ? 20000000 : opts.maxNodes;
  const m = problem.matrix;
  const { L, R, U, D, C, ROW, size } = m;
  let nodes = 0;
  let count = 0;
  const stack = new Int32Array(m.numCols + 1);
  const best = [];
  let stop = false;
  let capped = false;

  function cover(c) {
    R[L[c]] = R[c]; L[R[c]] = L[c];
    for (let i = D[c]; i !== c; i = D[i]) {
      for (let x = R[i]; x !== i; x = R[x]) {
        D[U[x]] = D[x]; U[D[x]] = U[x];
        size[C[x]]--;
      }
    }
  }

  function uncover(c) {
    for (let i = U[c]; i !== c; i = U[i]) {
      for (let x = L[i]; x !== i; x = L[x]) {
        size[C[x]]++;
        D[U[x]] = x; U[D[x]] = x;
      }
    }
    R[L[c]] = c; L[R[c]] = c;
  }

  function search(depth) {
    if (stop) return;
    if (R[0] === 0) {
      count++;
      if (wantFirst && best.length === 0) {
        for (let i = 0; i < depth; i++) best.push(ROW[stack[i]]);
      }
      if (count >= limit) stop = true;
      return;
    }
    nodes++;
    if (nodes > maxNodes) {
      capped = true;
      stop = true;
      return;
    }
    let c = -1;
    let bestSize = Infinity;
    for (let j = R[0]; j !== 0; j = R[j]) {
      if (size[j] < bestSize) { bestSize = size[j]; c = j; if (bestSize === 1) break; }
    }
    if (c < 0 || bestSize === 0) return;
    cover(c);
    for (let r = D[c]; r !== c; r = D[r]) {
      stack[depth] = r;
      for (let j = R[r]; j !== r; j = R[j]) cover(C[j]);
      search(depth + 1);
      for (let j = L[r]; j !== r; j = L[j]) uncover(C[j]);
      if (stop) break;
    }
    uncover(c);
  }

  search(0);
  return {
    count,
    nodes,
    capped,
    truncated: !capped && limit !== Infinity && count >= limit,
    solution: wantFirst ? best.slice().sort((a, b) => a - b) : null,
  };
}

// countSolutions(specOrProblem, limit) -> number of exact covers, at most `limit`.
// Accepts a raw spec ({w,h,mask,pieces}) or a pre-packed problem.
export function countSolutions(target, limit = Infinity) {
  return searchCount(target, { limit }).count;
}

// Does the level have exactly one solution, and what is it? Returns
// { count, placements, nodes, truncated, capped } with `placements` non-null only when
// count === 1. Pass limit = 2 to answer "unique?" without enumerating everything.
// `maxNodes` forwards to searchCount: without it a caller cannot ask for the hang guard at all,
// and the `capped` branch would be a claim no test could ever reach.
export function solveLevel(target, limit = Infinity, maxNodes) {
  const problem = compile(target);
  const r = searchCount(problem, maxNodes === undefined
    ? { limit, wantFirst: true }
    : { limit, wantFirst: true, maxNodes });
  if (r.count !== 1 || !r.solution || r.solution.length !== problem.spec.pieces.length) {
    return {
      count: r.count, nodes: r.nodes, truncated: r.truncated, capped: r.capped,
      placements: null, problem,
    };
  }
  const placements = r.solution.map((rowId) => {
    const row = problem.rows[rowId];
    return { piece: row.piece, variant: row.variant, x: row.x, y: row.y };
  });
  return {
    count: r.count, nodes: r.nodes, truncated: r.truncated, capped: r.capped,
    placements, problem,
  };
}

export function compile(target) {
  if (target && target.matrix && target.spec) return target;
  return packProblem(normaliseSpec(target));
}

// collectSolutions(target, { max }) -> { solutions, truncated, nodes, count }
//   Every exact cover, as { cells: [board cell indices] } per piece placement. Used by the
//   anchor test to enumerate the rectangle boards and then quotient by the board's own
//   symmetries, which is how the published combinatorial figures are counted.
//   `max` is a hard cap so an accidental big board cannot eat the CI runner.
export function collectSolutions(target, opts = {}) {
  const problem = compile(target);
  const max = opts.max === undefined ? 20000 : opts.max;
  const maxNodes = opts.maxNodes === undefined ? 40000000 : opts.maxNodes;
  const m = problem.matrix;
  const { L, R, U, D, C, ROW, size } = m;
  const out = [];
  let nodes = 0;
  let count = 0;
  let truncated = false;
  const stack = [];

  function cover(c) {
    R[L[c]] = R[c]; L[R[c]] = L[c];
    for (let i = D[c]; i !== c; i = D[i]) {
      for (let x = R[i]; x !== i; x = R[x]) {
        D[U[x]] = D[x]; U[D[x]] = U[x];
        size[C[x]]--;
      }
    }
  }

  function uncover(c) {
    for (let i = U[c]; i !== c; i = U[i]) {
      for (let x = L[i]; x !== i; x = L[x]) {
        size[C[x]]++;
        D[U[x]] = x; U[D[x]] = x;
      }
    }
    R[L[c]] = c; L[R[c]] = c;
  }

  function search() {
    if (out.length >= max) { truncated = true; return; }
    if (R[0] === 0) {
      count++;
      out.push(stack.map((rowId) => problem.rows[rowId]).map((row) => ({ piece: row.piece, cells: row.cells })));
      return;
    }
    nodes++;
    if (nodes > maxNodes) { truncated = true; return; }
    let c = -1;
    let bestSize = Infinity;
    for (let j = R[0]; j !== 0; j = R[j]) {
      if (size[j] < bestSize) { bestSize = size[j]; c = j; if (bestSize === 1) break; }
    }
    if (c < 0 || bestSize === 0) return;
    cover(c);
    for (let r = D[c]; r !== c; r = D[r]) {
      stack.push(ROW[r]);
      for (let j = R[r]; j !== r; j = R[j]) cover(C[j]);
      search();
      for (let j = L[r]; j !== r; j = L[j]) uncover(C[j]);
      stack.pop();
      if (truncated) break;
    }
    uncover(c);
  }

  search();
  return { solutions: out, count, nodes, truncated };
}
