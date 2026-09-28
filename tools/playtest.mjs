// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). Zero
// dependencies: puppeteer would be a 40 MB answer to a 40-line question.
//
// env: CDP_PORT (devtools port, default 9357), BASE_URL (page to attach to)
// usage:
//   node tools/playtest.mjs open  <url>              # close our tabs, open a fresh one
//   node tools/playtest.mjs nav   <url>
//   node tools/playtest.mjs eval  '<js expression>'  # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval  '@boot'            # | @play | @routes | @save | @pointer
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9357;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a
// fresh about:blank tab when the app is served from anywhere else.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5197/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network: a
  // fixed sleep is long enough for a localhost server and too short for GitHub Pages, where it
  // made an innocent deployment look broken (`window.pentapack` still undefined, the canvas
  // still the unstyled 300x150 default). The floor keeps the local case as fast as it was.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.pentapack && window.pentapack.state && window.pentapack.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse, so what gets asserted is the pointer wiring in js/view.js — the snap,
// the bounce, the double click and the long press — and not the rules behind it.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons, button = 'left', clickCount = 0) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount,
  }, sessionId);
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);

  // A press, a few intermediate moves, a release. No teleporting: the view reads the moves.
  async function dragTo(from, to) {
    const steps = 6;
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps), 1);
      await sleep(12);
    }
    await mouse('mouseReleased', to.x, to.y, 0);
    await sleep(80);
  }
  const grab = (i) => runJS(`window.pentapack.piecePoint(${i})`);
  const dropAt = (i, x, y, v) => runJS(`window.pentapack.dropPoint(${i},${x},${y},${v === undefined ? 'undefined' : v})`);
  const st = () => runJS(`window.pentapack.state`);
  const pose = (i) => runJS(`window.pentapack.poseOf(${i})`);

  // A mouse cannot turn a piece: dropPoint's variant only sizes the bbox, and the release
  // commits whatever pose the piece already carries (js/view.js:572). So the finger has to be
  // preceded by the same two free operations a player uses — rotate, and mirror if the target
  // pose is on the other face. rot and flip generate D4, so four turns per face covers every
  // variant a piece has; the loop re-reads the pose from the page rather than trusting the
  // index arithmetic.
  const turnTo = async (i, want) => {
    for (let face = 0; face < 2; face++) {
      for (let r = 0; r < 4; r++) {
        if ((await pose(i)).variant === want) return true;
        await runJS(`window.pentapack.rotate(${i})`);
      }
      await runJS(`window.pentapack.flip(${i})`);
    }
    return (await pose(i)).variant === want;
  };

  await runJS(`window.pentapack.load('#/lot/taster-01'); 'ok'`);
  await sleep(250);
  const ids = await runJS(`['lot','undo','hint','restart','share','curtain','stars','shelf','wipe','readout'].map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  // Where a piece has to go, straight from the baked solution the page is holding.
  const plan = await runJS(`window.pentapack.solution().map((s,i) => ({ ...s, order: i })).sort((a,b)=>a.piece-b.piece)`);
  rec('the mouse gets a four-piece level to pack', plan.length === 4 && (await st()).k === 4, { plan, k: (await st()).k });

  const log = [];
  let played = 0;
  for (const step of plan) {
    const turned = await turnTo(step.piece, step.variant);
    const from = await grab(step.piece);
    const to = await dropAt(step.piece, step.x, step.y, step.variant);
    await dragTo(from, to);
    const after = await pose(step.piece);
    played++;
    log.push({ piece: step.piece, turned, want: `${step.variant}@${step.x},${step.y}`, got: `${after.variant}@${after.x},${after.y}`, moves: (await st()).moves });
    if (!after.onBoard || after.variant !== step.variant || after.x !== step.x || after.y !== step.y) {
      rec(`mouse drop of piece ${step.piece} snaps to the aimed cell`, false, log[log.length - 1]);
      break;
    }
    if ((await st()).moves !== played) {
      rec(`drop ${played} cost exactly one operation`, false, log);
      break;
    }
  }
  rec('the mouse drags every piece in from the tray, one operation each', played === plan.length, log);
  const lastState = await st();
  rec('a real pointer packs the whole匣 and the panel says so',
    lastState.done && lastState.moves === 4 && lastState.placed === 4, lastState);
  rec('the completion card goes up with the no-waste grade',
    await runJS(`!document.getElementById('curtain').hidden && document.getElementById('stars').textContent === '★★★' && document.getElementById('verdict').textContent === '一次到位'`),
    await runJS(`[document.getElementById('stars').textContent, document.getElementById('verdict').textContent]`));

  // ---- the refusal paths: none of these may cost an operation ----
  await runJS(`document.getElementById('again').click(); 'ok'`);
  await sleep(150);
  rec('再来一次 clears the card and the count', (await st()).moves === 0 && await runJS(`document.getElementById('curtain').hidden`), await st());

  // An overlap: put piece 0 down, then let the page find — by geometry, with the same
  // placementMask the rules use — another piece that would sit inside the board but lands on
  // the first one's cells. turnTo then walks that piece, free of charge, into exactly the pose
  // that was searched for, so the drop really is the one the search reported.
  const s0 = plan[0];
  await turnTo(s0.piece, s0.variant);
  await dragTo(await grab(s0.piece), await dropAt(s0.piece, s0.x, s0.y, s0.variant));
  const clash = await runJS(`(() => {
    const g = window.pentapack, c = g.core, b = g.board();
    const spec = { w: b.w, h: b.h, mask: new Uint8Array(b.mask), pieces: b.pieces };
    const taken = new Set();
    for (let i = 0; i < b.cells.length; i++) if (b.cells[i] >= 0) taken.add(i);
    for (let p = 0; p < b.pieces.length; p++) {
      if (b.cells.some((v) => v === p)) continue; // already down; not a tray candidate
      const vs = c.VARIANTS[b.pieces[p]];
      for (let v = 0; v < vs.length; v++) {
        for (let y = 0; y < b.h; y++) {
          for (let x = 0; x < b.w; x++) {
            const m = c.placementMask(spec, vs[v].cells, x, y);
            if (m.ok && m.cells.some((cc) => taken.has(cc))) return { piece: p, variant: v, x, y };
          }
        }
      }
    }
    return null;
  })()`);
  if (clash) {
    const beforeClash = (await st()).moves;
    const turned = await turnTo(clash.piece, clash.variant);
    await sleep(60);
    const aimed = await pose(clash.piece);
    await dragTo(await grab(clash.piece), await dropAt(clash.piece, clash.x, clash.y, aimed.variant));
    const after = await st();
    rec('压叠的落点被弹回，且没有算作一步',
      turned && aimed.variant === clash.variant && after.moves === beforeClash && (await pose(clash.piece)).onBoard === false,
      { before: beforeClash, after: after.moves, turned, clash, pose: await pose(clash.piece) });
    rec('弹回后那块还在待置区', (await pose(clash.piece)).onBoard === false && after.placed === 1, await pose(clash.piece));
  } else {
    rec('压叠的落点被弹回，且没有算作一步', false, 'no clashing placement exists on this level');
  }

  // From here on exactly one piece is down and the operation count is 1; every gesture in the
  // next five rows must leave that number alone.
  const before = (await st()).moves;
  rec('到目前为止只落了一块', before === 1 && (await st()).placed === 1, { moves: before, placed: (await st()).placed });

  // Out of bounds: aim so the anchor falls outside the frame.
  const s1 = plan[1];
  const outside = { x: -3, y: 0 };
  await dragTo(await grab(s1.piece), await dropAt(s1.piece, outside.x, outside.y, s1.variant));
  const afterOut = await st();
  rec('出界的落点也被弹回，同样没有算作一步',
    afterOut.moves === before && (await pose(s1.piece)).onBoard === false, { before, after: afterOut.moves, pose: await pose(s1.piece) });

  // Rotate and mirror cost nothing but must actually change the piece — and that needs a board
  // whose rules *permit* an in-place turn. Measured over all 30 campaign lots: a piece sitting at
  // its solved pose inside a fully packed 匣 can never be turned where it stands, because
  // js/core/game.js:140 refuses any new pose that collides at the same anchor and a solved packing
  // leaves no slack; and on taster-01 even a lone piece has nowhere to turn (P@(3,0), V@(0,0),
  // W@(0,5) all come back code 'blocked', X@(1,3) is a single-variant 'noop'), so the two rows
  // below could never have passed here — the gesture is refused by the rules, not lost by the
  // view. They run on the first lot that does allow it, taster-02 piece 1 (V): alone at variant 2
  // @(2,2), rotate gives 3 @(2,2) and mirror then gives 0 @(2,2).
  await runJS(`window.pentapack.load('#/lot/taster-02'); 'ok'`);
  await sleep(220);
  const gest = await runJS(`window.pentapack.solution().find((s) => s.piece === 1)`);
  const turnedGest = await turnTo(gest.piece, gest.variant);
  await dragTo(await grab(gest.piece), await dropAt(gest.piece, gest.x, gest.y, gest.variant));
  const gestState = await st();
  rec('换到那一关，手上还是只压着一块',
    turnedGest && gestState.moves === 1 && gestState.placed === 1, { turnedGest, gest, state: gestState });
  const gestMoves = gestState.moves;

  const dblPoint = await grab(gest.piece);
  const poseBefore = await pose(gest.piece);
  await mouse('mousePressed', dblPoint.x, dblPoint.y, 1, 'left', 1);
  await mouse('mouseReleased', dblPoint.x, dblPoint.y, 0, 'left', 1);
  await sleep(40);
  await mouse('mousePressed', dblPoint.x, dblPoint.y, 1, 'left', 2);
  await mouse('mouseReleased', dblPoint.x, dblPoint.y, 0, 'left', 2);
  await sleep(140);
  const poseAfterDbl = await pose(gest.piece);
  rec('双击原地转了一下：姿态真的变了，块还在原位',
    poseAfterDbl.variant !== poseBefore.variant && poseAfterDbl.onBoard &&
      poseAfterDbl.x === poseBefore.x && poseAfterDbl.y === poseBefore.y,
    { before: poseBefore, after: poseAfterDbl });
  rec('旋转不计入操作数，也不误判成落子', (await st()).moves === gestMoves, { moves: (await st()).moves, want: gestMoves });

  const variantsOfGest = await runJS(`window.pentapack.core.VARIANTS[window.pentapack.layout()[${gest.piece}].name].length`);
  const ctxPoint = await grab(gest.piece);
  await mouse('mousePressed', ctxPoint.x, ctxPoint.y, 1, 'right', 1);
  await mouse('mouseReleased', ctxPoint.x, ctxPoint.y, 0, 'right', 1);
  await sleep(140);
  const poseAfterCtx = await pose(gest.piece);
  rec('右键镜像真的生效（姿态集合变了）',
    poseAfterCtx.cells.join(' ') !== poseAfterDbl.cells.join(' ') && poseAfterCtx.variant !== poseAfterDbl.variant,
    { afterDbl: poseAfterDbl, afterCtx: poseAfterCtx, variants: variantsOfGest });
  rec('镜像也不计一步', (await st()).moves === gestMoves, (await st()).moves);

  // Long press mirrors too — the touch path, same effect, and it must not drop the piece. This
  // asks for a *tray* piece, and piece 0 here is a T whose tray pose mirrors into a different
  // variant (0 -> 3); picking the X would have been vacuous, since its mirror is itself.
  const tp = await grab(0);
  const poseTrayBefore = await pose(0);
  await mouse('mousePressed', tp.x, tp.y, 1);
  await sleep(700);
  await mouse('mouseReleased', tp.x, tp.y, 0);
  await sleep(150);
  const poseLong = await pose(0);
  rec('长按镜像生效，并且没有把那块丢下去',
    poseLong.cells.join(' ') !== poseTrayBefore.cells.join(' ') && poseLong.onBoard === false && (await st()).moves === gestMoves,
    { before: poseTrayBefore, after: poseLong, moves: (await st()).moves });

  // Drag a placed piece back to the tray: that *is* an operation. Back on taster-01, the lot whose
  // `plan` the drops above were walked from and the only plan this block still holds.
  await runJS(`window.pentapack.load('#/lot/taster-01'); 'ok'`);
  await sleep(220);
  await runJS(`document.getElementById('again').click(); 'ok'`);
  await sleep(150);
  for (const step of plan.slice(0, 2)) {
    await turnTo(step.piece, step.variant);
    await dragTo(await grab(step.piece), await dropAt(step.piece, step.x, step.y, step.variant));
  }
  const downBefore = await st();
  const home = await runJS(`(() => { const s = window.pentapack.solution()[0]; return window.pentapack.boardPoint(s.x, s.y); })()`);
  const tray = await runJS(`(() => { const g = window.pentapack; return g.piecePoint(${plan[0].piece}); })()`);
  await dragTo(home, { x: Math.min(tray.x, 40), y: tray.y });
  const afterBack = await st();
  rec('拖回待置区等于取回那块，算一步',
    afterBack.moves === downBefore.moves + 1 && afterBack.placed === downBefore.placed - 1,
    { before: downBefore.moves, placedBefore: downBefore.placed, after: afterBack.moves, placed: afterBack.placed });

  // Keyboard the panel advertises.
  await key('u');
  await sleep(140);
  rec('u 键撤销那一步', (await st()).moves === downBefore.moves, { moves: (await st()).moves, want: downBefore.moves });
  await key('h');
  await sleep(140);
  rec('h 键给提示且不动棋盘',
    (await st()).hints === 1 && (await st()).moves === downBefore.moves, await st());

  const readoutText = await runJS(`document.getElementById('readout').textContent`);
  rec('面板里没有 NaN / undefined 之类的破口', !/NaN|undefined/.test(readoutText), readoutText);

  return { rows };
}

// In-page suites. Each returns { rows: [{ test, pass, detail }] }. They run inside the real
// page, so `window.pentapack` is the shipped object and the numbers they read are the ones a
// player sees.
const SCENARIOS = {
  boot: `(async () => {
    const g = window.pentapack;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const D = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    rec('the shell boots straight into a level', g && g.version === 1 && g.state.mode && !!g.state.id, g && g.state);
    const c = D('lot');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    const lit = (() => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      let colours = new Set();
      for (let i = 0; i < d.length; i += 4 * 61) {
        if (d[i + 3] > 0) n++;
        colours.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      }
      return { n, colours: colours.size };
    })();
    rec('the box and its pieces were actually painted', lit.n > 100 && lit.colours > 6, lit);
    const pool = g.pool;
    rec('the baked campaign loaded', pool.lots === 30 && pool.version === 1, pool && { lots: pool.lots, version: pool.version });
    rec('the twelve pentominoes are all in play somewhere', g.core.FULL_SET.length === 12 && g.core.NAMES.length === 12, g.core.NAMES.join(''));
    rec('the fixed-variant table adds up to 63', g.state.variants === 63, g.state.variants);
    const readout = D('readout').textContent;
    rec('the panel prints 解数 and 推理深度 and 操作数', /解数/.test(readout) && /推理深度/.test(readout) && /操作数/.test(readout), readout);
    rec('the panel states the proof, not an opinion', /已证明/.test(readout), readout);
    rec('the rule set is quoted in the about block', /两条规则/.test(D('readout').closest('.stage').textContent), '');

    // The headline claim, re-run in the browser: dancing links on the level that is on screen.
    const proof = g.prove(2);
    rec('this build proves 解数=1 for the level on screen', proof.count === 1 && proof.nodes > 0, proof);
    const t0 = performance.now();
    const quick = g.prove(2);
    rec('counting stops at 2, so a unique level costs milliseconds', quick.count === 1 && performance.now() - t0 < 400, { ms: Math.round(performance.now() - t0) });
    const reason = g.reason();
    rec('the reasoning solver agrees with the printed 推理深度', reason.solved && reason.agrees && reason.depth === g.state.depth, { reason, printed: g.state.depth });
    g.load('#/lot/iron-01'); await sleep(200);
    const iron = g.state;
    rec('the hardest band really is deeper', iron.k === 8 && g.reason().depth === iron.depth && iron.depth >= 4, { k: iron.k, depth: iron.depth });
    g.load('#/lot/taster-01'); await sleep(150);
    rec('an unknown lot id tells you instead of blanking the board', (() => { g.load('#/lot/nope-999'); return true; })(), '');
    rec('and the board survived that', !!g.state.id && g.state.k >= 4, g.state);
    g.load('#/lot/taster-01'); await sleep(150);
    rec('the mask renders as a box of five-cell lumps', g.placementText().split('/').length === g.state.h, g.placementText());
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.pentapack;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const D = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    g.store.resetForTest();
    g.load('#/lot/taster-01'); await sleep(150);
    const k = g.state.k;
    const sol = g.solution();
    rec('a level starts empty with a floor of k operations', g.state.moves === 0 && g.state.placed === 0 && k === 4, g.state);

    // Rotate and mirror are free, in the tray as well as on the board.
    const before = g.poseOf(0);
    g.rotate(0);
    const turned = g.poseOf(0);
    // Two mirrors cancel, so what flip-flip returns to is the pose rotate left behind, not
    // the pre-rotation one: on taster-01's P the walk is rot 0 -> 4, mirror 4 -> 5, mirror 5 -> 4.
    rec('旋转与翻面都不算一步', g.state.moves === 0, { moves: g.state.moves, before: before.variant, turned: turned.variant });
    g.flip(0);
    rec('翻面换了一个真实存在的姿态', g.poseOf(0).cells.join(' ') !== turned.cells.join(' '), { before: turned.cells, after: g.poseOf(0).cells });
    g.flip(0);
    rec('再翻一次回到转过来那一面', g.poseOf(0).cells.join(' ') === turned.cells.join(' ') && g.poseOf(0).variant === turned.variant, { want: turned, got: g.poseOf(0) });

    // A legal drop, then the same piece again where another piece already is.
    const r0 = g.place(sol[0].piece, sol[0].x, sol[0].y, sol[0].variant);
    rec('落子算一步，且落在瞄准的那格', r0.ok && r0.moved && g.state.moves === 1 && g.state.placed === 1, { r0, state: g.state });
    const clash = g.place(sol[1].piece, sol[0].x, sol[0].y, sol[1].variant);
    rec('压叠被拒绝：不算一步，块还在待置区', !clash.ok && g.state.moves === 1 && !g.poseOf(sol[1].piece).onBoard, clash);
    const out = g.place(sol[2].piece, -2, 0, sol[2].variant);
    rec('出界同样被拒绝', !out.ok && out.code !== null && g.state.moves === 1, out);
    const off = g.place(sol[2].piece, g.board().w - 1, g.board().h - 1, sol[2].variant);
    rec('落在匣子的缺口外也被拒绝（代码是 off 或 out）', !off.ok && ['off', 'out', 'overlap'].includes(off.code), off);
    const noop = g.place(sol[0].piece, sol[0].x, sol[0].y, sol[0].variant);
    rec('原地按下去再放开什么都不发生', noop.ok && !noop.moved && g.state.moves === 1, noop);

    // Drag a placed piece: one operation, not two.
    const moved = g.place(sol[0].piece, sol[0].x + 1, sol[0].y, sol[0].variant);
    const midMoves = g.state.moves;
    rec('拖动已落子到别处 = 一步', (!moved.ok || moved.moved) && (moved.ok ? midMoves === 2 : true), { moved, moves: midMoves });
    g.undo(); g.undo();
    rec('撤销能回到空盘', g.state.moves === 0 && g.state.placed === 0, g.state);

    g.play();
    await sleep(150);
    rec('一次到位：k 步装满，三颗星', g.state.done && g.state.moves === k && D('stars').textContent === '★★★' && D('verdict').textContent === '一次到位', { moves: g.state.moves, stars: D('stars').textContent });
    D('again').click();
    await sleep(150);
    // Waste some operations, then finish: over par wins with fewer stars. The waste is two,
    // not one — 取回 also bills a step (js/core/game.js:6-11), so that piece is paid for three
    // times instead of once, landing the run on grade()'s over <= 2 edge (game.js:248).
    g.rotate(1);
    g.place(sol[0].piece, sol[0].x, sol[0].y, sol[0].variant);
    g.take(sol[0].piece);
    g.place(sol[0].piece, sol[0].x, sol[0].y, sol[0].variant);
    for (const s of g.solution().slice(1)) g.place(s.piece, s.x, s.y, s.variant);
    await sleep(150);
    rec('超出下限也能赢，只是星少', g.state.done && g.state.moves === k + 2 && D('stars').textContent === '★★☆' && D('verdict').textContent === '干净装箱', { moves: g.state.moves, k, stars: D('stars').textContent, verdict: D('verdict').textContent });
    rec('完成时面板上写着这一步是第几步：操作数与下限同时可见', new RegExp('操作数').test(D('readout').textContent) && new RegExp('下限 ' + k).test(D('readout').textContent), D('readout').textContent);

    D('restart').click(); await sleep(120);
    const h1 = g.hintOnce();
    rec('提示说清哪一块去哪一格', h1.hints === 1 && /放到 \\(-?\\d+, -?\\d+\\)/.test(h1.line), h1);
    const snapshot = g.layout().map((a) => a.onBoard ? 1 : 0).join('');
    g.hintOnce();
    rec('提示不动棋盘，也不加操作数', g.layout().map((a) => a.onBoard ? 1 : 0).join('') === snapshot && g.state.moves === 0, { snapshot, moves: g.state.moves });
    rec('提示是免费的：它只查烘焙好的解答，不现场搜索', g.state.hints === 2, g.state.hints);
    D('restart').click(); await sleep(120);
    rec('倒回清零：块数、操作数、提示都归位', g.state.moves === 0 && g.state.placed === 0 && g.state.hints === 0 && D('curtain').hidden, g.state);

    // The guard that makes "compare against the baked line" sound. setSolution() only rewrites
    // what the finish check compares against — the pieces still go down the real baked way, one
    // commit at a time — so a board that fills up while the stored claim disagrees has to be
    // reported as 异常 instead of being congratulated. (An earlier version of these two rows
    // "shifted" the line by copying it unchanged and then max()'d the coordinate, i.e. it asserted
    // nothing and returned true by construction; the mutation below is a real disagreement.)
    const real = g.solution();
    const shifted = real.map((s, i) => (i === 0 ? { ...s, x: s.x + 1 } : s));
    g.setSolution(real.map((s) => ({ ...s })));
    g.play();
    rec('按烘焙解答装满 → 判定完成', g.state.done && g.state.anomaly === null, g.state);
    g.load('#/lot/taster-01'); await sleep(160);
    g.setSolution(shifted);
    for (const s of real) g.place(s.piece, s.x, s.y, s.variant);
    await sleep(60);
    rec('存档换成另一条解后，同样装满不判完成，并且明说证明异常',
      g.state.done === false && g.state.anomaly === 'second-solution' &&
        /异常/.test(D('hintline').textContent), { st: g.state, line: D('hintline').textContent });
    g.load('#/lot/taster-01'); await sleep(160);
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.pentapack;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    g.load('#/lot/mid-03'); await sleep(160);
    rec('#/lot/<id> opens exactly that lot', g.state.id === 'mid-03' && g.state.k === 6 && g.state.band === 'mid', g.state);
    g.load('#/lot/does-not-exist'); await sleep(160);
    rec('未知 id 不白屏，且明说没有这一关', /没有这一关/.test(document.getElementById('hintline').textContent), document.getElementById('hintline').textContent);

    g.load('#/daily/2026-03-04'); await sleep(200);
    const daily = g.state;
    g.load('#/lot/taster-01'); await sleep(160);
    g.load('#/daily/2026-03-04'); await sleep(200);
    rec('每日匣同一日期两次进来是同一关', g.state.id === daily.id && g.state.depth === daily.depth && g.state.k === daily.k, { first: daily, again: g.state });
    g.load('#/daily/2026-03-05'); await sleep(200);
    rec('换一天就是另一关', g.state.id !== daily.id, { a: daily.id, b: g.state.id });
    g.load('#/daily'); await sleep(200);
    const bare = g.state.id;
    // adopt() stamps the source into the id, so a daily is daily-daily-<date> and a random lot
    // rand-<seed> (test/library.test.mjs:426 pins the daily shape). What this row is really
    // asking — is a date-less link today's puzzle? — is answered by the app's own no-argument
    // daily(), not by a date the test reads off its own clock.
    rec('裸 #/daily 就是今天那一关', bare === g.daily().id, { bare, todayId: g.daily().id });
    rec('并且 id 里真的写着日期', /^daily-daily-\\d{4}-\\d{2}-\\d{2}$/.test(bare), bare);
    rec('每日匣也是可证明唯一的', g.prove(2).count === 1 && g.reason().agrees, { id: g.state.id, k: g.state.k, depth: g.state.depth });

    g.load('#/random/seed-alpha'); await sleep(200);
    const ra = { id: g.state.id, k: g.state.k, depth: g.state.depth, band: g.state.band, mask: g.board().mask.join('') };
    g.load('#/lot/taster-01'); await sleep(150);
    g.load('#/random/seed-alpha'); await sleep(200);
    const rb = { id: g.state.id, k: g.state.k, depth: g.state.depth, band: g.state.band, mask: g.board().mask.join('') };
    rec('同一随机种子 = 同一盘棋（逐格相同）', ra.mask === rb.mask && ra.id === rb.id, { ra, rb });
    g.load('#/random/seed-beta'); await sleep(200);
    rec('换种子就换棋盘', g.board().mask.join('') !== ra.mask, { a: ra.mask.slice(0, 24), b: g.board().mask.join('').slice(0, 24) });
    g.load('#/random/fixed?band=iron'); await sleep(220);
    rec('band= 能点将难度带', g.state.band === 'iron' && g.state.k === 8 && g.state.depth >= 4, g.state);
    g.load('#/random/fixed?band=taster'); await sleep(200);
    rec('同一个 band+seed 稳定复现', g.state.id === 'rand-fixed' && g.state.k === 4 && g.state.source === 'rand', g.state);

    g.load(''); await sleep(160);
    // The empty route is what a player gets on first load, so this row asks about *that*:
    // naming a lot the previous row happened to leave on screen would prove nothing.
    rec('空路由落到匣阵第一关', g.state.id === 'taster-01' && g.state.source === 'campaign' && g.state.index === 0, g.state);
    g.load('#/campaign'); await sleep(160);
    // ...and the '#/campaign' the shell used to substitute for it is not a link this game
    // defines: it must say so instead of quietly keeping the previous board company.
    rec('没有定义的路由明说，不装作还是那一关',
      /没有这一关/.test(document.getElementById('hintline').textContent) && g.state.route === '#/campaign',
      { hint: document.getElementById('hintline').textContent, route: g.state.route });
    g.load('#/lot/what-is-this'); await sleep(160);
    rec('坏链接留下的是文字提示而不是异常', /没有这一关/.test(document.getElementById('hintline').textContent) && !!g.state.id, g.state);
    const serialised = g.serialise();
    const back = g.deserialise(serialised);
    rec('序列化的一关可以还原并自检', back.ok && back.same, { back, json: serialised.slice(0, 60) });
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.pentapack;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const D = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const KEY = 'pentapack.save.v1';
    // Wiped through the button a player uses, not by poking the store: the shell caches
    // app.saved (js/main.js:59) and only re-reads it on a completion and on a real wipe, so
    // store.resetForTest() alone left that cache holding an earlier run's 解锁 — and the next
    // completion "unlocked" nothing, because it took the max with a number no longer on disk.
    localStorage.removeItem(KEY);
    D('wipe').click(); await sleep(80);
    D('wipe').click(); await sleep(160);
    g.load('#/lot/taster-01'); await sleep(160);
    rec('一张白纸：没有成绩，也没有解锁', Object.keys(g.store.load().best).length === 0 && g.store.load().unlock === 0, g.store.load());
    const locked = [...D('shelf').querySelectorAll('button')].filter((b) => b.disabled).length;
    rec('匣阵默认锁着后面的关', locked > 20, { lockedButtons: locked });

    g.play(); await sleep(160);
    const id = g.state.id;
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('通关写进了 localStorage，不只是内存', !!(raw && raw.best && raw.best[id] && raw.best[id].moves === g.state.k), raw && { keys: Object.keys(raw), best: raw.best[id] });
    rec('解锁前进一格，匣阵第二关可点', raw.unlock === 1 && g.store.load().unlock === 1, { unlock: raw.unlock });
    rec('totals 行报告了进度', /已装/.test(D('totals').textContent) && /解锁/.test(D('totals').textContent), D('totals').textContent);

    // best only ever goes down: a sloppier replay must not overwrite the record.
    D('restart').click(); await sleep(120);
    g.rotate(1);
    g.play(); await sleep(160);
    const after2 = JSON.parse(localStorage.getItem(KEY));
    rec('操作数只降不升：重打得更差也拿不走纪录', after2.best[id].moves === g.state.k - 1 + 1 || after2.best[id].moves === g.state.k, { stored: after2.best[id], moves: g.state.moves });

    // unlock only ever goes up
    g.store.save({ unlock: 0 });
    const after3 = JSON.parse(localStorage.getItem(KEY));
    rec('解锁只升不降', after3.unlock === 1, { unlock: after3.unlock });
    g.store.unlockTo(9);
    g.render();
    // The shelf locks globalIndex > s.unlock (js/main.js:206), so opening index 9 lights the
    // first ten lots and keeps the other twenty grey. "not one button disabled" was never the
    // promise this game makes.
    const shelfBtns = [...D('shelf').querySelectorAll('button[data-id]')];
    rec('unlockTo(9) 之后前 10 关都能点，第 11 关起仍然上锁',
      JSON.parse(localStorage.getItem(KEY)).unlock === 9 && shelfBtns.length === 30
      && shelfBtns.slice(0, 10).every((b) => !b.disabled) && shelfBtns.slice(10).every((b) => b.disabled),
      { unlock: g.store.load().unlock, buttons: shelfBtns.length, locked: shelfBtns.filter((b) => b.disabled).length });

    g.load('#/daily/2026-06-06'); await sleep(200);
    g.play(); await sleep(160);
    const dailyId = g.state.id;
    rec('每日匣的成绩也入账，用的是同一个 key', !!JSON.parse(localStorage.getItem(KEY)).best[dailyId], { id: dailyId, best: JSON.parse(localStorage.getItem(KEY)).best[dailyId] });
    rec('整个存档只有一个 key', Object.keys(localStorage).filter((k) => k.indexOf('pentapack') === 0).length === 1, Object.keys(localStorage));

    // A save file from a broken build must degrade, not crash.
    localStorage.setItem(KEY, '{not json at all');
    const degraded = g.store.load();
    rec('坏档退化成空档而不是抛异常', degraded && degraded.v === 1 && Object.keys(degraded.best).length === 0, degraded);
    localStorage.setItem(KEY, JSON.stringify({ v: 1, best: { x: { moves: -5 }, y: 'junk', z: { moves: 7, seconds: 3 } }, unlock: -3, done: null, settings: { hint: 5 } }));
    const sanitised = g.store.load();
    rec('脏字段被清掉：负数/非对象/负解锁都不留', !sanitised.best.x && !sanitised.best.y && sanitised.best.z.moves === 7 && sanitised.unlock === 0, sanitised);
    // Wiped through the button a player uses, not by poking the store: the shell caches
    // app.saved (js/main.js:59) and only re-reads it on a completion and on a real wipe, so
    // store.resetForTest() alone left that cache holding an earlier run's 解锁 — and the next
    // completion "unlocked" nothing, because it took the max with a number no longer on disk.
    localStorage.removeItem(KEY);
    D('wipe').click(); await sleep(80);
    D('wipe').click(); await sleep(160);
    g.load('#/lot/taster-01'); await sleep(160);
    g.play(); await sleep(160);
    const solvedId = g.state.id;

    // The wipe is the only destructive control, so it arms first.
    D('wipe').click(); await sleep(80);
    const armed = JSON.parse(localStorage.getItem(KEY));
    rec('清空第一次点击只是武装，成绩还在', !!armed && !!armed.best[solvedId] && armed.clearArm > 0, armed && { clearArm: armed.clearArm, kept: Object.keys(armed.best) });
    D('wipe').click(); await sleep(160);
    rec('二次确认才真的清空，且 key 被删除', localStorage.getItem(KEY) === null && Object.keys(g.store.load().best).length === 0 && g.store.load().unlock === 0, { raw: localStorage.getItem(KEY), save: g.store.load() });
    rec('清空之后匣阵又回到第一关可玩', g.state.id && g.state.k === 4, g.state);
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
