#!/usr/bin/env python3
"""五连块匣的美术资产工厂：一条命令重画出全部图标、纹理与粒子贴图。

    python3 assets/gen/gen_art.py             # 画
    python3 assets/gen/gen_art.py --verify     # 重画一遍并逐文件比 sha256，漂移即红

为什么自己画而不下图：这个仓的玩法就是"五连块填满匣子，且只有解由精确覆盖
证明"，所以图标的主体不是随手一个圆角方块，而是**真的把 5x5 匣子无重叠铺满
的五个不同五连块** —— 由本文件里那个 first-fit exact cover 跑出来的解，写进
manifest.json 供对账。颜色与形状都不另立一份表：BODY 从 js/view.js 解析、
SHAPES 从 js/core/pieces.js 解析、色板从 css/game.css 解析。改了一处配色，
图标必须跟着重画，否则 --verify 就红 —— 资产与代码不许各说各话。

只用 python3 标准库（zlib/struct/math/re），不依赖 PIL，也不下载任何字体：
因此 CI 与本地画出来的字节完全一致（没有随机、没有墙钟、没有系统字体）。像素
用带解析抗锯齿的 SDF 光栅（coverage = clamp(0.5 - sd, 0, 1)），小尺寸按原生
分辨率重画而不是从大图缩放，所以 16px 的 favicon 不糊成一团。
"""
import hashlib
import json
import math
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
REPO = os.path.dirname(ASSETS)
GEN_VERSION = 'pentapack-art-1'

# Each rung here is a <link rel="icon" sizes=...> in index.html; 180 is deliberately absent
# because icons/apple-touch-icon.png already *is* the 180px opaque render.
FULL_SIZES = [1024, 512, 192, 96]
BOLD_SIZES = [64, 48, 32, 16]
OG_W, OG_H = 1200, 630


# ------------------------------------------------------------------ 输入：从产品代码里读
def parse_css_vars():
    src = open(os.path.join(REPO, 'css', 'game.css'), encoding='utf-8').read()
    out = {}
    for m in re.finditer(r'--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})', src):
        out[m.group(1)] = m.group(2)
    missing = [k for k in ['bg', 'bg-2', 'panel', 'brass', 'jade', 'rust'] if k not in out]
    if missing:
        raise SystemExit('css/game.css is missing palette vars: %s' % ', '.join(missing))
    return out


def parse_body_colours():
    src = open(os.path.join(REPO, 'js', 'view.js'), encoding='utf-8').read()
    block = re.search(r'const BODY = \{([\s\S]*?)\n\};', src)
    if not block:
        raise SystemExit('js/view.js no longer declares the BODY colour table')
    out = {}
    for m in re.finditer(r'([A-Z])\s*:\s*\'#([0-9a-fA-F]{6})\'', block.group(1)):
        out[m.group(1)] = '#' + m.group(2).lower()
    if len(out) != 12:
        raise SystemExit('js/view.js BODY table has %d colours, expected 12' % len(out))
    return out


def parse_shapes():
    src = open(os.path.join(REPO, 'js', 'core', 'pieces.js'), encoding='utf-8').read()
    block = re.search(r'export const SHAPES = \{([\s\S]*?)\n\};', src)
    if not block:
        raise SystemExit('js/core/pieces.js no longer declares SHAPES')
    out = {}
    for line in block.group(1).split('\n'):
        head = re.match(r'\s*([A-Z])\s*:\s*\[(.*)\]\s*,?\s*$', line)
        if not head:
            continue
        cells = [(int(a), int(b)) for a, b in
                 re.findall(r'\[\s*(\d+)\s*,\s*(\d+)\s*\]', head.group(2))]
        if len(cells) == 5:
            out[head.group(1)] = cells
    if len(out) != 12:
        raise SystemExit('parsed %d pentominoes from pieces.js, expected 12' % len(out))
    return out


def parse_lot_count():
    src = open(os.path.join(REPO, 'js', 'data', 'lots.js'), encoding='utf-8').read()
    m = re.search(r'"lots"\s*:\s*(\d+)', src)
    if not m:
        raise SystemExit('js/data/lots.js no longer declares META.lots')
    return int(m.group(1))


def rgb(hexstr):
    h = hexstr.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


# ------------------------------------------------------------------ 图标主体的来源：真铺一次
def norm(cells):
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]
    return tuple(sorted((x - min(xs), y - min(ys)) for x, y in cells))


def variants(cells):
    seen = set()
    cur = [tuple(c) for c in cells]
    for _ in range(4):
        for pose in (cur, [(x, -y) for x, y in cur]):
            seen.add(norm(pose))
        cur = [(y, -x) for x, y in cur]
    return sorted(seen)


def tile_square(shapes, order, side=5):
    """Distinct-piece exact cover of a side x side square, first solution in fixed order.

    Names and poses are walked in a fixed sorted order and the search is plain depth-first,
    so the same twelve shapes always yield the same tiling. That determinism is the only
    reason a regenerated icon can be byte-compared at all.
    """
    if (side * side) % 5:
        raise SystemExit('side must make the area divisible by 5')
    poses = {}
    for name in order:
        out = []
        for v in variants(shapes[name]):
            bw = max(x for x, _ in v) + 1
            bh = max(y for _, y in v) + 1
            for oy in range(side - bh + 1):
                for ox in range(side - bw + 1):
                    out.append((ox, oy, tuple((x + ox, y + oy) for x, y in v)))
        poses[name] = sorted(out)
    grid = {}
    used = set()
    solution = []

    def first_free():
        for y in range(side):
            for x in range(side):
                if (x, y) not in grid:
                    return (x, y)
        return None

    def rec():
        cell = first_free()
        if cell is None:
            return True
        for name in order:
            if name in used:
                continue
            for ox, oy, cells in poses[name]:
                if cell not in cells or any(c in grid for c in cells):
                    continue
                for c in cells:
                    grid[c] = name
                used.add(name)
                solution.append((name, ox, oy, cells))
                if rec():
                    return True
                solution.pop()
                used.discard(name)
                for c in cells:
                    del grid[c]
        return False

    if not rec():
        raise SystemExit('no exact cover found for a %dx%d square' % (side, side))
    return list(solution)


# ------------------------------------------------------------------ 光栅
class Img:
    def __init__(self, w, h, fill=(0, 0, 0, 0)):
        self.w = w
        self.h = h
        self.buf = bytearray(bytes(list(fill) * w) * h)

    def blend(self, i, col, a):
        b = self.buf
        if a >= 1.0:
            b[i] = col[0]
            b[i + 1] = col[1]
            b[i + 2] = col[2]
            b[i + 3] = 255
            return
        ia = 1.0 - a
        b[i] = int(col[0] * a + b[i] * ia + 0.5)
        b[i + 1] = int(col[1] * a + b[i + 1] * ia + 0.5)
        b[i + 2] = int(col[2] * a + b[i + 2] * ia + 0.5)
        b[i + 3] = int(255.0 * a + b[i + 3] * ia + 0.5)

    def pixel(self, x, y, col, a):
        if a <= 0.0 or x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        if a > 1.0:
            a = 1.0
        self.blend((y * self.w + x) * 4, col, a)


def sd_rrect(px, py, cx, cy, hx, hy, r):
    qx = abs(px - cx) - (hx - r)
    qy = abs(py - cy) - (hy - r)
    ax = qx if qx > 0 else 0.0
    ay = qy if qy > 0 else 0.0
    return math.sqrt(ax * ax + ay * ay) - r + min(max(qx, qy), 0.0)


def cover(d):
    v = 0.5 - d
    if v <= 0.0:
        return 0.0
    return 1.0 if v >= 1.0 else v


def fill_rrect(img, x0, y0, x1, y1, r, col, alpha=1.0):
    """Rounded rect; `col` is a 3-tuple or a callable (lx, ly, w, h) -> 3-tuple."""
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return
    r = max(0.0, min(r, (x1 - x0) / 2.0, (y1 - y0) / 2.0))
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    hx, hy = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    callable_col = callable(col)
    for y in range(max(0, int(math.floor(y0)) - 1), min(img.h, int(math.ceil(y1)) + 1)):
        for x in range(max(0, int(math.floor(x0)) - 1), min(img.w, int(math.ceil(x1)) + 1)):
            d = sd_rrect(x + 0.5, y + 0.5, cx, cy, hx, hy, r)
            if d > 0.5:
                continue
            a = alpha * cover(d)
            if a <= 0.0:
                continue
            c = col(x - x0, y - y0, x1 - x0, y1 - y0) if callable_col else col
            img.pixel(x, y, c, a)


def stroke_rrect(img, x0, y0, x1, y1, r, w, col, alpha=1.0):
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    hx, hy = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    r = max(0.0, min(r, hx, hy))
    half = w / 2.0
    for y in range(max(0, int(y0 - w) - 2), min(img.h, int(y1 + w) + 3)):
        for x in range(max(0, int(x0 - w) - 2), min(img.w, int(x1 + w) + 3)):
            d = sd_rrect(x + 0.5, y + 0.5, cx, cy, hx, hy, r)
            a = alpha * cover(abs(d) - half)
            if a > 0.0:
                img.pixel(x, y, col, a)


def fill_disc(img, cx, cy, rad, col, alpha=1.0, falloff=None):
    for y in range(max(0, int(cy - rad) - 2), min(img.h, int(cy + rad) + 3)):
        for x in range(max(0, int(cx - rad) - 2), min(img.w, int(cx + rad) + 3)):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if d > rad:
                continue
            a = alpha * (falloff(d / rad) if falloff else cover(rad - d - 0.5))
            if a > 0.0:
                img.pixel(x, y, col, a)


def glow(img, cx, cy, rad, col, peak):
    fill_disc(img, cx, cy, rad, col, 1.0, falloff=lambda d: max(0.0, 1.0 - d) ** 2 * peak)


def vgrad(top, bottom):
    def shade(lx, ly, bw, bh):
        t = ly / max(1e-6, bh)
        return tuple(int(top[i] + (bottom[i] - top[i]) * t + 0.5) for i in range(3))
    return shade


def hash2(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967295.0


def value_noise(x, y, lattice, seed, period=0):
    """Smooth bilinear value noise. period>0 wraps the lattice, which is what makes the
    felt texture tile without a visible seam when canvas repeats it."""
    fx, fy = x / lattice, y / lattice
    ix, iy = int(math.floor(fx)), int(math.floor(fy))
    tx, ty = fx - ix, fy - iy
    sx, sy = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)

    def wp(v):
        return v % period if period else v

    a = hash2(wp(ix), wp(iy), seed)
    b = hash2(wp(ix + 1), wp(iy), seed)
    c = hash2(wp(ix), wp(iy + 1), seed)
    d = hash2(wp(ix + 1), wp(iy + 1), seed)
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sy) + d * sy) * sy


def mottle(img, x0, y0, x1, y1, amp, seed, lattice=7.0, period=0):
    if lattice < 1.0 or period and abs((x1 - x0) / lattice - round((x1 - x0) / lattice)) > 1e-6:
        return
    for y in range(max(0, int(y0)), min(img.h, int(y1))):
        for x in range(max(0, int(x0)), min(img.w, int(x1))):
            i = (y * img.w + x) * 4
            k = int((value_noise(x - x0, y - y0, lattice, seed, period) - 0.5) * amp + 0.5)
            for ch in range(3):
                v = img.buf[i + ch] + k
                img.buf[i + ch] = 0 if v < 0 else (255 if v > 255 else v)


def shade_mul(colour, f):
    return tuple(min(255, int(c * f + 0.5)) for c in colour)


# ------------------------------------------------------------------ 主体：匣与块
DARK = (8, 10, 14)


def draw_tile(img, px, py, size, colour, lift=0.0):
    """One cell of a piece, drawn the way js/view.js draws them: body, top sheen, dark edge."""
    inset = size * 0.06
    x0, y0 = px + inset, py + inset
    x1, y1 = px + size - inset, py + size - inset
    r = size * 0.17
    fill_rrect(img, x0, y0, x1, y1, r, shade_mul(colour, 0.94 + 0.12 * lift))
    top_h = (y1 - y0) * 0.24
    if top_h > size * 0.10:
        fill_rrect(img, x0 + size * 0.10, y0 + size * 0.06, x1 - size * 0.10, y0 + top_h,
                   r * 0.45, (255, 255, 255), 0.13 + 0.05 * lift)
    stroke_rrect(img, x0, y0, x1, y1, r, max(0.9, size * 0.07), DARK, 0.9)


def draw_box(img, bx, by, bw, bh, pal, seed):
    fill_rrect(img, bx, by, bx + bw, by + bh, bw * 0.07, rgb(pal['panel']))
    glow(img, bx + bw * 0.5, by + bh * 0.42, bw * 0.62, (255, 255, 255), 0.05)
    stroke_rrect(img, bx, by, bx + bw, by + bh, bw * 0.07, max(1.0, bw * 0.014),
                 rgb(pal['brass']), 0.62)


def subject_tiling(img, box, plan, colours, pal):
    """The proven 5x5 cover, five bevelled lumps inside a brass-edged 匣."""
    bx, by, bw, bh = box
    draw_box(img, bx, by, bw, bh, pal, 21)
    mottle(img, bx, by, bx + bw, by + bh, 7, 21, lattice=bw / 34.0)
    pad = bw * 0.06
    cell = (bw - 2 * pad) / 5.0
    for name, _ox, _oy, cells in plan:
        colour = rgb(colours[name])
        for (cx, cy) in cells:
            draw_tile(img, bx + pad + cx * cell, by + pad + cy * cell, cell, colour)


def subject_bold(img, box, cells, colour, pal):
    """The <=64px reading: one W staircase at native resolution, never a shrunk big icon."""
    bx, by, bw, bh = box
    draw_box(img, bx, by, bw, bh, pal, 21)
    w_ = max(c[0] for c in cells) + 1
    h_ = max(c[1] for c in cells) + 1
    cell = (bw - 2 * (bw * 0.12)) / max(w_, h_)
    ox = bx + (bw - cell * w_) / 2.0
    oy = by + (bh - cell * h_) / 2.0
    for (cx, cy) in cells:
        draw_tile(img, ox + cx * cell, oy + cy * cell, cell, colour)


def lacquer(img, pal):
    ink_top, ink_bot = rgb(pal['bg-2']), (6, 8, 11)
    fill_rrect(img, -8, -8, img.w + 8, img.h + 8, img.w * 0.20, vgrad(ink_top, ink_bot))
    mottle(img, 0, 0, img.w, img.h, 9, 3, lattice=img.w / 26.0)
    glow(img, img.w * 0.5, img.h * 0.06, img.w * 0.62, rgb(pal['brass']), 0.16)
    edge = max(1.0, img.w * 0.012)
    stroke_rrect(img, edge, edge, img.w - edge, img.h - edge, img.w * 0.19, edge * 0.9,
                 rgb(pal['brass']), 0.5)


# ------------------------------------------------------------------ 5x7 拉丁字模（无系统字体）
FONT = {
    'A': (0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11), 'B': (0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E),
    'C': (0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E), 'D': (0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E),
    'E': (0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F), 'F': (0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10),
    'G': (0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F), 'H': (0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11),
    'I': (0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E), 'J': (0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C),
    'K': (0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11), 'L': (0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F),
    'M': (0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11), 'N': (0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11),
    'O': (0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E), 'P': (0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10),
    'Q': (0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D), 'R': (0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11),
    'S': (0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E), 'T': (0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04),
    'U': (0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E), 'V': (0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04),
    'W': (0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11), 'X': (0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11),
    'Y': (0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04), 'Z': (0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F),
    '0': (0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E), '1': (0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E),
    '2': (0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F), '3': (0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E),
    '4': (0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02), '5': (0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E),
    '6': (0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E), '7': (0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08),
    '8': (0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E), '9': (0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C),
    ' ': (0, 0, 0, 0, 0, 0, 0), '-': (0, 0, 0, 0x1F, 0, 0, 0), '+': (0, 0x04, 0x04, 0x1F, 0x04, 0x04, 0),
    '.': (0, 0, 0, 0, 0, 0x0C, 0x0C),
}


def draw_text(img, text, x, y, scale, col, alpha=1.0, tracking=1):
    cx = x
    for ch in text.upper():
        glyph = FONT.get(ch)
        if glyph is None:
            cx += 3 * scale
            continue
        for ry, bits in enumerate(glyph):
            for rx in range(5):
                if bits & (1 << (4 - rx)):
                    fill_rrect(img, cx + rx * scale, y + ry * scale,
                               cx + (rx + 1) * scale, y + (ry + 1) * scale, 0, col, alpha)
        cx += (5 + tracking) * scale
    return cx


def text_width(text, scale, tracking=1):
    return len(text) * (5 + tracking) * scale - tracking * scale


# ------------------------------------------------------------------ 各个产品
def render_icon(size, plan, colours, pal, bold_cells):
    img = Img(size, size)
    lacquer(img, pal)
    u = size / 100.0
    box = (17 * u, 19 * u, 66 * u, 66 * u)
    if size >= 90:
        subject_tiling(img, box, plan, colours, pal)
    else:
        subject_bold(img, box, bold_cells, rgb(colours['W']), pal)
    return img


def render_apple_touch(size, plan, colours, pal):
    img = Img(size, size, rgb(pal['bg']) + (255,))
    fill_rrect(img, -8, -8, size + 8, size + 8, 0,
               vgrad(rgb(pal['bg-2']), (5, 7, 9)))
    mottle(img, 0, 0, size, size, 8, 3, lattice=size / 36.0)
    glow(img, size * 0.5, size * 0.05, size * 0.6, rgb(pal['brass']), 0.14)
    subject_tiling(img, (size * 0.13, size * 0.15, size * 0.74, size * 0.74), plan, colours, pal)
    return img


def render_maskable(size, plan, colours, pal):
    img = Img(size, size, rgb(pal['bg']) + (255,))
    mottle(img, 0, 0, size, size, 8, 3, lattice=size / 64.0)
    u = size / 100.0
    subject_tiling(img, (30 * u, 32 * u, 40 * u, 40 * u), plan, colours, pal)
    return img


def render_og(plan, colours, pal, lot_count):
    w, h = OG_W, OG_H
    img = Img(w, h)
    fill_rrect(img, -8, -8, w + 8, h + 8, 0, vgrad(rgb(pal['bg-2']), (5, 7, 10)))
    mottle(img, 0, 0, w, h, 9, 5, lattice=42.0)
    glow(img, w * 0.22, h * 0.5, h * 0.95, rgb(pal['brass']), 0.10)
    side = 380.0
    subject_tiling(img, (70.0, (h - side) / 2.0, side, side), plan, colours, pal)
    x = 520.0
    ink = (231, 234, 240)
    dim = (141, 151, 167)
    lines = [
        ('PENTAPACK', 10, 150, rgb(pal['brass']), 1.0),
        ('ONE SOLUTION PROVEN', 5, 268, ink, 0.95),
        ('EXACT COVER + DLX', 5, 312, rgb(pal['jade']), 0.95),
        ('%d LOTS BAKED' % lot_count, 4, 356, dim, 0.9),
        ('Z-BIZ-GAME', 4, 486, dim, 0.7),
    ]
    for text, scale, ty, col, alpha in lines:
        if x + text_width(text, scale) > w - 40:
            raise SystemExit('og text overflows the card: %s' % text)
        draw_text(img, text, x, ty, scale, col, alpha)
    fill_rrect(img, x, 244, x + 560, 246, 0, rgb(pal['brass']), 0.45)
    cx = x
    for name, _ox, _oy, _cs in plan:
        fill_rrect(img, cx, 404, cx + 30, 434, 6, rgb(colours[name]), 0.95)
        cx += 40
    stroke_rrect(img, 8, 8, w - 8, h - 8, 18, 2.0, rgb(pal['brass']), 0.35)
    return img


def render_felt(size, pal):
    """可无缝平铺的漆布：canvas 拿它当匣内衬，CSS 拿它垫整页。"""
    img = Img(size, size, rgb(pal['panel']) + (255,))
    mottle(img, 0, 0, size, size, 13, 31, lattice=size / 32.0, period=32)
    mottle(img, 0, 0, size, size, 6, 47, lattice=size / 64.0, period=64)
    step = max(2, int(round(size / 64.0)))
    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            k = 3 if ((x + y) // step) % 2 == 0 else -3
            for ch in range(3):
                v = img.buf[i + ch] + k
                img.buf[i + ch] = 0 if v < 0 else (255 if v > 255 else v)
    return img


def render_dust(size):
    img = Img(size, size)
    c = size / 2.0
    fill_disc(img, c, c, c - 0.5, (255, 255, 255), 1.0,
              falloff=lambda d: max(0.0, 1.0 - d) ** 3.2)
    return img


def render_spark(size):
    img = Img(size, size)
    c = size / 2.0
    arm = c - 1.0
    fill_disc(img, c, c, arm, (255, 255, 255), 1.0,
              falloff=lambda d: max(0.0, 1.0 - d) ** 5.0 * 0.5)
    for k in range(4):
        ang = k * math.pi / 2.0
        dx, dy = math.cos(ang), math.sin(ang)
        for t in range(int(arm)):
            r = t / arm
            wdt = (1.0 - r) * size * 0.06 + 0.7
            px, py = c + dx * t, c + dy * t
            span = int(math.ceil(wdt)) + 1
            for oy in range(-span, span + 1):
                for ox in range(-span, span + 1):
                    d = math.hypot(ox + px - math.floor(px) - 0.5, oy + py - math.floor(py) - 0.5)
                    a = max(0.0, 1.0 - d / wdt) * (1.0 - r) ** 1.6 * 0.9
                    img.pixel(int(math.floor(px)) + ox, int(math.floor(py)) + oy,
                              (255, 255, 255), a)
    fill_disc(img, c, c, size * 0.10, (255, 255, 255), 1.0,
              falloff=lambda d: max(0.0, 1.0 - d) ** 2.0)
    return img


# ------------------------------------------------------------------ png
def write_png(img, path):
    w, h = img.w, img.h
    stride = w * 4
    BPP = 4
    raw = bytearray()
    prev = bytes(stride)
    for y in range(h):
        row = bytes(img.buf[y * stride:(y + 1) * stride])
        sub = row[:BPP] + bytes((a - b) & 0xFF for a, b in zip(row[BPP:], row))
        up = bytes((a - b) & 0xFF for a, b in zip(row, prev))
        # Per-row filter choice by the minimum-sum-of-absolute-differences heuristic over
        # none/sub/up; on the noisy lacquer ground this roughly halves the file.
        cost = [(sum(v if v < 128 else 256 - v for v in pred), ft, pred)
                for ft, pred in ((0, row), (1, sub), (2, up))]
        _c, ft, pred = min(cost, key=lambda t: t[0])
        raw.append(ft)
        raw += pred
        prev = row
    body = zlib.compress(bytes(raw), 9)

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', body) + chunk(b'IEND', b'')
    with open(path, 'wb') as fh:
        fh.write(out)
    return hashlib.sha256(out).hexdigest(), len(out)


def build():
    pal = parse_css_vars()
    colours = parse_body_colours()
    shapes = parse_shapes()
    plan = tile_square(shapes, list(shapes.keys()), 5)
    files = {}

    def emit(rel, img):
        path = os.path.join(ASSETS, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        digest, size = write_png(img, path)
        files[rel] = {'w': img.w, 'h': img.h, 'sha256': digest, 'bytes': size}

    for s in FULL_SIZES + BOLD_SIZES:
        emit('icons/icon-%d.png' % s, render_icon(s, plan, colours, pal, shapes['W']))
    emit('icons/apple-touch-icon.png', render_apple_touch(180, plan, colours, pal))
    emit('icons/icon-maskable-512.png', render_maskable(512, plan, colours, pal))
    emit('og-cover.png', render_og(plan, colours, pal, parse_lot_count()))
    emit('textures/felt.png', render_felt(256, pal))
    emit('sprites/dust.png', render_dust(64))
    emit('sprites/spark.png', render_spark(64))
    manifest = {
        'generator': GEN_VERSION,
        'palette': pal,
        'piece_colours': colours,
        'tiling': [[n, ox, oy] for n, ox, oy, _cs in plan],
        'files': files,
    }
    with open(os.path.join(HERE, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False, sort_keys=True)
        fh.write('\n')
    return manifest, files


def verify():
    recorded = json.load(open(os.path.join(HERE, 'manifest.json'), encoding='utf-8'))
    _manifest, fresh = build()
    bad = []
    for rel, info in sorted(recorded['files'].items()):
        got = fresh.get(rel)
        path = os.path.join(ASSETS, rel)
        if not os.path.exists(path):
            bad.append('%s missing on disk' % rel)
            continue
        on_disk = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        if not got or got['sha256'] != info['sha256'] or on_disk != info['sha256']:
            bad.append('%s drifts (manifest %s, regenerated %s, disk %s)'
                       % (rel, info['sha256'][:12], (got or info)['sha256'][:12], on_disk[:12]))
    for rel in sorted(set(fresh) - set(recorded['files'])):
        bad.append('asset not in manifest: %s' % rel)
    for rel in sorted(fresh):
        print('%-32s %4dx%-4d %8d B  %s' % (rel, fresh[rel]['w'], fresh[rel]['h'],
                                            fresh[rel]['bytes'], fresh[rel]['sha256'][:16]))
    print('tiling: %s' % ' '.join('%s@%d,%d' % (n, ox, oy) for n, ox, oy in recorded['tiling']))
    if bad:
        for b in bad:
            print('DRIFT %s' % b)
        return 1
    print('all %d assets regenerate byte-identically' % len(fresh))
    return 0


if __name__ == '__main__':
    if '--verify' in sys.argv:
        sys.exit(verify())
    manifest, files = build()
    total = sum(f['bytes'] for f in files.values())
    for rel in sorted(files):
        print('%-32s %4dx%-4d %8d B' % (rel, files[rel]['w'], files[rel]['h'], files[rel]['bytes']))
    print('tiling: %s' % ' '.join('%s@%d,%d' % (n, ox, oy) for n, ox, oy in manifest['tiling']))
    print('%d assets, %.1f KiB total' % (len(files), total / 1024.0))
