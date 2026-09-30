// Canvas renderer + gestures. This file owns pixels and pointers and decides nothing about
// legality: on release it hands main.js a piece, a variant and a snapped anchor, and
// js/core/game.js says yes or no. A refused drop is drawn where it failed, animated back to
// where it came from, and costs nothing — because the only place an operation is counted is
// game.place / game.takeBack, which a bounced drop never reaches.
//
// The pieces themselves are still drawn procedurally from js/core/pieces.js geometry: a piece
// on screen is literally the same five-cell list the solver reasons about. What the generated
// bitmaps under assets/ are for is the *material* — the lacquer cloth lining the 匣 and the
// dust/spark sprites the feedback particles draw from. Both are optional at runtime: if the
// images never load (file://, a blocked request, an offline first paint) every consumer falls
// back to the flat colour it used before, so the board is never blank because of an asset.
//
// Two coordinate systems and no more:
//   local = CSS pixels inside the canvas rect (what pointer events give)
//   cell  = board cells, origin at the 匣 frame's top-left
// `snap()` maps local -> cell; `dropPoint()` is its exact inverse, so an automated finger can
// aim at a cell instead of guessing at an off-by-one (tools/playtest.mjs does exactly that).
//
// Every animation is integrated from the frame delta: `clock += dt`, `p.x += p.vx * dt`,
// damping as `Math.pow(k, dt * 60)`. Nothing here may assume 60Hz — a 30Hz tablet and a 120Hz
// phone must show the same bounce over the same wall-clock second, and tools/../harness
// proves it by feeding 30/60/120Hz against one virtual duration.

import { VARIANTS } from './core/pieces.js';
import { pieceAt } from './core/game.js';

const PAD = 14;
const TRAY_RATIO = 0.3; // share of the width given to 待置块区
const GAP = 12;
const LONG_PRESS_MS = 480;
const BOUNCE_S = 0.2; // a refused drop's flight home, in seconds (was 200ms at 60Hz)
const FLASH_S = 0.3;
const HINT_S = 3;
const DUST_S = 0.62;
const SPARK_S = 0.9;
const MAX_DT = 0.25; // a backgrounded tab returns with a huge delta: never fast-forward the world

const FELT_URL = 'assets/textures/felt.png';
const DUST_URL = 'assets/sprites/dust.png';
const SPARK_URL = 'assets/sprites/spark.png';

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

// Deterministic per-burst randomness: Math.random() would make the same drop look different
// twice and, worse, make a 30Hz run diverge from a 120Hz run for no reason but the RNG.
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function loadArt(onReady) {
  const art = { felt: null, dust: null, spark: null, patterns: 0 };
  const want = [[FELT_URL, 'felt'], [DUST_URL, 'dust'], [SPARK_URL, 'spark']];
  let settled = 0;
  for (const [url, key] of want) {
    const img = new Image();
    img.onload = () => {
      art[key] = img;
      if (key === 'felt') art.patterns++;
      onReady(key);
    };
    img.onerror = () => {
      // Missing material is a flat-colour game, not a broken one. Counted so fx() can say so.
      art.missing = (art.missing || []).concat([url]);
      settled++;
    };
    img.src = url;
  }
  return art;
}

export function createView(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  let game = null;
  let geom = null;
  let drag = null; // { piece, variant, x, y, origin, moved }
  let hint = null; // { piece, cells, ax, ay, t, life }
  let flash = null; // { cells, ax, ay, t, life, code }  a refused drop, shown where it failed
  let anim = null; // { piece, variant, from, to, t, life }  a piece flying home
  let parts = []; // feedback particles, integrated from dt
  let raf = 0;
  let pressTimer = 0;
  let longFired = false;
  let clock = 0; // seconds of *unpaused* presentation time, accumulated from frame deltas
  let last = -1; // the rAF timestamp of the previous frame; -1 until the first one arrives
  let paused = false;
  let reduced = false;
  let bursts = 0;
  let feltPattern = null;
  const art = loadArt((key) => {
    if (key === 'felt' && art.felt) {
      try {
        feltPattern = ctx.createPattern(art.felt, 'repeat');
      } catch (err) {
        feltPattern = null;
      }
    }
    draw();
  });

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
    // The generated lacquer cloth over the flat wood tint; a soft-light blend keeps the cells
    // readable. Only when the bitmap actually arrived.
    if (feltPattern) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = feltPattern;
      roundRect(ctx, 3, 3, geom.vw - 6, geom.vh - 6, 12);
      ctx.fill();
      ctx.restore();
    }

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
    if (feltPattern) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = feltPattern;
      roundRect(ctx, box.x - 6, box.y - 6, box.w + 12, box.h + 12, 10);
      ctx.fill();
      ctx.restore();
    }
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
      // The refused pose stops pulsing under reduced motion; it stays visible for its window.
      const pulse = reduced ? 1 : 1 - 0.25 * Math.sin(Math.PI * (flash.t / flash.life));
      ctx.globalAlpha = pulse;
      fillPose(flash.cells, box.x + flash.ax * cell, box.y + flash.ay * cell, cell, BAD_GHOST);
      outlinePose(flash.cells, box.x + flash.ax * cell, box.y + flash.ay * cell, cell, BAD);
      ctx.globalAlpha = 1;
    }
    drawParticles();
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
    const t = Math.max(0, Math.min(1, anim.t / anim.life));
    const e = reduced ? t : 1 - Math.pow(1 - t, 3);
    const x = anim.from.x + (anim.to.x - anim.from.x) * e;
    const y = anim.from.y + (anim.to.y - anim.from.y) * e;
    const name = game.pieces[anim.piece];
    const g = anchorOf(anim.piece);
    drawPose(name, pose(name, anim.variant),
      anim.flying ? x : g.x, anim.flying ? y : g.y, geom.cell, 0.92, true);
  }

  // ---------------------------------------------------------------- feedback particles
  function spawnBurst(cells, ax, ay, kind) {
    if (reduced || !cells) return 0;
    const cell = geom.cell;
    const box = geom.box;
    const rand = lcg((ax + 1) * 7919 + (ay + 1) * 104729 + bursts * 31 + kind * 7);
    const per = kind === 1 ? 3 : 5;
    let made = 0;
    for (const [dx, dy] of cells) {
      const cx = box.x + (ax + dx + 0.5) * cell;
      const cy = box.y + (ay + dy + 0.5) * cell;
      for (let i = 0; i < per; i++) {
        const ang = rand() * Math.PI * 2;
        const speed = (kind === 1 ? 78 : 34) * (0.55 + rand() * 0.9);
        parts.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - (kind === 1 ? 26 : 12),
          t: 0, life: (kind === 1 ? SPARK_S : DUST_S) * (0.75 + rand() * 0.5),
          size: cell * (kind === 1 ? 0.5 : 0.34) * (0.6 + rand() * 0.8),
          kind,
        });
        made++;
      }
    }
    parts = parts.length > 420 ? parts.slice(parts.length - 420) : parts;
    bursts++;
    return made;
  }

  function stepParticles(dt) {
    if (!parts.length) return false;
    const keep = [];
    for (const p of parts) {
      p.t += dt;
      if (p.t >= p.life) continue;
      // Exponential damping written as pow(k, dt*60) so one second of real time is one second
      // of damping no matter how many frames that second arrives in.
      const drag = Math.pow(0.9, dt * 60);
      p.vx *= drag;
      p.vy = p.vy * drag + 128 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      keep.push(p);
    }
    const changed = keep.length !== parts.length;
    parts = keep;
    // A field that merely moved still has to be repainted; the frame that empties it needs one
    // last paint to clear it. Returning only `changed` here made the burst integrate every frame
    // and repaint only when a particle died, i.e. a frozen image that popped (harness: 0 sprites
    // painted on the frames between deaths, at every rate).
    return changed || parts.length > 0;
  }

  function drawParticles() {
    if (!parts.length) return;
    const sprite = (kind) => (kind === 1 ? art.spark : art.dust);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      const r = p.t / p.life;
      const alpha = (1 - r) * (1 - r) * (p.kind === 1 ? 0.9 : 0.5);
      const img = sprite(p.kind);
      if (!img) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
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
    if (!game || game.done || paused || ev.button === 2) return; // right button is 翻面, not a drag
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
      spawnBurst(pose(game.pieces[piece], variant), target.x, target.y, 0);
      draw();
      return;
    }
    const code = (res && res.code) || 'overlap';
    flash = { cells: pose(game.pieces[piece], variant), ax: target.x, ay: target.y, t: 0, life: FLASH_S, code };
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
      t: 0, life: longer ? BOUNCE_S + 0.06 : BOUNCE_S,
    };
    draw();
  }

  function dbl(ev) {
    if (!game || game.done || paused) return;
    const p = toLocal(ev);
    const piece = pieceUnder(p) >= 0 ? pieceUnder(p) : slotAt(p);
    if (piece < 0) return;
    if (hooks.onRotate) hooks.onRotate(piece);
    ev.preventDefault();
  }

  function onContext(ev) {
    ev.preventDefault();
    if (!game || game.done || paused) return;
    const p = toLocal(ev);
    const under = pieceUnder(p);
    const piece = under >= 0 ? under : slotAt(p);
    if (piece >= 0 && hooks.onFlip) hooks.onFlip(piece);
  }

  // ---------------------------------------------------------------- loop
  function frame(dt) {
    let dirty = false;
    if (hint) {
      hint.t += dt;
      if (hint.t >= hint.life) {
        hint = null;
        dirty = true;
      }
    }
    if (flash) {
      flash.t += dt;
      if (flash.t >= flash.life) {
        flash = null;
        dirty = true;
      }
    }
    if (anim) {
      anim.t += dt;
      if (anim.t >= anim.life) {
        anim = null;
        dirty = true;
      }
    }
    if (stepParticles(dt)) dirty = true;
    if (dirty) draw();
  }

  function advance(dt) {
    clock += dt;
    frame(dt);
    if (hooks.onFrame) hooks.onFrame(dt);
  }

  function tick(ts) {
    const now = typeof ts === 'number' ? ts : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = last < 0 ? 0 : (now - last) / 1000;
    last = now;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;
    if (!paused) advance(dt);
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
      parts = [];
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
      // A stopped loop has no next frame to take the delta from, so the next start() must not
      // charge the whole paused interval to the world.
      last = -1;
    },
    // 暂停：主循环继续跑（纱层要能重绘），但 dt 一律不计入世界，输入也被挡住。
    setPaused(v) {
      paused = !!v;
      last = -1;
      draw();
      return paused;
    },
    // prefers-reduced-motion 的真分支：粒子不生成、弹回退化为线性、闪光不再脉动。
    setReduced(v) {
      const next = !!v;
      if (next === reduced) return reduced;
      reduced = next;
      if (reduced) parts = [];
      draw();
      return reduced;
    },
    // What the frame-rate harness reads: presentation clock, live particles, burst count.
    fx() {
      return {
        clock,
        seconds: Math.floor(clock),
        particles: parts.length,
        bursts,
        paused,
        reduced,
        felt: !!feltPattern,
        sprites: (art.dust ? 1 : 0) + (art.spark ? 1 : 0),
      };
    },
    celebrate() {
      if (!game || !geom) return 0;
      let made = 0;
      for (const a of game.at) {
        if (!a.onBoard) continue;
        made += spawnBurst(pose(game.pieces[a.piece], a.variant), a.x, a.y, 1);
      }
      draw();
      return made;
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
        t: 0,
        life: HINT_S,
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
    // turned it to that pose already (double click, right click, long press, or v).
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
