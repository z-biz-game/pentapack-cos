// The external anchor, as a command.
//
//   node tools/proof.mjs              # the four published rectangle counts, with timings
//   FULL=1 node tools/proof.mjs       # additionally re-count every shipped lot twice over
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// js/core/dlx.js is this game's only difficulty oracle: "解数 = 1" is a claim about a matrix,
// and every band label on screen is derived from it. A counter that agrees with the generator
// that used it proves nothing on its own — both could be wrong together. So the counter is
// reconciled against numbers that were published before this repository existed and that nobody
// here computed: the number of ways to pack all twelve pentominoes into a rectangle,
//
//   3x20 = 2   4x15 = 368   5x12 = 1010   6x10 = 2339
//
// Those are counts of solutions *up to the symmetries of the rectangle*, which is why the raw
// enumeration has to be quotiented by frameSymmetries() before it can be compared: the raw count
// of any non-square rectangle is a multiple of four, and 2339 being odd is itself proof that the
// published figures are orbits, not raw covers. A piece set that is wrong in one place cannot
// produce all four numbers — the draft with two Ns and no V totals 61 variants and returns 0 for
// 3x20 and 2712 for 4x15.
//
// test/anchor.test.mjs asserts these four values in CI; this file is the same computation
// printed, so the table in README.md is regenerated with one command instead of copied by hand.
// The digest column is the dancing-links bookkeeping audit: cover/uncover must leave the matrix
// byte-identical, or a second count of the same problem would silently be counting a damaged
// matrix — which is exactly the failure a hand-written UI would never notice.

import { FULL_SET } from '../js/core/pieces.js';
import { fullRect, frameSymmetries, countOrbits } from '../js/core/board.js';
import { collectSolutions, searchCount, packProblem, matrixDigest, isMatrixClean } from '../js/core/dlx.js';
import { campaign } from '../js/core/library.js';

// The published figures, with the raw cover count each implies (4 orbits' worth, since no
// solution of these four boards is invariant under a non-trivial symmetry of the frame).
export const ANCHORS = [
  { w: 3, h: 20, orbits: 2, raw: 8 },
  { w: 4, h: 15, orbits: 368, raw: 1472 },
  { w: 5, h: 12, orbits: 1010, raw: 4040 },
  { w: 6, h: 10, orbits: 2339, raw: 9356 },
];

// The twelve pentominoes over the whole rectangular frame: the board the published counts are
// about, in the shape js/core/dlx.js takes.
export function rectSpec(w, h) {
  return { w, h, mask: fullRect(w, h), pieces: FULL_SET.slice() };
}

// proveRect(anchor) -> the measurement for one published figure.
//
// opts.recount (default true) walks the whole tree a second time and demands the same number.
// That is the claim a human wants to see printed, but it doubles the cost, and it is the *weaker*
// form of the same fact: `clean` inspects the matrix itself and proves that cover/uncover left it
// byte-identical, which is precisely why a second sweep could not return anything else. So
// test/anchor.test.mjs passes recount:false and asserts the digest, while this file run by hand
// pays for both.
export function proveRect(anchor, opts = {}) {
  const spec = rectSpec(anchor.w, anchor.h);
  const problem = packProblem(spec);
  const before = matrixDigest(problem);
  const t0 = Date.now();
  const sweep = collectSolutions(problem, { max: opts.max || 40000 });
  const syms = frameSymmetries(anchor.w, anchor.h);
  const { raw, orbits } = countOrbits(syms, sweep.solutions);
  // The same problem, counted again: if the sweep had leaked a cover, this number would move.
  const again = opts.recount === false ? null : searchCount(problem, { limit: Infinity }).count;
  const ms = Date.now() - t0;
  const clean = isMatrixClean(problem, before);
  const bounded = searchCount(problem, { limit: 2 });
  return {
    board: `${anchor.w}x${anchor.h}`,
    orbits,
    wantOrbits: anchor.orbits,
    raw,
    wantRaw: anchor.raw,
    truncated: sweep.truncated,
    nodes: sweep.nodes,
    ms,
    recount: again,
    clean,
    // The limit=2 gate must reject a many-solution board after two covers, i.e. in a small
    // fraction of the full sweep's work — that is what makes countSolutions(spec, 2) cheap
    // enough to be the generator's uniqueness filter.
    boundedCount: bounded.count,
    boundedNodes: bounded.nodes,
    earlyReturn: bounded.nodes * 10 < sweep.nodes,
    ok: !sweep.truncated && orbits === anchor.orbits && raw === anchor.raw
      && (again === null || again === raw) && clean && bounded.count === 2,
  };
}

const rows = ANCHORS.map((anchor) => {
  const r = proveRect(anchor);
  process.stdout.write(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.board.padEnd(6)} orbits ${String(r.orbits).padStart(5)} (published ${String(r.wantOrbits).padStart(5)})`
    + ` | raw ${String(r.raw).padStart(5)} = orbits x 4`
    + ` | recount ${String(r.recount).padStart(5)} | digest ${r.clean ? 'clean' : 'MOVED'}`
    + ` | nodes ${String(r.nodes).padStart(8)}`
    + ` | limit=2 -> ${r.boundedCount} in ${String(r.boundedNodes).padStart(6)} nodes (${r.earlyReturn ? 'early' : 'NOT early'})`
    + ` | ${r.ms}ms\n`,
  );
  return r;
});

if (process.env.FULL) {
  // Re-count every shipped lot with the code path that just reproduced published
  // combinatorics, twice, and confirm the matrix survives each search byte-for-byte.
  const lots = campaign();
  let bad = 0;
  for (const lot of lots) {
    const problem = packProblem(lot.spec);
    const before = matrixDigest(problem);
    const a = searchCount(problem, { limit: 2 });
    const b = searchCount(problem, { limit: 2 });
    if (a.count !== 1 || b.count !== 1 || matrixDigest(problem) !== before) {
      bad++;
      process.stdout.write(`FAIL ${lot.id}: count ${a.count}/${b.count} digest ${before}/${matrixDigest(problem)}\n`);
    }
  }
  process.stdout.write(`shipped lots: ${lots.length} re-counted twice, ${bad} wrong\n`);
  if (bad) process.exitCode = 1;
}

const failed = rows.filter((r) => !r.ok);
process.stdout.write(`anchors: ${rows.length} fail: ${failed.length}\n`);
if (failed.length) process.exitCode = 1;
