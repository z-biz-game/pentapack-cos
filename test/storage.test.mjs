// js/core/storage.js — the two monotonicity rules the player can feel, under a node gate.
//
// WHY THIS FILE EXISTS
// ----------------------------------------------------------------------------
// storage.js has named this file in its own comment since it was written ("the one place that
// decides what the slot's bytes look like has to be the same place test/storage.test.mjs and @save
// compare against"), but the file did not exist, and the promise at the top of the module —
// `best[id].moves` only ever goes DOWN, `unlock` only ever goes UP — was guarded only by the
// browser leg (@save). That is a real difference in strength: `npm test` could stay green while a
// writer regression opened the whole campaign backwards. 破坏试验 proved it — K11 (flip `<=` to `>=`
// in the best-record merge) and K12 (flip `Math.max` to `Math.min` for unlock) were GREEN across
// all ten node suites before this file existed. Both bite now.
//
// The second half of the file is the other contract in the header: a localStorage that is missing
// (this suite: node has no `window`), or full of garbage from an old build, must degrade rather
// than throw, and must not resurrect a game that was wiped.
//
// Nothing here reads a clock: armClear() takes its `now` as an argument, which is why a two-click
// wipe can be asserted with synthetic timestamps instead of sleeping.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  store, sanitise, decode, encode, defaultSave, SAVE_KEY, SAVE_VERSION,
} from '../js/core/storage.js';

// node has no `window`, so every write lands in the module-level memory copy. Each case starts
// from a clean slot; the store is a singleton on purpose (a test that pokes it twice sees its own
// writes), which also means a case that forgot to reset would leak into the next one.
const blank = () => store.resetForTest();

test('白纸档的形状：版本、空成绩、零解锁、提示开着', () => {
  const d = defaultSave();
  eq([d.v, d.unlock, d.clearArm], [SAVE_VERSION, 0, 0], 'the numbers a fresh save starts on');
  eq([d.best, d.done], [{}, {}], 'and nothing is recorded yet');
  eq(d.settings, { hint: true }, 'hints default to on');
  eq(SAVE_KEY, 'pentapack.save.v1', 'one versioned key, spelled once');
  blank();
  eq(store.load(), defaultSave(), 'load() on an untouched slot is the default save');
});

test('没有 window 也不抛：写进内存档，并且读得回来', () => {
  blank();
  const before = store.load().best;
  eq(Object.keys(before).length, 0, 'starts empty in node too');
  const r = store.record('taster-01', { moves: 4, seconds: 30, date: '2026-09-30' });
  eq([r.first, r.improved], [true, true], 'a first clear is both new and an improvement');
  eq(store.load().best['taster-01'].moves, 4, 'the write is visible to the next read');
  eq(store.rawText(), encode(r.save), 'and the bytes the slot would hold come from encode()');
});

test('best 只降不升：打得更差拿不走已经写下的纪录', () => {
  blank();
  store.record('taster-01', { moves: 4, seconds: 20, date: '2026-09-30' });
  const worse = store.record('taster-01', { moves: 9, seconds: 90, date: '2026-10-01' });
  eq(worse.first, false, 'not a first clear any more');
  eq(worse.improved, false, 'and a 9-move replay did not improve a 4');
  eq(worse.save.best['taster-01'], { moves: 4, seconds: 20, date: '2026-09-30' }, 'the record stands, date and all');
  eq(worse.previous, { moves: 4, seconds: 20, date: '2026-09-30' }, 'and the writer reports what it kept');
  const better = store.record('taster-01', { moves: 5, seconds: 60, date: '2026-10-02' });
  eq(better.improved, false, '5 moves is still worse than 4');
  eq(better.save.best['taster-01'].moves, 4, 'so it still cannot overwrite');
  const best = store.record('taster-01', { moves: 4, seconds: 12, date: '2026-10-03' });
  eq(best.improved, true, 'same moves, faster clock time does count as an improvement');
  eq(best.save.best['taster-01'], { moves: 4, seconds: 12, date: '2026-10-03' }, 'and the record is replaced wholesale');
});

test('record 需要 id，并把 done 也盖上', () => {
  blank();
  const r = store.record('mid-02', { moves: 6, seconds: 5 });
  eq(r.save.done['mid-02'], 1, 'finishing marks the lot as done');
  eq(store.load().done['mid-02'], 1, 'in the slot, not only in the return value');
  let threw = null;
  try { store.record(null, { moves: 1 }); } catch (err) { threw = String(err.message); }
  ok(threw && /needs a level id/.test(threw), `an id-less record throws (${threw})`);
});

test('unlock 只升不降：一次 save({unlock:0}) 关不掉已经打开的匣阵', () => {
  blank();
  store.unlockTo(7);
  eq(store.load().unlock, 7, 'index 7 and everything before it is open');
  const back = store.save({ unlock: 0 });
  eq(back.unlock, 7, 'the writer refuses the regression instead of obeying it');
  const neg = store.save({ unlock: -3 });
  eq(neg.unlock, 7, 'a negative target does not sneak past the floor either');
  eq(store.unlockTo(3).unlock, 7, 'unlockTo() lower than the current value is a no-op');
  eq(store.unlockTo(29).unlock, 29, 'and a higher one opens the campaign');
  eq(store.unlockTo(29.7).unlock, 29, 'fractional targets are floored, not rounded up');
});

test('settings 改动不碰成绩，成绩改动不碰 settings', () => {
  blank();
  store.record('taster-01', { moves: 4, seconds: 9 });
  const after = store.setSetting('hint', false);
  eq(after.settings.hint, false, 'the switch flipped');
  eq(after.best['taster-01'].moves, 4, 'the record is untouched by a settings write');
  eq(after.unlock, 0, 'and no unlocking came along with it');
});

test('脏字段被消毒：负数、非对象、非有限、未知键都进不了档', () => {
  const dirty = sanitise({
    v: SAVE_VERSION,
    best: {
      x: { moves: -5 }, y: 'junk', z: { moves: 7, seconds: 3 }, w: { moves: 'NaN' },
      s: { moves: 2.6, seconds: -1, date: 99 },
    },
    unlock: -3,
    done: { a: 1, b: 0, c: 'yes' },
    settings: { hint: 5, theme: 'brass', nested: { deep: 1 } },
    clearArm: 'soon',
    ghost: 'unknown key',
  });
  eq(Object.keys(dirty.best).sort(), ['s', 'z'], 'a record survives only with a finite non-negative moves');
  eq(dirty.best.s, { moves: 3, seconds: 0, date: '' }, 'moves rounds, a negative seconds becomes 0, a non-string date goes empty');
  eq(dirty.unlock, 0, 'a negative unlock is not an unlock');
  eq(dirty.done, { a: 1, c: 1 }, 'done is folded to 1-or-absent');
  eq(dirty.settings, { hint: 5, theme: 'brass' }, 'only scalars survive in settings');
  eq(dirty.clearArm, 0, 'an unparseable arming window is disarmed');
  eq('ghost' in dirty, false, 'and unknown keys are dropped, not carried forward');
});

test('读档：坏 JSON、空槽、别的版本都不许抛', () => {
  eq(decode(null), defaultSave(), 'no slot at all is a fresh start');
  eq(decode('{"v":1,}'), defaultSave(), 'unparseable bytes are a fresh start, not a crash');
  eq(decode('[]'), defaultSave(), 'an array is not a save');
  eq(decode('{"v":2,"best":{"x":{"moves":4}}}').v, SAVE_VERSION, 'a file from another epoch is re-stamped');
  eq(decode('{"v":2,"best":{"x":{"moves":4}}}').best.x.moves, 4,
    'what it keeps are the sanitised fields; the version it claims is not trusted');
});

test('清档要两次点击：武装、窗口内确认、过期作废', () => {
  blank();
  store.record('taster-01', { moves: 4, seconds: 9 });
  store.unlockTo(3);
  const armed = store.armClear(1000);
  eq([armed.cleared, armed.armed], [false, true], 'the first click only arms');
  eq(store.load().best['taster-01'].moves, 4, 'and the record is still there after it');
  eq(store.load().clearArm, 1000, 'the arming timestamp is in the save itself, so a reload keeps it');
  const within = store.armClear(4500);
  eq([within.cleared, within.armed], [true, false], 'the second click inside the window wipes');
  eq(store.load(), defaultSave(), 'wiped means wiped: no records, no unlock, no arming');
  eq(store.rawText(), '', 'and the slot is emptied, not rewritten with defaults');
  store.record('taster-01', { moves: 4, seconds: 9 });
  store.armClear(10000);
  const stale = store.armClear(16000);
  eq([stale.cleared, stale.armed], [false, true], 'a confirmation six seconds later is a new first click');
  eq(store.load().best['taster-01'].moves, 4, 'so the records survive it');
  eq(store.disarmClear().clearArm, 0, 'and clicking elsewhere disarms without wiping');
  eq(store.disarmClear().best['taster-01'].moves, 4, 'disarming never deletes anything');
});

test('encode 是唯一的字节口径：脏对象进去，消毒过的字节出来', () => {
  const text = encode({ v: 99, best: { ok: { moves: 2.4, seconds: '7' } }, unlock: 4.9, junk: 1 });
  const parsed = JSON.parse(text);
  eq([parsed.v, parsed.unlock], [SAVE_VERSION, 4], 'version is normalised and unlock is floored on the way out');
  eq(parsed.best.ok, { moves: 2, seconds: 7, date: '' }, 'numbers are rounded and unknown fields dropped');
  eq('junk' in parsed, false, 'the slot never grows keys the reader does not know');
  eq(decode(text), parsed, 'and what encode writes is exactly what decode reads back');
});

process.exitCode = run();
