#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real server,
# driven over CDP. Everything this script starts exits with the script, including the Chrome,
# and the script says so out loud instead of leaving a headless process behind.
#
# PORTS: web 5197, devtools 9357. They must NOT collide with the sibling repos in this series
# (gridlock and pocket-cube both default to :5180/:9340, the batch runs :5185-:5196 /
# :9345-:9356) — a collision is not a nuisance, it is a false verdict, because the driver
# would attach to somebody else's Chrome and read a page that is not this game.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process will not exit
# on its own. This game is 2D canvas, so plain headless Chrome is enough — one instance, ever:
# the browser suites share the single tab this script opens and run one at a time in order.
#
#   bash tools/verify.sh                       # node suites + @boot @play @routes @save @pointer
#   SCENARIOS="pointer" bash tools/verify.sh   # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh           # browser only (what the CI browser job runs)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9357}
WEB_PORT=${WEB_PORT:-5197}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
TAG=pentapack
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# Refuse *before* the run, not after it. If something already listens on either port, the waiting
# loops below would succeed against that other process: the driver would drive a browser that did
# not start with this checkout, the leaked process would then be blamed on the run, and the verdict
# would be a guess. (This actually happened: a throwaway probe left a Chrome on :9357 and a server
# on :5197, and the suite reported 20/20 rows for a page it never launched.)
#
# A TCP connect, not an HTTP probe: the question is "is this port taken", and a listener that
# answers 404 to /json/version is still somebody else's listener. node is already a hard
# requirement for this script, and `net.connect` works the same on macOS and on the CI runner
# (lsof is not guaranteed there).
busy() {
  node -e 'const net = require("node:net"); const p = Number(process.argv[1]);
    const s = net.connect(p, "127.0.0.1");
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 800);' "$1"
}
owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -3; }
if busy "$CDP_PORT"; then
  echo "port $CDP_PORT is already listening; refusing to drive someone else's Chrome" >&2
  echo "  owner: $(owner "$CDP_PORT")" >&2
  exit 6
fi
if [ "$BASE" = "http://127.0.0.1:$WEB_PORT/" ] && busy "$WEB_PORT"; then
  echo "port $WEB_PORT is already listening; refusing to test through someone else's server" >&2
  echo "  owner: $(owner "$WEB_PORT")" >&2
  exit 6
fi

# A throwaway profile: --user-data-dir is the only way to be sure a warm profile from someone
# else's Chrome session cannot make this run hang on a "restore pages?" bubble.
# The template must carry the X's inline: GNU `mktemp -d -t pentapack` aborts with "too few X's"
# (that is exactly how the CI browser job died on 2026-09-28 — macOS accepts it, Linux does not,
# so the run failed before Chrome was even launched and reported "devtools never bound").
UDD=$(mktemp -d "${TMPDIR:-/tmp}/$TAG.XXXXXXXX")
# Fail here rather than three minutes from now: an empty $UDD would leave `--user-data-dir=`
# pointing at nothing, and the run would end as "devtools never bound" with no hint of why.
[ -d "$UDD" ] || { echo "could not create a throwaway profile dir: '$UDD'" >&2; exit 7; }
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=980,760 --no-first-run --no-default-browser-check about:blank >/tmp/$TAG-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/$TAG-server.log 2>&1 &
SPID=$!
CHROME_GONE=0
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  # `wait` is what reaps them; without it the processes stay as zombies and the pipeline never
  # sees the run finish.
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# runs inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on both
# endpoints rather than guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
  # tools/check.mjs is the layering gate: no dependencies, no DOM and no clock inside js/core,
  # no import that points at a file that is not there. The suites cannot see any of that, because
  # a suite only ever reads the files it imports itself.
  echo "--- tools/check.mjs"
  node tools/check.mjs || FAILED=1
  # The generator's yield is a probability, so it needs many draws, which no single-call test can
  # give it. tools/balance.mjs --check folds 40 one-attempt draws per (band, bias) cell through
  # yieldOf() and asserts the accounting identities, that every rung is reachable at every bias,
  # that measured depth really moves right with k, that no draw grazed a cap, and that a repeated
  # sweep prints the same histograms. It prints no `rows:` line, so it adds nothing to the sum.
  echo "--- tools/balance.mjs --check"
  # BALANCE_RC, not the pipeline's tail: `| tail` would report awk's success, and a red rig would
  # look like a green line. The rc is printed into the log so the artifact names its own gate.
  node tools/balance.mjs --check > /tmp/penta-balance.log 2>&1
  BALANCE_RC=$?
  tail -1 /tmp/penta-balance.log
  echo "balance rc: $BALANCE_RC"
  [ "$BALANCE_RC" = "0" ] || FAILED=1
  # tools/doctest.mjs is the sixth gate: every recomputable number README and DESIGN print is
  # re-derived from the code or from a live re-run, so a doc that drifts from the tree goes red.
  # It pins its own size (groups x rows per group x total), so the two EXPECT_* values below are
  # not decoration: dropping an assertion without re-pinning turns the grep red, and so does
  # quietly shrinking the gate to a subset. DOCTEST_RC for the same reason as BALANCE_RC.
  echo "--- tools/doctest.mjs"
  DOCTEST_GROUPS_EXPECT=${DOCTEST_GROUPS_EXPECT:-15}
  DOCTEST_ROWS_EXPECT=${DOCTEST_ROWS_EXPECT:-207}
  node tools/doctest.mjs > /tmp/penta-doctest.log 2>&1
  DOCTEST_RC=$?
  tail -3 /tmp/penta-doctest.log
  grep -q "^pin: groups=$DOCTEST_GROUPS_EXPECT rows=$DOCTEST_ROWS_EXPECT" /tmp/penta-doctest.log \
    || { echo "doctest pin mismatch: expected groups=$DOCTEST_GROUPS_EXPECT rows=$DOCTEST_ROWS_EXPECT" >&2; DOCTEST_RC=1; }
  echo "doctest rc: $DOCTEST_RC"
  [ "$DOCTEST_RC" = "0" ] || FAILED=1
else
  echo "(skipped: SKIP_UNIT=1)"
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is a table of measurements and the shell resolves a route before it reports a
# state, so wait on window.pentapack rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.pentapack?window.pentapack.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.pentapack never appeared at $BASE" >&2; exit 5; }

for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  node tools/playtest.mjs eval "@$s" nonav 2>&1 | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-400:]); sys.exit(1)
# raw_decode, not a brace count: the rows carry Chinese text and nested detail objects, and a
# detail whose text contains an unbalanced "{" makes a hand-rolled count never return to zero —
# the suite then dies with a NameError inside the aggregator and reports no verdict at all.
dec = json.JSONDecoder()
try:
    d, _end = dec.raw_decode(raw, start)
except Exception as e:
    print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
rows = d.get("rows", [])
fails = d.get("fail") or []
print("rows: %d fail: %d" % (len(rows), len(fails)))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if fails else 0)
' || FAILED=1
  node tools/playtest.mjs shot "/tmp/$TAG-$s.png" >/dev/null 2>&1
done

echo "=== console (must be empty of errors) ==="
node tools/playtest.mjs logs | tee /tmp/$TAG-console.txt
# A clean console is part of green, not a footnote: a swallowed exception in the module graph
# would otherwise show up only as a missing window.pentapack.
if grep -qiE "\[error\]|\[EXCEPTION\]|\[warning\]|\[log:[a-z]+\]|uncaught|typeerror|referenceerror" /tmp/$TAG-console.txt; then
  echo "console not clean" >&2; FAILED=1
fi

kill $WD 2>/dev/null
wait $WD 2>/dev/null
cleanup
# Confirm the browser really is gone before claiming success — a leaked headless Chrome eats
# the machine for every later run in this repo farm.
for i in $(seq 1 20); do
  if ! pgrep -f "remote-debugging-port=$CDP_PORT" >/dev/null 2>&1; then CHROME_GONE=1; break; fi
  sleep 0.25
done
if [ "$CHROME_GONE" != "1" ]; then
  echo "chrome did not exit (port $CDP_PORT still owned); refusing to claim green" >&2
  FAILED=1
else
  echo "chrome exited"
fi
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
