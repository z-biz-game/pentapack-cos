// Determinism, because the daily puzzle and a shared link are promises about a *specific*
// puzzle. Everything here is checked against values computed outside this repository: the
// expected hashSeed outputs come from an independent FNV-1a implementation written in Python
// over the same documented byte order, and the mulberry32 stream from an independent port of
// the published algorithm. Neither number was read back out of js/core/rng.js.

import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import { hashSeed, mulberry32, rngFrom, todayKey } from '../js/core/rng.js';

// An independent implementation of the same published construction: FNV-1a 32-bit, offset basis
// 0x811c9dc5, prime 0x01000193, fed each character as its low byte then its high byte (so this
// is FNV over UTF-16 code units, not over UTF-8 — which is what the next table pins down).
function refHash(str) {
  let h = 0x811c9dc5;
  const mul = (v) => Math.imul(v, 0x01000193) >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = mul((h ^ (c & 0xff)) >>> 0);
    h = mul((h ^ ((c >> 8) & 0xff)) >>> 0);
  }
  return h >>> 0;
}

// hand-computed with the reference above; '' is the offset basis untouched
const HASH_VECTORS = [
  ['', 2166136261],
  ['a', 723832900],
  ['ab', 2174188438],
  ['PENTAPACK', 332568898],
  ['pentapack', 2668090594],
  ['2026-03-01', 1605594449],
  ['daily:2026-03-01', 4172587626],
  ['匣', 650684755],
];

// The same character's UTF-8 FNV-1a value, computed in Python over the three encoded bytes:
// deliberately different, because this hash consumes code units as two bytes, not the UTF-8 form.
const HASH_UTF8_OF_XIA = 744081253;

const MULBERRY = {
  0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111],
  1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741],
  20260301: [0.5822490171995014, 0.7691851132549345, 0.9738989360630512, 0.5535603957250714],
  // what mulberry32(hashSeed('')) feeds the generator
  2166136261: [0.6112444521859288, 0.4935242917854339, 0.7740248835179955, 0.4122861116193235],
};

test('hashSeed is the FNV-1a construction it claims, on vectors computed elsewhere', () => {
  for (const [input, want] of HASH_VECTORS) {
    eq(hashSeed(input), want, `hashSeed('${input}')`);
  }
  eq(hashSeed(''), 2166136261, 'the empty string is the offset basis, unmixed');
});

test('it matches an independent implementation on every seed the game uses', () => {
  const seeds = ['daily:2026-03-01', 'random:abc', 'band|first', 'pentapack-v1:iron:12', '匣', '五格拼盘'];
  for (const s of seeds) eq(hashSeed(s), refHash(s), `${s}: two implementations, one number`);
  assert(hashSeed('匣') !== HASH_UTF8_OF_XIA, 'code units, not UTF-8 bytes: the two differ on non-ASCII');
});

test('hashSeed stays a uint32 and separates nearby strings', () => {
  for (const s of ['a', 'ab', 'abc', '2026-03-01', '2026-03-02', 'daily:2026-03-01', 'daily:2026-03-02']) {
    const h = hashSeed(s);
    ok(Number.isInteger(h) && h >= 0 && h < 4294967296, `${s}: an unsigned 32-bit integer`);
  }
  const days = [];
  for (let d = 1; d <= 31; d++) days.push(hashSeed(`daily:2026-03-${String(d).padStart(2, '0')}`));
  eq(new Set(days).size, 31, 'thirty-one consecutive daily keys, thirty-one different seeds');
});

test('mulberry32 reproduces a published stream, exactly and repeatably', () => {
  for (const seed of Object.keys(MULBERRY)) {
    const rng = mulberry32(Number(seed));
    eq([rng(), rng(), rng(), rng()], MULBERRY[seed], `seed ${seed}: four draws against the reference port`);
  }
  const a = mulberry32(7);
  const b = mulberry32(7);
  eq([a(), a()], [b(), b()], 'same state in, same stream out');
  eq(mulberry32(8)() === mulberry32(9)(), false, 'and one bit of seed is enough to diverge');
});

test('rngFrom dispatches on the seed type it documents', () => {
  eq(rngFrom(2166136261)(), mulberry32(2166136261)(), 'a number is the state itself');
  const viaText = rngFrom('');
  const viaHash = mulberry32(hashSeed(''));
  eq([viaText(), viaText()], [viaHash(), viaHash()], 'a string is hashed first, then used as the state');
  const passed = rngFrom('round-trip');
  eq(rngFrom(passed), passed, 'an existing rng is handed straight back');
  ok(typeof rngFrom('x') === 'function', 'and what comes out is callable');
});

test('the helpers stay inside the ranges they promise', () => {
  const rng = rngFrom('helpers');
  for (let i = 0; i < 500; i++) {
    const u = rng();
    assert(u >= 0 && u < 1, `uniform draw ${u} in [0,1)`);
    const k = rng.int(5);
    assert(Number.isInteger(k) && k >= 0 && k < 5, `int(5) gave ${k}`);
    const r = rng.range(3, 6);
    assert(Number.isInteger(r) && r >= 3 && r <= 6, `range(3,6) gave ${r}`);
  }
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(rngFrom(`s${i}`).range(3, 6));
  eq(Array.from(seen).sort(), [3, 4, 5, 6], 'range hits both endpoints — it is inclusive, as make.js needs');
  eq(rngFrom('a').int(1), 0, 'int(1) has one answer');
  const pool = ['F', 'I', 'L'];
  eq(new Set(Array.from({ length: 60 }, (_, i) => rngFrom(`p${i}`).pick(pool))).size, 3, 'pick can reach every entry');
  eq(rngFrom('yes').chance(1), true, 'chance(1) is certain');
  eq(rngFrom('no').chance(0), false, 'chance(0) is not');
});

test('shuffle permutes, deterministically, and in place', () => {
  const base = ['F', 'I', 'L', 'P', 'N', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
  const a = rngFrom('shuffle').shuffle(base.slice());
  const b = rngFrom('shuffle').shuffle(base.slice());
  eq(a, b, 'same seed, same order');
  eq(a.slice().sort(), base.slice().sort(), 'a permutation, not a sample with repeats');
  ok(a.join('') !== base.join(''), 'and it actually moved something');
  const counts = new Set();
  for (let i = 0; i < 40; i++) counts.add(rngFrom(`o${i}`).shuffle(base.slice()).join(''));
  ok(counts.size > 20, `forty seeds give many orders (${counts.size} distinct), not one fixed answer`);
  // The documented contract is an in-place Fisher-Yates that hands the same array back. Callers
  // that need their original (js/core/make.js's packOnce copies its pool first) must slice.
  const mine = base.slice();
  const back = rngFrom(3).shuffle(mine);
  ok(back === mine, 'the returned array IS the one that was passed in — it shuffles in place');
  ok(back !== base, 'and the caller owns whatever array it hands over');
  eq(mine.slice().sort(), base.slice().sort(), 'the in-place array is still a permutation of itself');
  // One draw per slot, n-1 down to 1: nothing else may consume the stream, or a caller that
  // shuffles and then draws would get a value that depends on how shuffle counts internally.
  const stepped = rngFrom(3);
  stepped.shuffle(base.slice());
  const reference = mulberry32(3);
  for (let i = base.length - 1; i > 0; i--) reference();
  eq(stepped(), reference(), 'after a 12-element shuffle the stream is exactly 11 draws along');
});

test('todayKey formats a date the caller read, and refuses to read one itself', () => {
  eq(todayKey(new Date(2026, 2, 1)), '2026-03-01', 'month is zero-based on the way in, not on the way out');
  eq(todayKey(new Date(2026, 0, 9)), '2026-01-09', 'single digits are padded');
  eq(todayKey(new Date(2026, 11, 31)), '2026-12-31', 'and the year is the local one');
  throws(() => todayKey(), /needs a Date read by the caller/, 'no argument at all');
  throws(() => todayKey('2026-03-01'), /needs a Date read by the caller/, 'a string is not a date');
  throws(() => todayKey(new Date(NaN)), /needs a Date read by the caller/, 'an invalid Date is not a date either');
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
