// 文档数字闸：README / DESIGN 里印出去的每一个「现值」都必须等于代码或现场重跑的现在值。
//
// 为什么这一仓缺一半：pentapack 有全仓最讲究的破坏试验台账（18 把产品刀 + 2 把"应当不红"的刀），
// 它砍的是**产品行为**。可文档里那一大排数 —— 面板六行、三个拒绝码的界面说法、十二个姿态数、
// 四行公开锚点、生成率表 bias 2 那一列、五档窗口与 30 关的逐关深度、门禁清单的 rows 与那两个求和、
// 目录清单与端口/存档 key —— 除了 pieces/library/anchor 三个套件顺手对了一眼，**没有任何一条命令**
// 守着"文档抄的那一行 == 现在算出来的这一行"。台账砍不到这一类谎：它砍的是代码，
// 砍不动"代码对了、散文抄错了"。
//
// 五条规矩（照 z-biz-game-kurotto-cos / z-biz-game-nurikabe-cos / z-biz-game-hashi-cos 的
// doctest 机制走，不自创一套）：
//   1. 每一条等式都配一条「解析到几处」的反空转断言 —— 正则没命中不是绿，是红；
//   2. 只比现值，不复测读数：ms / 墙钟 / 浏览器层那些本机量只以"文档自己写明这一列会漂"的
//      关系出现（D14），绝不重新计时，也绝不把新测的毫秒写回文档；
//   3. **代码是基准**：期望值一律现场从 js/core/* 或仓自己的工具算出来，再对文档那张表；
//      文档说谎就改文档，绝不为了绿而弱化断言；
//   4. 引用 `file:NN` / `file:NN-MM` / `file:NN,MM` 的每一条都跑一次范围检查，另有一条"那一行确实
//      还写着它点名的那个符号"的钉表，和一条 `file:符号` 引用必须真能在该文件里找到该符号 ——
//      代码插一行，行号就漂，漂了必须在这里红，不能让读者去撞；
//   5. 本闸自己的组数、每组项数、总项数都自钉（D15）—— 加一项删一项都得同时改这里的钉。
//
//   子集运行：ONLY=D6,D7 node tools/doctest.mjs 只跑点名的组，其余组逐组打 NOTE 并在结尾声明
//   这不是全量运行（自钉那组在子集里不成立）。D4（四次真穷举 ≈18 s）与 D8（11 条门禁现跑 ≈9 s）
//   是这里两条慢腿；破坏台账逐把下刀时只跑它自己那一组的子集。
//
//   这一闸不 import js/data/lots.js：tools/check.mjs 规定那份数据只从 js/core/library.js 进门，
//   一个工具绕过门去读数据，等于给"两个读者两套口径"开门。META 的数一律问 stats()。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { NAMES, VARIANT_COUNT, rotatedIndex, mirroredIndex } from '../js/core/pieces.js';
import { BOUNCE } from '../js/core/game.js';
import { RULES, RULE_SET_VERSION, logicSolve } from '../js/core/logic.js';
import { BANDS } from '../js/core/make.js';
import { ALL, LOT_VERSION, campaign, bands, stats, parseRoute, resolveRoute, bandForDay } from '../js/core/library.js';
import { validateLevel, maskCount } from '../js/core/board.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 本闸自己的规模，钉在这里（不是文件末尾）：README 的测试日志要抄同一个数，那一句必须和 D15
// 读同一个常量，否则"文档抄闸的钉"会变成两处各写各的。
const EXPECT_GROUPS = 15;
const EXPECT_ROWS_BY_GROUP = {
  D1: 8, D2: 9, D3: 9, D4: 31, D5: 13, D6: 27, D7: 12, D8: 33, D9: 9, D10: 5, D11: 7, D12: 8, D13: 10, D14: 9,
};
const WANT_D15 = 2 + Object.keys(EXPECT_ROWS_BY_GROUP).length + 2;
const EXPECT_ROWS = Number(process.env.EXPECT_ROWS || 0) || 208;

const fail = [];
const emitted = new Set();
const perGroup = {};
const skipped = [];
let rows = 0;
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const need = (g) => !ONLY.length || ONLY.includes(g);
const ok = (cond, label, detail) => {
  const m = label.match(/^D\d+/);
  if (!m) throw new Error(`断言标签必须以 D<N> 开头：${label}`);
  if (!ONLY.length || ONLY.includes(m[0])) {
    rows++;
    emitted.add(m[0]);
    perGroup[m[0]] = (perGroup[m[0]] || 0) + 1;
    if (!cond) fail.push(label);
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
    return;
  }
  if (!skipped.includes(m[0])) { skipped.push(m[0]); console.log(`  NOTE ${m[0]} 未列入 ONLY，不执行（子集运行）`); }
};
// 反引号、全角破折号、千分位与空白在文档里是排版而不是数值；除此之外逐字比
const norm = (s) => String(s).replace(/`/g, '').replace(/\s+/g, '').replace(/×/g, 'x').replace(/[–—]/g, '-');
const num = (s) => Number(String(s).replace(/,/g, ''));

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DOCS = README + '\n' + DESIGN;
// DESIGN §9 是一张更正表：它的文体就是把当年的谎话原样引出来再点名。所以"文档里不许出现 X"
// 这一类断言只适用于正文，不适用于台账 —— 否则这一组会在文档变诚实的当场红一次（§9 现在
// 引着 `BOUNCE_MS = 200` 与 `没有图片资产` 两处，正是为了不再让它们出现在正文里）。
const DESIGN_BODY = DESIGN.slice(0, DESIGN.indexOf('## 9.') < 0 ? 0 : DESIGN.indexOf('## 9.'));
const DOCS_CLAIMS = README + '\n' + DESIGN_BODY;
const CI = read('.github/workflows/ci.yml');
const VERIFY = read('tools/verify.sh');
const PKG = JSON.parse(read('package.json'));
const MAIN = read('js/main.js');
const VIEW = read('js/view.js');
const BAKE = read('tools/bake.mjs');
const GAME = read('js/core/game.js');

const runCmd = (cmd, ms) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: ms, maxBuffer: 64 * 1024 * 1024 });
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const lineOf = (src, n) => (src.split('\n')[n - 1] || '').trim();

// ------------------------------------------------------------------ D1 面板那六行
// README 说这六行是"照抄数据的，没有一个数字是估的"，还给了行号引用。两样都得当场成立。
const PANEL = ['块数', '解数', '推理深度', '操作数', '用时', '最佳'];
const readoutSeg = MAIN.slice(MAIN.indexOf('function renderReadout'), MAIN.indexOf('function renderLegend'));
const fieldCalls = [...readoutSeg.matchAll(/field\('([^']+)',/g)].map((m) => m[1]);
const fieldNames = [...new Set(fieldCalls)];
const docPanel = [...README.matchAll(/^\| (块数|解数|推理深度|操作数|用时|最佳) \| ([^|]+) \| ?([^|]*)\|$/gm)]
  .map((m) => ({ name: m[1], what: m[2].trim(), from: m[3].trim() }));
ok(docPanel.length === 6, `D1a README「面板字段」那张表解析到 6 行（解析不到就是表格形状改了）`, `${docPanel.length} 行：${docPanel.map((d) => d.name).join(' ')}`);
ok(fieldNames.length === 6 && fieldCalls.length === 7,
  `D1b js/main.js 的 renderReadout 印 6 个读数、7 次 field(…) 调用（最佳那一行有通关/未通关两个分支）`, `名字 ${fieldNames.join(' ')} · 调用 ${fieldCalls.length} 次`);
ok(fieldNames.join(' ') === PANEL.join(' ') && docPanel.map((d) => d.name).join(' ') === PANEL.join(' '),
  `D1c 文档那六行的名字与顺序 == 面板代码里 field(…) 的首现顺序`, `文档 ${docPanel.map((d) => d.name).join(' ')} · 代码 ${fieldNames.join(' ')}`);
const panelCite = (README.match(/js\/main\.js:(\d+)-(\d+)/) || []).slice(1).map(Number);
// 一次 field(…) 调用，不是一行：「最佳」那一行是 `best ? field(...) : field(...)`，两个分支
// 两次调用，所以 6 行里有 7 次。按行数的话这一条会一直少数一个，且永远发现不了有人在同一行
// 又塞进一个字段。
const fieldCallLines = MAIN.split('\n')
  .map((l, i) => ({ n: i + 1, c: (l.match(/field\('/g) || []).length }))
  .filter((x) => x.c > 0);
const inCited = fieldCallLines.filter((x) => panelCite.length === 2 && x.n >= panelCite[0] && x.n <= panelCite[1]);
const citedCalls = inCited.reduce((a, x) => a + x.c, 0);
ok(panelCite.length === 2, `D1d 文档那句「js/main.js:NN-NN」解析得到一个行号区间`, panelCite.join('-') || '解析不到');
ok(citedCalls === 7, `D1e 文档引用的那段区间里正好有 7 次 field(…) 调用（插一行、挪一段就是这里红）`,
  `区间内 ${citedCalls} 次 / ${inCited.length} 行：${inCited.map((x) => x.n).join(',')}`);
const suffixes = { 块数: '片五连块', 解数: '已证明', 推理深度: '假设框' };
const suffixLive = Object.entries(suffixes).filter(([name, sfx]) => {
  const call = (readoutSeg.match(new RegExp(`field\\('${name}',[^\\n]*`)) || [''])[0];
  return call.includes(`'${sfx}'`);
}).length;
ok(suffixLive === 3, `D1f 文档"从哪来"那一列写的三个后缀（片五连块 / 已证明 / 假设框）在面板代码里逐个还在`, `${suffixLive}/3`);
const solveDefault = (readoutSeg.match(/field\('解数'[^)]*\?\s*(\d+)\s*:/) || [])[1];
ok(/解数 \| `1`，后缀"已证明"/.test(README) && num(solveDefault) === 1,
  `D1g 文档说解数那一行印的是 1（"已证明"），代码里那句的默认值确实是 1`, `文档 1 · 代码默认 ${solveDefault ?? '解析不到'}`);
const unitCells = docPanel.map((d) => d.from).join(' ');
ok(/localStorage/.test(unitCells) && /外壳的计时器/.test(unitCells),
  `D1h 文档那一列仍写着"最佳"来自 localStorage、"用时"来自外壳计时器（这两个来源换了就得连表一起改）`, unitCells.slice(0, 60));

// ------------------------------------------------------------------ D2 三个拒绝码，一处定义
const docBounce = [...README.matchAll(/^\s*\| `(out|off|overlap)` \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map((m) => ({ code: m[1], case: m[2].trim(), ui: m[3].trim() }));
ok(docBounce.length === 3, `D2a README 的拒绝码表解析到 3 行`, `${docBounce.length} 行：${docBounce.map((d) => d.code).join(' ')}`);
ok(docBounce.map((d) => d.code).join(' ') === Object.keys(BOUNCE).join(' '),
  `D2b 文档那三个码与 game.js:BOUNCE 的键逐个同序`, `文档 ${docBounce.map((d) => d.code).join(' ')} · 代码 ${Object.keys(BOUNCE).join(' ')}`);
ok(docBounce.every((d) => BOUNCE[d.code] === d.ui),
  `D2c 「界面说法」那一列逐字等于 BOUNCE 的值（文档承诺视图/提示/断言都从这一处取，那它抄的就得是那一句）`,
  docBounce.map((d) => `${d.code}:「${d.ui}」vs「${BOUNCE[d.code]}」`).join(' · '));
const designCodes = [...DESIGN.matchAll(/^- `(out|off|overlap)`：([^；;]+)/gm)].map((m) => m[1]);
ok(designCodes.join(' ') === Object.keys(BOUNCE).join(' '),
  `D2d DESIGN §2.2 列的拒绝码与 README 那张表、与代码是同一套（两份文档各抄一遍时最容易分家）`, designCodes.join(' ') || '解析不到');
const bounceTexts = Object.values(BOUNCE);
const copies = [...MAIN.split('\n'), ...VIEW.split('\n')]
  .filter((l) => !/^\s*(\/\/|\*)/.test(l) && bounceTexts.some((t) => l.includes(t)) && !l.includes('BOUNCE'));
ok(copies.length === 0, `D2e 这三句中文在视图与装配层里没有第二处副本（有第二处就是"第四种说法"的温床）`, copies.map((l) => l.trim().slice(0, 40)).join(' / ') || '0 处');
const LONG = num((VIEW.match(/const LONG_PRESS_MS = (\d+)/) || [])[1]);
const bounceS = num((VIEW.match(/const BOUNCE_S = ([\d.]+)/) || [])[1]);
ok(LONG === 480 && /右键 \/ 长按 480 ms/.test(README) && /长按阈值 480 ms/.test(DESIGN),
  `D2f 两份文档的「480 ms」== view.js 的 LONG_PRESS_MS 现值`, `代码 ${LONG}`);
ok(bounceS * 1000 === 200 && /回位动画 200 ms/.test(README),
  `D2g 文档那句「回位动画 200 ms」== view.js 的 BOUNCE_S 换算（代码里是 0.2 秒，不是 200 毫秒那个名字）`, `BOUNCE_S=${bounceS} → ${bounceS * 1000} ms`);
ok(!/BOUNCE_MS/.test(DOCS_CLAIMS),
  `D2h DESIGN 正文不再引用一个叫 BOUNCE_MS 的常量（代码里那个名字已经没了；引用不存在的符号 = 文档写给读不到的人。§9 台账引它是点名旧账，不算）`,
  /BOUNCE_MS/.test(DOCS_CLAIMS) ? `正文里还有 ${DOCS_CLAIMS.match(/BOUNCE_MS/g).length} 处` : '正文 0 处');
ok(/code:'done'/.test(README) && /if \(game\.done\) return \{ ok: false, moved: false, code: 'done' \}/.test(GAME),
  `D2i 文档那句"匣满之后 place 一律返回 code:'done'"在代码里逐字成立（步数经济学的锁死分支）`, '在');

// ------------------------------------------------------------------ D3 十二个姿态数与 63
const POSE_RE = /逐块姿态数 ([A-Z]\d+(?: [A-Z]\d+){11})/g;
const poseHits = [...DOCS.matchAll(POSE_RE)];
ok(poseHits.length === 2, `D3a 「逐块姿态数 …」这句在两份文档里解析到 ${poseHits.length} 处（一份改了另一份没改就是这里红）`, poseHits.map((m) => m[1]).join(' // '));
const livePose = NAMES.map((n) => `${n}${VARIANT_COUNT[n]}`).join(' ');
ok(poseHits.every((m) => m[1] === livePose), `D3b 文档那串姿态数逐字 == pieces.js 的 VARIANT_COUNT 现算`, `代码 ${livePose}`);
const sum63 = Object.values(VARIANT_COUNT).reduce((a, b) => a + b, 0);
const docSum = [...DOCS.matchAll(/合计 \*\*(\d+)\*\*/g)].map((m) => num(m[1]));
ok(docSum.length === 2 && docSum.every((x) => x === sum63 && x === 63),
  `D3c 文档两处「合计 **63**」等于现加 ${sum63}`, `解析到 ${docSum.join('/')} · 现加 ${sum63}`);
ok(VARIANT_COUNT.X === 1 && VARIANT_COUNT.Z === 4 && VARIANT_COUNT.U === 4,
  `D3d 那三块最容易被写错的（X=1、Z=4、U=4）现在还是 1、4、4`, `X ${VARIANT_COUNT.X} · Z ${VARIANT_COUNT.Z} · U ${VARIANT_COUNT.U}`);
// 文档还留下一句历史陈述："之前 README 和 DESIGN 都写着 U8，十二个数字加起来 67"。
// 这句要成立，得是"把 U 改成 8 之后现加真的等于 67"，而不是有人记得的数。
const asIfU8 = sum63 - VARIANT_COUNT.U + 8;
const hist67 = num((README.match(/十二个数字加起来 (\d+)/) || [])[1]);
ok(hist67 === asIfU8 && hist67 === 67, `D3e 文档那句「U8 时十二个数字加起来 67」用现在的表复算成立（复算不出就说明这句话已经不属于这份代码）`,
  `现加 ${sum63} − U(${VARIANT_COUNT.U}) + 8 = ${asIfU8} · 文档 ${hist67}`);
const draft61 = num((read('js/core/pieces.js').match(/totals (\d+) variants/) || [])[1]);
ok(draft61 === 61 && draft61 === sum63 - 2, `D3f pieces.js 头部那句"两套 N 少一块 V 的草稿 = 61"复算成立（63 − 2）`, `注释 ${draft61} · 现算 ${sum63 - 2}`);
ok(NAMES.length === 12 && /十二块五连块/.test(README) && /十二块/.test(DESIGN),
  `D3g 代码里是 ${NAMES.length} 块，两份文档也都说十二块`, `NAMES ${NAMES.length}`);
// 手性 = 镜像不在旋转轨道里。用姿态数判是错的：Z 有 180° 对称，姿态数只有 4，
// 但它的镜像仍然要靠 mirror 才能得到（pieces.js 头部那句"Z=8 会加到 67"说的是同一件事）。
const rotOrbitOf = (n) => { const seen = new Set([0]); let i = 0; for (let k = 0; k < 4; k++) { i = rotatedIndex(n, i); seen.add(i); } return seen; };
const chiralLive = NAMES.filter((n) => !rotOrbitOf(n).has(mirroredIndex(n, 0))).join(' ');
const chiralDoc = (README.match(/`([A-Z ]+)` 六块/) || [])[1];
ok(chiralDoc === 'F L P N Y Z' && chiralLive === 'F L P N Y Z',
  `D3h 文档点名的六块手性（F L P N Y Z）== 由 rot/mirror 现推的那六块`, `文档 ${chiralDoc || '解析不到'} · 现推 ${chiralLive}`);
const orbitDoc = [...DOCS.matchAll(/variantCount[^|]*\|stabiliser\| = (\d+)/g)].map((m) => num(m[1]));
ok(orbitDoc.length === 1 && orbitDoc[0] === 8,
  `D3i DESIGN 那句轨道-稳定子等式的右边 == 姿态数上限 8（D₄ 的阶，不是随手抄的数）`, orbitDoc.join('/') || '解析不到');

// ------------------------------------------------------------------ D4 四行公开锚点（现跑真穷举）
const ANCHOR_DOC = [...README.matchAll(/^\| (\d+)×(\d+) \| ([\d,]+) \| ([\d,]+) \| ([\d,]+) \|$/gm)]
  .map((m) => ({ w: +m[1], h: +m[2], orbits: num(m[3]), published: num(m[4]), nodes: num(m[5]) }));
ok(ANCHOR_DOC.length === 4, `D4a README 那张锚点表解析到 4 行（3×20/4×15/5×12/6×10）`, `${ANCHOR_DOC.length} 行：${ANCHOR_DOC.map((r) => `${r.w}x${r.h}`).join(' ')}`);
const DESIGN_ANCHORS = [...DESIGN.matchAll(/^(\d+)x(\d+)\s+orbits\s+(\d+)\s+\(published\s+(\d+)\)\s+\|\s+raw\s+(\d+) = orbits x 4\s+\|\s+recount\s+(\d+)\s+\|\s+digest\s+(\w+)\s+\|\s+nodes\s+(\d+)/gm)]
  .map((m) => ({ w: +m[1], h: +m[2], orbits: +m[3], published: +m[4], raw: +m[5], recount: +m[6], digest: m[7], nodes: +m[8] }));
ok(DESIGN_ANCHORS.length === 4, `D4b DESIGN §2.3 那个代码块解析到 4 行（proof 换了输出形状，抄下来的块就必须一起换）`, `${DESIGN_ANCHORS.length} 行`);
const proofOut = need('D4') ? runCmd('node tools/proof.mjs', 180000).out : '';
const liveAnchor = [...proofOut.matchAll(/^ok\s+(\d+)x(\d+)\s+orbits\s+(\d+) \(published\s+(\d+)\)\s+\|\s+raw\s+(\d+) = orbits x 4\s+\|\s+recount\s+(\d+)\s+\|\s+digest\s+(\w+)\s+\|\s+nodes\s+(\d+)/gm)]
  .map((m) => ({ w: +m[1], h: +m[2], orbits: +m[3], published: +m[4], raw: +m[5], recount: +m[6], digest: m[7], nodes: +m[8] }));
if (need('D4')) {
  ok(liveAnchor.length === 4, `D4c tools/proof.mjs 的输出解析到 4 行（解析形状改了必须在这里红，不能静默少比四行）`, `${liveAnchor.length} 行`);
  for (const r of ANCHOR_DOC) {
    const g = liveAnchor.find((x) => x.w === r.w && x.h === r.h);
    const d = DESIGN_ANCHORS.find((x) => x.w === r.w && x.h === r.h);
    ok(!!g && !!d, `D4d ${r.w}×${r.h} 这一行锚点在 proof 现跑与 DESIGN 的块里都在`, `proof ${g ? '在' : '缺'} · DESIGN ${d ? '在' : '缺'}`);
    if (!g) continue;
    ok(r.orbits === g.orbits && r.published === g.published && g.orbits === g.published,
      `D4e ${r.w}×${r.h} 文档「本质不同 ${r.orbits} / 公开值 ${r.published}」== 现跑 ${g.orbits}/${g.published}`, `现跑 orbits ${g.orbits} published ${g.published}`);
    ok(!d || (d.orbits === r.orbits && d.published === r.published && d.nodes === r.nodes),
      `D4f ${r.w}×${r.h} DESIGN 抄的那一行与 README 那三格逐个相同（两份文档抄同一次实测，抄出两个版本就是有人在猜）`,
      d ? `DESIGN ${d.orbits}/${d.published}/${d.nodes}` : 'DESIGN 无此行');
    ok(g.raw === g.orbits * 4 && g.recount === g.raw, `D4g ${r.w}×${r.h} 的 raw ${g.raw} == 商 × 4 且 recount 逐字复现（文档说这是被断言的关系，不是巧合）`, `raw ${g.raw} · recount ${g.recount} · ${g.orbits}×4`);
    ok(g.digest === 'clean', `D4h ${r.w}×${r.h} 的舞蹈链digest 现跑是 clean（cover/uncover 漏一次就在这一格红）`, `digest ${g.digest}`);
    ok(r.nodes === g.nodes, `D4i ${r.w}×${r.h} 文档那格 DLX 展开节点 ${r.nodes.toLocaleString('en-US')} == 现跑 ${g.nodes.toLocaleString('en-US')}`, `文档 ${r.nodes} · 现跑 ${g.nodes}`);
  }
  ok(/^anchors: 4 fail: 0$/m.test(proofOut), `D4j proof 现跑自己报 anchors: 4 fail: 0`, (proofOut.match(/^anchors: .*$/m) || ['无'])[0]);
  const early = [...proofOut.matchAll(/limit=2 -> 2 in\s+(\d+) nodes \(early\)/g)].map((m) => +m[1]);
  const docEarly = num((DESIGN.match(/limit=2 时 5×12 只用 (\d+) 个节点/) || [])[1]);
  ok(early.length === 4 && docEarly === early[2], `D4k DESIGN 那句「limit=2 时 5×12 只用 1016 个节点」== 现跑第三行的提前停止读数（烘焙为什么便宜的证据）`, `现跑 ${early.join('/')}`);
  // DESIGN 这一轮新引了 anchor 那条断言的措辞。引用被引文件的句子，就要去被引文件里找它 ——
  // 本仓刚刚才发现 tools/proof.mjs 的注释说 anchor.test 走 recount:false 那一支，而它根本不调 proveRect。
  ok(read('test/anchor.test.mjs').includes('cover and uncover are inverses over'),
    `D4l DESIGN 引了 anchor 那条 digest 断言的原文，而被引的文件里真找得到这句话`,
    read('test/anchor.test.mjs').includes('cover and uncover are inverses over') ? '两文件一致' : '被引文件里没有这句');
  ok(!/passes recount:false/.test(read('tools/proof.mjs')),
    `D4m proof.mjs 的注释不再声称 anchor 调用它（那条注释本轮被改成实话；注释吹的调用方不存在 = 下一个撞坑的人）`,
    /passes recount:false/.test(read('tools/proof.mjs')) ? '还在吹' : '已改口');
}

// ------------------------------------------------------------------ D5 生成率表 bias 2 那一列
const DIFF_DOC = [...README.matchAll(/^\| ([4-8]) \| (\d+) \| ((?:\d+:\d+)(?: \d+:\d+)*) \|$/gm)]
  .map((m) => ({ k: +m[1], unique: +m[2], hist: m[3].replace(/\s+/g, ' ').trim() }));
ok(DIFF_DOC.length === 5, `D5a README「唯一解盘数 / 300 + 深度分布」那张表解析到 5 行（k=4..8）`, `${DIFF_DOC.length} 行：${DIFF_DOC.map((r) => r.k).join(' ')}`);
const balOut = need('D5') ? runCmd('node tools/balance.mjs', 120000).out : '';
const balCells = [...balOut.matchAll(/^ {2}k=(\d) bias (\d): (\d+)\/(\d+) unique\s+((?:\d+:\d+)(?: \d+:\d+)*)$/gm)]
  .map((m) => ({ k: +m[1], bias: +m[2], unique: +m[3], draws: +m[4], hist: m[5] }));
if (need('D5')) {
  ok(balCells.length === 15, `D5b balance 全扫解析到 15 格（5 档 × 3 个 bias）`, `${balCells.length} 格`);
  ok(DIFF_DOC.every((r) => balCells.some((c) => c.k === r.k && c.bias === 2)),
    `D5c 文档那五行点名的是 bias 2 那一列，而现跑里每一档都有 bias 2 这一格`, `文档 k ${DIFF_DOC.map((r) => r.k).join(' ')}`);
  for (const r of DIFF_DOC) {
    const g = balCells.find((c) => c.k === r.k && c.bias === 2);
    if (!g) continue;
    ok(g.unique === r.unique && g.hist === r.hist,
      `D5d k=${r.k} 那一格：文档「${r.unique} · ${r.hist}」== balance 现跑「${g.unique} · ${g.hist}」（决定性种子，任何机器逐字复算）`,
      `现跑 ${g.unique}/${g.draws} ${g.hist}`);
  }
  const drawDoc = num((README.match(/跑 (\d+) 次独立的"一次装箱"/) || [])[1]);
  const drawLive = num((balOut.match(/balance: (\d+) one-attempt draws per cell/) || [])[1]);
  ok(drawDoc === drawLive && drawLive === 300, `D5e 文档那句「跑 300 次」== balance 全扫的 DRAWS 默认现值`, `文档 ${drawDoc} · 现跑 ${drawLive}`);
  const cellDoc = num((README.match(/\*\*(\d+) 格 \/ 0 breach\*\*/) || [])[1]);
  const checkOut = runCmd('node tools/balance.mjs --check', 120000).out;
  const checkLine = (checkOut.match(/^balance --check: (\d+) cells, (\d+) breaches$/m) || [])[0];
  const checkCells = num(((checkLine || '').match(/: (\d+) cells/) || [])[1]);
  ok(/0 breaches/.test(checkLine || '') && cellDoc === checkCells,
    `D5f 文档「15 格 / 0 breach」的格数 == balance --check 现跑那一行的格数，且现跑 0 breach`, `文档 ${cellDoc} · 现跑 ${checkLine || '解析不到'}`);
  const biasDoc = (balOut.match(/biases \[([\d, ]+)\]/) || [])[1];
  ok(/bias 2 那一列/.test(README) && String(biasDoc).includes('2'),
    `D5g 文档说表是「bias 2 那一列」，而现跑的 bias 集合里确实有 2（否则那张表抄的是一个跑不出来的格子）`, `现跑 biases [${biasDoc}]`);
  const histDepths = (k) => [...new Set(balCells.filter((c) => c.k === k).flatMap((c) => c.hist.split(' ').map((p) => +p.split(':')[0])))].sort((a, b) => a - b);
  const iron = histDepths(8);
  const avgOf = (c) => { let n = 0; let dsum = 0; for (const p of c.hist.split(' ')) { const [d, x] = p.split(':').map(Number); n += x; dsum += d * x; } return dsum / n; };
  const avgs = [4, 5, 6, 7, 8].map((k) => avgOf(balCells.find((c) => c.k === k && c.bias === 2)));
  ok(/深度真的铺满 0\.\.7/.test(README) && iron.join(',') === '0,1,2,3,4,5,6,7',
    `D5h 文档那句「散框上深度真的铺满 0..7」：现跑 k=8 三个 bias 的深度并集正是 0..7`, `并集 ${iron.join(',')}`);
  ok(avgs.every((x, i) => i === 0 || x > avgs[i - 1]),
    `D5i 文档那句「且随 k 右移」：现跑 bias 2 那一列的平均深度逐档严格上升`, avgs.map((x) => x.toFixed(2)).join(' → '));
}

// ------------------------------------------------------------------ D6 五档窗口与 30 关实测深度
const BAND_DOC = [...README.matchAll(/^\| (taster|easy|mid|hard|iron) \| ([^|]+) \| (\d) \| ([\d–-]+) \| ([\d,]+) \| ?(\d*) ?\|$/gm)]
  .map((m) => ({ key: m[1], name: m[2].trim(), k: +m[3], win: m[4], seq: m[5], sum: m[6] }));
ok(BAND_DOC.length === 5, `D6a README 的档位表解析到 5 行`, `${BAND_DOC.length} 行：${BAND_DOC.map((r) => r.key).join(' ')}`);
ok(BAND_DOC.map((r) => r.key).join(' ') === bands().map((b) => b.key).join(' '),
  `D6b 文档那五行的档位名与顺序 == make.js BANDS`, `文档 ${BAND_DOC.map((r) => r.key).join(' ')} · 代码 ${bands().map((b) => b.key).join(' ')}`);
const s = stats();
for (const b of BANDS) {
  const d = BAND_DOC.find((x) => x.key === b.key);
  if (!d) continue;
  ok(d.name === b.name && d.k === b.k[0] && norm(d.win) === `${b.depth[0]}-${b.depth[1]}`,
    `D6c ${b.key} 那一行：名称「${d.name}」/ 块数 ${d.k} / 窗口 ${d.win} == BANDS 现值「${b.name} / ${b.k[0]} / ${b.depth[0]}–${b.depth[1]}」`,
    `代码 ${b.name} · k ${b.k.join('-')} · depth ${b.depth.join('-')}`);
  const live = campaign().filter((l) => l.band === b.key).map((l) => l.depth);
  ok(d.seq.split(',').map(Number).join(',') === live.join(','),
    `D6d ${b.key} 那 6 关的实测深度序列文档「${d.seq}」== lots.js 现算「${live.join(',')}」`, `现算自 ${live.length} 关`);
  const st = s.bands[b.key] || {};
  ok(st.n === live.length && st.min === Math.min(...live) && st.max === Math.max(...live),
    `D6e ${b.key}：stats() 现量的 n/min/max == 文档那一行的关数与深度序列的两端`, `stats n ${st.n} min ${st.min} max ${st.max}`);
  ok(live.every((x) => x >= b.depth[0] && x <= b.depth[1]),
    `D6f ${b.key} 现算的 6 个深度全都落在自己那档窗口里`, `${live.join(',')} vs ${b.depth.join('-')}`);
}
const totalDepth = campaign().reduce((a, l) => a + l.depth, 0);
const docTotalDepth = num((BAND_DOC.map((r) => r.sum).find((x) => x !== '') || ''));
ok(docTotalDepth === totalDepth && totalDepth === 86, `D6g 文档那一格「全战役深度和 ${docTotalDepth}」== 30 关现加 ${totalDepth}`, `现加 ${totalDepth}`);
const reMeasured = need('D6') ? campaign().map((l) => logicSolve(l.spec).depth) : [];
if (need('D6')) {
  ok(reMeasured.length === 30 && reMeasured.join(',') === campaign().map((l) => l.depth).join(','),
    `D6h 两规则求解器现场重测的 30 个深度 == lots.js 里印着的那 30 个（重测一次 ≈1 s，不靠测试套件的转述）`,
    `${reMeasured.length} 关 · 印的 ${campaign().length}`);
  ok(reMeasured.reduce((a, x) => a + x, 0) === totalDepth, `D6i 现测深度相加也等于文档那个全战役和`, `现测和 ${reMeasured.reduce((a, x) => a + x, 0)}`);
}
ok(s.mislabelled === 0, `D6j stats() 报的"档位与 (k, 深度) 不符"数为 0（文档说档位是查出来的不是贴的）`, `mislabelled ${s.mislabelled}`);
const days = [];
for (let m = 1; m <= 12; m++) { const len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; for (let d = 1; d <= len; d++) days.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`); }
const keyOf = (x) => ((x && x.key) || x);
const dayBands = [...new Set(days.map((k) => keyOf(bandForDay(k))))];
ok(days.length === 365 && dayBands.length === 5 && /档位按年在五档之间轮转/.test(README),
  `D6k 文档那句「档位按年在五档之间轮转」：2026 年 365 个日历键问 bandForDay，覆盖到的正是那 5 档`, `${dayBands.join(' ')}（${days.length} 个键）`);

// ------------------------------------------------------------------ D7 规模、面积恒等式与路由
ok(campaign().length === 30 && ALL.length === 30 && s.lots === 30, `D7a 出厂匣阵现数 30 关（ALL / campaign() / stats() 三条路都要给 30）`, `ALL ${ALL.length} · stats ${s.lots}`);
const bandKeys = Object.keys(s.bands);
const perBand = bandKeys.map((k) => s.bands[k].n);
ok(bandKeys.length === 5 && perBand.every((n) => n === 6), `D7b 现量「${bandKeys.length} 档 × 每档 ${perBand.join('/')} 关」== 文档那句 5 档 × 6 关`, `每档 ${perBand.join(',')}`);
ok(/匣阵 30 关 = 5 档 × 6 关/.test(README), `D7c 文档那句「30 关 = 5 档 × 6 关」原样还在（改了这句话要连表一起改）`, /匣阵 30 关 = 5 档 × 6 关/.test(README) ? '在' : '不在');
// spec.mask 是展平的 Uint8Array（w*h 个 0/1），不是一维数组的数组 —— 问 board.js 的 maskCount，
// 不自己 re-implement 求和（那等于给同一件事第二个口径）。
const maskCountOf = (lot) => maskCount(lot.spec.mask);
const areaBad = ALL.filter((l) => maskCountOf(l) !== 5 * l.k).map((l) => `${l.id}:${maskCountOf(l)}≠5×${l.k}`);
ok(areaBad.length === 0, `D7d 面积恒等式 5k 对 30 关逐关现算成立（有一关不符就是数据与规则分家）`, areaBad.slice(0, 3).join(' ') || '30/30');
const shiftMask = (mask, target) => {
  const m = mask.slice();
  let delta = target - maskCountOf(ALL[0]);
  for (let i = 0; i < m.length && delta !== 0; i++) {
    if (delta > 0 && !m[i]) { m[i] = 1; delta--; } else if (delta < 0 && m[i]) { m[i] = 0; delta++; }
  }
  return m;
};
const targets = [5 * ALL[0].k + 1, 5 * ALL[0].k - 1];
const bad5k = targets.map((t) => ({ want: t, err: validateLevel({ ...ALL[0].spec, mask: shiftMask(ALL[0].spec.mask, t) }) }));
ok(bad5k.every((v) => !!v.err && /multiple|needs/.test(v.err)),
  `D7e 同一关的面积改成 5k±1 之后 validateLevel 必须**因为面积**拒它（面积恒等式是闸守着的，不是文档说说的）`,
  bad5k.map((v) => `${v.want}→${v.err || '收了！'}`).join(' · '));
const routes = ['#/', '#/lot/iron-03', '#/daily', '#/daily/2026-03-04', '#/random/abc', '#/random/abc?band=hard'];
const TODAY = '2026-10-03';
const resolved = routes.map((h) => resolveRoute(h, TODAY) || {});
ok(resolved.every((r) => r.kind), `D7f 文档「三种内容，同一套规则」那块列的 6 种 URL 形态，resolveRoute 现在每个都给出一个 kind`, routes.map((r, i) => `${r}→${resolved[i].kind}`).join(' '));
const kinds = [...new Set(resolved.map((r) => r.kind))].sort();
const familes = [...new Set(resolved.map((r) => (r.kind === 'lot' ? 'campaign' : r.kind)))].sort();
ok(kinds.length === 4 && familes.join(' ') === 'campaign daily random',
  `D7g 这 6 种形态归成 4 个 kind、并成文档那句「三种内容」（#/lot/x 是匣阵里的一关，不是第四种内容）`, `kind ${kinds.join(' ')} · 三族 ${familes.join(' ')}`);
const q = parseRoute('#/random/abc?band=hard');
ok(q.parts.join('/') === 'random/abc' && q.params.band === 'hard',
  `D7h 文档表里那条「?band=hard」由 parseRoute 拆成 params.band，不是让壳层自己切字符串`, `parts ${q.parts.join('/')} · band ${q.params.band}`);
const camp = resolveRoute('#/campaign', TODAY) || {};
ok(camp.kind === 'unknown' && camp.lot === null && camp.missing === 'campaign',
  `D7i DESIGN §9 第 3 条那句「#/campaign 不是本游戏定义的链接（kind unknown、lot null）」现在仍然成立`, `kind=${camp.kind} lot=${camp.lot} missing=${camp.missing}`);
const empty = resolveRoute('', TODAY) || {};
ok(empty.kind !== 'unknown' && empty.lot?.id === ALL[0].id,
  `D7j 文档那句「空 hash 落到匣阵第一关」：resolveRoute('') 给的正是 ALL[0]（那一关当年被换成 #/campaign 时红过）`, `kind=${empty.kind} lot=${empty.lot?.id}`);
const dailyRoute = resolveRoute('#/daily/2026-03-04', '2026-10-03') || {};
ok(/daily-daily-2026-03-04/.test(DESIGN) && dailyRoute.lot?.id === 'daily-daily-2026-03-04',
  `D7k DESIGN 抄的那个 id 形如 daily-daily-<日期>，现跑 resolveRoute 给的正是它（前缀是来源、后段是 adopt() 的 seed）`, `现跑 ${dailyRoute.lot?.id ?? '没有 lot'}`);
const noDate = resolveRoute('#/daily', '2026-03-04') || {};
ok(noDate.lot?.id === 'daily-daily-2026-03-04',
  `D7l DESIGN 那句「空日期由调用方注入的日历键决定」：#/daily 不带日期时，注入 2026-03-04 得到的正是那一关`, `现跑 ${noDate.lot?.id ?? '没有 lot'}`);

// ------------------------------------------------------------------ D8 门禁清单那 11 行（现跑）
const GATE_DOC = [...README.matchAll(/^\| `([\w.]+\.test\.mjs)` \| (\d+) \|/gm)].map((m) => ({ file: m[1], rows: +m[2] }));
const checkDoc = num((README.match(/^\| `tools\/check\.mjs` \| (\d+) \|/m) || [])[1]);
ok(GATE_DOC.length === 10 && Number.isFinite(checkDoc), `D8a README 的门禁清单解析到 10 个套件 + 1 行 tools/check.mjs（少一行就是表格形状改了）`,
  `${GATE_DOC.length} 套件 + check ${checkDoc}`);
if (need('D8')) {
  const live = {};
  for (const g of [...GATE_DOC.map((x) => x.file), 'check.mjs']) {
    const path = g === 'check.mjs' ? 'tools/check.mjs' : `test/${g}`;
    const r = runCmd(`node ${path}`, 180000);
    const m = r.out.match(/^rows: (\d+) fail: (\d+)$/m);
    live[g] = { rc: r.rc, rows: m ? +m[1] : -1, failed: m ? +m[2] : -1 };
    ok(r.rc === 0 && m && +m[2] === 0, `D8b ${path} 现场跑 rc=${r.rc} 且打了「rows: N fail: 0」`, m ? `rows ${m[1]} fail ${m[2]}` : '解析不到 rows 行');
  }
  for (const g of GATE_DOC) {
    ok(live[g.file] && live[g.file].rows === g.rows, `D8c 文档那一行 \`${g.file}\` = ${g.rows} == 现跑 ${live[g.file] ? live[g.file].rows : '∅'}`, `现跑 ${live[g.file] ? live[g.file].rows : '跑失败'}`);
  }
  ok(live['check.mjs'].rows === checkDoc, `D8d 文档那行 tools/check.mjs = ${checkDoc} == 现跑 ${live['check.mjs'].rows}`, `现跑 ${live['check.mjs'].rows}`);
  const suiteSum = GATE_DOC.reduce((a, g) => a + (live[g.file] ? live[g.file].rows : 0), 0);
  const nodeSum = suiteSum + live['check.mjs'].rows;
  const docSumLine = [...README.matchAll(/node 层 (\d+) 行 \/ 0 失败/g)].map((m) => num(m[1]));
  ok(suiteSum === 158, `D8e 十个套件现加 ${suiteSum} == 文档那句「10 个套件 158 行」`, `现加 ${suiteSum}`);
  ok(docSumLine.length >= 1 && docSumLine.every((x) => x === nodeSum), `D8f 文档印的每一行「node 层 N 行 / 0 失败」都等于现算 ${nodeSum}（158 + ${live['check.mjs'].rows}）`,
    `文档 ${docSumLine.join('/')} · 现算 ${nodeSum}`);
  // num() 拿整段 "181 行 / 0 失败" 会把两个数字接成 1810，所以先取捕获组再转数。
  const rowZero = [...new Set((README.matchAll(/(\d+) 行 \/ 0 失败/g)).map((m) => +m[1]))];
  ok(rowZero.includes(nodeSum), `D8g 文档「N 行 / 0 失败」这种句子里出现的数里有现算的 node 层 ${nodeSum}`, rowZero.join(' '));
  // 五个场景的读数在 README 里出现两处（一次是 verify 的输出块，一次是 CI 日志那段），所以先
  // 把同名的收成一组、要求它们彼此一致，再拿"去重之后"的那五个数相加对文档自己的合计。
  const seen = new Map();
  const disagree = [];
  for (const m of README.matchAll(/@(boot|play|routes|save|pointer) (\d+)/g)) {
    if (seen.has(m[1]) && seen.get(m[1]) !== +m[2]) disagree.push(`${m[1]} ${seen.get(m[1])}/${m[2]}`);
    if (!seen.has(m[1])) seen.set(m[1], +m[2]);
  }
  ok(seen.size === 5 && disagree.length === 0, `D8h 文档的五个浏览器场景各有一致的读数（同一场景写了两处不同数就是这里红）`,
    [...seen].map(([k, v]) => `@${k} ${v}`).join(' ') + (disagree.length ? ` · 冲突 ${disagree.join(',')}` : ''));
  const browserSum = num((README.match(/合计 (\d+) 行 \/ 0 失败/) || [])[1]);
  const scenSum = [...seen.values()].reduce((a, x) => a + x, 0);
  ok(seen.size === 5 && scenSum === browserSum, `D8i 五个场景相加 == 文档那句「合计 ${browserSum} 行」（浏览器层的条数本身是本机读数，见 D14；这里只钉它自己那笔账）`,
    `相加 ${scenSum} · 合计 ${browserSum}`);
  const twoLayers = num((README.match(/两层合计 \*\*(\d+) 行断言/) || [])[1]);
  ok(twoLayers === nodeSum + browserSum, `D8j 文档那句「两层合计」== node 层现算 ${nodeSum} + 文档浏览器层 ${browserSum}`, `${nodeSum} + ${browserSum} = ${nodeSum + browserSum} · 文档 ${twoLayers}`);
  ok(/`rows` 是断言条数，不是"性质个数"/.test(README), `D8k 文档自己写明 rows 数的是断言条数（这套口径由 tools/harness.mjs 决定，不是每个套件各有定义）`, '在');
  const designRows = num((DESIGN.match(/机器化了的不变量（现跑 (\d+) 行断言/) || [])[1]);
  ok(designRows === live['check.mjs'].rows, `D8l DESIGN §1 那句「（N 行断言，全绿）」== tools/check.mjs 现跑 ${live['check.mjs'].rows}（上一棒把它从 16 行长到 23 行，文档那句话没跟着走）`, `DESIGN ${designRows} · 现跑 ${live['check.mjs'].rows}`);
  const checkRowDesc = (README.match(/^\| `tools\/check\.mjs` \| \d+ \| ([^|]+) \|/m) || [])[1] || '';
  ok(/资产|asset|像素|pixel/i.test(checkRowDesc),
    `D8m README 给 check.mjs 那一行写的「钉住的东西」现在包括资产/像素那一条（check 多了这条规则，文档那一格还停在旧的分工）`, checkRowDesc.trim().slice(0, 56));
  // 本闸自己的规模也写在文档里，而它的真值是文件头那个钉值。这一条把"闸钉的数"与"文档抄的数"
  // 接上：改钉不改文档、或改文档不改钉，都在这里红（D15 只知道自己那一头）。
  const doctestDoc = num((README.match(/^\| `tools\/doctest\.mjs` \| (\d+) \|/m) || [])[1]);
  ok(doctestDoc === EXPECT_ROWS, `D8n README 给第六道闸那行写的 ${doctestDoc} 行 == 本闸自己钉的总项数 ${EXPECT_ROWS}`,
    `文档 ${doctestDoc} · 钉 ${EXPECT_ROWS}`);
}

// ------------------------------------------------------------------ D9 条数：规则、不变量、四道闸
const ruleBlock = README.slice(README.indexOf('## 规则'), README.indexOf('## 难点'));
const ruleItems = [...ruleBlock.matchAll(/^(\d+)\. \*\*/gm)].map((m) => +m[1]);
ok(ruleItems.length === 9 && ruleItems.join(',') === '1,2,3,4,5,6,7,8,9', `D9a README §规则 的编号项解析到 ${ruleItems.length} 条且连续（加了条没编号、或删了条都红）`, ruleItems.join(','));
ok(RULES.length === 2 && /只用两条推理规则/.test(README) && /两条规则与假设深度/.test(DESIGN),
  `D9b 求解器的规则数现量 ${RULES.length} == 两份文档那句「两条」`, `RULES ${RULES.length} · ${RULES.map((r) => r.text).join(' / ').slice(0, 40)}`);
const designBlock = DESIGN.slice(DESIGN.indexOf('## 1.'), DESIGN.indexOf('## 2.'));
const invar = [...designBlock.matchAll(/^(\d+)\. \*\*/gm)].map((m) => +m[1]);
ok(invar.length === 4 && /四条不变量/.test(designBlock) && /四条.*不变量/.test(README),
  `D9c DESIGN §1 的不变量列表 ${invar.length} 条 == 两份文档标题那句「四条」（条数改了，标题和 README 都得改）`, `${invar.length} 条：${invar.join(',')}`);
const pngNow = (() => {
  const count = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
    .reduce((a, e) => a + (e.isDirectory() ? count(`${dir}/${e.name}`) : /\.png$/.test(e.name) ? 1 : 0), 0);
  return count('assets');
})();
ok(!/没有图片资产|零图片/.test(DOCS_CLAIMS) && /图片|资产|asset/i.test(designBlock),
  `D9d 文档正文不再声明"没有图片资产 / 零图片"（磁盘现量 ${pngNow} 张 PNG，check.mjs 数的是像素而不是禁止文件），且 §1 那四条里有一条讲资产`,
  `${(/图片|资产|asset/i.test(designBlock) ? '' : '§1 无资产条 · ')}${(DOCS_CLAIMS.match(/没有图片资产|零图片/g) || []).join(' · ') || '正文两句都已改口'}`,
);
const bakeGates = [...new Set([...BAKE.matchAll(/^\s*\/\/\s+([1-4])\./gm)].map((m) => +m[1]))];
const docGates = [...README.slice(README.indexOf('## 生成流水线'), README.indexOf('## 门禁清单')).matchAll(/^([1-4])\. \*\*/gm)].map((m) => +m[1]);
ok(bakeGates.join(',') === '1,2,3,4' && docGates.join(',') === '1,2,3,4',
  `D9e README 那四道闸与 bake.mjs 自己编号的四道逐个对上（少一道，"任何一道对不上就 throw"就不成立）`, `bake ${bakeGates.join('')} · 文档 ${docGates.join('')}`);
const throws = (BAKE.match(/throw new Error/g) || []).length;
ok(throws >= 4, `D9f bake.mjs 里 throw new Error 至少 4 处（文档那句"任何一道对不上就 throw"的代码背书）`, `${throws} 处`);
const designFixes = [...DESIGN.slice(DESIGN.indexOf('## 9.')).matchAll(/^\| (\d+) \| /gm)].map((m) => +m[1]);
ok(designFixes.length === 20 && designFixes.join(',') === Array.from({ length: 20 }, (_, i) => i + 1).join(','),
  `D9g DESIGN §9 那张更正表现在 ${designFixes.length} 行连续编号（它上面那句按类相加的账必须当场对得上）`, `${designFixes.length} 行：${designFixes.join(',')}`);
// 分类计数那句话改成"把句子里每一个「N 处」加起来对表"，而不是钉死五个捕获组：
// 这一轮它从五类长到六类，钉死组数的写法会在文档变诚实的时候反而红一次。
const tallyLine = (DESIGN.match(/^产品缺陷 .*$/m) || [''])[0] + (DESIGN.match(/^台架与发布脚本缺陷 .*$/m) || [''])[0];
const tally = [...tallyLine.matchAll(/(\d+) 处/g)].map((m) => +m[1]);
ok(tally.length >= 5, `D9h 更正记录开头那句分类计数解析到 ${tally.length} 类（每类都得写「N 处」，解析不到就是那句话被改散了）`, tally.join('+') || '一类都没解析到');
ok(tally.reduce((a, x) => a + x, 0) === designFixes.length,
  `D9i 那句按类相加 ${tally.join('+')} = ${tally.reduce((a, x) => a + x, 0)} == 表里的 ${designFixes.length} 行`,
  `相加 ${tally.reduce((a, x) => a + x, 0)} · 行数 ${designFixes.length}`);

// ------------------------------------------------------------------ D10 文档里的 path:NN 引用
const resolvePath = (raw) => {
  const cand = [raw, `js/core/${raw}`, `js/${raw}`, `tools/${raw}`, `test/${raw}`];
  return cand.find((c) => existsSync(join(ROOT, c))) || null;
};
const CITE_RE = /((?:js\/(?:core\/|data\/)?|css\/|tools\/|test\/|assets\/gen\/)?[\w.-]+\.(?:mjs|cjs|js|sh|css|html|json|py))[:：]([0-9]+(?:\s*[-,]\s*[0-9]+)?)/g;
const cites = [...DOCS.matchAll(CITE_RE)]
  .map((m) => ({ raw: m[0].replace(/`/g, ''), file: m[1], nums: m[2].split(/[-,]/).map((x) => +x) }))
  .filter((c) => !/^lots\.js:/.test(c.raw));
ok(cites.length >= 15, `D10a 两份文档里的 path:NN 引用解析到 ${cites.length} 条（少于 15 条说明引用格式被改了或被删空）`, `${cites.length} 条`);
const badRange = [];
for (const c of cites) {
  const rp = resolvePath(c.file);
  if (!rp) { badRange.push(`${c.raw}（文件不在）`); continue; }
  const n = read(rp).split('\n').length;
  const out = c.nums.filter((x) => x > n || x < 1);
  if (out.length) badRange.push(`${c.raw}（${rp} 只有 ${n} 行）`);
}
ok(badRange.length === 0, `D10b 每一条 path:NN 都落在真实文件的行数内（改了代码不重编行号，就是这里红）`,
  badRange.slice(0, 5).join('，') || `${cites.length} 条全部在范围内`);
const SYMBOL_RE = /((?:js\/(?:core\/|data\/)?|tools\/)?[\w.-]+\.(?:mjs|js))[:：]([A-Za-z_][\w]*)/g;
const symCites = [...DOCS.matchAll(SYMBOL_RE)].map((m) => ({ raw: m[0].replace(/`/g, ''), file: m[1], sym: m[2] }))
  .filter((c) => resolvePath(c.file));
const symMissing = symCites.filter((c) => !new RegExp(`\\b${c.sym}\\b`).test(read(resolvePath(c.file))));
ok(symCites.length >= 8 && symMissing.length === 0,
  `D10c 文档用「文件:符号」形式的引用，符号现在真在那个文件里（改名或删掉函数，这里红）`,
  `解析 ${symCites.length} 条 · 找不到：${symMissing.map((s) => s.raw).join(' ') || '无'}`);
// 文档点名"那一行写的是什么"的引用，逐个当场验：行号漂一格就换成了隔壁那条断言。
const ANCHORED = [
  { cite: 'js/main.js:188', want: /field\('块数'/, says: '面板第一行' },
  { cite: 'js/main.js:193', want: /field\('最佳'/, says: '面板最后一行' },
  { cite: 'js/main.js:88', want: /todayKey\(new Date\(\)\)/, says: '全仓唯一读日历那一行' },
  { cite: 'js/core/game.js:91', want: /export const BOUNCE/, says: '三个拒绝码在一处定义' },
  { cite: 'js/core/game.js:197', want: /function checkDone/, says: '完成判定' },
  { cite: 'js/core/storage.js:16', want: /pentapack\.save\./, says: '存档 key 的那一行' },
  { cite: 'js/view.js:31', want: /const LONG_PRESS_MS = 480/, says: '长按阈值' },
  { cite: 'server.cjs:50', want: /port = 5197/, says: '默认端口' },
];
const drift = [];
for (const a of ANCHORED) {
  const [file, n] = a.cite.split(':');
  if (!a.want.test(lineOf(read(file), +n))) drift.push(`${a.cite}（${a.says}）现在是「${lineOf(read(file), +n).slice(0, 30)}」`);
}
ok(drift.length === 0, `D10d 钉表里 ${ANCHORED.length} 条「那一行写着什么」的引用逐条还在原位（代码插一行，这一条就替读者先撞上）`, drift.join(' / ') || '全部命中');
const citedNums = cites.flatMap((c) => c.nums.map((n) => `${c.file}:${n}`));
ok(citedNums.length >= 20, `D10e 引用行号总数现量 ${citedNums.length}（D10 那一组不是只比一两条样本）`, `${new Set(citedNums).size} 个不重复的行号`);

// ------------------------------------------------------------------ D11 版本号与"重烤"这句话
ok(RULE_SET_VERSION === 1 && s.ruleSet === 1 && s.version === 1 && LOT_VERSION === 1,
  `D11a 规则版本号现值 1 == stats() 盖在数据上的那个 == 数据文件 META 里的那个 == library 自己声明的 LOT_VERSION`,
  `logic ${RULE_SET_VERSION} · stats ${s.ruleSet} · META ${s.version} · LOT ${LOT_VERSION}`);
ok(/RULE_SET_VERSION = 1/.test(README) && /规则一改，关卡必须重新烘焙/.test(README) && /RULE_SET_VERSION = 1/.test(DESIGN),
  `D11b 两份文档印的「RULE_SET_VERSION = 1」与 README 那句"规则一改必须重烤"都还在（诚实条款不许被删软）`,
  /RULE_SET_VERSION = 1/.test(README) ? '两句都在' : '缺句');
// DESIGN 把免责句"引"成了中文句子，还署了出处（"就写在那张表的文件头"）。一句引用只有两种活法：
// 被引用的文件里真找得到它，或者文档标明那是译文。上一版这里直接把中文串拿去 lots.js 里 grep，
// 于是一条本来成立的引用被读成假话 —— 现在拆开：数据文件那一句现读原文，文档那一句必须带原文。
const DISCLAIM = 'every number below is a statement about those rules';
const DISCLAIM_HEAD = 'Depth belongs to the rule pair, not to the puzzle';
ok(read('js/data/lots.js').includes(DISCLAIM) && read('js/data/lots.js').includes(DISCLAIM_HEAD),
  `D11c lots.js 文件头那句免责（英文原文，现场读）还在原处（数据自己带着自己的免责）`,
  (read('js/data/lots.js').split('\n').find((l) => l.includes(DISCLAIM_HEAD)) || '找不到那一句').trim().slice(0, 60));
// 文档写的是"逐字抄、不节选"，那这句话就得整句能在被引用的文件里拼回来。数据文件把同一句
// 折成两行（中间隔着 `//`），所以按两半比；文档那一行不许折。
const lotsFlat = read('js/data/lots.js').replace(/\n\/\/ /g, ' ');
const disclaimFull = `${DISCLAIM_HEAD}; if the rules change, re-bake, because ${DISCLAIM}.`;
ok(DESIGN.includes(disclaimFull) && lotsFlat.includes(disclaimFull),
  `D11d DESIGN 印的那句"原文"整句能在 lots.js 里逐字拼回来（署了出处只抄半句，另一半就没人背书）`,
  `文档 ${DESIGN.includes(disclaimFull) ? '整句' : '缺整句'} · 数据 ${lotsFlat.includes(disclaimFull) ? '整句' : '缺整句'}`);
const lotsHead = read('js/data/lots.js').split('\n').slice(0, 6).join('\n');
ok(/GENERATED by tools\/bake\.mjs/.test(lotsHead) && /do not edit by hand|别手改|not.*hand/i.test(lotsHead),
  `D11e lots.js 顶部仍写着自己是 bake 生成、不许手改（这份数据的唯一写入方是工具）`, lotsHead.split('\n')[0].slice(0, 70));
const rngDoc = (DESIGN.match(/hashSeed\('a'\) = (\d+)/) || [])[1];
const rngDocUtf8 = (DESIGN.match(/UTF-8 FNV-1a\('a'\)\s*\n?= (\d+)/) || DESIGN.match(/UTF-8 FNV-1a\('a'\) = (\d+)/) || [])[1];
ok(rngDoc === '723832900' && rngDocUtf8 === '3826002220',
  `D11g DESIGN 那两个哈希向量（本仓构造 723832900 / 教科书 UTF-8 3826002220）仍是文档写的那两个字符串`,
  `文档 ${rngDoc} vs ${rngDocUtf8}（这两个数由 test/rng.test.mjs 对着独立实现钉，闸只比抄写）`);
ok(/FNV-1a 32 位/.test(DESIGN) && /0x811c9dc5/.test(read('js/core/rng.js')) && /0x01000193/.test(read('js/core/rng.js')),
  `D11f DESIGN 说的 FNV-1a 构造（offset basis 与 prime）在 rng.js 里逐字还是那两个常量`, '在');

// ------------------------------------------------------------------ D12 接线：本闸必须真的在门上
ok(!!(PKG.scripts && /tools\/doctest\.mjs/.test(PKG.scripts.doctest || '')),
  `D12a package.json 有 doctest 这条 script 且指向本仓 tools/`, PKG.scripts?.doctest || '没有');
// npm test 可以写 `npm run doctest` 而不是路径，但那一跳必须真指向本文件：
// 链条两头分开各钉一次，中间不许有悬空的一节（只查路径会把 `npm run doctest` 判成"没接线"）。
const testChain = (PKG.scripts && PKG.scripts.test) || '';
ok(/tools\/doctest\.mjs/.test(testChain) || (/\bnpm run doctest\b/.test(testChain) && /tools\/doctest\.mjs/.test(PKG.scripts?.doctest || '')),
  `D12b npm test 里含本闸（"npm test 全绿"这句话必须包含它；走 npm run doctest 那一跳时，那一跳的目标也得指向 tools/doctest.mjs）`, testChain || '没有 test');
ok(/node tools\/doctest\.mjs/.test(VERIFY), `D12c verify.sh 跑了本闸（在 node 层里，不是只在文档里）`, /node tools\/doctest\.mjs/.test(VERIFY) ? '在' : '不在');
const unitJob = CI.slice(CI.indexOf('  unit:'), CI.indexOf('  browser:'));
ok(/node tools\/doctest\.mjs/.test(unitJob), `D12d CI 的 unit job（不开浏览器那个）跑本闸 —— 本地绿＝CI 绿，不许有只在本地跑的闸`, /doctest/.test(unitJob) ? '在 unit job' : '不在');
ok(/doctest/.test(README), `D12e README 提到了这道文档数字闸（新闸不进文档就等于没上）`, /doctest/.test(README) ? '在' : '不在');
const expectLines = [...VERIFY.matchAll(/(DOCTEST_GROUPS_EXPECT|DOCTEST_ROWS_EXPECT)=(?:\$\{[^}]*:-)?(\d+)/g)].map((m) => ({ k: m[1], v: +m[2] }));
ok(expectLines.length === 2, `D12f verify.sh 把本闸的组数与项数都钉进了 expect（缺一格就是缩小范围无人守）`, expectLines.map((x) => `${x.k}=${x.v}`).join(' · ') || '一格都没有');
ok(/SKIP_UNIT/.test(VERIFY) && /SKIP_UNIT=1/.test(CI), `D12g browser job 用 SKIP_UNIT 跳过 node 层 —— 这句话是本闸能进 unit job 的前提，两个文件都得还写着`,
  `${/SKIP_UNIT=1/.test(CI) ? 'CI 有' : 'CI 没有'}`);
// 破坏台账（tools/sabotage.py）搬到仓里来，为的就是这一条：它此前住在仓外的 `_tmp-pentapack-sab.py`，
// 于是"有 37 把刀"这句话只活在某一台机器的终端记录里，CI 看不见、npm 调不到、改断言的人也不会撞上它。
// 四个位置缺一处，这句话就重新变回一段没人执行的代码：unit job 的那一步 / package.json 的 script /
// README 里那条命令 / 台架里那把专门砍这条接线的刀。verify.sh 故意不在名单里——本地验收门不该压 12 分钟的刀。
const SABPY = existsSync(join(ROOT, 'tools/sabotage.py')) ? read('tools/sabotage.py') : '';
const sabWires = {
  ci: /run: python3 tools\/sabotage\.py/.test(unitJob),
  pkg: ((PKG.scripts || {}).sabotage || '').trim() === 'python3 tools/sabotage.py',
  readme: /python3 tools\/sabotage\.py/.test(README),
  knife: /'D12h/.test(SABPY),
};
ok(Object.values(sabWires).every(Boolean),
  `D12h 破坏台账接进了 CI unit job、package.json 与 README，而且这条接线自己有一把刀（砍掉任何一处它就只是一段代码）`,
  Object.entries(sabWires).map(([k, v]) => `${k}=${v ? '在' : '缺'}`).join(' · ') + (SABPY ? '' : ' · 台架文件不在树里'));

// ------------------------------------------------------------------ D13 文件清单（README 目录块）
// 这一组是"目录"这个词唯一的机器含义：文档那块列的每一行都要在磁盘上，磁盘上每一个入口
// 文件都要被那一块列到（图片或按目录收进）。上一棒往树里加了 PWA 与美术层，README 一字未动
// —— 那条「没有图片资产」的不变量现在由 check.mjs 数像素守着，而"文档说过的清单全不全"没人守。
const dirBlock = README.slice(README.indexOf('## 目录'), README.indexOf('## 端口'));
const listed = [...dirBlock.matchAll(/^(\S+)\s{2,}/gm)].map((m) => m[1])
  // 代码围栏与分隔线也被这条正则收进来过（``` 与 --- 都是 \S+），于是"清单反闭"变成比 markdown
  // 语法。只留形状像路径的条目：含 / 或含 .。
  .filter((t) => /^[A-Za-z0-9._/-]+$/.test(t) && (t.includes('/') || t.includes('.')));
const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = `${dir}/${e}`;
    if (statSync(join(ROOT, p)).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};
const entryFiles = ['index.html', 'server.cjs', 'sw.js', 'manifest.webmanifest', 'css/game.css', 'js/main.js', 'js/view.js', 'js/audio.js', 'js/sw-register.js', 'js/data/lots.js']
  .concat(walk('js/core'), walk('tools'), walk('electron'))
  .concat(['test/pieces.test.mjs', 'test/board.test.mjs', 'test/dlx.test.mjs', 'test/logic.test.mjs', 'test/make.test.mjs', 'test/library.test.mjs', 'test/game.test.mjs', 'test/storage.test.mjs', 'test/rng.test.mjs', 'test/anchor.test.mjs', 'test/fixture.mjs']);
const covered = (f) => listed.includes(f) || listed.some((t) => t.endsWith('/') && f.startsWith(t)) || listed.some((t) => t.endsWith('/*.png') && f.startsWith(t.slice(0, -6)) && /\.png$/.test(f));
const unlisted = entryFiles.filter((f) => !covered(f));
const ghost = listed.filter((t) => !t.endsWith('/') && !t.endsWith('/*.png') && !existsSync(join(ROOT, t)));
ok(listed.length >= 25, `D13a README 的目录块解析到 ${listed.length} 行条目（解析行数掉了就是格式改了）`, listed.length + ' 行');
ok(unlisted.length === 0, `D13b 磁盘上每一个入口文件都被目录块列到（缺的那些就是"存在但没人知道"的面：${unlisted.join(' ')}）`, unlisted.join(' ') || `${entryFiles.length} 个逐个在清单里`);
ok(ghost.length === 0, `D13c 目录块里没有"写了但其实不在"的文件（清单反过来也要闭）`, ghost.join(' ') || '无幽灵条目');
const coreOrder = ['pieces', 'board', 'dlx', 'logic', 'make', 'library', 'game', 'storage', 'rng'];
const coreFiles = readdirSync(join(ROOT, 'js/core')).map((f) => f.replace(/\.js$/, '')).sort();
ok(coreOrder.slice().sort().join(' ') === coreFiles.join(' '),
  `D13d 文档那句"纯规则层九个文件"逐个存在，且 js/core 里没有第十个不被文档提到的文件`, `文档 ${coreOrder.length} · 磁盘 ${coreFiles.length}：${coreFiles.join(' ')}`);
ok(/10 个 node suite|10 个 node 套件/.test(README) && /10 个 node suite/.test(DESIGN) && readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length === 10,
  `D13e 磁盘上 test/ 里的套件数 == 两份文档那句「10 个」（第 11 个套件出现了，文档那两句就得一起改）`, `磁盘 ${readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length}`);
const portDoc = num((README.match(/本地静态服务 \| \*\*(\d+)\*\*/) || [])[1]);
const devScript = num(((PKG.scripts.dev || '').match(/(\d{4})/) || [])[1]);
const portLive = num((read('server.cjs').match(/port = (\d+)/) || [])[1]);
ok(portDoc === devScript && portDoc === portLive && portDoc === 5197, `D13f 端口 5197 三处同源：文档端口表、npm run dev、server.cjs 默认值`, `文档 ${portDoc} · dev ${devScript} · server ${portLive}`);
const cdpDoc = num((README.match(/浏览器门禁 devtools \| \*\*(\d+)\*\*/) || [])[1]);
const cdpLive = num((VERIFY.match(/CDP_PORT=\$\{CDP_PORT:-(\d+)\}/) || [])[1]);
const cdpDesign = num((DESIGN.match(/devtools (\d+)/) || [])[1]);
ok(cdpDoc === cdpLive && cdpDoc === cdpDesign && cdpDoc === 9357, `D13g devtools 端口 9357 三处同源：README 表、verify.sh 现值、DESIGN §8`, `文档 ${cdpDoc}/${cdpDesign} · verify.sh ${cdpLive}`);
const saveDoc = (README.match(/`pentapack\.save\.v(\d+)`/) || [])[1];
const saveLive = (read('js/core/storage.js').match(/pentapack\.save\.v(\d+)/) || [])[1];
const saveDesign = (DESIGN.match(/`pentapack\.save\.v(\d+)`/) || [])[1];
ok(saveDoc === saveLive && saveDesign === saveLive, `D13h 存档 key 的版本号两份文档写的与 storage.js 里那一个相同（key 版本一变，旧档必须能被认出来不是本构建的）`, `文档 v${saveDoc}/v${saveDesign} · 代码 v${saveLive}`);
const assetCount = walk('assets').filter((f) => /\.png$/.test(f)).length;
const pngDoc = [...DOCS.matchAll(/(\d+) 张 PNG/g)].map((m) => num(m[1]));
ok(pngDoc.length === 0 || pngDoc.every((x) => x === assetCount),
  `D13i 文档若写死 PNG 张数，那个数 == 磁盘现量 ${assetCount}（写了不复核的张数就是下一个「没有图片资产」）`,
  `文档 ${pngDoc.join('/') || '未写死'} · 磁盘 ${assetCount} 张`);
ok(assetCount === pngNow, `D13j 本闸两处数的 PNG 是同一个数（D9d 与 D13i 各走一条遍历，分家了就是其中一条在骗人）`, `D9d ${pngNow} · D13 ${assetCount}`);

// ------------------------------------------------------------------ D14 钉不住的读数：显式清单
// 规矩 2：这些是本机读数（毫秒、某次 CI 的 run、历史一次 20/20）。闸不复测它们，
// 但要求"文档仍然把它们标注成读数" —— 悄悄删掉或改口成承诺，就是这里的红。
const UNPINNED = [
  // 这一条钉的是"标注"而不是那几个数：每行毫秒必须还带着一句"这是读数"。数字本身会随下一次
  // 复跑变，"变宽了要重新抄一遍并说明它不是断言"这句话不能变。
  { id: 'U1', says: 'DESIGN §2.3 proof 那块旁边的每行毫秒，且仍被标成读数（钉的是标注，不是那几个数）', re: /逐行[\s\d/]*ms[\s\S]{0,24}读数/ },
  // U2/U3 钉的是"这句话还在、而且仍然带着小数点级的读数形状"，不是那几个秒数本身：
  // 秒数每轮都会漂，把它们写死进 needle 就等于下一轮为了绿去改断言。
  { id: 'U2', says: '「本轮 N s / M s」这两个总时长（README §不承诺，形状对就行）', re: /本轮 \d+\.\d s \/ \d+\.\d s/ },
  { id: 'U3', says: '门禁清单那句「本机 N s」（balance --check 的墙钟，形状对就行）', re: /本机 \d+\.\d+ s/ },
  { id: 'U4', says: '「曾经有过一次：残留的 Chrome 让套件报 20/20」这段历史', re: /残留的 Chrome/ },
  { id: 'U5', says: '「472d535 那次 / cdf58d8」两个 CI 读数（引用的是当时的 run，不是现在的树）', re: /472d535[\s\S]{0,200}cdf58d8/ },
  { id: 'U6', says: 'DESIGN 那句 anchor.test「本机一轮跑 9.4 s——读数，不进断言」', re: /9\.4 s——读数，不进断言/ },
  { id: 'U7', says: '浏览器层那五个场景的行数与「=== ALL GREEN ===」（只在真 Chrome 上才成立，本闸不跑浏览器）', re: /@boot \d+ +@play \d+/ },
  { id: 'U8', says: 'README 那句「LIVE_RC=0」与线上前缀复跑（引用的是已上线站点的一次运行）', re: /LIVE_RC=0/ },
];
for (const u of UNPINNED) {
  ok(u.re.test(DOCS), `D14 ${u.id}「${u.says}」还写在文档里（钉不住 ≠ 可以删；删了或改口成承诺就是这一条红）`, u.re.test(DOCS) ? `${(DOCS.match(u.re) || [''])[0].length} 字节命中` : '0 处');
}
ok(/没有毫秒层面的承诺/.test(README) && !/\bms\b.*断言/.test(README.match(/没有毫秒层面的承诺[^\n]*/)?.[0] || ''),
  `D14z 文档自己写着"没有毫秒层面的承诺"，而本闸这一组一条也没测毫秒`, /没有毫秒层面的承诺/.test(README) ? '在' : '不在');

// ------------------------------------------------------------------ D15 自钉：组数、每组项数、总项数
// 全量运行的规模由"逐组钉值 + 本组自己"闭成一笔账：任何一条 ok() 增删都会同时让那一组的
// D15c 和最后的 D15e 红，而改总钉值不改逐组钉值 —— D15d 那笔求和对账也会红。
// 那三个常量住在文件头，README 的测试日志抄的是同一个 EXPECT_ROWS。
const rowsBefore = rows;
const predicted = rowsBefore + WANT_D15;
if (ONLY.length) {
  // 点名的组都得发声。这里不数 `emitted.size === ONLY.length`：D15 自己发声之前那一格还是空的，
  // 单独跑 ONLY=D15（破坏台账点名本闸时就是这么跑）会永远红，红得和刀没关系。
  ok(ONLY.every((g) => g === 'D15' || emitted.has(g)), `D15z 子集运行把点名的组都执行了（${ONLY.join(',')}）`, `发声 ${[...emitted].join(' ')} · 钉成等式的项数在全量运行才成立`);
} else {
  ok(emitted.size + 1 === EXPECT_GROUPS, `D15a 本闸发出 ${emitted.size + 1} 组 D 标签（钉在 ${EXPECT_GROUPS}；少一组就是这里红）`, Object.keys(perGroup).sort().join(' '));
  ok(predicted === EXPECT_ROWS, `D15b 本闸整跑项数钉在 ${EXPECT_ROWS}（预测 = 到这里 ${rowsBefore} + 本组自己 ${WANT_D15}；增删一条 ok() 都要同时改这里的钉）`, `预测 ${predicted}`);
  for (const [g, want] of Object.entries(EXPECT_ROWS_BY_GROUP)) {
    ok(perGroup[g] === want, `D15c ${g} 这一组现发 ${perGroup[g]} 项 == 钉的 ${want}`, `钉 ${want} vs 实发 ${perGroup[g] ?? 0}`);
  }
  const sumGroups = Object.values(EXPECT_ROWS_BY_GROUP).reduce((a, b) => a + b, 0);
  ok(sumGroups + WANT_D15 === EXPECT_ROWS, `D15d 逐组钉值相加 ${sumGroups} + 本组 ${WANT_D15} == 总钉值 ${EXPECT_ROWS}（两笔账不许分家）`, `相加 ${sumGroups + WANT_D15}`);
  // 这一条自己就是那 18 项里的最后一项，而 ok() 的参数在自增之前求值：它在场时 `rows` 还差
  // 它自己一个。所以比的是 rows + 1（写成 rows 会永远少一，钉值 207 也永远对不上 206）。
  ok(rows + 1 === predicted && rows + 1 === EXPECT_ROWS, `D15e 现场发到的项数 == 预测 == 钉值（有人在本闸前面加了条断言又没改钉，就是这里红）`, `实发 ${rows + 1} · 预测 ${predicted} · 钉 ${EXPECT_ROWS}`);
}

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
// 点名的组一条都没发 = 这一趟什么都没跑就"绿"了。一个不存在的组名（手打错、或别的进程把
// ONLY 这个环境变量带进了子进程，比如台账自己的 ONLY）必须当场红，而不是打一行 NOTE 退 0。
const dead = ONLY.filter((g) => !perGroup[g]);
if (dead.length) {
  console.log(`FAIL ONLY 点名了没有发声的组：${dead.join(' ')}（可用的组：${Object.keys(perGroup).sort().join(' ') || '无'}）`);
  console.log(`rows: ${rows} fail: ${fail.length + 1}`);
  process.exit(1);
}
if (skipped.length) console.log(`NOTE 本次是子集运行（ONLY=${ONLY.join(',')}），未执行的组：${skipped.sort().join(' ')}；自钉 D15 在全量运行才成立`);
console.log(`rows: ${rows} fail: ${fail.length}`);
console.log(`pin: groups=${ONLY.length ? emitted.size : EXPECT_GROUPS} rows=${EXPECT_ROWS} 逐组=${Object.entries(perGroup).map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`钉成等式的文档现值：${rows - UNPINNED.length - 1} 项 · 显式 unpinned（只要求句子还在）：${UNPINNED.length + 1} 项`);
if (fail.length) { for (const f of fail) console.log(`  未过：${f}`); process.exit(1); }
process.exit(0);
