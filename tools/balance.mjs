// tools/balance.mjs — the generator's yield, measured over many independent draws.
//
// js/core/make.js builds a 匣 by packing pieces at random and then *proves* the result is unique
// with dancing links. That makes the generator's yield a probability with an obvious meaning:
//
//     uniquenessRate = P(the random packing is the only one)  = unique   / evaluated
//     yieldRate      = P(an attempt becomes an accepted level) = accepted / attempts
//
// A single makeLevel() call cannot report either honestly (make.js says so at js/core/make.js:220),
// so this file folds many independent one-attempt draws through yieldOf() — the same arithmetic the
// acceptance test uses, from the same exported function, so the two cannot disagree about the
// denominator.
//
//   node tools/balance.mjs              full sweep: 5 bands x 3 biases x 300 draws
//   node tools/balance.mjs --check      reduced sweep (40 draws, each cell run twice) plus the
//                                       assertions; this is what `npm run balance -- --check` gates
//   DRAWS=60 BIAS=0,2 K=iron node tools/balance.mjs     narrower sweep
//
// `--check` asserts only integer facts: the two accounting identities, that every band is
// reachable at every bias, that the depth histogram moves right as k grows, that no draw ever hit
// the DLX node cap or the reasoning frame cap, and that a repeated sweep is byte-identical.
// Wall-clock is printed as a reading of this machine and is never part of a verdict.

import { BANDS, makeLevel, yieldOf } from '../js/core/make.js';
import { renderMask } from '../js/core/board.js';
import { countSolutions } from '../js/core/dlx.js';

const env = (key, dflt) => (process.env[key] === undefined || process.env[key] === '' ? dflt : process.env[key]);
const CHECK = process.argv.includes('--check');
const DRAWS = Number(env('DRAWS', CHECK ? 40 : 300));
const BISES = String(env('BIAS', '0,2,4')).split(',').map(Number);
const KEYS = String(env('K', BANDS.map((b) => b.key).join(','))).split(',');
const MAX_NODES = 20000000;      // js/core/dlx.js's own default guard
const MAX_FRAMES = 60000;        // makeLevel's default logic frame cap
const FUSE_MS = Number(env('FUSE_MS', CHECK ? 120000 : 900000));
const t0 = Date.now();

const EMPTY = {
  attempts: 0, deadEnds: 0, disconnected: 0, evaluated: 0, notUnique: 0,
  bandRejects: 0, logicTruncated: 0, accepted: 0, maxDlxNodes: 0, maxLogicFrames: 0,
};
const merge = (a, b) => {
  const out = { ...a };
  for (const key of Object.keys(EMPTY)) {
    if (key.startsWith('max')) out[key] = Math.max(a[key], b[key]);
    else out[key] = a[key] + b[key];
  }
  return out;
};

function sweep(seedTag) {
  const cells = [];
  for (const band of BANDS.filter((b) => KEYS.includes(b.key))) {
    for (const bias of BISES) {
      let total = { ...EMPTY };
      const hist = {};
      const ids = [];
      for (let i = 0; i < DRAWS; i++) {
        const made = makeLevel({ seed: `${seedTag}|${band.key}|${bias}|${i}`, band: band.key, bias, maxAttempts: 1 });
        total = merge(total, made.stats);
        if (made.ok) {
          hist[made.depth] = (hist[made.depth] || 0) + 1;
          ids.push(made.seed);
        } else if (made.stats.timeOut) {
          throw new Error(`draw ${band.key}/${bias}/${i} reported a deadline it was never given`);
        }
      }
      cells.push({ band, bias, total, hist, ids, rates: yieldOf(total) });
    }
  }
  return cells;
}

// The same seeds with the depth window opened all the way: `hist` above only ever sees levels that
// already passed the band's window, so a "depth grows with k" claim read off it is a restatement of
// the window, not a measurement. These are the raw measured depths of *unique* random levels, which
// is what the windows in js/core/make.js:BANDS were chosen against.
function rawSweep(seedTag) {
  const out = [];
  for (const band of BANDS.filter((b) => KEYS.includes(b.key))) {
    for (const bias of BISES) {
      const hist = {};
      let unique = 0;
      let attempts = 0;
      for (let i = 0; i < DRAWS; i++) {
        attempts++;
        const made = makeLevel({
          seed: `${seedTag}|${band.key}|${bias}|${i}`, k: band.k[0], bias,
          depth: [0, Infinity], maxAttempts: 1,
        });
        if (made.ok) { unique++; hist[made.depth] = (hist[made.depth] || 0) + 1; }
      }
      out.push({ band, bias, hist, unique, attempts });
    }
  }
  return out;
}

const fmtHist = (hist) => {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  return keys.length ? keys.map((d) => `${d}:${hist[d]}`).join(' ') : '(none)';
};

function report(cells) {
  console.log(`balance: ${DRAWS} one-attempt draws per cell, biases [${BISES.join(', ')}], bands [${KEYS.join(', ')}]`);
  console.log('band  k  bias  attempts  evaluated   unique  accepted   P(unique)   yield   deadEnds  disc.  notUniq  bandRej  trunc   maxNodes  maxFrames  depth histogram');
  for (const c of cells) {
    const t = c.total;
    const pct = (x) => (x * 100).toFixed(1).padStart(5);
    console.log(
      `${c.band.key.padEnd(6)} ${String(c.band.k[0]).padStart(2)}  ${String(c.bias).padStart(3)}`
      + `  ${String(t.attempts).padStart(9)}  ${String(t.evaluated).padStart(9)}`
      + `  ${String(c.rates.unique).padStart(9)}  ${String(t.accepted).padStart(9)}`
      + `  ${pct(c.rates.uniquenessRate)}%  ${pct(c.rates.yieldRate)}%`
      + `  ${String(t.deadEnds).padStart(8)}  ${String(t.disconnected).padStart(5)}`
      + `  ${String(t.notUnique).padStart(6)}  ${String(t.bandRejects).padStart(7)}  ${String(t.logicTruncated).padStart(5)}`
      + `  ${String(t.maxDlxNodes).padStart(9)}  ${String(t.maxLogicFrames).padStart(9)}  ${fmtHist(c.hist)}`,
    );
  }
  return cells;
}

const cells = report(sweep(CHECK ? 'check' : 'sweep'));
const raw = rawSweep(CHECK ? 'check' : 'sweep');
console.log('window-free (the measurement the BANDS windows were read off) — depths of unique random levels:');
for (const c of raw) {
  console.log(`  k=${c.band.k[0]} bias ${c.bias}: ${c.unique}/${c.attempts} unique  ${fmtHist(c.hist)}`);
}

// A wall-clock reading of this machine, deliberately not compared against anything.
const perAccepted = cells.reduce((a, c) => a + c.total.accepted, 0);
console.log(`observed: ${((Date.now() - t0) / 1000).toFixed(1)} s for ${cells.reduce((a, c) => a + c.total.attempts, 0)} attempts`
  + ` (${perAccepted} accepted levels) on ${process.platform}; not a promise about anyone else's hardware`);

if (!CHECK) process.exit(0);

const fails = [];
const need = (cond, msg) => { if (!cond) fails.push(msg); };
for (const c of cells) {
  const t = c.total;
  need(t.evaluated === t.attempts - t.deadEnds - t.disconnected,
    `${c.band.key}/bias ${c.bias}: evaluated != attempts - deadEnds - disconnected (${t.evaluated} vs ${t.attempts} - ${t.deadEnds} - ${t.disconnected})`);
  need(c.rates.unique === t.accepted + t.bandRejects + t.logicTruncated,
    `${c.band.key}/bias ${c.bias}: unique != accepted + bandRejects + logicTruncated (${c.rates.unique} vs ${t.accepted} + ${t.bandRejects} + ${t.logicTruncated})`);
  need(t.accepted > 0, `${c.band.key}/bias ${c.bias}: no draw was accepted, so this rung of the ladder is unreachable`);
  need(t.maxDlxNodes < MAX_NODES, `${c.band.key}/bias ${c.bias}: the DLX node cap was reached (${t.maxDlxNodes})`);
  need(t.maxLogicFrames < MAX_FRAMES, `${c.band.key}/bias ${c.bias}: the reasoning frame cap was reached (${t.maxLogicFrames})`);
  need(t.notUnique > 0, `${c.band.key}/bias ${c.bias}: nothing was ever rejected as non-unique, so the uniqueness proof is not discriminating`);
}
// The direction claim the band windows are built on: measured depth drifts right as k grows.
// Computed on the window-free sweep, so it is a measurement and not a restatement of the windows.
for (const bias of BISES) {
  const means = raw.filter((c) => c.bias === bias).map((c) => {
    const sum = Object.entries(c.hist).reduce((a, [d, k]) => a + Number(d) * k, 0);
    return { key: c.band.key, k: c.band.k[0], mean: c.unique ? sum / c.unique : NaN };
  });
  for (let i = 1; i < means.length; i++) {
    need(Number.isFinite(means[i].mean) && means[i].mean > means[i - 1].mean,
      `bias ${bias}: mean measured depth did not rise from k=${means[i - 1].k} to k=${means[i].k}`
      + ` (${means[i - 1].mean.toFixed(2)} -> ${means[i].mean.toFixed(2)})`);
  }
}
// Determinism, asserted on the rig's own output rather than trusted: a second sweep of the same
// seeds must print the same histograms, in both shapes.
const again = sweep(CHECK ? 'check' : 'sweep');
const againRaw = rawSweep(CHECK ? 'check' : 'sweep');
const shape = (list) => list.map((c) => `${c.band.key}/${c.bias} ${fmtHist(c.hist)} n=${c.total ? c.total.accepted : c.unique}`).join('|');
need(shape(again) === shape(cells), 'a repeated sweep over the same seeds printed a different histogram');
need(shape(againRaw) === shape(raw), 'and the window-free sweep is not reproducible either');

// renderMask is documented as the rig's and test failures' view of a board (js/core/board.js:165).
if (fails.length) {
  const first = cells.find((c) => c.ids.length);
  if (first) {
    const made = makeLevel({ seed: first.ids[0], band: first.band.key, bias: first.bias, maxAttempts: 1 });
    console.log(renderMask(made.spec));
  }
}
console.log(fails.length ? `FAIL balance --check: ${fails.length} breach(es)\n  - ${fails.join('\n  - ')}` : `balance --check: ${cells.length} cells, 0 breaches`);
process.exit(fails.length ? 1 : 0);
