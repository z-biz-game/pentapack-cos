// Hand-written levels, used by more than one suite. These exist so the counter can be checked
// against numbers a human proved on paper: a fixture the same program generated would only ever
// prove the program agrees with itself.
//
// Every mask is a frame written as rows of '#' / '.', top row first, and the reasoning that fixes
// its solution count is spelled out beside it — with cell coordinates, so a reader can retrace it
// without running anything. test/anchor.test.mjs, test/dlx.test.mjs and test/board.test.mjs read
// these; nothing under js/ does.
//
// Coordinates in the proofs are (x, y) with x across and y down, matching js/core/board.js:cellIndex.

import { parseMask } from '../js/core/board.js';

function fromRows(rows, w) {
  const W = w || rows[0].length;
  return parseMask(rows.map((r) => r.replace(/#/g, '1').replace(/\./g, '0')).join(''), W, rows.length);
}

// ---------------------------------------------------------------------------
// The plus board: five cells, one piece.
//
//   (1,0)
//   (0,1) (1,1) (2,1)
//   (1,2)
//
// X is the only pentomino with a cell touching all four edge-neighbours of its centre, and this
// board has exactly one such cell: (1,1). So X's centre is forced and all four arms are then
// covered. 解数 = 1, proved by hand. Propagation finds it without guessing, so 推理深度 = 0 as
// well, and the frame is 3x3 so the w/h/mask arithmetic below has nowhere to hide a mistake.
export const X_PLUS = {
  why: 'X 在五格十字盘上：唯一的四邻格迫使 X 就位 —— 手算 1 解',
  w: 3,
  h: 3,
  mask: fromRows(['.#.', '###', '.#.']),
  pieces: ['X'],
  solutions: 1,
  depth: 0,
};

// ---------------------------------------------------------------------------
// The 10-cell hook, with pieces L and P.
//
//   (1,0) (2,0)
//   (1,1) (2,1) (3,1)
//   (1,2) (2,2) (3,2) (4,2)
//   (1,3)
//
// The board has exactly two straight runs of four cells: column 1, {(1,0),(1,1),(1,2),(1,3)}, and
// row 2, {(1,2),(2,2),(3,2),(4,2)}. (Row 1 and column 2 only reach three, and column 0 is empty.)
// L is a four-run with one extra cell at an end; P is a 2x2 block with one extra cell, so its
// longest run is three. Two cells have a single in-board neighbour: (1,3) [via (1,2)] and (4,2)
// [via (3,2)] — a piece covering either must also cover that neighbour. Now split by which piece
// owns (4,2):
//
//   The L covers (4,2). Its run must then be row 2 ((4,2) can only be a run end or the tail of a
//   run through (3,2), and the only such run is row 2), and its end-cell must be (1,1) or (1,3):
//     tail (1,3) -> the L is {(1,2),(2,2),(3,2),(4,2),(1,3)} and the P is the complement
//       {(1,0),(2,0),(1,1),(2,1),(3,1)}: a 2x2 block with the tail (3,1). COVER 2.
//     tail (1,1) -> the complement is {(1,0),(2,0),(2,1),(3,1),(1,3)} and (1,3) is cut off from
//       it, so the P would be disconnected. Rejected.
//   The P covers (4,2). Then (4,2) is the P's tail — no 2x2 block fits in row 2's right end — so
//   the block is {(2,1),(3,1),(2,2),(3,2)} and the L is the complement
//   {(1,0),(1,1),(1,2),(1,3),(2,0)}: column 1's run with the end-cell (2,0). COVER 1.
//   (The P's block cannot contain (4,2): that would need (5,2) or (4,1)/(4,3), all off board.)
//
// Exactly two covers, both listed above, and they are not mirror images of one another.
export const HOOK_LP = {
  why: '十格钩形：按"L 还是 P 盖住 (4,2)"分情形只剩两条路 —— 手算 2 解，两解不互为镜像',
  w: 8,
  h: 4,
  mask: fromRows([
    '.##.....',
    '.###....',
    '.####...',
    '.#......',
  ]),
  pieces: ['L', 'P'],
  solutions: 2,
};

// The hook's rows, exported because the product fixture below reuses this exact left half;
// keeping one source stops the two boards from drifting apart.
export const HOOK_SHAPE_ROWS = [
  '.##.....',
  '.###....',
  '.####...',
  '.#......',
];

// ---------------------------------------------------------------------------
// Two disjoint boards in one frame, separated by fully empty columns 5 and 6.
//
// Every pentomino is edge-connected, so a piece can never occupy cells on both sides of an
// entirely empty column. Both regions have area 10 and 5, and pieces carry 5 cells each, so the
// partition of the piece set is forced too: {L,P} into the hook, {X} into the plus. The count of
// the union is therefore the *product* of the counts of the parts, 2 x 1 = 2.
//
// That is a property of the counter worth pinning: if cover/uncover ever let a row cover the
// wrong columns, the product identity is the first thing to break.
export const HOOK_PLUS_UNION = {
  why: '空列隔开两块独立棋盘：合并解数 = 2 x 1 = 2；铲掉左半又回到 1',
  w: 10,
  h: 4,
  mask: fromRows([
    '.##.....#.',
    '.###...###',
    '.####...#.',
    '.#........',
  ]),
  pieces: ['L', 'P', 'X'],
  solutions: 2,
};

// The same frame with the left half removed: still a legal level (15 - 10 = 5 cells, one piece),
// still unique. The pair (this, the union above) is the whole uniqueness refutation in two lines:
// same counter, same code path, one extra chunk of board and one extra piece, and the verdict
// moves from 1 to 2 — which is what "the generator's 解数 = 1 filter can actually fail" means.
export const PLUS_ONLY = {
  why: '同一帧里只留右半：又回到 1 解',
  w: 10,
  h: 4,
  mask: fromRows([
    '........#.',
    '.......###',
    '........#.',
    '..........',
  ]),
  pieces: ['X'],
  solutions: 1,
};

// ---------------------------------------------------------------------------
// A 12-cell board with two pieces: area-consistent in the frame, but 12 % 5 != 0. The point of
// this fixture is the *order* of the validator's checks — it must reach the area rule with a
// clean piece set, so both names here are real pentominoes.
export const ODD_AREA = {
  why: '面积 12 不是 5 的倍数：任何五连块组合都装不满',
  w: 6,
  h: 2,
  mask: parseMask('1'.repeat(12), 6, 2),
  pieces: ['I', 'L'],
  invalid: 'area 12 is not a multiple of 5',
  rule: 'area',
};

export const COUNT_MISMATCH = {
  why: '面积 25 要 5 块，这里只给 4 块',
  w: 5,
  h: 5,
  mask: parseMask('1'.repeat(25), 5, 5),
  pieces: ['I', 'L', 'P', 'X'],
  invalid: 'area 25 needs 5 pieces, got 4',
  rule: 'count',
};

export const DUPLICATE_PIECE = {
  why: '同一块出现两次：物理上十二块各一，数据写错',
  w: 5,
  h: 2,
  mask: parseMask('1'.repeat(10), 5, 2),
  pieces: ['I', 'I'],
  invalid: "piece 'I' appears twice — the twelve pentominoes are distinct",
  rule: 'duplicate',
};

export const UNKNOWN_PIECE = {
  why: '不存在的块名',
  w: 5,
  h: 2,
  mask: parseMask('1'.repeat(10), 5, 2),
  pieces: ['I', 'Q'],
  invalid: "unknown piece 'Q'",
  rule: 'unknown',
};

// A tetromino named 'O': the frame and the piece count are made arithmetically consistent (10
// cells, 2 pieces) so the only thing left to reject is the name. A fixture that was wrong in two
// ways could not tell which rule fired.
export const NOT_A_PENTOMINO = {
  why: '四格块 O：不是五连块，而面积/块数都对得上，所以只能是被名字拒绝',
  w: 5,
  h: 2,
  mask: parseMask('1'.repeat(10), 5, 2),
  pieces: ['I', 'O'],
  invalid: "unknown piece 'O'",
  rule: 'unknown',
};

export const MASK_TOO_SHORT = {
  why: '掩码长度对不上帧宽 —— 手写数据文件最容易打错的一种',
  w: 5,
  h: 2,
  mask: parseMask('1'.repeat(10), 5, 2).slice(0, 9),
  invalid: 'mask has 9 cells for a 5x2 frame',
  rule: 'mask',
};

export const FIXTURES = {
  X_PLUS, HOOK_LP, HOOK_PLUS_UNION, PLUS_ONLY,
  ODD_AREA, COUNT_MISMATCH, DUPLICATE_PIECE, UNKNOWN_PIECE, NOT_A_PENTOMINO, MASK_TOO_SHORT,
};

export const INVALID_FIXTURES = [
  ODD_AREA, COUNT_MISMATCH, DUPLICATE_PIECE, UNKNOWN_PIECE, NOT_A_PENTOMINO, MASK_TOO_SHORT,
];

// The four whose solution counts are proved on paper above, with the proof value attached.
export const HAND_FIXTURES = [X_PLUS, HOOK_LP, HOOK_PLUS_UNION, PLUS_ONLY];
export const VALID_FIXTURES = HAND_FIXTURES;
