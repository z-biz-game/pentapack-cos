// The level model: a board (a subset of a w x h frame) plus a set of pieces, and the rules
// that say whether a level, a placement, or a serialised lot is well formed.
//
// Deliberately separate from dlx.js: this file knows what a board *is*, the counter knows
// how to enumerate covers. Both are pure — no DOM, no Date, no Math.random.

import { CELLS, getPiece } from './pieces.js';

export const MAX_FRAME = 20; // a frame edge longer than this is a typo, not a level

export function cellIndex(w, x, y) {
  return y * w + x;
}

export function cellX(w, i) {
  return i % w;
}

export function cellY(w, i) {
  return Math.floor(i / w);
}

// "111001..." -> Uint8Array. Kept as a string in js/data/lots.js so a baked level stays a
// readable, greppable line.
export function parseMask(str, w, h) {
  const want = w * h;
  if (typeof str !== 'string' || str.length !== want) {
    throw new Error(`mask length ${str == null ? String(str) : str.length} != ${want}`);
  }
  const mask = new Uint8Array(want);
  for (let i = 0; i < want; i++) {
    const ch = str[i];
    if (ch !== '0' && ch !== '1') throw new Error(`mask char ${i} is '${ch}'`);
    if (ch === '1') mask[i] = 1;
  }
  return mask;
}

export function maskString(mask) {
  let s = '';
  for (let i = 0; i < mask.length; i++) s += mask[i] ? '1' : '0';
  return s;
}

export function maskCells(mask) {
  const out = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return out;
}

export function maskCount(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i] ? 1 : 0;
  return n;
}

export function fullRect(w, h) {
  return new Uint8Array(w * h).fill(1);
}

// normaliseSpec(raw) -> { w, h, mask, pieces }
// Accepts the serialised shape (mask as a string) or the in-memory one (Uint8Array).
export function normaliseSpec(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('spec must be an object');
  const { w, h } = raw;
  if (!(w > 0) || !(h > 0)) throw new Error('spec needs positive w and h');
  const mask = raw.mask instanceof Uint8Array
    ? Uint8Array.from(raw.mask)
    : parseMask(raw.mask, w, h);
  const pieces = Array.isArray(raw.pieces) ? raw.pieces.slice() : String(raw.pieces || '').split('');
  return { w, h, mask, pieces };
}

// validateLevel(raw) -> null | error string. Every failure mode a hand-edited data file or
// a buggy generator could produce, each one exercised by a negative test.
export function validateLevel(raw) {
  if (!raw || typeof raw !== 'object') return 'spec is not an object';
  const { w, h } = raw;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return 'w and h must be positive integers';
  if (w > MAX_FRAME || h > MAX_FRAME) return `frame ${w}x${h} exceeds the ${MAX_FRAME} limit`;
  let mask;
  try {
    mask = raw.mask instanceof Uint8Array ? raw.mask : parseMask(raw.mask, w, h);
  } catch (err) {
    return String(err.message || err);
  }
  if (mask.length !== w * h) return `mask has ${mask.length} cells for a ${w}x${h} frame`;
  const pieces = Array.isArray(raw.pieces) ? raw.pieces : String(raw.pieces || '').split('');
  if (!pieces.length) return 'no pieces';
  for (const p of pieces) {
    if (!getPiece(p)) return `unknown piece '${p}'`;
  }
  const seen = new Set();
  for (const p of pieces) {
    if (seen.has(p)) return `piece '${p}' appears twice — the twelve pentominoes are distinct`;
    seen.add(p);
  }
  const area = maskCount(mask);
  if (area % CELLS !== 0) return `area ${area} is not a multiple of ${CELLS}`;
  if (area / CELLS !== pieces.length) return `area ${area} needs ${area / CELLS} pieces, got ${pieces.length}`;
  return null;
}

// Cells covered by `cells` (a variant pose) with its anchor at (ax, ay).
// Returns { ok, cells, code } where code names the first failure: 'out' or 'off-board'.
export function placementMask(spec, cells, ax, ay) {
  const { w, h, mask } = spec;
  const out = [];
  for (const [dx, dy] of cells) {
    const x = ax + dx;
    const y = ay + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) return { ok: false, code: 'out', cells: out };
    const i = cellIndex(w, x, y);
    if (!mask[i]) return { ok: false, code: 'off', cells: out };
    out.push(i);
  }
  out.sort((a, b) => a - b);
  return { ok: true, code: null, cells: out };
}

// Does a whole placement list tile the board exactly, each piece once? Returns
// { ok, code, cell, piece } with code naming the first violation:
//   'duplicate' | 'unknown-piece' | 'out' | 'off' | 'overlap' | 'gap' | 'count'
export function validatePlacements(raw, placements) {
  const spec = normaliseSpec(raw);
  const err = validateLevel(spec);
  if (err) return { ok: false, code: 'level', reason: err };
  const used = new Set();
  const covered = new Uint8Array(spec.w * spec.h);
  for (const pl of placements) {
    const name = spec.pieces[pl.piece];
    if (!name) return { ok: false, code: 'unknown-piece', piece: pl.piece };
    if (used.has(pl.piece)) return { ok: false, code: 'duplicate', piece: pl.piece };
    used.add(pl.piece);
    const piece = getPiece(name);
    const variant = piece.variants[pl.variant];
    if (!variant) return { ok: false, code: 'bad-variant', piece: pl.piece };
    const m = placementMask(spec, variant, pl.x, pl.y);
    if (!m.ok) return { ok: false, code: m.code, cell: m.cells[m.cells.length - 1], piece: pl.piece };
    for (const i of m.cells) {
      if (covered[i]) return { ok: false, code: 'overlap', cell: i, piece: pl.piece };
      covered[i] = 1;
    }
  }
  if (placements.length !== spec.pieces.length) {
    return { ok: false, code: 'count', piece: null, cell: null };
  }
  for (let i = 0; i < covered.length; i++) {
    if (spec.mask[i] && !covered[i]) return { ok: false, code: 'gap', cell: i };
  }
  return { ok: true, code: null };
}

// Two placement lists describe the same arrangement if every piece sits in the same
// variant at the same anchor, regardless of the order they were written in.
export function samePlacements(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const key = (list) => list
    .map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`)
    .sort()
    .join('|');
  return key(a) === key(b);
}

// The board as rows of text — used by the balance rig and by test failures, never by the UI.
// (The twelve names live in js/core/pieces.js:NAMES. There used to be a `PIECE_NAMES` alias here
// too, and it went: two exported names for one fact is one too many to keep in step.)
export function renderMask(spec) {
  const lines = [];
  for (let y = 0; y < spec.h; y++) {
    let s = '';
    for (let x = 0; x < spec.w; x++) s += spec.mask[cellIndex(spec.w, x, y)] ? '#' : '.';
    lines.push(s);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Board symmetries — needed to reconcile with the published rectangle counts.
//
// The figures quoted in the literature for "all twelve pentominoes in a rectangle"
// (3x20 = 2, 4x15 = 368, 5x12 = 1010, 6x10 = 2339) are counts of solutions **up to the
// four symmetries of a non-square rectangle**: identity, mirror in x, mirror in y, turn by
// 180. A 6x10 rectangle has an odd published count, which is itself proof that it cannot be
// a raw count (the raw count of any rectangle is a multiple of four), so the reconciliation
// has to quotient. js/core/dlx.js enumerates the *fixed* board; the functions below turn a
// raw solution list into orbit representatives so the test can assert the published number
// exactly — and, as a side effect, prove that no solution of these four boards is invariant
// under a non-trivial symmetry (if one were, orbits would be strictly less than raw/4).
// ---------------------------------------------------------------------------

export function frameSymmetries(w, h) {
  const at = (x, y) => y * w + x;
  const build = (name, f) => {
    const map = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [nx, ny] = f(x, y);
        map[at(x, y)] = at(nx, ny);
      }
    }
    return { name, map };
  };
  return [
    build('identity', (x, y) => [x, y]),
    build('mirror-x', (x, y) => [w - 1 - x, y]),
    build('mirror-y', (x, y) => [x, h - 1 - y]),
    build('turn-180', (x, y) => [w - 1 - x, h - 1 - y]),
  ];
}

// A solution here is [{ piece, cells }]; cells are board indices.
export function applySymmetry(sym, solution) {
  return solution
    .map((p) => ({ piece: p.piece, cells: p.cells.map((i) => sym.map[i]).sort((a, b) => a - b) }))
    .sort((a, b) => a.piece - b.piece);
}

export function solutionKey(solution) {
  return solution.map((p) => `${p.piece}:${p.cells.join('.')}`).join('|');
}

// The orbit representative: the lexicographically smallest key over the board's symmetries.
export function canonicalSolutionKey(syms, solution) {
  let best = null;
  for (const s of syms) {
    const k = solutionKey(applySymmetry(s, solution));
    if (best === null || k < best) best = k;
  }
  return best;
}

export function countOrbits(syms, solutions) {
  const seen = new Set();
  for (const s of solutions) seen.add(canonicalSolutionKey(syms, s));
  return { raw: solutions.length, orbits: seen.size };
}
