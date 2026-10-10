// A game in progress: pure state plus the rules that touch it. No DOM anywhere in here,
// which is what lets test/game.test.mjs and tools/playtest.mjs drive the same object the
// screen does.
//
// The move economy, because it defines the number the panel prints:
//   * dropping a piece onto the board  = 1 operation
//   * taking a piece back to the tray  = 1 operation
//   * dragging a placed piece elsewhere = 1 operation (it is one decision, not two)
//   * rotating or mirroring            = 0 operations (spec: 旋转/翻转不算一步)
//   * a drop that overlaps or hangs off the board = 0 operations, the piece bounces back
// So the minimum for a k-piece level is exactly k, and `grade` measures the waste above it.
// The *difficulty* of a level is never this counter — that is 解数 and 推理深度, which come
// from dlx.js and logic.js.

import { getPiece, rotatedIndex, mirroredIndex } from './pieces.js';
import { normaliseSpec, placementMask, samePlacements, maskCells } from './board.js';

const EMPTY = -1;

export function createGame(lot) {
  const spec = normaliseSpec(lot.spec);
  const game = {
    id: lot.id,
    band: lot.band,
    depth: lot.depth,
    solutions: lot.solutions === undefined ? 1 : lot.solutions,
    solution: lot.solution.map((p) => ({ ...p })),
    spec,
    pieces: spec.pieces.slice(),
    n: spec.pieces.length,
    cells: new Int32Array(spec.w * spec.h).fill(EMPTY),
    at: spec.pieces.map((_, i) => ({ piece: i, onBoard: false, variant: 0, x: 0, y: 0 })),
    moves: 0,
    history: [],
    done: false,
    anomaly: null,
  };
  return game;
}

export function boardCellsOf(game) {
  return maskCells(game.spec.mask);
}

// Cells a piece would cover at (x, y) in a given variant, or the reason it cannot go there.
export function cellsFor(game, piece, variant, x, y) {
  const name = game.pieces[piece];
  const p = getPiece(name);
  if (!p) return { ok: false, code: 'unknown-piece', cells: [] };
  const v = ((variant % p.variants.length) + p.variants.length) % p.variants.length;
  return placementMask(game.spec, p.variants[v], x, y);
}

// Would this piece fit here, ignoring the cells it already occupies itself?
export function fits(game, piece, variant, x, y) {
  const m = cellsFor(game, piece, variant, x, y);
  if (!m.ok) return false;
  for (const c of m.cells) {
    if (game.cells[c] !== EMPTY && game.cells[c] !== piece) return false;
  }
  return true;
}

function erase(game, piece) {
  for (let i = 0; i < game.cells.length; i++) {
    if (game.cells[i] === piece) game.cells[i] = EMPTY;
  }
}

function paint(game, piece, cells) {
  for (const c of cells) game.cells[c] = piece;
}

function snapshot(game) {
  return {
    moves: game.moves,
    at: game.at.map((a) => ({ ...a })),
  };
}

function restore(game, snap) {
  game.moves = snap.moves;
  game.at = snap.at;
  game.cells.fill(EMPTY);
  for (const a of game.at) if (a.onBoard) paint(game, a.piece, cellsFor(game, a.piece, a.variant, a.x, a.y).cells);
}

// The three failure codes a drop can be refused for. They are named here so the view can
// flash one and the test can assert on it, instead of both guessing at a boolean. The codes
// are the ones js/core/board.js:placementMask reports, plus the overlap case.
export const BOUNCE = {
  out: '放下会超出边框',
  off: '放下会落在匣子外',
  overlap: '放下会压住别的块',
};

// Drop a piece onto the board. Returns { ok, moved, code }.
export function place(game, piece, variant, x, y) {
  if (game.done) return { ok: false, moved: false, code: 'done' };
  const before = snapshot(game);
  const a = game.at[piece];
  const m = cellsFor(game, piece, variant, x, y);
  if (!m.ok) return { ok: false, moved: false, code: m.code || 'outside' };
  for (const c of m.cells) {
    if (game.cells[c] !== EMPTY && game.cells[c] !== piece) return { ok: false, moved: false, code: 'overlap' };
  }
  const same = a.onBoard && a.variant === variant && a.x === x && a.y === y;
  if (same) return { ok: true, moved: false, code: 'noop' }; // press and release in place
  erase(game, piece);
  a.onBoard = true;
  a.variant = variant;
  a.x = x;
  a.y = y;
  paint(game, piece, m.cells);
  game.moves++;
  game.history.push(before);
  checkDone(game);
  return { ok: true, moved: true, code: null };
}

// Back to the tray. 1 operation.
export function takeBack(game, piece) {
  if (game.done) return { ok: false, moved: false, code: 'done' };
  const a = game.at[piece];
  if (!a.onBoard) return { ok: false, moved: false, code: 'not-placed' };
  game.history.push(snapshot(game));
  erase(game, piece);
  a.onBoard = false;
  game.moves++;
  game.done = false;
  return { ok: true, moved: true, code: null };
}

// Rotate / mirror. Never costs an operation. On the board the piece only moves if the new
// pose still fits where it stands (spec: 旋转后与他块冲突则不动); in the tray it always turns.
function transform(game, piece, nextVariant) {
  const a = game.at[piece];
  if (nextVariant < 0) return { ok: false, moved: false, code: 'unknown-piece' };
  if (a.variant === nextVariant) return { ok: true, moved: false, code: 'noop' };
  if (a.onBoard && !fits(game, piece, nextVariant, a.x, a.y)) {
    return { ok: false, moved: false, code: 'blocked' };
  }
  a.variant = nextVariant;
  if (a.onBoard) {
    erase(game, piece);
    paint(game, piece, cellsFor(game, piece, a.variant, a.x, a.y).cells);
  }
  return { ok: true, moved: true, code: null };
}

export function rotate(game, piece) {
  return transform(game, piece, rotatedIndex(game.pieces[piece], game.at[piece].variant));
}

export function flip(game, piece) {
  return transform(game, piece, mirroredIndex(game.pieces[piece], game.at[piece].variant));
}

export function pieceAt(game, x, y) {
  const { w } = game.spec;
  if (x < 0 || y < 0 || x >= w || y >= game.spec.h) return EMPTY;
  return game.cells[y * w + x];
}

export function trayOrder(game) {
  const out = [];
  for (let i = 0; i < game.n; i++) if (!game.at[i].onBoard) out.push(i);
  return out;
}

export function placedCount(game) {
  let n = 0;
  for (const a of game.at) if (a.onBoard) n++;
  return n;
}

export function playerPlacements(game) {
  return game.at.filter((a) => a.onBoard).map((a) => ({ piece: a.piece, variant: a.variant, x: a.x, y: a.y }));
}

// Every board cell still empty. `boardCellsOf` is the same list the view walks when it paints
// the 匣, and `trayOrder` is the same list the hint reads, so "which cells are in play" and
// "which pieces are still in the tray" each have exactly one spelling in this file.
export function isComplete(game) {
  if (trayOrder(game).length !== 0) return false;
  for (const i of boardCellsOf(game)) {
    if (game.cells[i] === EMPTY) return false;
  }
  return true;
}

// The front end never searches. Completion is checked against the baked solution, which is
// sound precisely because the bake proved 解数 = 1 for this level: if the player ever fills
// the board in a way that differs from the baked line, the proof was wrong, and that is
// reported as an anomaly instead of being papered over. See DESIGN.md 2.4 for why this is
// preferable to a live DLX run on tap.
function checkDone(game) {
  if (!isComplete(game)) return;
  const mine = playerPlacements(game);
  const agree = samePlacements(mine, game.solution);
  game.done = agree;
  game.anomaly = agree ? null : 'second-solution';
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  restore(game, last);
  game.done = false;
  game.anomaly = null;
  return true;
}

export function reset(game) {
  for (const a of game.at) {
    a.onBoard = false;
    a.variant = 0;
    a.x = 0;
    a.y = 0;
  }
  game.cells.fill(EMPTY);
  game.moves = 0;
  game.history = [];
  game.done = false;
  game.anomaly = null;
}

// Which piece should go where next, according to the baked solution: the hint is a lookup,
// not a search, so it is instant and it can never contradict the printed proof.
export function hintFor(game) {
  if (game.done) return null;
  const at = game.at;
  for (const s of game.solution) {
    const a = at[s.piece];
    if (!a.onBoard) return { piece: s.piece, target: { ...s }, why: 'in-tray' };
    if (a.variant !== s.variant || a.x !== s.x || a.y !== s.y) {
      return { piece: s.piece, target: { ...s }, why: 'misplaced' };
    }
  }
  return null;
}

// Operations used against the floor of k. Grades are defined here, not in the markup, so the
// tests can assert them.
export function grade(game) {
  const over = game.moves - game.n;
  if (over <= 0) return { key: 'perfect', label: '一次到位', stars: 3 };
  if (over <= 2) return { key: 'clean', label: '干净装箱', stars: 2 };
  return { key: 'loose', label: '反复挪动', stars: 1 };
}
