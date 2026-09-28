// Canvas renderer + gestures. This file owns pixels and pointers and decides nothing about
// legality: on release it hands main.js a piece, a variant and a snapped anchor, and
// js/core/game.js says yes or no. A refused drop is drawn where it failed, animated back to
// where it came from, and costs nothing — because the only place an operation is counted is
// game.place / game.takeBack, which a bounced drop never reaches.
//
// Everything is drawn procedurally from js/core/pieces.js geometry: no image assets exist in
// this repo, so a piece on screen is literally the same five-cell list the solver reasons
// about. Pieces are drawn in *pose space* (offsets from the anchor cell) everywhere, which
// keeps the snap maths, the ghost and the outlines three names for one thing.
//
// Two coordinate systems and no more:
//   local = CSS pixels inside the canvas rect (what pointer events give)
//   cell  = board cells, origin at the 匣 frame's top-left
// `snap()` maps local -> cell; `dropPoint()` is its exact inverse, so an automated finger can
// aim at a cell instead of guessing at an off-by-one (tools/playtest.mjs does exactly that).

import { VARIANTS } from './core/pieces.js';
import { pieceAt } from './core/game.js';

const PAD = 14;
const TRAY_RATIO = 0.3; // share of the width given to 待置块区
const GAP = 12;
const LONG_PRESS_MS = 480;
const BOUNCE_MS = 200;

// One colour per pentomino, muted so five tiles of one piece read as one object.
const BODY = {
  F: '#b4553f', I: '#3f74a8', L: '#c08a3e', P: '#7a5aa8', N: '#4f8f6a', T: '#a8527f',
  U: '#5f8fa8', V: '#8fa83e', W: '#a8703e', X: '#6f6fb0', Y: '#3fa893', Z: '#93507f',
};
const WOOD = '#0f1216';
const BOX = '#1b2028';
const BOX_EDGE = 'rgba(216, 180, 90, 0.55)';
const OK_GHOST = 'rgba(111, 208, 182, 0.18)';
const BAD_GHOST = 'rgba(216, 121, 90, 0.22)';
const HINT = '#6fd0b6';
const BAD = '#d8795a';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  let game = null;
  let geom = null;
  let drag = null; // { piece, variant, x, y, origin, moved }
  let hint = null; // { piece, pose, ax, ay, until }
  let flash = null; // { pose, ax, ay, until, code }  a refused drop, shown once where it failed
  let anim = null; // { piece, variant, from, to, t0, life }  a piece flying home
  let raf = 0;
  let pressTimer = 0;
  let longFired = false;

  // ---------------------------------------------------------------- geometry
  function pose(name, variant) {
    return VARIANTS[name][variant].cells;
  }

  function measure() {
    if (!game) return;
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(240, Math.round(box.width));
    const H = Math.max(240, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = game.spec;
    const trayW = Math.max(90, Math.round(W * TRAY_RATIO));
    const cell = Math.max(12, Math.floor(Math.min(
      (W - trayW - PAD * 2 - GAP) / w,
      (H - PAD * 2) / h,
    )));
    const bx = Math.round(trayW + GAP + (W - trayW - GAP - cell * w) / 2);
    const by = Math.round((H - cell * h) / 2);
    // Tray layout: one column when every piece fits vertically, two when it does not.
    const avail = H - PAD * 2 - 14;
    const one = Math.floor(Math.min((trayW - PAD * 2) / 5, avail / (game.n * 5.4)));
    const two = Math.floor(Math.min((trayW - PAD * 2 - 6) / 10, avail / (Math.ceil(game.n / 2) * 5.4)));
    const cols = one >= 7 ? 1 : 2;
    const tcell = Math.max(4, cols === 1 ? one : two);
    const slotW = tcell * 5;
    const slotH = tcell * 5.4;
    const slots = [];
    for (let i = 0; i < game.n; i++) {
      const col = cols === 2 ? i % 2 : 0;
      const row = cols === 2 ? Math.floor(i / 2) : i;
      const rows = cols === 2 ? Math.ceil(game.n / 2) : game.n;
      slots.push({
        piece: i,
        x: Math.round(PAD + col * (slotW + 6)),
        y: Math.round(20 + (avail - rows * (slotH + 4)) / 2 + row * (slotH + 4)),
        w: slotW,
        h: slotH,
      });
    }
    geom = {
      cell, vw: W, vh: H, w, h, trayW, cols, tcell,
      box: { x: bx, y: by, w: cell * w, h: cell * h },
      slots,
    };
    draw();
  }

  function toLocal(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // local pixel -> the anchor cell whose *bbox centre* is nearest that pixel.
  function snap(p, name, variant) {
    const vb = VARIANTS[name][variant].bbox;
    return {
      x: Math.round((p.x - geom.box.x) / geom.cell - vb.w / 2),
      y: Math.round((p.y - geom.box.y) / geom.cell - vb.h / 2),
    };
  }

  function inBox(p) {
    const b = geom.box;
    return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
  }

  function slotAt(p) {
    if (p.x >= geom.trayW) return -1;
    for (const s of geom.slots) {
      if (p.x >= s.x - 4 && p.y >= s.y - 4 && p.x <= s.x + s.w + 4 && p.y <= s.y + s.h + 4) return s.piece;
    }
    return -2; // in the tray, but not on a piece
  }

  function pieceUnder(p) {
    if (!inBox(p)) return -1;
    const x = Math.floor((p.x - geom.box.x) / geom.cell);
    const y = Math.floor((p.y - geom.box.y) / geom.cell);
    if (x < 0 || y < 0 || x >= geom.w || y >= geom.h) return -1;
    // game.js owns "who is on this cell", bounds check included; the view only turns a pixel
    // into a cell. The hand-rolled `game.cells[y * w + x]` that used to sit here could not
    // report -1 for an off-frame cell, so a click on the box's outer border was undefined
    // behaviour rather than "nothing here".
    return pieceAt(game, x, y);
  }

  function slotCentre(piece) {
    const s = geom.slots[piece];
    return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  }

  // Where a piece's *anchor* (bbox top-left) is drawn right now, in local pixels, at board
  // scale. Used by the ghost, the bounce and the hit maths so they cannot disagree.
  function anchorOf(piece) {
    const a = game.at[piece];
    return { x: geom.box.x + a.x * geom.cell, y: geom.box.y + a.y * geom.cell };
  }

  function ghostAnchor(piece, variant, p) {
    const vb = VARIANTS[game.pieces[piece]][variant].bbox;
    return { x: p.x - (vb.w * geom.cell) / 2, y: p.y - (vb.h * geom.cell) / 2 - 10 };
  }

  // A press that is *on* a placed piece: the centre of the occupied cell nearest the middle of
  // its bounding box. The box centre itself is a hole for V, U and W, and pieceUnder() reads a
  // hole as "nothing under the finger" — which is right, so the finger has to aim at the body.
  function grabCentre(piece) {
    const a = game.at[piece];
    const vb = VARIANTS[game.pieces[piece]][a.variant].bbox;
    let best = [0, 0];
    let nearest = Infinity;
    for (const [dx, dy] of pose(game.pieces[piece], a.variant)) {
      const d = Math.hypot(dx + 0.5 - vb.w / 2, dy + 0.5 - vb.h / 2);
      if (d < nearest) { nearest = d; best = [dx, dy]; }
    }
    return { x: anchorOf(piece).x + (best[0] + 0.5) * geom.cell, y: anchorOf(piece).y + (best[1] + 0.5) * geom.cell };
  }

  // ---------------------------------------------------------------- painting
  // pose = [[dx,dy]] relative to the anchor; (px, py) = anchor pixel; size = cell edge.
  function drawPose(name, cells, px, py, size, alpha, lift) {
    const colour = BODY[name] || '#7d8493';
    const set = new Set(cells.map(([dx, dy]) => `${dx},${dy}`));
    ctx.globalAlpha = alpha;
    for (const [dx, dy] of cells) {
      const cx = px + dx * size;
      const cy = py + dy * size;
      ctx.fillStyle = colour;
      roundRect(ctx, cx + 1, cy + 1, size - 2, size - 2, Math.max(2, size * 0.16));
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      roundRect(ctx, cx + 2.5, cy + 2.5, Math.max(2, size - 5), Math.max(2, size * 0.22), 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(10, 12, 16, 0.9)';
    ctx.lineWidth = Math.max(1.2, size * 0.08);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [dx, dy] of cells) {
      const cx = px + dx * size;
      const cy = py + dy * size;
      if (!set.has(`${dx},${dy - 1}`)) { ctx.moveTo(cx, cy); ctx.lineTo(cx + size, cy); }
      if (!set.has(`${dx},${dy + 1}`)) { ctx.moveTo(cx, cy + size); ctx.lineTo(cx + size, cy + size); }
      if (!set.has(`${dx - 1},${dy}`)) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + size); }
      if (!set.has(`${dx + 1},${dy}`)) { ctx.moveTo(cx + size, cy); ctx.lineTo(cx + size, cy + size); }
    }
    ctx.stroke();
    if (lift) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1.5;
      for (const [dx, dy] of cells) {
        roundRect(ctx, px + dx * size + 1, py + dy * size + 1, size - 2, size - 2, Math.max(2, size * 0.16));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function outlinePose(cells, px, py, size, colour) {
    const set = new Set(cells.map(([dx, dy]) => `${dx},${dy}`));
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (const [dx, dy] of cells) {
      const cx = px + dx * size;
      const cy = py + dy * size;
      if (!set.has(`${dx},${dy - 1}`)) { ctx.moveTo(cx, cy); ctx.lineTo(cx + size, cy); }
      if (!set.has(`${dx},${dy + 1}`)) { ctx.moveTo(cx, cy + size); ctx.lineTo(cx + size, cy + size); }
      if (!set.has(`${dx - 1},${dy}`)) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + size); }
      if (!set.has(`${dx + 1},${dy}`)) { ctx.moveTo(cx + size, cy); ctx.lineTo(cx + size, cy + size); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function fillPose(cells, px, py, size, colour) {
    ctx.fillStyle = colour;
    for (const [dx, dy] of cells) ctx.fillRect(px + dx * size, py + dy * size, size, size);
  }

  function draw() {
    if (!game || !geom) return;
    const { cell, box } = geom;
    ctx.clearRect(0, 0, geom.vw, geom.vh);
    ctx.fillStyle = WOOD;
    roundRect(ctx, 3, 3, geom.vw - 6, geom.vh - 6, 12);
    ctx.fill();

    // --- tray
    ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
    roundRect(ctx, 6, 6, geom.trayW - 8, geom.vh - 12, 10);
    ctx.fill();
    ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('待置块', 10, 16);
    for (const s of geom.slots) {
      const a = game.at[s.piece];
      const dragging = drag && drag.piece === s.piece;
      if (a.onBoard || dragging) {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.06)';
        ctx.setLineDash([3, 4]);
        roundRect(ctx, s.x, s.y, s.w, s.h, 6);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (a.onBoard || dragging || (anim && anim.piece === s.piece)) continue;
      drawPose(game.pieces[s.piece], pose(game.pieces[s.piece], a.variant),
        s.x, s.y + 2, geom.tcell, 1, false);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(game.pieces[s.piece], s.x + 1, s.y + s.h - 1);
      if (hint && hint.piece === s.piece) {
        ctx.strokeStyle = HINT;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        roundRect(ctx, s.x - 2, s.y - 2, s.w + 4, s.h + 4, 8);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- the 匣 itself
    ctx.fillStyle = BOX;
    roundRect(ctx, box.x - 6, box.y - 6, box.w + 12, box.h + 12, 10);
    ctx.fill();
    ctx.strokeStyle = BOX_EDGE;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    for (let y = 0; y < geom.h; y++) {
      for (let x = 0; x < geom.w; x++) {
        if (!game.spec.mask[y * geom.w + x]) continue;
        const cx = box.x + x * cell;
        const cy = box.y + y * cell;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
        ctx.fillRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.07)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
      }
    }

    for (const a of game.at) {
      if (!a.onBoard) continue;
      if ((drag && drag.piece === a.piece) || (anim && anim.piece === a.piece)) continue;
      drawPose(game.pieces[a.piece], pose(game.pieces[a.piece], a.variant),
        anchorOf(a.piece).x, anchorOf(a.piece).y, cell, 1, false);
    }

    if (hint && hint.cells) {
      outlinePose(hint.cells, box.x + hint.ax * cell, box.y + hint.ay * cell, cell, HINT);
    }
    if (flash && flash.cells) {
      fillPose(flash.cells, box.x + flash.ax * cell, box.y + flash.ay * cell, cell, BAD_GHOST);
      outlinePose(flash.cells, box.x + flash.ax * cell, box.y + flash.ay * cell, cell, BAD);
    }
    if (anim) drawAnim();
    if (drag) drawGhost();
  }

  // The floating piece plus the snap preview under it.
  function drawGhost() {
    const name = game.pieces[drag.piece];
    const cells = pose(name, drag.variant);
    const p = inBox(drag) ? snap(drag, name, drag.variant) : null;
    if (p && hooks.canDrop && hooks.canDrop(drag.piece, drag.variant, p.x, p.y)) {
      fillPose(cells, geom.box.x + p.x * geom.cell, geom.box.y + p.y * geom.cell, geom.cell, OK_GHOST);
    } else if (p) {
      fillPose(cells, geom.box.x + p.x * geom.cell, geom.box.y + p.y * geom.cell, geom.cell, BAD_GHOST);
    }
    const g = ghostAnchor(drag.piece, drag.variant, drag);
    drawPose(name, cells, g.x, g.y, geom.cell, 0.96, true);
  }

  function drawAnim() {
    const t = Math.max(0, Math.min(1, (Date.now() - anim.t0) / anim.life));
    const e = 1 - Math.pow(1 - t, 3);
    const x = anim.from.x + (anim.to.x - anim.from.x) * e;
    const y = anim.from.y + (anim.to.y - anim.from.y) * e;
    const name = game.pieces[anim.piece];
    const g = anchorOf(anim.piece);
    drawPose(name, pose(name, anim.variant),
      anim.flying ? x : g.x, anim.flying ? y : g.y, geom.cell, 0.92, true);
  }

  // ---------------------------------------------------------------- gestures
  function beginDrag(piece, p) {
    const a = game.at[piece];
    drag = {
      piece,
      variant: a.variant,
      x: p.x,
      y: p.y,
      origin: a.onBoard ? { onBoard: true, x: a.x, y: a.y } : { onBoard: false },
      moved: false,
    };
    longFired = false;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (!drag || drag.piece !== piece) return;
      longFired = true;
      const v = drag.piece;
      endDrag();
      if (hooks.onFlip) hooks.onFlip(v);
    }, LONG_PRESS_MS);
    draw();
  }

  function capture(ev) {
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* a browser that refuses capture still drags fine inside the canvas */
      }
    }
  }

  function down(ev) {
    if (!game || game.done || ev.button === 2) return; // right button is 翻面, not a drag
    const p = toLocal(ev);
    const onBoard = pieceUnder(p);
    if (onBoard >= 0) {
      beginDrag(onBoard, p);
      capture(ev);
      ev.preventDefault();
      return;
    }
    const slot = slotAt(p);
    if (slot >= 0 && !game.at[slot].onBoard) {
      beginDrag(slot, p);
      capture(ev);
      ev.preventDefault();
    }
  }

  function move(ev) {
    if (!drag) return;
    const p = toLocal(ev);
    if (pressTimer && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 6) {
      clearTimeout(pressTimer);
      pressTimer = 0;
    }
    drag.x = p.x;
    drag.y = p.y;
    drag.moved = true;
    ev.preventDefault();
  }

  function endDrag() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = 0;
    }
    drag = null;
  }

  function up(ev) {
    if (!drag) return;
    if (longFired) {
      endDrag();
      if (ev) ev.preventDefault();
      return;
    }
    const piece = drag.piece;
    const variant = drag.variant;
    const fromBoard = drag.origin.onBoard;
    const p = toLocal(ev || drag);
    const overTray = !inBox(p) && p.x < geom.trayW;
    const target = inBox(p) ? snap(p, game.pieces[piece], variant) : null;
    const ghostFrom = ghostAnchor(piece, variant, p);
    endDrag();
    if (ev) ev.preventDefault();

    if (overTray) {
      if (fromBoard && hooks.onTake) hooks.onTake(piece);
      else draw();
      return;
    }
    if (!target) {
      flyHome(piece, variant, ghostFrom, fromBoard);
      return;
    }
    const res = hooks.onDrop ? hooks.onDrop(piece, variant, target.x, target.y) : null;
    if (res && res.ok) {
      draw();
      return;
    }
    const code = (res && res.code) || 'overlap';
    flash = { cells: pose(game.pieces[piece], variant), ax: target.x, ay: target.y, until: Date.now() + 300, code };
    if (hooks.onRefuse) hooks.onRefuse(code);
    flyHome(piece, variant, ghostFrom, fromBoard, true);
  }

  // No state was touched, so the piece goes back exactly where it was.
  function flyHome(piece, variant, from, onBoard, longer) {
    const a = game.at[piece];
    const to = onBoard
      ? anchorOf(piece)
      : { x: slotCentre(piece).x - (VARIANTS[game.pieces[piece]][variant].bbox.w * geom.cell) / 2,
        y: slotCentre(piece).y - (VARIANTS[game.pieces[piece]][variant].bbox.h * geom.cell) / 2 };
    anim = {
      piece, variant, from, to, flying: true,
      t0: Date.now(), life: longer ? BOUNCE_MS + 60 : BOUNCE_MS,
    };
    setTimeout(() => {
      anim = null;
      draw();
    }, anim.life + 20);
    draw();
  }

  function dbl(ev) {
    if (!game || game.done) return;
    const p = toLocal(ev);
    const piece = pieceUnder(p) >= 0 ? pieceUnder(p) : slotAt(p);
    if (piece < 0) return;
    if (hooks.onRotate) hooks.onRotate(piece);
    ev.preventDefault();
  }

  function onContext(ev) {
    ev.preventDefault();
    if (!game || game.done) return;
    const p = toLocal(ev);
    const under = pieceUnder(p);
    const piece = under >= 0 ? under : slotAt(p);
    if (piece >= 0 && hooks.onFlip) hooks.onFlip(piece);
  }

  // ---------------------------------------------------------------- loop
  function tick() {
    const now = Date.now();
    let dirty = !!anim;
    if (hint && now > hint.until) {
      hint = null;
      dirty = true;
    }
    if (flash && now > flash.until) {
      flash = null;
      dirty = true;
    }
    if (dirty) draw();
    raf = requestAnimationFrame(tick);
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => {
    if (drag) flyHome(drag.piece, drag.variant, ghostAnchor(drag.piece, drag.variant, drag), drag.origin.onBoard);
    endDrag();
  });
  canvas.addEventListener('dblclick', dbl);
  canvas.addEventListener('contextmenu', onContext);

  return {
    setGame(g) {
      game = g;
      drag = null;
      anim = null;
      flash = null;
      hint = null;
      measure();
    },
    measure,
    draw,
    start() {
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    geometry() {
      return geom;
    },
    // The hint: outline where the baked solution says this piece goes, or dash its tray slot.
    showHint(h) {
      if (!game || !h) return;
      const s = h.target;
      hint = {
        piece: h.piece,
        cells: s ? pose(game.pieces[h.piece], s.variant) : null,
        ax: s ? s.x : 0,
        ay: s ? s.y : 0,
        until: Date.now() + 3000,
      };
      draw();
    },
    clearHint() {
      hint = null;
      draw();
    },

    // --- the automated-finger API (window.pentapack forwards these) --------
    // Client pixels, because CDP Input events are in client space.
    piecePoint(piece) {
      const p = game.at[piece].onBoard ? grabCentre(piece) : slotCentre(piece);
      const r = canvas.getBoundingClientRect();
      return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) };
    },
    boardPoint(x, y) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round(r.left + geom.box.x + (x + 0.5) * geom.cell),
        y: Math.round(r.top + geom.box.y + (y + 0.5) * geom.cell),
      };
    },
    // Release the mouse here and this piece's anchor lands on (x, y) — the exact inverse of
    // snap(), which is what makes a drag-and-drop test independent of the renderer's layout.
    // `variant` only sizes the bbox: a mouse cannot turn a piece, so the caller must have
    // turned it to that pose already (double click, right click, long press, or f).
    dropPoint(piece, x, y, variant) {
      const v = variant === undefined ? game.at[piece].variant : variant;
      const vb = VARIANTS[game.pieces[piece]][v].bbox;
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round(r.left + geom.box.x + (x + vb.w / 2) * geom.cell),
        y: Math.round(r.top + geom.box.y + (y + vb.h / 2) * geom.cell),
      };
    },
    // What a release at a client point *would* do, predicted without moving a mouse.
    aimAt(clientX, clientY, piece, variant) {
      const r = canvas.getBoundingClientRect();
      const p = { x: clientX - r.left, y: clientY - r.top };
      const v = variant === undefined ? game.at[piece].variant : variant;
      if (inBox(p)) return { where: 'board', ...snap(p, game.pieces[piece], v) };
      if (p.x < geom.trayW) return { where: 'tray' };
      return { where: 'nowhere' };
    },
  };
}

export const PIECE_COLOURS = BODY;
