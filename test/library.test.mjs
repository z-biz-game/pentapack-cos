// The shipped campaign, re-proved from the bytes in js/data/lots.js.
//
// WHY THIS FILE EXISTS
// ----------------------------------------------------------------------------
// tools/bake.mjs writes js/data/lots.js and, as it writes, re-proves every row. That is a
// statement about the moment of baking. This file makes the same statement about the file that
// actually ships: it reads the row text, turns it back into a level, and re-runs the two
// oracles. A hand-edit to a `depth`, a `mask` or a `solution` tuple — the classic way a
// generated data file rots — fails here, not in someone's eyeballs.
//
// The four claims per row, re-measured rather than re-read:
//   1. the row is a legal level (js/core/board.js:validateLevel says null);
//   2. 解数 == 1: dancing links finds exactly one exact cover, and stops looking at the second
//      one (limit=2). This is the sentence the whole game rests on;
//   3. 推理深度 == the printed number, measured again by the pencil-and-paper solver, which
//      must also find the *same* placement the file ships;
//   4. the printed band is the band whose (k, depth) window contains those two measurements, so
//      a label cannot survive being detached from its numbers.
//
// And one claim about the *gate* rather than the data: a board with two solutions must read as
// 2 here. If a counter cannot say 2, then "解数 == 1" is not evidence of anything.
//
// Cost: thirty small boards (k <= 8 on an 8x8 frame), each proved by a bounded search. This
// file runs in a fraction of a second; the heavy enumeration is test/anchor.test.mjs.

import { readFileSync } from 'node:fs';
import { test, run, ok, eq, assert } from '../tools/harness.mjs';
import {
  ALL, LOT_VERSION, campaign, byId, indexById, bands, lotsIn, nextOf, prevOf,
  bandOf, bandForDay, dailyLot, randomLot, parseRoute, resolveRoute,
  serialiseLot, deserialiseLot, expandSolution, specOf, stats,
} from '../js/core/library.js';
import { FRAME_W, FRAME_H, BANDS, bandName } from '../js/core/make.js';
import {
  validateLevel, validatePlacements, samePlacements, maskCount, maskString, parseMask, fullRect, placementMask,
} from '../js/core/board.js';
import { countSolutions, solveLevel, collectSolutions } from '../js/core/dlx.js';
import { logicSolve, RULE_SET_VERSION } from '../js/core/logic.js';
import { CELLS, FULL_SET, VARIANTS } from '../js/core/pieces.js';

// ---------------------------------------------------------------------------
// the file as bytes, not as a module
// ---------------------------------------------------------------------------
// Read rather than imported on purpose: js/data/* may enter the app through js/core/library.js
// and nothing else (tools/check.mjs enforces that), and a test that wants to accuse the file of
// lying has to look at the text, not at a module the file itself exports.

const dataText = readFileSync(new URL('../js/data/lots.js', import.meta.url), 'utf8');
const FILE_ROWS = dataText
  .split('\n')
  .filter((line) => /^\s*\{"id":/.test(line))
  .map((line) => JSON.parse(line.trim().replace(/,$/, '')));
const META_TEXT = dataText.slice(0, dataText.indexOf('export const LOTS'));
const metaNumber = (key) => Number(new RegExp(`"${key}":\\s*(\\d+)`).exec(META_TEXT)[1]);

// A row re-enters the pipeline through the serialiser, so the proof runs on shipped bytes.
const reflow = (row) => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row }));
const specOfRow = (row) => ({
  w: row.w, h: row.h, mask: parseMask(row.mask, row.w, row.h), pieces: row.pieces.split(''),
});
const placementKey = (list) => list.map((p) => `${p.piece}:${p.variant}@${p.x},${p.y}`).sort().join(' ');
// What js/core/board.js:validatePlacements says about a list that really does tile the box.
const TILED = { ok: true, code: null };

test('the data file is one JSON row per lot, and every row boots', () => {
  eq(FILE_ROWS.length, 30, 'thirty rows sit in js/data/lots.js');
  eq(new Set(FILE_ROWS.map((r) => r.id)).size, 30, 'and no id appears twice');
  eq(campaign().length, FILE_ROWS.length, 'library.js loaded exactly as many levels as the file has');
  for (const row of FILE_ROWS) {
    const lot = byId(row.id);
    assert(lot, `${row.id} is reachable by id`);
    eq(lot.row, row, `${row.id}: the object in memory is the row on disk`);
    eq(lot.source, 'campaign', `${row.id}: stamped as baked content, not generated`);
  }
});

test("META's own numbers match the rows underneath them", () => {
  eq(metaNumber('version'), LOT_VERSION, 'META.version is the version deserialiseLot demands');
  eq(metaNumber('lots'), FILE_ROWS.length, 'META.lots counts the rows');
  eq(metaNumber('bands'), BANDS.length, 'META.bands counts the ladder');
  eq(metaNumber('perBand') * metaNumber('bands'), FILE_ROWS.length, 'and perBand x bands is the campaign size');
  const cells = FILE_ROWS.reduce((a, r) => a + r.k * CELLS, 0);
  eq(metaNumber('cells'), cells, 'META.cells is the total board area of the campaign');
  eq(cells, 900, 'which is 6 lots x (4+5+6+7+8) pieces x 5 cells = 900');
  eq(stats().ruleSet, RULE_SET_VERSION, 'and the depth numbers are stamped with the rule set they belong to');
  eq(stats().frame, [FRAME_W, FRAME_H], 'with the scatter frame that produced them');
});

// ---------------------------------------------------------------------------
// the re-proof, band by band
// ---------------------------------------------------------------------------

// The measurements are kept so the summary rows can talk about them without re-running anything.
const measured = new Map(); // id -> { row, lot, verdict, logic }

for (const band of BANDS) {
  test(`${band.key}: all six lots re-prove from their serialised form`, () => {
    const rows = FILE_ROWS.filter((r) => r.band === band.key);
    eq(rows.length, 6, `${band.key} ships six lots`);
    for (const row of rows) {
      const lot = reflow(row);
      eq(lot.id, row.id, 'deserialising keeps the id');
      eq(serialiseLot(lot), JSON.stringify({ v: LOT_VERSION, ...row }),
        `${row.id}: re-serialising is the identity, so the stored row is in canonical form`);

      // 0. legality.
      const err = validateLevel(lot.spec);
      eq(err, null, `${row.id} is a legal level (${err})`);
      eq(maskCount(lot.spec.mask), row.k * CELLS, `${row.id}: the board area is k x 5`);
      eq(lot.band, band.key, `${row.id} carries the band it was filed under`);
      eq(lot.k, row.k, 'and the piece count it claims');

      // 1. 解数 == 1, bounded and unbounded.
      eq(countSolutions(lot.spec, 2), 1, `${row.id}: dancing links says exactly one cover`);
      const sweep = collectSolutions(lot.spec, { max: 8 });
      eq(sweep.truncated, false, `${row.id}: a cap of eight was never reached, so the sweep was exhaustive`);
      eq(sweep.solutions.length, 1, `${row.id}: enumerated without an early stop, still one cover`);
      const verdict = solveLevel(lot.spec, 2);
      eq(verdict.count, 1, `${row.id}: solveLevel agrees`);
      eq(verdict.capped, false, `${row.id}: and never came near its node cap`);
      eq(verdict.truncated, false, `${row.id}: nor its solution cap`);
      ok(verdict.nodes >= 1, `${row.id}: proving uniqueness cost ${verdict.nodes} node visits`);

      // 2. the shipped placement list IS that cover, geometrically.
      eq(validatePlacements(lot.spec, lot.solution), TILED, `${row.id}: the shipped solution tiles the box`);
      eq(placementKey(verdict.placements), placementKey(lot.solution), `${row.id}: and equals what DLX found`);

      // 3. 推理深度, re-measured on the re-entered spec.
      const logic = logicSolve(lot.spec);
      eq(logic.solved, true, `${row.id}: the reasoning solver finishes it`);
      eq(logic.truncated, false, `${row.id}: without hitting its frame cap`);
      eq(logic.depth, row.depth, `${row.id}: the printed 推理深度 ${row.depth} is what the solver measures again`);
      eq(placementKey(logic.placements), placementKey(lot.solution), `${row.id}: and it finds the shipped solution, not another one`);

      // 4. the label follows the numbers.
      const derived = bandName(row.k, logic.depth);
      assert(derived, `${row.id}: (k=${row.k}, depth=${logic.depth}) lands in some band window`);
      eq(derived.key, row.band, `${row.id}: stamped ${row.band}, derived ${derived.key}`);
      measured.set(row.id, { row, lot, verdict, logic });
    }
  });
}

test('the difficulty ladder is monotone across bands, in the numbers themselves', () => {
  const perBand = BANDS.map((b) => {
    const rows = FILE_ROWS.filter((r) => r.band === b.key);
    const depths = rows.map((r) => r.depth);
    return { key: b.key, min: Math.min(...depths), max: Math.max(...depths), ks: new Set(rows.map((r) => r.k)) };
  });
  for (const b of perBand) {
    const band = bandOf(b.key);
    eq(Array.from(b.ks), [band.k[0]], `${b.key}: every lot in the band has exactly the band's k`);
    assert(b.min >= band.depth[0] && b.max <= band.depth[1], `${b.key}: depths ${b.min}..${b.max} inside ${band.depth}`);
  }
  for (let i = 1; i < perBand.length; i++) {
    assert(perBand[i].min >= perBand[i - 1].min, `${perBand[i].key} does not get easier at the bottom`);
    assert(perBand[i].max > perBand[i - 1].max, `${perBand[i].key} reaches deeper than ${perBand[i - 1].key}`);
  }
  eq(perBand.map((b) => [...b.ks][0]), [4, 5, 6, 7, 8], 'the campaign is a piece-count ladder as well as a depth ladder');
});

test('no two shipped lots are the same puzzle wearing a different id', () => {
  const seen = new Map();
  for (const row of FILE_ROWS) {
    const sig = `${row.pieces.split('').sort().join('')}@${row.mask}`;
    eq(seen.has(sig), false, `${row.id} repeats the board and piece set of ${seen.get(sig)}`);
    seen.set(sig, row.id);
  }
  eq(seen.size, FILE_ROWS.length, 'thirty distinct (board, piece-set) pairs');
});

test('the twelve letters are the only vocabulary, and no lot repeats one', () => {
  for (const row of FILE_ROWS) {
    for (const letter of row.pieces) {
      assert(FULL_SET.includes(letter), `${row.id}: letter ${letter} is a real pentomino`);
    }
    eq(new Set(row.pieces).size, row.pieces.length, `${row.id}: no piece is listed twice`);
  }
  const used = new Set(FILE_ROWS.flatMap((r) => r.pieces.split('')));
  eq(Array.from(used).sort(), FULL_SET.slice().sort(), 'between them the thirty lots use all twelve pieces');
});

// ---------------------------------------------------------------------------
// the gate has to be able to say something other than 1
// ---------------------------------------------------------------------------

test('refutation: erasing a piece from a lot makes it unsolvable, all thirty times', () => {
  // Same board, one fewer piece: the box still has 5k cells and there are now 5(k-1) cells of
  // pieces, so an exact cover is impossible. If this ever returns 1, "解数 == 1" proves nothing.
  // The level validator also catches this statically, which is the belt; the oracle is the braces.
  for (const row of FILE_ROWS) {
    const spec = specOfRow(row);
    spec.pieces = spec.pieces.slice(0, -1);
    const err = validateLevel(spec);
    assert(typeof err === 'string' && new RegExp(`area ${row.k * CELLS} needs ${row.k} pieces, got ${row.k - 1}`).test(err),
      `${row.id}: validateLevel spots the shortfall first — "${err}"`);
    eq(countSolutions(spec, 2), 0, `${row.id}: with one piece erased there is no cover at all`);
  }
});

test('refutation: one cell too much or too little in the box is also unsolvable', () => {
  let checked = 0;
  for (const row of FILE_ROWS) {
    // 5k + 1 cells: no set of k pentominoes covers it, whatever the shapes.
    const bigger = parseMask(row.mask, row.w, row.h);
    let added = -1;
    for (let i = 0; i < bigger.length; i++) if (!bigger[i]) { bigger[i] = 1; added = i; break; }
    assert(added >= 0, `${row.id}: the scatter frame has a free cell to add`);
    eq(countSolutions({ w: row.w, h: row.h, mask: bigger, pieces: row.pieces.split('') }, 2), 0,
      `${row.id}: ${row.k} pieces cannot cover ${maskCount(bigger)} cells`);
    // 5k - 1 cells: same argument on the other side, and the one a mis-typed mask string causes.
    const smaller = parseMask(row.mask, row.w, row.h);
    smaller[added] = 0;
    smaller[smaller.indexOf(1)] = 0;
    eq(maskCount(smaller), row.k * CELLS - 1, `${row.id}: the shrunk box is one cell short`);
    eq(countSolutions({ w: row.w, h: row.h, mask: smaller, pieces: row.pieces.split('') }, 2), 0,
      `${row.id}: and nothing tiles it either`);
    checked++;
  }
  eq(checked, FILE_ROWS.length, 'both directions tried on every row');
});

test('refutation: a duplicated piece makes the count 2, which is why the validator forbids it', () => {
  // Two pieces that happen to be both I pentominoes on a 5x2 strip. Geometry leaves exactly one
  // *shape*: each piece covers one whole row, because a vertical I needs five rows and the strip
  // has two. But the two pieces are two separate exact-cover columns, so the covers are the two
  // assignments of pieces to rows: 2! = 2, by hand.
  const I_H = VARIANTS.I.findIndex((v) => v.bbox.w === 5 && v.bbox.h === 1);
  const I_V = VARIANTS.I.findIndex((v) => v.bbox.w === 1 && v.bbox.h === 5);
  ok(I_H >= 0 && I_V >= 0, 'I has a 5x1 pose and a 1x5 pose, and only one of them fits here');
  const spec = { w: 5, h: 2, mask: fullRect(5, 2), pieces: ['I', 'I'] };
  // The two covers, exhibited by hand through the per-placement geometry check, which is the one
  // gate that does not know about the duplicate letter (validatePlacements refuses the level).
  const top = placementMask(spec, VARIANTS.I[I_H].cells, 0, 0);
  const bottom = placementMask(spec, VARIANTS.I[I_H].cells, 0, 1);
  eq([top.ok, top.cells], [true, [0, 1, 2, 3, 4]], 'cover one puts a piece in the top row');
  eq([bottom.ok, bottom.cells], [true, [5, 6, 7, 8, 9]], 'cover two puts one in the bottom row');
  eq(placementMask(spec, VARIANTS.I[I_V].cells, 0, 0), { ok: false, code: 'out', cells: [0, 5] },
    'and the vertical pose covers two rows then leaves the board: the strip is two rows tall');
  eq(countSolutions(spec, 2), 2, 'so the oracle says 2 and the uniqueness filter fires');
  eq(solveLevel(spec, 2).placements, null, 'solveLevel refuses to hand back "the" solution');
  eq(collectSolutions(spec, { max: 8 }).solutions.map((s) => s.map((p) => `${p.piece}@${p.cells[0]}`).sort().join(' ')).sort(),
    ['0@0 1@5', '0@5 1@0'], 'the two covers are the two assignments of piece to row, and nothing else');
  eq(validateLevel(spec), "piece 'I' appears twice — the twelve pentominoes are distinct",
    'validateLevel rejects the board the game could never ship');
});

test('refutation: lift a piece out of a lot and the rest still packs, so the oracle is not blind', () => {
  // The relaxation a player performs constantly: take one piece away and leave its cells off the
  // board. The cover that remains is the lot's own solution minus that piece, which the test
  // supplies by hand, so the oracle has to find at least one cover on every one of these boards.
  let proven = 0;
  for (const row of FILE_ROWS) {
    const solution = expandSolution(row);
    const drop = solution[solution.length - 1];
    const mask = parseMask(row.mask, row.w, row.h);
    for (const [dx, dy] of VARIANTS[row.pieces[drop.piece]][drop.variant].cells) {
      mask[(drop.y + dy) * row.w + drop.x + dx] = 0;
    }
    const pieces = row.pieces.split('').filter((_, i) => i !== drop.piece);
    const spec = { w: row.w, h: row.h, mask, pieces };
    eq(validateLevel(spec), null, `${row.id}: the de-clued board is still a legal level`);
    const rest = solution.filter((p) => p.piece !== drop.piece);
    eq(validatePlacements(spec, rest), TILED, `${row.id}: the placements left behind still tile it`);
    ok(countSolutions(spec, 2) >= 1, `${row.id}: and the oracle finds at least the cover that is left`);
    proven++;
  }
  eq(proven, FILE_ROWS.length, 'thirty de-clued boards, all of them still solvable');
});

// ---------------------------------------------------------------------------
// routes, serialisation, generated content
// ---------------------------------------------------------------------------

test('specOf and expandSolution turn a row into the shape every other module eats', () => {
  const row = FILE_ROWS[0];
  const spec = specOf(row);
  eq([spec.w, spec.h], [8, 8], 'a baked row is on the 8x8 frame');
  eq(spec.pieces, row.pieces.split(''), 'pieces become a list of letters');
  eq(maskString(spec.mask), row.mask, 'the digit string parses back to itself');
  eq(spec.mask instanceof Uint8Array, true, 'and the mask is bytes, not a string');
  eq(specOf(row), specOf(row), 'twice on the same row gives the same thing, in the same shape');
  eq(expandSolution(row), row.solution.map(([piece, variant, x, y]) => ({ piece, variant, x, y })),
    'a tuple solution expands positionally');
  eq(reflow(row).solution, expandSolution(row), 'which is exactly what deserialiseLot does');
  eq(expandSolution(row).every((p) => Object.keys(p).join(',') === 'piece,variant,x,y'), true,
    'and the expanded form carries nothing else');
});

test('the serialiser refuses rows from another epoch, and hand-edits to the level', () => {
  const row = FILE_ROWS[0];
  throws(() => deserialiseLot(JSON.stringify({ ...row, v: 99 })), /lot version 99 unsupported/, 'a future bake');
  throws(() => deserialiseLot(JSON.stringify(row)), /lot version undefined unsupported/, 'a row with no version');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, pieces: `${row.pieces}Q` })),
    /unknown piece 'Q'/, 'an unknown letter');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, pieces: row.pieces[0] + row.pieces })),
    /appears twice/, 'a doubled letter');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, pieces: '' })),
    /no pieces/, 'no pieces at all');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, mask: maskString(fullRect(row.w, row.h)) })),
    /area 64 is not a multiple of 5/, 'a full 8x8 box for four pieces');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, mask: '0'.repeat(64) })),
    /area 0 needs 0 pieces, got 4/, 'an empty box');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, mask: row.mask.slice(1) })),
    /mask length 63 != 64/, 'a mask string one character short');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, mask: `${row.mask.slice(0, -1)}2` })),
    /mask char 63 is '2'/, 'a mask string with a non-binary character');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, w: 8.5 })),
    /mask length 64 != 68/, 'a fractional width has no mask of the right length any more');
  throws(() => deserialiseLot(JSON.stringify({ v: LOT_VERSION, ...row, w: 21, h: 21, mask: '0'.repeat(441) })),
    /exceeds the 20 limit/, 'a frame edge longer than board.js:MAX_FRAME is a typo, not a level');
  eq(deserialiseLot(serialiseLot(byId(row.id))).id, row.id, 'a clean row still round-trips after all that');
});

test('the serialiser checks the level; the answer is checked by the re-proof, not by the loader', () => {
  // Worth pinning down explicitly, because it decides where a hand-edit gets caught. prepare()
  // validates geometry and vocabulary — enough to boot — and deliberately does not search. The
  // `solution` field is only believed after dancing links and the reasoning solver have both
  // re-derived it, which is what the band rows at the top of this file do.
  const row = FILE_ROWS[0];
  const badVariant = { v: LOT_VERSION, ...row, solution: [[row.solution[0][0], 99, row.solution[0][2], row.solution[0][3]]] };
  const loaded = deserialiseLot(JSON.stringify(badVariant));
  eq(validateLevel(loaded.spec), null, 'the level itself is still legal, so the loader lets it through');
  eq(validatePlacements(loaded.spec, loaded.solution), { ok: false, code: 'bad-variant', piece: row.solution[0][0] },
    'and the answer check is where the lie surfaces');
  const missing = { v: LOT_VERSION, ...row, solution: row.solution.slice(1) };
  const loaded2 = deserialiseLot(JSON.stringify(missing));
  eq(validatePlacements(loaded2.spec, loaded2.solution), { ok: false, code: 'count', piece: null, cell: null },
    'a solution that forgot a piece is a count failure');
  const slid = { v: LOT_VERSION, ...row, solution: row.solution.map((t) => [t[0], t[1], t[2] + 1, t[3]]) };
  const loaded3 = deserialiseLot(JSON.stringify(slid));
  eq(validatePlacements(loaded3.spec, loaded3.solution).ok, false, 'a solution slid one cell right does not tile the box');
  eq(countSolutions(loaded3.spec, 2), 1, 'while the puzzle it came from is still unique — the mask is the puzzle');
  const swapped = { v: LOT_VERSION, ...row, solution: row.solution.map((t) => [t[1], t[0], t[2], t[3]]) };
  const loaded4 = deserialiseLot(JSON.stringify(swapped));
  eq(validatePlacements(loaded4.spec, loaded4.solution).ok, false, 'variant and piece index transposed is not a solution either');
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

test('the campaign ladder walks in band order and stops at both ends', () => {
  eq(ALL.length, 30, 'ALL is the campaign');
  eq(campaign(), ALL, 'campaign() is the same array, not a copy a caller can rot');
  eq(ALL[0].id, 'taster-01', 'the ladder starts at the first taster');
  eq(ALL[ALL.length - 1].band, 'iron', 'and ends in iron');
  eq(prevOf('taster-01'), null, 'nothing before the first lot');
  eq(nextOf('iron-06'), byId('iron-06'), 'and "next" at the end stays put rather than wrapping');
  eq(nextOf('no-such-lot'), ALL[0], 'an unknown id falls back to the start of the campaign');
  eq(prevOf('no-such-lot'), null, 'and backwards from nowhere is nowhere');
  let cursor = ALL[0];
  const walked = [cursor.id];
  for (let i = 0; i < 60; i++) {
    const next = nextOf(cursor.id);
    if (next.id === cursor.id) break;
    walked.push(next.id);
    cursor = next;
  }
  eq(walked.length, 30, 'nextOf visits all thirty lots and then halts');
  eq(walked.map((id) => indexById(id)), ALL.map((_, i) => i), 'indexById agrees with the walk order');
  eq(bands(), BANDS, 'bands() is make.js\'s ladder, not a second table');
  for (const b of BANDS) eq(lotsIn(b.key).length, 6, `${b.key} has six lots`);
  eq(lotsIn('nope'), [], 'and an unknown band is empty, not everything');
});

test('parseRoute takes links apart without judging them', () => {
  eq(parseRoute('#/lot/taster-01'), { parts: ['lot', 'taster-01'], params: {} }, 'a lot link');
  eq(parseRoute(''), { parts: [], params: {} }, 'an empty hash');
  eq(parseRoute('#/'), { parts: [], params: {} }, 'a bare slash is the same thing');
  eq(parseRoute('#/random/abc?band=hard'), { parts: ['random', 'abc'], params: { band: 'hard' } }, 'a pinned band');
  eq(parseRoute('#/random/%E5%8C%A3'), { parts: ['random', '%E5%8C%A3'], params: {} },
    'path segments stay raw — only query values are percent-decoded, so a seed typed into the path is used verbatim');
  eq(parseRoute('#/random?seed=%E5%8C%A3'), { parts: ['random'], params: { seed: '匣' } },
    'and the ?seed= form does decode, which is how a share link round-trips');
  eq(parseRoute('#/random/x?band='), { parts: ['random', 'x'], params: { band: '' } }, 'an empty pin stays empty');
  eq(parseRoute('#/daily?date=2026-03-01'), { parts: ['daily'], params: { date: '2026-03-01' } }, 'a date override');
});

test('resolveRoute turns each documented link into a playable lot', () => {
  const lot = resolveRoute('#/lot/mid-04');
  eq(lot.kind, 'lot', 'a campaign link');
  eq(lot.lot.id, 'mid-04', 'and it found that lot');
  eq(resolveRoute('').lot.id, ALL[0].id, 'no hash at all boots the first lot');
  const missing = resolveRoute('#/lot/does-not-exist');
  eq(missing.lot, null, 'a wrong id is reported, not crashed on');
  eq(missing.missing, 'does-not-exist', 'and says which id');
  eq(resolveRoute('#/nowhere').kind, 'unknown', 'an unknown route kind is its own answer');
  eq(resolveRoute('#/nowhere').lot, null, 'and it carries no level');
  for (const r of [resolveRoute('#/lot/taster-01'), resolveRoute('#/random/abc'), resolveRoute('#/daily?date=2026-03-01')]) {
    eq(validateLevel(r.lot.spec), null, `${r.kind}: the level it hands the UI is legal`);
    eq(countSolutions(r.lot.spec, 2), 1, `${r.kind}: and unique`);
  }
  // A date-less #/daily is today's puzzle, and "today" arrives from the caller: js/core/* may
  // not read a clock, so js/main.js passes the key it read (js/main.js:84).
  eq(resolveRoute('#/daily', '2026-03-04').lot.id, 'daily-daily-2026-03-04', 'the caller-supplied key is the one a bare link gets');
  eq(resolveRoute('#/daily?date=2026-03-05', '2026-03-04').lot.dateKey, '2026-03-05', 'and a date written into the link wins over it');
  throws(() => resolveRoute('#/random/abc?band=nonsense'), /known band/,
    'a pinned band that does not exist throws: silently ignoring it would lie about difficulty');
});

test('a date link and a daily link resolve to the same puzzle', () => {
  const key = '2026-03-01';
  const byDate = resolveRoute(`#/lot/${key}`);
  const byDaily = resolveRoute(`#/daily?date=${key}`);
  eq(byDate.kind, 'lot', 'the date pattern is what makes a #/lot/ link a daily');
  eq(byDate.lot.dateKey, key, 'and it remembers which day');
  eq(maskString(byDaily.lot.spec.mask), maskString(byDate.lot.spec.mask), 'same box');
  eq(byDaily.lot.solution, byDate.lot.solution, 'same solution');
  eq(byDaily.lot.band, byDate.lot.band, 'same band');
  eq(byDaily.lot.title, `每日匣 · ${key}`, 'and the title says which date');
  eq(byDaily.lot.source, 'daily', 'both links hand back generated content, not a baked row');
});

test('the daily puzzle is a function of the calendar key and nothing else', () => {
  const key = '2026-03-01';
  const a = dailyLot(key);
  const b = dailyLot(key);
  eq(serialiseLot(a), serialiseLot(b), 'two calls on the same key give byte-identical lots');
  eq(samePlacements(a.solution, b.solution), true, 'and the same answer, read as placements rather than as JSON');
  eq(a.source, 'daily', 'and it is stamped as generated, not as campaign');
  eq(a.seed, `daily-${key}`, 'the seed carries the date, so a shared date is a shared puzzle');
  eq(a.id, `daily-daily-${key}`, 'the id is built from that seed, which is what it says on the tin');
  eq(a.band, bandForDay(key), 'the band is the day\'s slot in the rotation');
  const band = bandOf(a.band);
  assert(a.k >= band.k[0] && a.k <= band.k[1], `k=${a.k} inside the ${a.band} window`);
  assert(a.depth >= band.depth[0] && a.depth <= band.depth[1], `depth=${a.depth} inside the ${a.band} window`);
  eq(validateLevel(a.spec), null, 'the generated box is a legal level');
  eq(validatePlacements(a.spec, a.solution), TILED, 'the generated answer really tiles it');
  eq(countSolutions(a.spec, 2), 1, 'and it is unique, which is the generator\'s own post-condition');
  eq(logicSolve(a.spec).depth, a.depth, 'and its printed depth re-measures the same');
  eq(a.stats.accepted, 1, 'the loop accepted exactly one candidate');
  eq(a.stats.attempts >= a.stats.evaluated, true, 'attempts is the outer count and evaluated the inner one');
  ok(a.stats.maxDlxNodes >= 1, `the accepted candidate cost ${a.stats.maxDlxNodes} DLX nodes at worst`);
});

test('different calendar keys give different dailies, and the band walks the year', () => {
  const sigs = new Set();
  for (let d = 1; d <= 24; d++) {
    const key = `2026-03-${String(d).padStart(2, '0')}`;
    const lot = dailyLot(key);
    eq(lot.dateKey, key, `${key} remembers its own date`);
    sigs.add(`${maskString(lot.spec.mask)}|${lot.spec.pieces.join('')}`);
  }
  eq(sigs.size, 24, 'twenty-four consecutive days are twenty-four different boxes');
  const seen = new Set();
  for (let d = 1; d <= 365; d++) {
    const t = new Date(Date.UTC(2026, 0, 1 + d));
    const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
    seen.add(bandForDay(key));
  }
  eq(Array.from(seen).sort(), BANDS.map((b) => b.key).sort(), 'all five bands appear during a year');
  eq(bandForDay('nonsense'), BANDS[0].key, 'a key that is not a date still gets a band, the first one');
  eq(bandForDay('2026-03-01'), bandForDay('2026-03-01'), 'and the mapping is a function of its argument');
});

test('randomLot keeps the promise a shared link makes', () => {
  const a = randomLot('abc');
  const b = randomLot('abc');
  eq(serialiseLot(a), serialiseLot(b), 'the same seed twice, the same box twice');
  eq(a.source, 'rand', 'stamped as random');
  eq(a.seed, 'abc', 'and the seed is the link\'s own text');
  eq(resolveRoute('#/random/abc').lot.id, a.id, 'the route and the function agree');
  eq(resolveRoute('#/random?seed=abc').lot.id, a.id, 'a ?seed= link is the same puzzle');
  const pinned = randomLot('abc', 'iron');
  eq(pinned.band, 'iron', 'an explicit band pin is honoured');
  eq(pinned.spec.pieces.length, 8, 'and the level really is eight pieces');
  assert(maskString(pinned.spec.mask) !== maskString(a.spec.mask), 'a pinned band changes the puzzle, so the pin is not decoration');
  const others = new Set();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) others.add(maskString(randomLot(seed).spec.mask));
  ok(others.size >= 6, `eight seeds give mostly-different boards (${others.size} distinct of 8)`);
  for (const band of BANDS) {
    const lot = randomLot('probe', band.key);
    eq(lot.band, band.key, `${band.key} is reachable from a link`);
    eq(countSolutions(lot.spec, 2), 1, `${band.key} from a link is still unique`);
    eq(logicSolve(lot.spec).depth, lot.depth, `${band.key} from a link prints a depth that re-measures`);
  }
});

test('stats() reports the campaign it is asked about, including the lying-label counter', () => {
  const s = stats();
  eq(s.mislabelled, 0, 'no row\'s band key disagrees with the (k, depth) window beside it');
  eq(Object.keys(s.bands).sort(), BANDS.map((b) => b.key).sort(), 'every band is represented');
  for (const b of BANDS) {
    const rows = FILE_ROWS.filter((r) => r.band === b.key);
    eq(s.bands[b.key].n, 6, `${b.key} counts six lots`);
    eq(s.bands[b.key].min, Math.min(...rows.map((r) => r.depth)), `${b.key} min depth`);
    eq(s.bands[b.key].max, Math.max(...rows.map((r) => r.depth)), `${b.key} max depth`);
    eq(Object.keys(s.bands[b.key].ks), [String(rows[0].k)], `${b.key} spans one piece count only`);
    eq(s.bands[b.key].avg, Math.round((rows.reduce((x, r) => x + r.depth, 0) / 6) * 100) / 100, `${b.key} mean depth`);
  }
  const depths = FILE_ROWS.map((r) => r.depth).sort((x, y) => x - y);
  eq(s.depth.min, depths[0], 'the printed range starts where the data does');
  eq(s.depth.max, depths[depths.length - 1], 'and ends where it ends');
  eq(s.depth.med, depths[Math.floor(depths.length / 2)], 'including the median');
  eq(s.bands.iron.min >= s.bands.taster.max, true, 'and the ladder does not invert between rungs');
});

test('what one click costs, measured on the shipped data', () => {
  // The front end never searches (DESIGN.md 2.4): completion is a lookup against the baked
  // solution. So the only search a tap can trigger is this file's re-proof, and its worst case
  // is the number a phone would pay if the game ever did have to check a placement.
  eq(FILE_ROWS.filter((r) => measured.has(r.id)).length, 30, 'every lot reached the end of its own re-proof row');
  const nodes = FILE_ROWS.map((r) => measured.get(r.id).verdict.nodes);
  const frames = FILE_ROWS.map((r) => measured.get(r.id).logic.frames);
  eq(nodes.length, 30, 'every lot was measured by the re-proof above');
  eq(frames.length, 30, 'and reasoned about too');
  ok(Math.max(...nodes) < 5000, `the most expensive uniqueness proof costs ${Math.max(...nodes)} node visits`);
  ok(Math.max(...frames) < 1000, `the deepest reasoning search used ${Math.max(...frames)} assumption frames`);
  const taster = FILE_ROWS.filter((r) => r.band === 'taster').map((r) => measured.get(r.id).verdict.nodes);
  const iron = FILE_ROWS.filter((r) => r.band === 'iron').map((r) => measured.get(r.id).verdict.nodes);
  ok(Math.max(...iron) > Math.max(...taster), `iron boxes cost more to prove (${Math.max(...iron)} vs ${Math.max(...taster)} nodes)`);
});

process.exitCode = run();
