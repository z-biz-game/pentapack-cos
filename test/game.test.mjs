// js/core/game.js is the file that decides what counts as a step, and the panel prints that
// number as the player's score — so its rules belong in a node suite, not only behind a mouse.
// The header of game.js has named this file since the first commit; the suite is what was
// missing. The browser suite (@pointer) drives the same object through real events, which proves
// the wiring; this proves the economy itself, including the branches a pointer cannot reach.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  createGame, place, takeBack, rotate, flip, undo, reset, hintFor, grade,
  isComplete, placedCount, trayOrder, boardCellsOf, cellsFor, fits, pieceAt, BOUNCE,
} from '../js/core/game.js';
import { campaign } from '../js/core/library.js';

const LOT = campaign()[0];          // taster-01: 4 pieces, PVWX, 8x8 frame
const fresh = () => createGame(LOT);
const occupied = (g) => g.cells.filter((v) => v >= 0).length;

// Every pose of `name`-carrying piece `forPiece` on this board, walked through the same
// cellsFor() the rules use, so a test that wants a collision / a refusal / a second home asks
// the rule instead of hard-coding a coordinate that a re-bake could move.
function poses(g, forPiece) {
  const out = [];
  for (let variant = 0; variant < 8; variant++) {
    for (let y = -6; y < g.spec.h + 6; y++) {
      for (let x = -6; x < g.spec.w + 6; x++) {
        out.push({ piece: forPiece, variant, x, y, m: cellsFor(g, forPiece, variant, x, y) });
      }
    }
  }
  return out;
}

const firstWhere = (g, forPiece, want, taken) =>
  poses(g, forPiece).find((p) => (want === 'clash'
    ? p.m.ok && p.m.cells.some((c) => taken.has(c) && g.cells[c] !== forPiece)
    : !p.m.ok && p.m.code === want)) || null;

test('开局：块全在待置区，步数 0，历史空，匣里一格都没有', () => {
  const g = fresh();
  eq(trayOrder(g), [0, 1, 2, 3], 'tray');
  eq([g.moves, g.done, g.anomaly], [0, false, null], 'counters');
  eq(occupied(g), 0, 'occupied cells');
  eq(g.history.length, 0, 'history');
  eq(boardCellsOf(g).length, LOT.k * 5, 'the 匣 is exactly k*5 cells');
});

test('放对一块 = 一步，板上多出 5 格，那块从此不在待置区', () => {
  const g = fresh();
  const s = LOT.solution[0];
  const r = place(g, s.piece, s.variant, s.x, s.y);
  eq([r.ok, r.moved, r.code], [true, true, null], 'result');
  eq([g.moves, placedCount(g), occupied(g)], [1, 1, 5], 'state');
  eq(trayOrder(g).includes(s.piece), false, 'no longer in the tray');
});

test('原地按下再松开不算一步（place 报 noop）', () => {
  const g = fresh();
  const s = LOT.solution[0];
  place(g, s.piece, s.variant, s.x, s.y);
  const r = place(g, s.piece, s.variant, s.x, s.y);
  eq([r.ok, r.moved, r.code], [true, false, 'noop'], 'result');
  eq(g.moves, 1, 'still one step');
});

test('压住别块的落点被拒绝：code overlap，0 步，那块也没上板', () => {
  const g = fresh();
  const s = LOT.solution[0];
  place(g, s.piece, s.variant, s.x, s.y);
  const taken = new Set();
  for (let i = 0; i < g.cells.length; i++) if (g.cells[i] >= 0) taken.add(i);
  const clash = firstWhere(g, trayOrder(g)[0], 'clash', taken);
  ok(clash, 'a clashing pose must exist on this frame');
  const r = place(g, clash.piece, clash.variant, clash.x, clash.y);
  eq([r.ok, r.moved, r.code], [false, false, 'overlap'], 'result');
  eq([g.moves, placedCount(g), occupied(g)], [1, 1, 5], 'nothing moved, nothing cost');
});

test('落在匣外被拒绝：code off（在框内、在匣外），且 0 步', () => {
  const g = fresh();
  const hit = firstWhere(g, 0, 'off');
  ok(hit, 'the frame has cells outside the 匣');
  const r = place(g, hit.piece, hit.variant, hit.x, hit.y);
  eq([r.ok, r.moved, r.code], [false, false, 'off'], 'result');
  eq([g.moves, occupied(g)], [0, 0], 'a refused drop is free');
});

test('伸出边框被拒绝：code out，同样 0 步', () => {
  const g = fresh();
  const hit = firstWhere(g, 0, 'out');
  ok(hit, 'a pose can hang off the frame');
  const r = place(g, hit.piece, hit.variant, hit.x, hit.y);
  eq([r.ok, r.moved, r.code], [false, false, 'out'], 'result');
  eq(g.moves, 0, 'and it costs nothing');
});

test('三个拒绝码在 BOUNCE 一处命名，视图与提示不会有第四种说法', () => {
  eq(Object.keys(BOUNCE).sort(), ['off', 'out', 'overlap'], 'the codes a drop can be refused for');
  eq(Object.values(BOUNCE).every((t) => typeof t === 'string' && t.length > 0), true, 'each names the reason');
});

test('把已上的块拖到别处 = 一步，让出来的格子当场腾空', () => {
  const g = fresh();
  const s = LOT.solution[0];
  place(g, s.piece, s.variant, s.x, s.y);
  const old = cellsFor(g, s.piece, s.variant, s.x, s.y).cells;
  const home = poses(g, s.piece).find((p) => p.m.ok && fits(g, s.piece, p.variant, p.x, p.y)
    && (p.x !== s.x || p.y !== s.y || p.variant !== s.variant));
  ok(home, 'the piece has somewhere else to go');
  const r = place(g, s.piece, home.variant, home.x, home.y);
  eq([r.ok, r.moved, g.moves], [true, true, 2], 'one decision, one step');
  // Measured on taster-01: piece 0 from pose 0 @(3,0) to pose 0 @(2,0) keeps cells 11 and 19 —
  // the two poses overlap, and an overlapping cell is supposed to stay painted. Only the cells
  // the new pose does *not* cover may go empty.
  const movedOut = old.filter((c) => !home.m.cells.includes(c));
  ok(movedOut.length > 0, 'the move must actually leave something behind');
  eq(movedOut.map((c) => g.cells[c]), movedOut.map(() => -1), 'the freed cells are empty');
  eq(home.m.cells.every((c) => g.cells[c] === s.piece), true, 'and the new ones are filled');
  eq(occupied(g), 5, 'still exactly one piece worth of cells');
});

test('取回 = 一步；没在板上的块取不回（not-placed）', () => {
  const g = fresh();
  const s = LOT.solution[0];
  place(g, s.piece, s.variant, s.x, s.y);
  const r = takeBack(g, s.piece);
  eq([r.ok, r.moved, g.moves], [true, true, 2], 'drop then take back is two steps');
  eq([placedCount(g), occupied(g)], [0, 0], 'the board is empty again');
  const nope = takeBack(g, trayOrder(g)[0]);
  eq([nope.ok, nope.moved, nope.code, g.moves], [false, false, 'not-placed', 2], 'nothing to take back');
});

test('待置区里旋转与镜像都算 0 步，姿态确实换了', () => {
  const g = fresh();
  const before = g.at[0].variant;
  const r = rotate(g, 0);
  eq([r.ok, r.moved, g.moves], [true, true, 0], 'rotate is free');
  ok(g.at[0].variant !== before, 'the pose changed');
  const mid = g.at[0].variant;
  const f = flip(g, 0);
  eq([f.ok, f.moved, g.moves], [true, true, 0], 'mirror is free');
  ok(g.at[0].variant !== mid, 'and it changed again');
  eq(occupied(g), 0, 'a tray piece paints nothing');
});

test('已上的块在原地转不过去就是转不过去：blocked，姿态一格没动', () => {
  const g = fresh();
  const s = LOT.solution[0];              // taster-01, P at variant 0 @(3,0)
  place(g, s.piece, s.variant, s.x, s.y);
  const r = rotate(g, s.piece);
  eq([r.ok, r.moved, r.code], [false, false, 'blocked'], 'the new pose would collide at the same anchor');
  eq([g.at[s.piece].variant, g.at[s.piece].x, g.at[s.piece].y], [s.variant, s.x, s.y], 'nothing moved');
  eq(g.moves, 1, 'and a refused turn costs no step');
});

test('只有一种姿态的块（X）原地旋转/镜像是 noop，不是失败', () => {
  const g = fresh();
  const xs = LOT.spec.pieces.indexOf('X');
  ok(xs >= 0, 'taster-01 carries the X');
  const s = LOT.solution.find((p) => p.piece === xs);
  place(g, xs, s.variant, s.x, s.y);
  eq([rotate(g, xs).moved, flip(g, xs).code], [false, 'noop'], 'no other pose exists');
  eq(g.at[xs].variant, s.variant, 'the piece keeps the pose it had');
});

test('按烘焙解答一块块装满：步数恰为 k，判定完成，三星一次到位', () => {
  const g = fresh();
  for (const s of LOT.solution) {
    eq([place(g, s.piece, s.variant, s.x, s.y).ok, true], [true, true], `drop of piece ${s.piece}`);
  }
  eq([g.moves, placedCount(g), isComplete(g), g.done, g.anomaly], [LOT.k, LOT.k, true, true, null], 'packed in the floor of k');
  eq(grade(g), { key: 'perfect', label: '一次到位', stars: 3 }, 'grade');
  eq(hintFor(g), null, 'a finished board has no hint to give');
});

test('多挪的档位在装满那一刻判：over=2 干净装箱两星，over=4 反复挪动一星', () => {
  const g = fresh();
  const spare = LOT.solution[LOT.solution.length - 1];
  const rest = LOT.solution.slice(0, -1);
  const churn = rest[0];
  // The waste has to happen while the 匣 is still open: as measured here, a finished board
  // refuses every further mutation with code 'done', so there is no taking a piece back once the
  // last one is down.
  for (const s of rest) place(g, s.piece, s.variant, s.x, s.y);
  takeBack(g, churn.piece);
  place(g, churn.piece, churn.variant, churn.x, churn.y);
  place(g, spare.piece, spare.variant, spare.x, spare.y);
  eq([g.moves, g.done, grade(g).key, grade(g).stars], [LOT.k + 2, true, 'clean', 2], 'over 2 is 干净装箱');
});

test('再挪两次：over=4 掉到一星，仍然算完成', () => {
  const g = fresh();
  const spare = LOT.solution[LOT.solution.length - 1];
  const rest = LOT.solution.slice(0, -1);
  const churn = rest[0];
  for (const s of rest) place(g, s.piece, s.variant, s.x, s.y);
  for (let i = 0; i < 2; i++) {
    takeBack(g, churn.piece);
    place(g, churn.piece, churn.variant, churn.x, churn.y);
  }
  place(g, spare.piece, spare.variant, spare.x, spare.y);
  eq([g.moves, g.done, grade(g).key, grade(g).label], [LOT.k + 4, true, 'loose', '反复挪动'], 'over 4 is 反复挪动');
});

test('匣一满就锁：done 之后的放置与取回一律被拒，且不记账', () => {
  const g = fresh();
  for (const s of LOT.solution) place(g, s.piece, s.variant, s.x, s.y);
  eq([g.moves, g.done, isComplete(g)], [LOT.k, true, true], 'a completed board');
  eq([place(g, 0, 1, 0, 0).code, takeBack(g, 0).code, g.moves], ['done', 'done', LOT.k], 'nothing more can happen to it');
});

test('undo 回到上一步的完整状态；历史空了返回 false', () => {
  const g = fresh();
  const a = LOT.solution[0], b = LOT.solution[1];
  place(g, a.piece, a.variant, a.x, a.y);
  place(g, b.piece, b.variant, b.x, b.y);
  const own = cellsFor(g, b.piece, b.variant, b.x, b.y).cells;
  const [ox, oy] = [own[0] % g.spec.w, Math.floor(own[0] / g.spec.w)];
  eq([g.moves, placedCount(g), pieceAt(g, ox, oy)], [2, 2, b.piece], 'two down');
  eq(undo(g), true, 'undo reports it had something to do');
  eq([g.moves, placedCount(g), occupied(g)], [1, 1, 5], 'back to one piece');
  eq(g.at[b.piece].onBoard, false, 'and that piece is in the tray again');
  eq(pieceAt(g, ox, oy), -1, 'the cell it held is empty');
  undo(g);
  eq(g.history.length, 0, 'history drained');
  eq([undo(g), g.moves], [false, 0], 'nothing left to undo');
});

test('锚点是包围盒左上角，那一格本身可能没有块：pieceAt 读它是空的', () => {
  const g = fresh();
  const b = LOT.solution[1];              // taster-01: the V, pose 3, anchor (0,0)
  place(g, b.piece, b.variant, b.x, b.y);
  const own = cellsFor(g, b.piece, b.variant, b.x, b.y).cells;
  eq(own.includes(b.y * g.spec.w + b.x), false, 'measured: V pose 3 does not cover its own anchor');
  eq(pieceAt(g, b.x, b.y), -1, 'so a pointer on the anchor is a pointer on nothing');
  // This is exactly why js/view.js:grabCentre aims a gesture at the occupied cell nearest the
  // box centre instead of at the box: the corner is a hole here, and the centre is one for V,
  // U and W. A hit-test that trusts either would silently miss the piece it is holding.
  const [cx, cy] = [own[0] % g.spec.w, Math.floor(own[0] / g.spec.w)];
  eq(pieceAt(g, cx, cy), b.piece, 'a cell of the pose is where the piece actually is');
});

test('reset 把姿态、步数、历史、done 一次清干净', () => {
  const g = fresh();
  for (const s of LOT.solution) place(g, s.piece, s.variant, s.x, s.y);
  rotate(g, 0);
  reset(g);
  eq([g.moves, g.history.length, g.done, occupied(g)], [0, 0, false, 0], 'counters and board');
  eq(g.at.map((a) => [a.onBoard, a.variant, a.x, a.y]), LOT.solution.map((_, i) => [false, 0, 0, 0]), 'every piece back in the tray at pose 0');
});

test('提示只是查烘焙解答：in-tray / misplaced 两种，且不动棋盘', () => {
  const g = fresh();
  const s = LOT.solution[0];
  eq([hintFor(g).piece, hintFor(g).why], [s.piece, 'in-tray'], 'the first thing missing is the first thing to place');
  place(g, s.piece, s.variant, s.x, s.y);
  const elsewhere = poses(g, s.piece).find((p) => p.m.ok && fits(g, s.piece, p.variant, p.x, p.y)
    && (p.x !== s.x || p.y !== s.y || p.variant !== s.variant));
  place(g, s.piece, elsewhere.variant, elsewhere.x, elsewhere.y);
  eq([hintFor(g).why, g.moves], ['misplaced', 2], 'a piece that is down but wrong');
  eq(hintFor(g).target, { ...s }, 'and the hint names the baked home, not the current mess');
  eq([placedCount(g), occupied(g)], [1, 5], 'a hint paints nothing by itself');
});

test('完成判定认的是烘焙那条解：对不上就报 anomaly，不发星', () => {
  const g = fresh();
  // Simulate a bake whose proof was wrong: the player fills the 匣 exactly as the rules allow,
  // while the stored line claims something else sat there. checkDone must say 异常, not 三星.
  g.solution = g.solution.map((s, i) => (i === 0 ? { ...s, x: s.x + 1 } : s));
  for (const s of LOT.solution) place(g, s.piece, s.variant, s.x, s.y);
  eq([isComplete(g), g.done, g.anomaly], [true, false, 'second-solution'], 'a full board is not a solved one');
});

test('姿态下标越界是取模，不是读穿表：cellsFor 与合法下标同格', () => {
  const g = fresh();
  // P carries 8 poses, so 99 has to mean pose 3 and -1 has to mean pose 7. The anchor is looked
  // for rather than written down, because both poses have to actually sit on this 匣 for the
  // comparison to say anything — an out-of-frame anchor would make both sides an empty prefix.
  const anchor = poses(g, 0).find((p) => p.variant === 3 && p.m.ok && cellsFor(g, 0, 7, p.x, p.y).ok);
  ok(anchor, 'there is somewhere both pose 3 and pose 7 sit legally');
  eq(anchor.m.cells.length, 5, 'a real pose covers five cells');
  eq(cellsFor(g, 0, 99, anchor.x, anchor.y).cells, anchor.m.cells, '99 wraps to 3');
  eq(cellsFor(g, 0, -1, anchor.x, anchor.y).cells, cellsFor(g, 0, 7, anchor.x, anchor.y).cells, 'and it wraps backwards too');
});

process.exitCode = run();
