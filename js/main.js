// The app shell: routes, DOM, timers, and the one place that decides what a completed level
// is worth. It owns no puzzle logic at all — legality lives in js/core/game.js, the numbers
// on screen come from js/core/dlx.js and js/core/logic.js (through the baked file, or through
// js/core/make.js for generated levels), and pixels live in js/view.js.
//
// `window.pentapack` at the bottom is the test surface tools/playtest.mjs drives. It is a real
// API, not a debug back door: every method forwards to the same function a click calls, so a
// green playtest run means the shipped path works, not a parallel one.

import { createGame, place, takeBack, rotate, flip, undo, reset, hintFor, grade, placedCount, fits, pieceAt, BOUNCE } from './core/game.js';
import {
  campaign, nextOf, prevOf, lotsIn, resolveRoute, stats as poolStats, dailyLot, randomLot,
  bands, bandOf, serialiseLot, deserialiseLot, byId,
} from './core/library.js';
import { store, SAVE_KEY } from './core/storage.js';
import { countSolutions, solveLevel, packProblem, matrixDigest, isMatrixClean } from './core/dlx.js';
import { logicSolve, RULES } from './core/logic.js';
import { makeLevel, bandName } from './core/make.js';
import { todayKey } from './core/rng.js';
import { validateLevel, renderMask, samePlacements, placementMask, validatePlacements } from './core/board.js';
import { TOTAL_VARIANTS, FULL_SET, VARIANTS, variantCells, variantCount, NAMES, CELLS, VARIANT_COUNT } from './core/pieces.js';
import { createView, PIECE_COLOURS } from './view.js';
import { createAudio } from './audio.js';

const el = {
  canvas: document.getElementById('lot'),
  modes: document.getElementById('modes'),
  totals: document.getElementById('totals'),
  crumbs: document.getElementById('crumbs'),
  readout: document.getElementById('readout'),
  legend: document.getElementById('legend'),
  shelf: document.getElementById('shelf'),
  hintline: document.getElementById('hintline'),
  curtain: document.getElementById('curtain'),
  stars: document.getElementById('stars'),
  verdict: document.getElementById('verdict'),
  tally: document.getElementById('tally'),
  proof: document.getElementById('proof'),
  undo: document.getElementById('undo'),
  prev: document.getElementById('prev'),
  hint: document.getElementById('hint'),
  restart: document.getElementById('restart'),
  share: document.getElementById('share'),
  again: document.getElementById('again'),
  next: document.getElementById('next'),
  wipe: document.getElementById('wipe'),
  toast: document.getElementById('toast'),
  help: document.getElementById('help'),
  pause: document.getElementById('pause'),
  mute: document.getElementById('mute'),
  fullscreen: document.getElementById('fullscreen'),
  veil: document.getElementById('veil'),
  resume: document.getElementById('resume'),
  tutorial: document.getElementById('tutorial'),
  start: document.getElementById('start'),
  skipTut: document.getElementById('skip-tut'),
};

const app = {
  mode: 'campaign',
  route: '',
  lot: null,
  game: null,
  index: 0,
  hints: 0,
  last: -1, // the piece the pointer touched last, which `v` flips
  seconds: 0,
  paused: false,
  saved: store.load(),
};

// --------------------------------------------------------------------------- lifecycle

function linkFor(hash) {
  return location.href.split('#')[0] + '#' + hash;
}

function go(hash) {
  const target = String(hash).replace(/^#?\/?/, '#/');
  if (location.hash === target) apply();
  else location.hash = target;
}

// The clock belongs to this layer, and there is exactly one place that reads it for a date.
// js/core/rng.js:todayKey refuses to default its argument precisely so that this line is the
// only `new Date` in the whole game: a test can then ask "which lot is 2026-03-01's daily" by
// passing a Date, instead of monkey-patching a global.
const today = () => todayKey(new Date());

// The elapsed time is *accumulated from the render loop's dt* rather than read off Date.now at
// an interval: a pause has to stop the number, and a background tab must not bank an hour it
// never played. `view.onFrame` is the only caller, and it does not call while paused.
let elapsedMs = 0;
let shownSeconds = -1;

function tickTime() {
  if (!app.game || app.game.done) return;
  app.seconds = Math.floor(elapsedMs / 1000);
  if (app.seconds === shownSeconds) return;
  shownSeconds = app.seconds;
  const node = el.readout.querySelector('[data-field="用时"] dd');
  if (node) node.textContent = `${app.seconds}s`;
}

function setLot(lot, label) {
  if (!lot) return;
  app.lot = lot;
  app.label = label;
  app.index = campaign().findIndex((l) => l.id === lot.id);
  app.game = createGame(lot);
  app.hints = 0;
  elapsedMs = 0;
  shownSeconds = -1;
  app.seconds = 0;
  setPaused(false);
  el.curtain.hidden = true;
  view.setGame(app.game);
  render();
}

function apply() {
  // '' is the documented "no hash boots the first lot" link (js/core/library.js:165); the
  // '#/campaign' this used to substitute is not a link this game defines — kind 'unknown', lot null.
  const hash = location.hash || '';
  app.route = hash;
  const { kind, lot, missing } = resolveRouteSafe(hash);
  app.mode = kind === 'lot' && String(lot && lot.id).indexOf('daily-') === 0 ? 'daily' : kind;
  if (!lot) {
    say(`链接里没有这一关：<b>${missing || hash}</b>。匣阵第一关在 <b>#/lot/${campaign()[0].id}</b>。`);
    render();
    return;
  }
  setLot(lot, kind === 'daily' ? '每日匣' : kind === 'random' ? '随机匣' : '匣阵');
  el.undo.disabled = true;
  el.restart.disabled = false;
}

// resolveRoute can throw if generation ever fails; a bad link must still show a playable
// board rather than a blank page, so the failure is reported on the hint line.
function resolveRouteSafe(hash) {
  try {
    return resolveRoute(hash, today());
  } catch (err) {
    return { kind: 'error', lot: null, missing: String(err.message || err) };
  }
}

// --------------------------------------------------------------------------- rendering

function say(html) {
  el.hintline.innerHTML = html;
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}" data-field="${label}"><dt>${label}</dt><dd>${value}${note ? ` <small>${note}</small>` : ''}</dd></div>`;
}

function renderCrumbs() {
  const lot = app.lot;
  if (!lot) {
    el.crumbs.innerHTML = '五连块匣<b>没有关卡</b>';
    return;
  }
  const idx = app.index >= 0 ? `第 ${app.index + 1}/${campaign().length} 匣` : '生成关';
  // The band word is *derived from the two numbers printed under it*, not from the label the
  // generator happened to stamp: bandName(k, depth) classifies the measurements. When the stamp
  // and the measurement disagree, the stamp loses and the mismatch becomes visible text —
  // @boot asserts this line never says 不一致 for a shipped lot.
  const measured = bandName(lot.k, lot.depth);
  const stamped = bandOf(lot.band);
  const drift = measured && stamped && measured.key !== stamped.key;
  const band = (measured || stamped);
  el.crumbs.innerHTML = `${idx} · <span class="band${drift ? ' drift' : ''}">${band ? band.name : lot.band}</span><b>${lot.id}</b>`
    + (drift ? `<span class="seed">档位与实测不符：${stamped.key} vs ${measured.key}</span>` : '')
    + (lot.seed ? `<span class="seed">种子 ${lot.seed}</span>` : '');
}

function renderReadout() {
  const lot = app.lot;
  const g = app.game;
  if (!lot || !g) {
    el.readout.innerHTML = '';
    return;
  }
  const best = store.load().best[lot.id];
  const over = g.moves - g.n;
  el.readout.innerHTML = [
    field('块数', g.n, '片五连块'),
    field('解数', `${lot.solutions === undefined ? 1 : lot.solutions}`, '已证明', 'proof'),
    field('推理深度', lot.depth, '假设框', 'depth'),
    field('操作数', g.moves, `下限 ${g.n}${over > 0 ? ` · 超 ${over}` : ''}`, over > 0 ? 'moves over' : 'moves'),
    field('用时', `${app.seconds}s`, `${placedCount(g)}/${g.n} 在匣`),
    best ? field('最佳', best.moves, `步 · ${best.seconds}s`, 'best') : field('最佳', '—', '未通关'),
  ].join('');
}

function renderLegend() {
  // Drawn from PIECE_COLOURS — the very object js/view.js mixes its fills from — so the
  //对照 can never drift from the canvas. Only the twelve names the game can actually place.
  el.legend.innerHTML = NAMES.map((n) => `<i class="chip" data-piece="${n}" style="--chip:${PIECE_COLOURS[n]}"></i>${n}`).join('');
}

function renderTotals() {
  const s = store.load();
  const solved = campaign().filter((l) => s.done[l.id]).length;
  const perfect = campaign().filter((l) => s.best[l.id] && s.best[l.id].moves <= l.k).length;
  el.totals.innerHTML = `已装 <b>${solved}</b>/${campaign().length} · 一次到位 <b>${perfect}</b> · 解锁至 <b>${Math.min(s.unlock + 1, campaign().length)}</b>`;
}

function renderShelf() {
  const s = store.load();
  const groups = bands().map((b) => ({ band: b, lots: lotsIn(b.key) }));
  let html = '';
  for (const grp of groups) {
    html += `<p class="tier">${grp.band.name} · ${grp.band.k[0]} 块 · 深度 ${grp.band.depth.join('-')}</p>`;
    grp.lots.forEach((lot) => {
      const globalIndex = campaign().findIndex((l) => l.id === lot.id);
      const locked = globalIndex > s.unlock;
      const rec = s.best[lot.id];
      const cls = [
        app.lot && app.lot.id === lot.id ? 'here' : '',
        locked ? '' : rec ? (rec.moves <= lot.k ? 'perfect' : 'done') : '',
      ].join(' ');
      html += `<button type="button" class="${cls}" data-id="${lot.id}"${locked ? ' disabled' : ''} title="${locked ? '未解锁' : `深度 ${lot.depth}`}">${locked ? '·' : globalIndex + 1}</button>`;
    });
  }
  html += `<button type="button" class="wide" data-reroll="1">换一匣随机（同一链接同一关）</button>`;
  el.shelf.innerHTML = html;
}

function render() {
  renderCrumbs();
  renderReadout();
  renderTotals();
  renderLegend();
  renderShelf();
  el.undo.disabled = !(app.game && app.game.history.length);
  el.prev.disabled = !(app.lot && app.index > 0);
  if (app.game && app.game.done) showCurtain();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
}

function showCurtain() {
  const g = grade(app.game);
  const lot = app.lot;
  el.stars.textContent = '★'.repeat(g.stars) + '☆'.repeat(3 - g.stars);
  el.verdict.textContent = g.label;
  el.tally.innerHTML = `操作数 <b>${g.moves}</b>（下限 ${g.n}）· 用时 <b>${app.seconds}s</b> · 提示 <b>${app.hints}</b> 次`;
  el.proof.innerHTML = `本关解数 = 1，由精确覆盖证明；推理深度 ${lot.depth} 来自两条规则（${RULES.map((r) => r.key).join(' / ')}）的假设框。`;
  el.curtain.hidden = false;
  const isCampaign = app.index >= 0 && app.index < campaign().length - 1;
  el.next.textContent = isCampaign ? '下一匣' : app.lot.source === 'daily' ? '回到匣阵' : '再来一匣随机';
}

// --------------------------------------------------------------------------- the rules
// Every mutation goes through js/core/game.js and then repaints. Nothing here decides
// legality, and nothing here counts an operation.

function commitDrop(piece, variant, x, y) {
  app.last = piece;
  const res = place(app.game, piece, variant, x, y);
  if (res.ok && res.moved) {
    view.clearHint();
    audio.place();
    afterMove();
  } else if (!res.ok && BOUNCE[res.code]) {
    audio.refuse();
    say(`<span class="no">${BOUNCE[res.code]}</span> 这一步没有算进操作数。`);
  }
  render();
  return res;
}

function commitTake(piece) {
  const res = takeBack(app.game, piece);
  if (res.ok) {
    audio.take();
    afterMove();
  }
  render();
  return res;
}

function commitRotate(piece) {
  app.last = piece;
  const res = rotate(app.game, piece);
  if (!res.ok && res.code === 'blocked') say('旋转后会压住别的块，所以它没动。旋转不算一步。');
  else if (res.ok) {
    audio.turn();
    say('旋了一下：不算一步。');
  }
  render();
  return res;
}

function commitFlip(piece) {
  app.last = piece;
  const res = flip(app.game, piece);
  if (!res.ok && res.code === 'blocked') say('镜像后会压住别的块，所以它没动。翻面不算一步。');
  else if (res.ok && res.code !== 'noop') {
    audio.turn();
    say('翻了一面：不算一步。');
  }
  render();
  return res;
}

function afterMove() {
  const g = app.game;
  if (g.anomaly) {
    say(`<span class="no">异常：出现了第二条解（${g.anomaly}）</span> 这一关的「解数 = 1」证明有问题，请把 <code>${g.id}</code> 报告出来。`);
    toast('证明异常：这关不止一解');
    return;
  }
  if (!g.done) return;
  app.seconds = Math.max(app.seconds, Math.floor(elapsedMs / 1000));
  view.celebrate();
  audio.win(grade(g).stars - 1);
  const rec = store.record(g.id, { moves: g.moves, seconds: app.seconds, date: today() });
  const idx = campaign().findIndex((l) => l.id === g.id);
  if (idx >= 0) store.unlockTo(Math.max(app.saved.unlock || 0, idx + 1));
  app.saved = store.load();
  const best = rec.save.best[g.id];
  say(rec.first
    ? `装满了：<b>${g.moves}</b> 步（下限 ${g.n}），首次通关。`
    : rec.improved
      ? `装满了，比之前更好：<b>${best.moves}</b> 步（之前 ${(rec.previous && rec.previous.moves) || best.moves}）。`
      : `装满了：<b>${g.moves}</b> 步，最佳仍是 ${best.moves} 步。`);
}

// --------------------------------------------------------------------------- view wiring

const view = createView(el.canvas, {
  onDrop: (piece, variant, x, y) => commitDrop(piece, variant, x, y),
  onTake: (piece) => commitTake(piece),
  onRotate: (piece) => commitRotate(piece),
  onFlip: (piece) => commitFlip(piece),
  onRefuse: () => {
    /* the message was already put on the hint line by commitDrop */
  },
  canDrop: (piece, variant, x, y) => (app.game ? fits(app.game, piece, variant, x, y) : false),
  // The one clock the panel prints. dt arrives in seconds from the render loop and this hook is
  // not called while the view is paused, which is what makes 暂停 stop the number.
  onFrame: (dt) => {
    elapsedMs += dt * 1000;
    tickTime();
  },
});

const audio = createAudio();

// --------------------------------------------------------------------------- the system HUD
// Four controls that are easy to fake, so each one's state is read back from the thing it acts
// on: paused is reported by the view (which is what refuses pointers and freezes particles),
// muted is reported by the audio layer (which counts allocated nodes), fullscreen is reported by
// document.fullscreenElement rather than by the click that asked for it.

function setPaused(next) {
  const want = !!next;
  if (want !== app.paused) {
    app.paused = want;
    view.setPaused(want);
    el.veil.hidden = !want;
    if (want) audio.halt();
    else audio.release();
  }
  el.pause.setAttribute('aria-pressed', want ? 'true' : 'false');
  el.pause.textContent = want ? '▶' : '⏸';
  el.pause.setAttribute('aria-label', want ? '继续' : '暂停');
  return want;
}

function paintMuted(want) {
  el.mute.setAttribute('aria-pressed', want ? 'true' : 'false');
  el.mute.textContent = want ? '🔇' : '🔊';
  el.mute.setAttribute('aria-label', want ? '取消静音' : '静音');
}

// persist=false is the boot path: restoring a saved preference must not rewrite the save file.
function setMuted(v, persist = true) {
  const want = audio.setMuted(v);
  paintMuted(want);
  if (persist) store.setSetting('muted', want);
  return want;
}

function showTutorial(v) {
  const want = !!v;
  el.tutorial.hidden = !want;
  el.help.setAttribute('aria-pressed', want ? 'true' : 'false');
  return want;
}

function closeTutorial() {
  if (!el.tutorial.hidden) {
    el.tutorial.hidden = true;
    el.help.setAttribute('aria-pressed', 'false');
    store.setSetting('tutorialSeen', true);
  }
}

// The browser may refuse (an iframe without allow="fullscreen") or may exit on its own, so the
// button's own label is painted from the document's state, not from the request's outcome.
function fullscreenEl() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function paintFullscreen() {
  const on = !!fullscreenEl();
  el.fullscreen.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.fullscreen.textContent = on ? '🗗' : '⛶';
  el.fullscreen.setAttribute('aria-label', on ? '退出全屏' : '全屏');
}

function toggleFullscreen() {
  const node = fullscreenEl();
  const exit = node ? (document.exitFullscreen || document.webkitExitFullscreen) : null;
  if (node && exit) {
    Promise.resolve(exit.call(document)).catch(() => { /* refused: the label is repainted anyway */ });
  } else if (!node) {
    const target = document.documentElement;
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!request) {
      toast('这个浏览器不支持全屏');
      return;
    }
    Promise.resolve(request.call(target)).catch(() => toast('全屏被拒绝（内嵌页面需要 allow="fullscreen"）'));
  }
}

el.pause.addEventListener('click', () => setPaused(!app.paused));
el.resume.addEventListener('click', () => setPaused(false));
el.mute.addEventListener('click', () => setMuted(!audio.isMuted()));
el.help.addEventListener('click', () => showTutorial(el.tutorial.hidden));
el.fullscreen.addEventListener('click', toggleFullscreen);
el.start.addEventListener('click', closeTutorial);
el.skipTut.addEventListener('click', closeTutorial);
document.addEventListener('fullscreenchange', paintFullscreen);
document.addEventListener('webkitfullscreenchange', paintFullscreen);
// A tab that goes to the background is not a player who stepped away: the clock should not keep
// banking seconds nobody watched, and a held envelope should not run behind an unseen page.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio.halt();
    if (!app.paused) setPaused(true);
  }
});

// --------------------------------------------------------------------------- motion preference
// The OS setting is the authority and the page follows it live; js/view.js keeps the pixel-level
// branch (no particles, no easing), this layer keeps the announcement so the change is visible.
const reduceQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

function paintReduced() {
  const on = !!(reduceQuery && reduceQuery.matches);
  view.setReduced(on);
  return on;
}

if (reduceQuery) {
  if (typeof reduceQuery.addEventListener === 'function') reduceQuery.addEventListener('change', paintReduced);
  else if (typeof reduceQuery.addListener === 'function') reduceQuery.addListener(paintReduced);
}

// --------------------------------------------------------------------------- controls

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  const mode = b.dataset.mode;
  if (mode === 'campaign') go(`#/lot/${campaign()[Math.min(app.saved.unlock || 0, campaign().length - 1)].id}`);
  else if (mode === 'daily') go(`#/daily/${today()}`);
  else go(`#/random/${Math.random().toString(36).slice(2, 8)}`);
});

el.shelf.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.reroll) {
    go(`#/random/${Math.random().toString(36).slice(2, 8)}`);
    return;
  }
  if (b.dataset.id) go(`#/lot/${b.dataset.id}`);
});

el.undo.addEventListener('click', () => {
  if (!app.game) return;
  undo(app.game);
  app.game.done = false;
  el.curtain.hidden = true;
  render();
});

el.hint.addEventListener('click', () => {
  if (!app.game || app.game.done) return;
  const h = hintFor(app.game);
  if (!h) {
    say('已经和解答一致了。');
    return;
  }
  app.hints++;
  view.showHint(h);
  const name = app.game.pieces[h.piece];
  // The letter alone is not enough to find a lump on a board of five-cell shapes, so the hint
  // carries the same colour the canvas painted that piece with.
  say(`提示（免费，不动棋盘）：把 <b><i class="chip" style="--chip:${PIECE_COLOURS[name]}"></i>${name}</b> 放到 (${h.target.x}, ${h.target.y})，${h.why === 'misplaced' ? '现在的位置不对' : '它还在待置块里'}。`);
  renderReadout();
});

function restart() {
  if (!app.game) return;
  reset(app.game);
  elapsedMs = 0;
  shownSeconds = -1;
  app.seconds = 0;
  app.hints = 0;
  el.curtain.hidden = true;
  view.clearFx();
  say('倒回来了：待置块回到左边，操作数归零。');
  render();
}

el.restart.addEventListener('click', restart);
el.again.addEventListener('click', restart);
// Campaign walking, in both directions, through js/core/library.js: the shelf is ordered
// band-ascending, so "next"/"previous" are table facts rather than arithmetic on a private
// index. A generated level (每日 / 随机) has no neighbours, which is what the fallbacks are for.
el.next.addEventListener('click', () => {
  const lot = app.lot;
  if (!lot) return;
  if (lot.source === 'daily') {
    go(`#/lot/${campaign()[Math.min((app.saved.unlock || 0) + 1, campaign().length - 1)].id}`);
    return;
  }
  const ahead = app.index >= 0 ? nextOf(lot.id) : null;
  if (ahead && ahead.id !== lot.id) go(`#/lot/${ahead.id}`);
  else go(`#/random/${Math.random().toString(36).slice(2, 8)}`);
});
el.prev.addEventListener('click', () => {
  const back = app.index > 0 ? prevOf(app.lot.id) : null;
  if (back) go(`#/lot/${back.id}`);
  else toast('这是匣阵第一匣，再往前没有了');
});

el.share.addEventListener('click', async () => {
  const url = linkFor(app.route || `#/lot/${app.lot.id}`);
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制：同一链接同一关');
  } catch (err) {
    toast(url);
  }
});

// Two-click wipe, where the *core* owns the arming window (js/core/storage.js:armClear) and
// this handler only reflects it into the button label. A wipe that a refresh could undo is not
// a wipe, so `clearArm` lives in the save file rather than in a closure.
function paintWipeButton(armed) {
  el.wipe.setAttribute('aria-pressed', armed ? 'true' : 'false');
  el.wipe.textContent = armed ? '再点一次确认清空' : '清空存档';
}

el.wipe.addEventListener('click', () => {
  const r = store.armClear(Date.now());
  paintWipeButton(r.armed);
  if (!r.armed && !r.cleared) return;
  if (!r.cleared) {
    toast('再点一次清空全部成绩');
    return;
  }
  app.saved = store.load();
  restart();
  // The wipe took the settings with it, so the engine goes back to audible and the button has to
  // follow in the same tick — a 🔇 that still plays is a control that lies.
  setMuted(!!app.saved.settings.muted, false);
  render();
  toast('已清空');
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
// Keyboard shortcuts. `v` flips the piece last touched — the only sensible meaning of "the piece
// under the keyboard" for a game whose pointer is a mouse or a finger — because `f` is what every
// other media page on this device already means: fullscreen.
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  const onControl = ev.target && typeof ev.target.closest === 'function'
    && ev.target.closest('button,[role="button"],a[href],input,select,textarea');
  if (onControl && (k === ' ' || k === 'enter')) return;
  if (k === 'escape') {
    if (!el.tutorial.hidden) closeTutorial();
    else if (!el.curtain.hidden) el.curtain.hidden = true;
  } else if (k === ' ' || k === 'enter') {
    ev.preventDefault();
    if (!el.tutorial.hidden) closeTutorial();
    else setPaused(!app.paused);
  } else if (k === 'p') setPaused(!app.paused);
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') restart();
  else if (k === 'm') setMuted(!audio.isMuted());
  else if (k === 'f') toggleFullscreen();
  else if (k === 'v' && app.last >= 0 && app.game) commitFlip(app.last);
  else if (k === '?' || k === '/') showTutorial(el.tutorial.hidden);
});

// --------------------------------------------------------------------------- boot

apply();
// Three preferences the page has to *follow*, not merely advertise: the OS motion setting, the
// saved mute state (without rewriting the save file on the way in), and whatever fullscreen the
// host is already in — the button is painted from the document's state in all three cases.
paintReduced();
setMuted(!!store.load().settings.muted, false);
paintFullscreen();
// The how-to-play card opens once per device. It lives in the side panel and pauses nothing, so
// the canvas underneath stays hittable — @pointer drives real mouse events into it.
showTutorial(!store.load().settings.tutorialSeen);
view.start();

// The test surface. Everything forwards to the functions above — the same code a click runs.
window.pentapack = {
  version: 1,
  get state() {
    const g = app.game;
    return {
      mode: app.mode,
      label: app.label,
      route: location.hash,
      id: g && g.id,
      band: app.lot && app.lot.band,
      source: app.lot && app.lot.source,
      k: g && g.n,
      depth: app.lot && app.lot.depth,
      solutions: app.lot && app.lot.solutions === undefined ? 1 : app.lot && app.lot.solutions,
      moves: g && g.moves,
      placed: g && placedCount(g),
      hints: app.hints,
      seconds: app.seconds,
      done: !!(g && g.done),
      anomaly: g && g.anomaly,
      curtain: !el.curtain.hidden,
      // The HUD, read from the layers that own it: `view.fx().paused` is what actually gates the
      // pointer, `audio.state().muted` is what refuses to allocate a node, `fullscreen` is the
      // document's own answer. A button that only repaints itself would fail all three.
      paused: app.paused,
      viewPaused: view.fx().paused,
      veil: !el.veil.hidden,
      tutorial: !el.tutorial.hidden,
      fullscreen: !!fullscreenEl(),
      muted: audio.isMuted(),
      fx: view.fx(),
      audio: audio.state(),
      reduced: view.fx().reduced,
      index: app.index,
      unlocked: store.load().unlock,
      solved: campaign().filter((l) => store.load().done[l.id]).length,
      w: g && g.spec.w,
      h: g && g.spec.h,
      totalLots: campaign().length,
      variants: TOTAL_VARIANTS,
      saveKey: SAVE_KEY,
    };
  },
  // The per-piece tally the twelve-pentomino self-check is built from, exposed so a suite can
  // assert 8,2,8,8,8,4,4,4,4,4,1,8 against the *page's own* table rather than against a copy of
  // the literal that lives in the test file.
  variantCounts() {
    return NAMES.map((n) => [n, VARIANT_COUNT[n], variantCount(n), VARIANTS[n].length]);
  },
  byId(id) {
    const lot = byId(id);
    return lot ? { id: lot.id, band: lot.band, k: lot.k, depth: lot.depth, pieces: lot.spec.pieces.join('') } : null;
  },
  load(hash) {
    go(hash);
    return app.lot && app.lot.id;
  },
  // Raw board: mask + occupancy, so a test can look at the state without reading pixels.
  board() {
    const g = app.game;
    return g ? {
      w: g.spec.w, h: g.spec.h, mask: Array.from(g.spec.mask),
      cells: Array.from(g.cells), pieces: g.pieces.slice(),
    } : null;
  },
  layout() {
    const g = app.game;
    return g ? g.at.map((a) => ({ ...a, name: g.pieces[a.piece] })) : null;
  },
  solution() {
    return app.lot ? app.lot.solution.map((p) => ({ ...p })) : null;
  },
  // The geometry of one piece right now: what an automated finger compares before/after a
  // rotate or mirror click, because the variant index alone would not prove anything moved.
  poseOf(i) {
    const a = app.game.at[i];
    const name = app.game.pieces[i];
    return {
      piece: i, name, variant: a.variant, onBoard: a.onBoard, x: a.x, y: a.y,
      cells: VARIANTS[name][a.variant].cells.map((c) => c.join(',')),
    };
  },
  // Test hook for the completion guard: replace the baked line the finish check compares
  // against. If the guard cannot be made to fire, the guard is decorative.
  setSolution(list) {
    app.game.solution = (list || app.game.solution).map((p) => ({ ...p }));
    app.game.done = false;
    app.game.anomaly = null;
    return app.game.solution.length;
  },
  // The pure layer, so the browser suite can look for a placement that *must* bounce
  // (geometry, not a hard-coded coordinate).
  core: { VARIANTS, FULL_SET, NAMES, CELLS, variantCells, placementMask, validatePlacements, samePlacements },
  placementText() {
    return app.game ? renderMask(app.game.spec).replace(/\n/g, '/') : '';
  },
  // Where things are, in client pixels, for Input.dispatchMouseEvent.
  piecePoint(i) {
    return view.piecePoint(i);
  },
  boardPoint(x, y) {
    return view.boardPoint(x, y);
  },
  dropPoint(i, x, y, v) {
    return view.dropPoint(i, x, y, v);
  },
  aimAt(x, y, i, v) {
    return view.aimAt(x, y, i, v);
  },
  // Programmatic play through the same commit() a mouse triggers.
  place(i, x, y, v) {
    return commitDrop(i, v === undefined ? app.game.at[i].variant : v, x, y);
  },
  // Whose piece is on this board cell, asked of the rules rather than of a copy of the index
  // maths: this is exactly what js/view.js's hit test calls, so @pointer can check what the
  // canvas thinks is under the finger against what game.js says.
  pieceAt(x, y) {
    return app.game ? pieceAt(app.game, x, y) : -1;
  },
  take(i) {
    return commitTake(i);
  },
  rotate(i) {
    return commitRotate(i);
  },
  flip(i) {
    return commitFlip(i);
  },
  play() {
    for (const s of app.game.solution) place(app.game, s.piece, s.variant, s.x, s.y);
    afterMove();
    render();
    return app.game.moves;
  },
  undo() {
    el.undo.click();
    return app.game.moves;
  },
  hintOnce() {
    el.hint.click();
    return { hints: app.hints, line: el.hintline.textContent };
  },
  // The browser-side proof: re-run the exact counter and the reasoning solver on the level
  // that is actually on screen, and report what they say. tools/playtest.mjs asserts these
  // agree with the panel, which is what makes 解数=1 a claim about this build.
  //
  // It also re-checks the dancing-links bookkeeping *after* the search: cover/uncover are
  // supposed to be exact inverses, and a leak would leave a mutated matrix behind that makes
  // every later count on the same page wrong. Checking it here means a leak fails in the
  // browser that a player could open, not only in node.
  prove(limit) {
    const lot = app.lot;
    if (!lot) return null;
    const t0 = performance.now();
    const problem = packProblem(lot.spec);
    const digest = matrixDigest(problem);
    const count = countSolutions(problem, limit === undefined ? 2 : limit);
    const ms = Math.round(performance.now() - t0);
    return {
      count, ms, clean: isMatrixClean(problem, digest), nodes: solveLevel(lot.spec, 2).nodes,
    };
  },
  reason() {
    const lot = app.lot;
    if (!lot) return null;
    const r = logicSolve(lot.spec);
    return { solved: r.solved, depth: r.depth, guesses: r.guesses, agrees: samePlacements(r.placements, lot.solution) };
  },
  generate(seed, band) {
    const r = makeLevel({ seed, band: band || 'taster', maxAttempts: 300 });
    return r.ok ? { id: r.spec && seed, k: r.k, depth: r.depth, mask: Array.from(r.spec.mask) } : { failed: true, stats: r.stats };
  },
  makeRandom(seed, band) {
    const lot = randomLot(seed, band);
    return { id: lot.id, k: lot.k, depth: lot.depth, band: lot.band };
  },
  daily(dateKey) {
    const lot = dailyLot(dateKey || today());
    return { id: lot.id, k: lot.k, depth: lot.depth, band: lot.band };
  },
  serialise() {
    return serialiseLot(app.lot);
  },
  deserialise(text) {
    const lot = deserialiseLot(text);
    return { id: lot.id, ok: validateLevel(lot.spec) === null, same: samePlacements(lot.solution, app.lot.solution) };
  },
  check(raw) {
    return validateLevel(raw);
  },
  get pool() {
    return poolStats();
  },
  get store() {
    return store;
  },
  get el() {
    return el;
  },
  // The same redraw a click produces. @save writes the save file behind the app's back, so it
  // has to ask for the repaint a real unlock would have caused.
  render() {
    render();
  },
  // The HUD, forwarded through the very functions a click runs. A suite that only checked
  // app.paused would pass a button that repaints itself; these report what the owning layer says.
  pause(v) {
    return setPaused(v === undefined ? !app.paused : !!v);
  },
  mute(v) {
    return setMuted(v === undefined ? !audio.isMuted() : !!v);
  },
  help(show) {
    if (show === false) closeTutorial();
    else showTutorial(true);
    return !el.tutorial.hidden;
  },
  fullscreen() {
    toggleFullscreen();
    return !!fullscreenEl();
  },
  reduced(v) {
    if (v === undefined) return paintReduced();
    view.setReduced(!!v);
    return view.fx().reduced;
  },
  fx() {
    return view.fx();
  },
  get audioState() {
    return audio.state();
  },
  view,
};
