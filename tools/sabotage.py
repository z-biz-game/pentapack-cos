#!/usr/bin/env python3
"""pentapack 破坏试验台架：一次只改一个字段，看门禁是否真的变红。

只在副本 _sabotage-copy/（本仓 .gitignore 里）上跑，真仓一个字节都不动。

这个文件 2026-10-03 之前住在仓外的 `_tmp-pentapack-sab.py`：那意味着它不进版本控制、CI 看不见它、
npm script 也调不到它——台账的 37 枪只活在某一台机器的终端记录里。住在仓里是这条闸能被跑到的前提。
每把刀：还原副本 -> 断言 needle 在目标文件里恰好出现 1 次 -> 替换 -> 跑它所属的那条腿 -> 收集 FAIL 行。
两条腿（每个数字都由 glob 现算，运行开头自己打出来，别在这里手写计数）：
  suites   test/*.test.mjs + tools/check.mjs + tools/balance.mjs --check
  doctest  只跑 tools/doctest.mjs（第六道闸），并且必须点名它红的那一条
结局有五类：GREEN / RED / THROW（rc 非 0 且 0 条 FAIL —— 闸跑到断言之前就被更早的自检拦住）/
ENV（闸的现跑被机器负载打断：只发了比它自己钉的条数少的断言 —— 那不是刀没咬住，重试一次，
两次都断就记 ENV-BOTH，不算通过）/ ERROR（needle 打不中、语法错）。
expect='green' 的刀守的是"逻辑上到不了的状态"，expect='throw' 的刀守的是"这把刀根本轮不到第六道闸"。
与预期不符 = 一条要记进 README 的缺陷，不是调参数；它同时决定本脚本的 rc（1），
SAB_SELFTEST=mismatch 是这条 rc 的阳性对照。
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

# 路径由本文件自己推导：这台台架要在 CI 的 runner 上、在任何人克隆的目录里都能跑起来，
# 所以它不能记得某一台机器的绝对路径。副本住在仓内但被 .gitignore 挡着（SKIP 里也有一份，
# 否则下一次 copytree 会把上一次的副本套进副本里）。
SRC = pathlib.Path(__file__).resolve().parent.parent
COPY = SRC / '_sabotage-copy'
LOG = SRC / '_sabotage-last-run.log'
SKIP = {'node_modules', '.git', '_sabotage-copy', '.DS_Store'}

# (id, file, needle, replacement, expect, 这句承诺是谁说的)
KNIVES = [
    ('K1', 'js/core/make.js',
     '    if (verdict.count !== 1) { stats.notUnique++; continue; }',
     '    if (verdict.count !== 2) { stats.notUnique++; continue; }',
     'red', '只出货解数恰好为 1 的匣子'),
    ('K2', 'js/core/make.js',
     '    if (!sameSet(baked, verdict.placements)) {',
     '    if (false && !sameSet(baked, verdict.placements)) {',
     'green', '装箱那一步本身必须就是那条唯一解（count==1 已经蕴含它，所以这道闸永不该触发）'),
    ('K3', 'js/core/make.js',
     "    if (verdict.capped) throw new Error('DLX hit its node cap while proving uniqueness');",
     "    if (false && verdict.capped) throw new Error('DLX hit its node cap while proving uniqueness');",
     'red', '数不完就说数不完，不许把熔断当成"解数不为 1"混过去'),
    ('K4', 'js/core/make.js',
     "  { id: 5, key: 'iron', name: '铁匣', k: [8, 8], depth: [4, 7] },",
     "  { id: 5, key: 'iron', name: '铁匣', k: [8, 8], depth: [0, 9] },",
     'red', '铁匣的深度窗口是 4–7，档位是被查出来的不是被贴上去的'),
    ('K5', 'js/core/game.js',
     "  if (over <= 2) return { key: 'clean', label: '干净装箱', stars: 2 };",
     "  if (over <= 3) return { key: 'clean', label: '干净装箱', stars: 2 };",
     'red', '三星/两星/一星的分界线写在 over=0 与 over=2'),
    ('K6', 'js/core/game.js',
     "  if (over <= 0) return { key: 'perfect', label: '一次到位', stars: 3 };",
     "  if (over <= 1) return { key: 'perfect', label: '一次到位', stars: 3 };",
     'red', 'over=1 那一档：三星线的右侧一格'),
    ('K7', 'js/core/game.js',
     '  a.variant = nextVariant;\n  if (a.onBoard) {',
     '  a.variant = nextVariant;\n  game.moves++;\n  if (a.onBoard) {',
     'red', '旋转/镜像 0 步'),
    ('K8', 'js/core/game.js',
     "  if (same) return { ok: true, moved: false, code: 'noop' };",
     "  if (false && same) return { ok: true, moved: false, code: 'noop' };",
     'red', '原地按下再松开不算一步'),
    ('K9', 'js/core/game.js',
     "  game.anomaly = agree ? null : 'second-solution';",
     '  game.anomaly = null;',
     'red', '满了但与烘焙解答不一致 = 报告异常，不是发星'),
    ('K10', 'js/data/lots.js',
     '{"id":"easy-05","band":"easy","k":5,"depth":1',
     '{"id":"easy-05","band":"easy","k":5,"depth":4',
     'red', '手改 lots.js 里任何一个 depth 都会把构建弄红'),
    ('K11', 'js/core/storage.js',
     '      if (!better) next.best[id] = old;',
     '      if (false && !better) next.best[id] = old;',
     'red', 'best[id].moves 只降不升（单调守卫真的在挡回归）'),
    ('K12', 'js/core/storage.js',
     '    next.unlock = Math.max(cur.unlock, Number(patch.unlock) || 0);',
     '    next.unlock = Math.min(cur.unlock, Number(patch.unlock) || 0);',
     'red', 'unlock 只升不降'),
    ('K16', 'README.md',
     'F8 I2 L8 P8 N8 T4 U4 V4 W4 X1 Y8 Z4',
     'F8 I2 L8 P8 N8 T4 U8 V4 W4 X1 Y8 Z4',
     'red', 'README 里那串姿态数必须等于 js/core/pieces.js 的表（U 是 4 不是 8）'),
    ('K17', 'js/core/storage.js',
     '      const better = rec.moves < old.moves || (rec.moves === old.moves && rec.seconds < old.seconds);',
     '      const better = rec.moves < old.moves;',
     'red', '同 hand 数更快的用时算改进：面板上"最佳"那一行不许说谎'),
    ('K18', 'tools/balance.mjs',
     '  need(t.maxDlxNodes < MAX_NODES,',
     '  need(t.maxDlxNodes < 10,',
     'red', 'balance --check 真的会红：把上界收紧到本轮读数以下必须炸出非零 rc（防空转）'),
    ('K13', 'js/core/library.js',
     '  const dayOfYear = Math.round(',
     '  const dayOfYear = 1 || Math.round(',
     'red', '每日匣由日历键决定，档位按年在五档间轮转'),
    ('K14', 'js/core/rng.js',
     '    h ^= (str.charCodeAt(i) >> 8) & 0xff;',
     '    // h ^= (str.charCodeAt(i) >> 8) & 0xff;',
     'red', 'hashSeed 逐字符混两个字节，种子串决定匣子'),
    ('K15', 'js/core/library.js',
     '    const derived = bandName(lot.k, lot.depth);',
     '    const derived = { key: lot.band };',
     'green', 'stats().mislabelled 是自比视图：它不红是构造使然，真正的闸在 bandName 的字面黄金值（K4）与逐行复证'),
    # N1 从前记的是"不该红"，那是台架自己的谎：r11/r14 那两轮的循环里根本没有 tools/check.mjs
    # （209 行那时只有 test/*.test.mjs），一个不看像素的台架当然测不出色号有承诺。r16 把 check.mjs
    # 加进同一轮，N1 当场变红 —— --bg 是 meta theme-color 与 manifest theme_color 的比对基准
    # （check.mjs:125-128、303）。所以这里期望红，而真正的阴性对照换成 N3：没人读的色号。
    ('N1', 'css/game.css', '--bg: #0e1013;', '--bg: #0e1014;', 'red',
     '背景色号是有承诺的：check.mjs 钉住 meta theme-color 与 manifest theme_color == css --bg'),
    ('N3', 'css/game.css', '--brass-dim: #7a6528;', '--brass-dim: #7a6529;', 'green',
     '没有一处闸读 --brass-dim（全仓 grep 过 tools/test/js/*.html）—— 这种改动就不该红'),
    ('N2', 'README.md',
     '以及一把刀一刀砍在哪些字段上、哪些砍不动。',
     '以及一把刀一刀砍在哪些字段上、哪些砍不动。（本句是散文，不承载断言）',
     'green', '改一句散文不改任何承诺 —— 不该红'),
    # ---- 第六道闸 tools/doctest.mjs 的刀：doctest 的 15 个组一组一把（D3 那组两把，见下）。
    # 多数刀切**代码**、跑 `node tools/doctest.mjs` 这一条腿，而且必须点名它红在哪一条：
    # 光 rc!=0 不算逼到，红在隔壁等于没守。DK3 是唯一的例外，它切文档侧 —— 因为代码侧轮不到闸（DK3b）。
    ('DK1', 'js/main.js',
     "    field('块数', g.n, '片五连块'),",
     "    field('块数', g.n, '片六连块'),",
     'red', 'README 面板表那一格的第三个字必须还是代码里那三个字', 'doctest', 'D1f'),
    ('DK2', 'js/core/game.js',
     "  out: '放下会超出边框',",
     "  out: '放下会超出边框外',",
     'red', '文档「界面说法」那一列逐字等于 BOUNCE.out', 'doctest', 'D2c'),
    # D3 这一组有两把刀，因为它们证明的是两件不同的事。
    # DK3 从文档侧下手：改 README 里那串姿态数（DESIGN 的那串不动），D3b 该红并点名。
    ('DK3', 'README.md',
     'W4 X1 Y8 Z4',
     'W4 X2 Y8 Z4',
     'red', '文档那串逐块姿态数 == VARIANT_COUNT 现算；把文档抄错必须红在 D3b', 'doctest', 'D3b'),
    # DK3b 从代码侧下手，结果不是"红"而是"闸根本跑不起来"：pieces.js:135-148 的自检在 import 时
    # 就用几何重算每块姿态数并比对表，X 改一个数字 → 模块抛错 → doctest 一行断言都没发就死了。
    # 这条不是缺陷，是更早的一道闸（页面 import 时就挡住，装不进 bundle）。台账给它一个新结局类
    # THROW：rc 非 0、stdout 里 0 条 FAIL、stderr 里必须有那句自检的话。
    ('DK3b', 'js/core/pieces.js',
     'V: 4, W: 4, X: 1, Y: 8, Z: 4,',
     'V: 4, W: 4, X: 2, Y: 8, Z: 4,',
     'throw', '代码侧改表轮不到第六道闸：pieces.js 的 import 期自检先抛（12 块姿态数由几何重算）',
     'doctest', 'twelve-pentomino self-check failed'),
    ('DK4', 'tools/proof.mjs',
     '// test/anchor.test.mjs asserts the digest on its own sweep and never calls this function, while',
     '// test/anchor.test.mjs passes recount:false and asserts the digest, while',
     'red', '注释不许再声称 anchor 调用 proveRect（那句谎话本轮才改掉）', 'doctest', 'D4m'),
    ('DK5', 'tools/balance.mjs',
     "const DRAWS = Number(env('DRAWS', CHECK ? 40 : 300));",
     "const DRAWS = Number(env('DRAWS', CHECK ? 40 : 250));",
     'red', '文档那句「跑 300 次」== 全扫的 DRAWS 默认值', 'doctest', 'D5e'),
    ('DK6', 'js/core/make.js',
     "  { id: 3, key: 'mid', name: '中匣', k: [6, 6], depth: [2, 4] },",
     "  { id: 3, key: 'mid', name: '中盒', k: [6, 6], depth: [2, 4] },",
     'red', '档位表里 mid 那一行的名字', 'doctest', 'D6c'),
    ('DK7', 'js/core/library.js',
     "  if (!head) return { kind: 'campaign', lot: ALL[0] || null };",
     "  if (!head) return { kind: 'campaign', lot: ALL[1] || null };",
     'red', '空 hash 必须落在匣阵第一关（ALL[0]）', 'doctest', 'D7j'),
    ('DK8', 'tools/harness.mjs',
     '  console.log(`rows: ${tally.length} fail: ${bad.length}`);',
     '  console.log(`rowcount ${tally.length} bad ${bad.length}`);',
     'red', '套件必须打「rows: N fail: 0」这一行，文档那 10 行才有读数可抄', 'doctest', 'D8b'),
    ('DK9', 'tools/bake.mjs',
     '//   3. the reasoning solver measured',
     '//   3x. the reasoning solver measured',
     'red', 'README 那四道闸与 bake.mjs 自己编号的四道逐个对上', 'doctest', 'D9e'),
    ('DK10', 'js/core/game.js',
     '// A game in progress: pure state plus the rules that touch it.',
     '// （这一行是台账插进来的一段废话，用来把下面所有行号往下顶一格）\n'
     '// A game in progress: pure state plus the rules that touch it.',
     'red', '文档钉住"那一行写着什么"的引用逐条还在原位', 'doctest', 'D10d'),
    ('DK11', 'js/core/logic.js',
     'export const RULE_SET_VERSION = 1;',
     'export const RULE_SET_VERSION = 2;',
     'red', '规则版本号四处同源（logic / stats / META / LOT_VERSION）', 'doctest', 'D11a'),
    ('DK12', 'package.json',
     '"doctest": "node tools/doctest.mjs",',
     '"doctest": "node tools/doctestx.mjs",',
     'red', 'package.json 的 doctest 那条必须指向本仓 tools/', 'doctest', 'D12a'),
    ('DK13', 'server.cjs',
     'function startServer({ port = 5197, root = __dirname } = {}) {',
     'function startServer({ port = 5198, root = __dirname } = {}) {',
     'red', '端口 5197 三处同源：文档端口表 / npm run dev / server 默认值', 'doctest', 'D13f'),
    ('DK14', 'tools/doctest.mjs',
     "re: /@boot \\d+ +@play \\d+/ },",
     "re: /@boot \\d+ @@play \\d+/ },",
     'red', 'unpinned 的那句读数形状还在文档里（needle 改到对不上就该红）', 'doctest', 'D14 U7'),
    ('DK15', 'tools/doctest.mjs',
     'const EXPECT_GROUPS = 15;',
     'const EXPECT_GROUPS = 16;',
     'red', '本闸自己发的组数 == 钉值（少一组就是这里红）', 'doctest', 'D15a'),
    ('DK16', '.github/workflows/ci.yml',
     '        run: python3 tools/sabotage.py',
     '        run: echo "ledger not wired"',
     'red', '台账这条接线本身：把 CI unit job 里那一步摘掉，第六道闸必须点着 D12h 红——'
            '"有台账"和"有人跑台账"是两句话，后者也需要一把自己的刀', 'doctest', 'D12h'),
]


def score_doctest(knife, out):
    kid, rel, needle, repl, expect, promise = knife[:6]
    leg = knife[6] if len(knife) > 6 else 'suites'
    named = knife[7] if len(knife) > 7 else None
    fails = [l.strip()[5:].strip() for l in out.stdout.splitlines()
             if l.strip().startswith('FAIL')]
    # THROW：rc 非 0 但一条 FAIL 都没发 —— 闸在跑到断言之前就死了（import 期抛错、语法错）。
    # 它既不是"红在别处"也不是绿，是一种独立结局：产品自己的某道更早的闸先拦住了，
    # 于是这把刀根本到不了第六道闸。对这类刀，named 认的是 stderr。
    thrown = bool(out.returncode) and not fails
    # ENV：本闸有几组是"现跑真东西"（proof / balance / 10 个套件）。机器被别的进程占满时它们会被
    # 自己的时间预算打断，于是断言条数掉到钉值以下、红一串 —— r17 的 DK6 就是这么被记成 NOT-NAMED 的：
    # 那是环境，不是这把刀没咬住。判据不抄外部常数，用闸自己打的两行对账（rows: N vs pin: rows=R）。
    ran = re.search(r'^rows: (\d+) fail: (\d+)$', out.stdout, re.M)
    pin = re.search(r'^pin: groups=\d+ rows=(\d+)', out.stdout, re.M)
    env = bool(ran) and bool(pin) and int(ran.group(1)) != int(pin.group(1))
    if expect == 'throw':
        hit = named in out.stderr
    elif named:
        hit = (not thrown) and any(f.startswith(named) for f in fails)
    else:
        hit = None
    return {'id': kid, 'rel': rel, 'promise': promise, 'expect': expect, 'leg': leg,
            'named': named, 'named_ok': bool(hit), 'thrown': thrown, 'env': env,
            'rows': int(ran.group(1)) if ran else None,
            'pinned': int(pin.group(1)) if pin else None,
            'red': bool(out.returncode),
            'suites': ['doctest.mjs'] if out.returncode else [],
            'cases': ([f for f in fails if f.startswith(named or '')][:1] or fails[:1]
                      or throw_evidence(out.stderr, named, thrown)),
            'fails_all': fails, 'raw_tail': out.stdout[-2500:], 'err_tail': out.stderr[-1200:]}


def pristine_copy():
    if COPY.exists():
        shutil.rmtree(COPY)
    shutil.copytree(SRC, COPY, ignore=shutil.ignore_patterns(*SKIP))


def throw_evidence(stderr, named, thrown):
    # THROW 的证据必须是那句"谁先拦住了这把刀"，不是 node 打印的版本号。
    if not thrown:
        return []
    lines = [l.strip() for l in stderr.splitlines() if l.strip()]
    for l in lines:
        if named and named in l:
            return [l[:160]]
    for l in lines:
        if l.startswith('Error') or 'throw' in l.lower():
            return [l[:160]]
    return lines[:1]


def run_knife(knife):
    kid, rel, needle, repl, expect, promise = knife[:6]
    leg = knife[6] if len(knife) > 6 else 'suites'
    named = knife[7] if len(knife) > 7 else None
    pristine_copy()
    path = COPY / rel
    if not path.exists():
        return {'id': kid, 'error': f'missing {rel}'}
    text = path.read_text()
    n = text.count(needle)
    if n != 1:
        return {'id': kid, 'error': f'needle count {n} != 1 for {rel}: {needle[:60]!r}'}
    path.write_text(text.replace(needle, repl, 1))
    if rel.endswith('.js'):
        chk = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
        if chk.returncode:
            return {'id': kid, 'error': 'syntax: ' + chk.stderr[:200]}

    if leg == 'doctest':
        # 只跑第六道闸这一条腿。红不是终点：FAIL 行里必须出现这把刀点名的那一条，
        # 红在别处等于这条承诺没人守（台账把它记成 NOT-NAMED，不算过）。
        out = subprocess.run(['node', str(COPY / 'tools' / 'doctest.mjs')],
                             capture_output=True, text=True, cwd=COPY, timeout=1800)
        return score_doctest(knife, out)

    fails, red_suites, rc = [], [], 0
    for suite in sorted((COPY / 'test').glob('*.test.mjs')) + [COPY / 'tools/check.mjs']:
        out = subprocess.run(['node', str(suite)], capture_output=True, text=True, cwd=COPY)
        rc += out.returncode
        for line in out.stdout.splitlines():
            if line.strip().startswith('FAIL'):
                fails.append(line.strip()[4:].strip())
        if out.returncode:
            red_suites.append(suite.name)
    # The generator-yield rig is part of the node layer (verify.sh runs it too), so a knife aimed at
    # tools/balance.mjs has to be tested against the rig itself, not only against the suites.
    bal = subprocess.run(['node', str(COPY / 'tools/balance.mjs'), '--check'],
                         capture_output=True, text=True, cwd=COPY)
    if bal.returncode:
        red_suites.append('balance.mjs')
        fails += [l.strip()[5:].strip() for l in bal.stdout.splitlines() if l.strip().startswith('FAIL')]
    return {'id': kid, 'rel': rel, 'promise': promise, 'expect': expect,
            'red': bool(red_suites), 'suites': red_suites, 'cases': fails[:6]}


def outcome(r):
    return 'THROW' if r.get('thrown') else ('RED' if r['red'] else 'GREEN')


def main():
    # 这个开关不叫 ONLY：doctest 自己认 ONLY（子集运行），同名会把闸点成零条断言然后退 0。
    only = set((os.environ.get('KNIVES') or os.environ.get('SAB_ONLY') or '').split(',')) - {''}
    results = []
    selftest_used = False
    pristine_copy()
    n_suites = len(list((COPY / 'test').glob('*.test.mjs')))
    print('=== 台架的两条腿 ===\nSuites leg: %d 个 test/*.test.mjs + tools/check.mjs + tools/balance.mjs --check'
          % n_suites)
    print(f"Doctest leg: tools/doctest.mjs（{len([k for k in KNIVES if len(k) > 6 and k[6] == 'doctest'])} 把刀点名它）")
    sys.stdout.flush()
    for knife in KNIVES:
        if only and knife[0] not in only:
            continue
        r = run_knife(knife)
        if r.get('env'):
            # 环境打断不是这把刀的判决：重试一次，两次都被打断就记 ENV-BOTH（算不符，不算通过）。
            print(f"{r['id']} ENV   现跑被打断：闸只发了 {r['rows']} 项，钉的是 {r['pinned']} —— 机器被占满，重试这一把")
            sys.stdout.flush()
            r = run_knife(knife)
            r['retried'] = True
        results.append(r)
        if 'error' in r:
            print(f"{r['id']} ERROR {r['error']}")
            continue
        got = outcome(r)
        r['got'] = got
        want = r['expect'].upper()
        # 台架的 rc 要有它自己的阳性对照：SAB_SELFTEST=1 把第一把刀的期望取反，
        # 这一轮必须"与预期不符 1"且退非 0。否则"bad 决定 rc"这句话和 r16 之前那些
        # 没人跑的注释一样，只是又一句写在台账里、台账自己从不读的话。
        if os.environ.get('SAB_SELFTEST') == 'mismatch' and not selftest_used:
            selftest_used = True
            want = 'GREEN' if want == 'RED' else 'RED'
        mark = 'ok' if (want == 'UNKNOWN' or want == got) else 'MISMATCH'
        if r.get('env'):
            mark = 'ENV-BOTH'
        elif r.get('leg') == 'doctest' and mark == 'ok' and not r.get('named_ok'):
            mark = 'NOT-NAMED'
        r['mark'] = mark
        print(f"{r['id']} {got:5s} want {want:7s} {mark:8s} {r['rel']} :: "
              f"{','.join(r['suites'])[:70]} :: {r['cases'][:2]}")
        sys.stdout.flush()
    # 判据只有一条：台账自己打的"与预期不符"必须决定它的 rc。r16 之前这里只在 needle 打不中
    # （error）时退非 0，于是一轮 35 枪里 2 枪不符预期照样 SAB_RC=0 —— 台架对自己用了它一直
    # 在别人的闸上找的那个毛病（打印了红，rc 却说绿）。
    bad = [r for r in results if 'error' in r or r.get('mark') != 'ok']
    unk = [r for r in results if r.get('expect') == 'unknown']
    for r in unk:
        print('  探针 %s -> %s :: %s' % (r['id'], outcome(r), r['promise']))
    header = '\n=== 破坏试验 %d 枪 / 与预期不符 %d ===\n' % (len(results), len(bad))
    print(header)
    LOG.write_text(json.dumps(results, ensure_ascii=False, indent=1) + header)
    # 副本里躺着的是最后一把刀改过的树（ci.yml 被换成 echo、某个 depth 窗口被放宽……）。留着它，
    # 下一个读仓的人就会把 `_sabotage-copy/js/core/make.js` 当成真源来读。要看现场就重跑那一只刀。
    shutil.rmtree(COPY, ignore_errors=True)
    if any('error' in r for r in results):
        sys.exit(2)
    if bad:
        sys.exit(1)


if __name__ == '__main__':
    main()
