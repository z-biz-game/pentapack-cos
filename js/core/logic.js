// The reasoning-only solver: what a player with a pencil can do, and nothing else.
//
// Two rules, applied to a fixpoint:
//   R1  a board cell for which only one placement remains   -> commit that placement
//   R2  a piece for which only one legal placement remains  -> commit it
// When neither rule fires and the board is not yet full, the solver has to *guess*: it takes
// the free cell with the fewest remaining candidates (ties broken by the lower cell index),
// assumes one candidate, and recurses one frame deeper. The number this file produces and
// the UI prints, `推理深度 k`, is the deepest assumption frame this program actually entered
// on the route that finished the puzzle — a measurement of an implementation on one level,
// not a heuristic star rating.
//
// HONESTY CLAUSE, and it matters: k belongs to the *rule pair above*, not to the puzzle in
// itself. Add a third rule ("if this piece went there, cell X would become impossible") and
// every k in the game drops. The rule set is fixed here, restated in DESIGN.md and quoted in
// README.md, and the baked levels must be re-generated whenever it changes.
//
// Same layering rule as the rest of js/core: pure functions, no DOM, no clock, no Math.random.
// Determinism is what makes the serialised re-verification in test/library.test.mjs possible.

import { compile } from './dlx.js';
import { maskCells } from './board.js';

const EMPTY = -1;

// The two rules, stated where the UI can quote them and a test can pin them.
export const RULES = [
  { key: 'cell-naked', text: '某一格只剩一个还能盖住它的块 —— 定' },
  { key: 'piece-naked', text: '某个块只剩一个还放得下的位置 —— 定' },
];

export const RULE_SET_VERSION = 1;

function makeState(problem) {
  const { w, h, mask, pieces } = problem.spec;
  return {
    n: pieces.length,
    rows: problem.rows,
    boardCells: maskCells(mask),
    placed: new Int32Array(w * h).fill(EMPTY), // row id covering that cell, or -1
    used: new Uint8Array(pieces.length),
    commits: [],
    filled: 0,
  };
}

function cloneState(s) {
  return {
    n: s.n,
    rows: s.rows,
    boardCells: s.boardCells,
    placed: Int32Array.from(s.placed),
    used: Uint8Array.from(s.used),
    commits: s.commits.slice(),
    filled: s.filled,
  };
}

function commitRow(s, rowId) {
  const row = s.rows[rowId];
  for (const c of row.cells) s.placed[c] = rowId;
  s.used[row.piece] = 1;
  s.filled += row.cells.length;
  s.commits.push(rowId);
}

function rowFits(s, row) {
  for (const c of row.cells) {
    if (s.placed[c] !== EMPTY) return false;
  }
  return true;
}

// Every still-legal row, grouped by the cell it would cover. A committed piece contributes
// nothing, so `byCell` shrinks as the board fills.
function candidates(s) {
  const byPiece = [];
  const byCell = new Map();
  for (let p = 0; p < s.n; p++) {
    byPiece.push(s.used[p] ? null : []);
  }
  for (let r = 0; r < s.rows.length; r++) {
    const row = s.rows[r];
    if (s.used[row.piece]) continue;
    if (!rowFits(s, row)) continue;
    byPiece[row.piece].push(r);
    for (const c of row.cells) {
      let list = byCell.get(c);
      if (!list) { list = []; byCell.set(c, list); }
      list.push(r);
    }
  }
  return { byPiece, byCell };
}

function done(s) {
  for (let p = 0; p < s.n; p++) if (!s.used[p]) return false;
  return true;
}

// R1/R2 to a fixpoint. Returns { ok, reason } where a failed reason is the contradiction
// that makes a guess falsifiable: a piece with nowhere to go, or a cell nobody can cover.
function propagate(s, stats) {
  for (;;) {
    stats.passes++;
    const { byPiece, byCell } = candidates(s);
    let changed = false;
    for (let p = 0; p < s.n; p++) {
      if (byPiece[p] === null) continue;
      if (byPiece[p].length === 0) return { ok: false, reason: 'piece' };
      if (byPiece[p].length === 1) {
        commitRow(s, byPiece[p][0]);
        stats.forced++;
        changed = true;
      }
    }
    if (changed) continue;
    for (const c of s.boardCells) {
      if (s.placed[c] !== EMPTY) continue;
      const list = byCell.get(c);
      if (!list || list.length === 0) return { ok: false, reason: 'cell' };
      if (list.length === 1) {
        commitRow(s, list[0]);
        stats.forced++;
        changed = true;
        break; // the board moved; recompute rather than reason from a stale candidate map
      }
    }
    if (!changed) return { ok: true, reason: null };
  }
}

// The cell a guess has to branch on: fewest candidates, then lowest index. Nothing here
// looks ahead more than one placement, which is the whole point of the measurement.
function guessTarget(s, cand) {
  let best = null;
  for (const c of s.boardCells) {
    if (s.placed[c] !== EMPTY) continue;
    const list = cand.byCell.get(c);
    if (!list || !list.length) continue;
    if (!best || list.length < best.list.length) best = { cell: c, list };
  }
  return best;
}

// logicSolve(specOrProblem, opts) -> {
//   solved, depth, guesses, contradictions, forced, passes, frames, placements, truncated
// }
//   depth          = deepest assumption frame on the successful route (the printed k)
//   guesses        = frames entered in total, so two levels with the same k can still be
//                    told apart by how much wasted reasoning they cost
//   contradictions = how many guesses were refuted before one survived
//   frames         = guesses that actually allocated a state, i.e. what `maxFrames` caps. The
//                    balance rig reports the largest value seen, which is the honest answer to
//                    "how many search states can one click cost?"
//   placements     = [{ piece, variant, x, y }] when solved, in commit order
export function logicSolve(target, opts = {}) {
  const problem = compile(target);
  const maxFrames = opts.maxFrames === undefined ? 20000 : opts.maxFrames;
  const stats = { forced: 0, passes: 0 };
  let frames = 0;
  let guesses = 0;
  let contradictions = 0;
  let truncated = false;

  function walk(state, depth, deepest) {
    const p = propagate(state, stats);
    if (!p.ok) {
      contradictions++;
      return null;
    }
    if (done(state)) return { depth: deepest, commits: state.commits.slice() };
    if (frames++ >= maxFrames) {
      truncated = true;
      return null;
    }
    const cand = candidates(state);
    const t = guessTarget(state, cand);
    if (!t) {
      // Cells still free but nothing can cover them: propagate would have caught a piece
      // with no options, so this is the "area left over, no row fits" case. No solution.
      return null;
    }
    guesses++;
    for (const rowId of t.list) {
      const next = cloneState(state);
      commitRow(next, rowId);
      const r = walk(next, depth + 1, Math.max(deepest, depth + 1));
      if (r) return r;
      if (truncated) return null;
    }
    return null;
  }

  const res = walk(makeState(problem), 0, 0);
  const placements = res
    ? res.commits.map((rowId) => {
      const row = problem.rows[rowId];
      return { piece: row.piece, variant: row.variant, x: row.x, y: row.y };
    })
    : null;
  return {
    solved: !!res,
    depth: res ? res.depth : -1,
    guesses,
    contradictions,
    forced: stats.forced,
    passes: stats.passes,
    frames,
    placements,
    truncated,
  };
}
