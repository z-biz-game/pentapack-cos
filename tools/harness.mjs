// Micro test harness (same shape as the rest of the z-biz-game family).
//
// The contract this file implements, which both the node suites and the browser suites
// written against it must satisfy:
//   * export test / it / ok / eq / fail / run
//   * `import { test, it, ok, assert, eq, run } from '<path>/tools/harness.mjs'`
//   * a test fails by throwing: `ok(cond, msg)` / `assert(cond, msg)` / `eq(a, b, msg)`
//   * run() RETURNS the process exit code — it must not call process.exit itself, because
//     the browser harness collects rows over CDP and only the Node suites exit the process
//   * the final line is exactly `rows: <count> fail: <count>`, so tools/verify.sh can sum
//     node and browser suites with one grep. A suite that prints an extra "failures:" line
//     gets double-counted, so it does not print one.
//
// Every z-biz-game-cos repo ships this file unchanged, so a suite written for one repo runs
// in another: `run()` and the `rows:` line are shared.

// One more contract, specific to how this repository is run in CI: the suites are executed both
// as plain programs (`node test/x.test.mjs`, which is what tools/verify.sh loops over) *and*
// under `node --test test/`. The runner only counts what was registered through `node:test`, so
// a file that just prints rows is reported as one anonymous pass — a suite of 12 assertions and
// a suite of 1 look identical. Under the runner (the child it spawns is the only place
// `NODE_TEST_CONTEXT` is set) every recorded row is therefore replayed as a named `node:test`
// case carrying that row's own verdict, so the two invocations report the same list of names
// instead of two different measurements. Run directly, nothing is imported-and-registered and
// the output stays the plain `rows:` shape.
import { test as nodeCase } from 'node:test';

const underNodeTest = !!process.env.NODE_TEST_CONTEXT;

const rows = [];

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export const it = test;

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

// `assert` is the same predicate as `ok`; both names are exported because suites read
// better with one or the other and a shared harness must not force a style.
export const assert = ok;

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

export function getRows() {
  return rows;
}

// -> exit code (0 = green). Callers that run in a process do `process.exitCode = run()`, which
// is also what makes a failing row fail `node --test` rather than only printing red text.
export function run() {
  const tally = getRows();
  const bad = tally.filter((r) => !r.pass);
  for (const r of tally) {
    console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  }
  console.log(`rows: ${tally.length} fail: ${bad.length}`);
  if (underNodeTest) {
    for (const r of tally) {
      nodeCase(r.test, () => {
        if (!r.pass) throw new Error(r.detail);
      });
    }
  }
  return bad.length ? 1 : 0;
}
