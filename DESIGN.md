# 设计 · 五连块匣

这份文件写的是**为什么这样切**，以及每个数字是从哪一行代码长出来的。
玩法与公开锚点表在 `README.md`，交付清点在 `deliverable.md`。

## 1. 分层与四条不变量

```
js/core/    纯规则层：pieces → board → dlx → logic → make → library → game → storage → rng
js/data/    一张被复证过的测量表（生成的，别手改）
js/view.js  只画，不判；js/main.js  只装配，不推理
tools/      烘焙、门禁、真事件台架
test/       9 个 node suite，跑在裸 node 上
```

四条被 `tools/check.mjs` 机器化了的不变量（16 行断言，全绿）：

1. **`js/core/*` 里没有 DOM 字样**，也没有 `window` —— 除了存储层，而它只在 `try/catch` 后面提。
   这条是"同一份规则既能在 node 里被断言、又能在浏览器里被真事件驱动"的前提。
2. **`js/core/*` 里没有时钟、没有 `Math.random`**。随机只来自 `rng.js` 的注入种子；
   `todayKey(date)` **拒绝**默认它的参数（`test/rng.test.mjs` 钉住），所以"今天"必须由调用方读表进来。
3. **零依赖**：`dependencies` 和 `devDependencies` 都是 `{}`，`tools/` 只碰 `node:` 内置模块。
4. **没有图片资产，也没有代码要图片**：十二块的形状就是数据，界面是 canvas 画的。

第 2 条不是洁癖。每日匣的链接可以不带日期（`#/daily`），这时"今天那一关"必须仍然成立，
而唯一读时钟的地方是 `js/main.js:84 const today = () => todayKey(new Date())`，
它把 key 注入 `resolveRoute(hash, today())`（`js/core/library.js:164`）。
规则层自己伸手看表的话，同一链接在两次渲染里会给出两关，而 node suite 永远不会发现这件事。

## 2. 规则层

### 2.1 姿态：63 个 fixed pentomino，D₄ 轨道表

`js/core/pieces.js` 里十二块各带一个 canonical 姿态，`buildVariants` 用 rot/mirror 生成它的轨道，
去重后按稳定顺序编号。逐块姿态数 F8 I2 L8 N8 P8 T4 U8 V4 W4 X1 Y8 Z4，合计 **63**。
`test/pieces.test.mjs` 不只数数，还断言群律：rot⁴=1、mirror²=1、`mirror∘rot∘mirror = rot³`，
以及轨道-稳定子定理 `variantCount × |stabiliser| = 8` 对每一块都成立；
手写的十二块若不是那个十二块（比如混进 S 或重复一个），模块加载时自检就直接拒绝。

`rotatedIndex/mirroredIndex` 是 D₄ 在编号上的作用，视图与测试都问这两个函数，不自己算下标。
`cellsFor()`（`game.js:46`）对越界下标取模，所以 `variant 99` 与 `variant 3` 是同一姿态
（`test/game.test.mjs` 里有一条专门钉它）。

### 2.2 匣、落点与三个拒绝码

匣 = 8×8 框内的一组被选格子（`mask`）。`board.js:placementMask(spec, cells, ax, ay)` 是唯一
回答"这一块在这个姿态、这个锚点，盖住哪些格"的地方，失败时返回**具名**的码：

- `out`：伸出边框；
- `off`：在框内、落在匣外；
- `overlap`：压住别的块 —— 这条由 `game.js:105` 判，因为只有它知道别人。

三个码在 `game.js:91` 的 `BOUNCE` 一处翻译成中文，视图照抄，提示照抄，
`@pointer` 断言照抄。拒绝的落子**不计步**，块弹回原处（`BOUNCE_MS = 200` 的回位动画）。

### 2.3 精确覆盖：DLX 与"解数 = 1"

`dlx.js` 是 Knuth 的 Algorithm X 带舞蹈链。一行 = 一个 (块, 姿态, 锚点) 三元组；
列 = 每个匣格（恰好被盖一次）+ 每块（恰好用一次）。`countSolutions(spec, limit)` 支持提前停。

这份实现对着公开数字校过（`node tools/proof.mjs`，本机实测）：

```
3x20  orbits     2 (published     2) | raw     8 = orbits x 4 | nodes    34783 | 147ms
4x15  orbits   368 (published   368) | raw  1472 = orbits x 4 | nodes   922440 | 3896ms
5x12  orbits  1010 (published  1010) | raw  4040 = orbits x 4 | nodes  2507589 | 10840ms
6x10  orbits  2339 (published  2339) | raw  9356 = orbits x 4 | nodes  4050281 | 18310ms
```

`raw = orbits × 4` 不是巧合而是被断言的关系：矩形自身的对称（旋转与镜像）把每条本质不同的铺法
展开成 4 条固定铺法。这四行由 `test/anchor.test.mjs`（共 20 行，整个文件在本机跑 17.0 s）
在 CI 里也跑，跑的是真搜索；`node tools/proof.mjs` 打印的就是上面那张表（四行合计约 33 s）。
另外 `countSolutions(spec, 2)` 的提前停止被单独测过：只要两条解就收工，
limit=2 时 5×12 只用 1016 个节点 —— 这就是烘焙为什么便宜。

### 2.4 完成判定：比对烘焙解答，而不是现场搜索

`checkDone()`（`game.js:197`）做的事：匣满了之后，把玩家的位置与随包发布的那条解答比
（`samePlacements`）。一致 → `done`；不一致 → **`anomaly = 'second-solution'`**，界面写
"异常：出现了第二条解 … 请把 `taster-01` 报告出来"，不发星。

为什么不现场跑一次 DLX：一关的铺法搜索在手机上要几百毫秒到十几秒（上面那张表就是代价），
而"填满即完成"这件事在解数=1 的前提下**等价于**比对一条已知答案。省下的代价换来的是
判定与证明同源。代价是这条等价的成立依赖烘焙的正确性 —— 所以它被反过来用：
**假如玩家真填出另一种满盘，那就不是"他也算过"，而是我们的证明错了**，
于是 `anomaly` 是这条依赖的哨兵，而不是装饰。`@play` 用 `window.pentapack.setSolution()`
把存档那条线换成一条真不一样的（piece 0 的 x+1），再按真解答装满，断言
`done === false && anomaly === 'second-solution'` 并且面板上真有那句"异常"；
`test/game.test.mjs` 在纯规则层跑同一条分支。

### 2.5 步数经济学

`game.js:5-11` 是这个游戏对"一步"的全部定义：落子 1、取回 1、把已上的块挪走 1、
旋转/镜像 0、被拒绝的落子 0、原地重按同一格 0（`place` 报 `noop`）。
所以 k 块关卡的下界恰为 k，`grade()` 量的是 `moves - k`：`<=0` 一次到位 ★★★，
`<=2` 干净装箱 ★★☆，否则 反复挪动 ★。

两条被 `test/game.test.mjs` 钉住、而界面看不见的推论：

- **匣满即锁**：`done` 之后 `place` 与 `takeBack` 一律返回 `code:'done'` 且不记账 —— 所以"浪费"
  必须发生在最后那块落下之前，写测试时把取回放在完成之后是徒劳的（我第一版就栽在这里）。
- **锚点是包围盒左上角，那一格可能是空的**：V 的姿态 3 在 (0,0) 不覆盖自己的锚点，
  `pieceAt(0,0)` 是空的。这与 §7 的抓取点是同一件事的两面。

难度**从不**是这个计数器：那是 `解数`（DLX）与 `推理深度`（logic）。

## 3. 生成：装箱构造 + 后验唯一

`make.js` 的 `makeLevel({seed, band, maxAttempts, deadline})`：

1. 在 8×8 框上用 `packOnce` 逐块装箱（带邻接偏置 `weightedPick`，bias 0 退化为均匀），
   每次落块必须与已落的边相邻；装满即得一个**天生有解**的匣与一套块；
2. `countSolutions(spec, 2) === 1` 后验唯一性 —— 不唯一的盘直接丢；
3. `logicSolve` 量深度，深度不在本档窗口内丢；
4. `deadline` 由调用方注入（§1 不变量 2），超时不生成而是报告。

`packOnce` 与 `weightedPick` 的确定性由 `test/make.test.mjs` 断言：同一 seed 同一 stream 同一盘，
死胡同诚实报告（`yieldOf` 报的是率，不是感觉）。

## 4. 度量：两条规则与假设深度

`logic.js` 的头部注释就是规格：R1 格暴露、R2 块暴露，求到不动点；不动点不满盘就必须猜，
取候选最少的空格（并列取低格号），递归一层。**`推理深度` = 这个程序为收工真正进过的最深假设层数。**

`RULES` 与 `RULE_SET_VERSION = 1` 是导出的，界面引用它，测试钉住它。
诚实条款（`logic.js:13-16`）说清了这个数的归属：它属于这对规则，不属于谜题本身；
规则一变，全屋的数都要重测，所以 `js/data/lots.js` 必须重新烘焙 —— 那句
"如果你改了规则，包里的数字就不再是关于任何东西的陈述"就写在那张表的文件头。

## 5. 关卡包与路由

`library.js` 把三种内容收敛成同一个对象形状：烘焙 30 关（`campaign()`）、每日匣
（`dailyLot(dateKey)`，id 形如 `daily-daily-2026-03-04`，前缀是来源、后段是 `adopt()` 的 seed）、
随机匣（`randomLot(seed, band)`，id `rand-<seed>`）。
**带来源前缀的 id 是刻意的**：不同来源的同一日期不能互相覆盖存档。

`resolveRoute(hash, todayKeyText)` 不抛异常：未知 id 返回 `{ kind:'lot', missing }`，
壳层写"链接里没有这一关"，而不是白屏或假装回到了刚才那关。
空 hash 是"没有链接"的意思，落到匣阵第一关（`ALL[0]`）；`#/campaign` **不是**这个游戏定义的链接。

种子的入口是 `rng.js:hashSeed`，值得在这里写清楚免得后人误标：它是 **FNV-1a 32 位的构造
（offset basis `0x811c9dc5`、prime `0x01000193`）逐 UTF-16 code unit 拆成两字节喂进去**，
不是对 UTF-8 字节的 FNV-1a。实测：`hashSeed('a') = 723832900`，而教科书 UTF-8 FNV-1a('a')
= 3826002220 —— 两个数不同，`test/rng.test.mjs` 的期望值来自一份独立的 Python 实现，
钉的是前者。随机匣在没指定档位时用 `hashSeed('band|' + seed)` 选档，所以这个函数一旦被"顺手
改成标准 FNV"，所有已分享的 `?seed=` 链接都会换关。

## 6. 存档

一个 key（`pentapack.save.v1`）、一份 JSON、两条单调规则写在**写入方**：
`best[id].moves` 只降，`unlock` 只升。清空匣的成绩需要两次确认，且 `clearArm` 写在存档里，
所以"再按一次"的窗口扛得住刷新 —— 一刷新就能撤销的清除不叫清除。
`localStorage` 缺失（node、隐私模式、无 profile 的 webview）或内容是旧构建的垃圾时，
`sanitise()` 把不认识的字丢掉、要求数字有限且非负，降级而不是崩，也**不许**把已清掉的游戏复活。

## 7. 视图与输入：命中几何是唯一有争议的部分

视图不判断合法性，只问规则（`view.js:3`）。三处坐标数学必须彼此一致，否则会出现
"幽灵画在这里、判定在别处"的裂缝，所以它们共用 `anchorOf()` / `ghostAnchor()` / `grabCentre()`：

- **抓取点不是包围盒中心。** V、U、W 的中心是洞，`pieceUnder()` 读到洞就认为"指下没有块"，
  于是手势会凭空失效。`grabCentre()` 取的是**离盒中心最近的那个被占据格的中心**。
- **鼠标不能转块。** `dropPoint(piece, x, y, variant)` 里那个 variant 只用来算 bbox 尺寸，
  松手提交的是块**当前**的姿态（`view.js:572`）。台架因此必须先做玩家真会做的免费操作
  （旋转，必要时镜像）再下指 —— 见 `tools/playtest.mjs:204` 的 `turnTo()`。
- **原地转不过去就不转**（`game.js:140`）：新姿态在同锚点冲突时 `rotate/flip` 返回 `blocked`，
  姿态一格不动，也不计步。

`dblclick` 与 `contextmenu` 是真的 DOM 事件（CDP 的 `Input.dispatchMouseEvent` 带 `clickCount`
会合成 `dblclick`），长按阈值 480 ms。应用监听的是 pointer 事件，所以 `mousedown/mouseup`
计数为 0 而 `pointerdown/click/dblclick` 会响 —— 台架按这个事实写断言。

## 8. 台架与门禁

`bash tools/verify.sh` = 9 个 node suite + `tools/check.mjs` + 一个真实 headless Chrome
经 CDP 打真实事件，五个场景一轮一轮共用同一个 tab（`@boot @play @routes @save @pointer`）。
本仓专属端口 **web 5197 / devtools 9357**（兄弟仓默认 5180/9340，批次用 5185-5196/9345-9356）。

四处设计是为了不让"绿"变成 opinion：

1. **开跑前拒绝占用**：任一端口上已有**监听**就直接 `exit 6` 并打印持有者 PID。判据是一次
   `net.connect`（node 本来就是硬依赖），不是 `curl /json/version` —— 后者会放过一个对
   `/json/version` 回 404 的监听者，而那个监听者一样会让 Chrome 绑不上。这条不是洁癖 ——
   一次探针留下过 9357 上的 Chrome 与 5197 上的服务，之后的运行报了 20/20 全过，
   而它驱动的是它自己没启动的那个浏览器。**端口撞车产出的是假判决，不是不便。**
2. **脏 console 算红**：聚合器 grep `[error] [EXCEPTION] [warning] [log:*] uncaught typeerror referenceerror`。
3. **收尾确认 Chrome 真退了**才写 `=== ALL GREEN ===`，否则红着退出；`exit $FAILED` 是真的退出码。
4. **门禁脚本本身要能在 Linux runner 上跑完**：CI 的 browser job 执行的就是这个文件，
   所以任何 macOS-only 的写法都等于"绿"里有一段从没被执行过。实测踩到的是
   `mktemp -d -t <前缀>`（GNU 要的是模板，报 too few X's，于是 profile 目录是空的，
   Chrome 起不来，最后只留下一句 "devtools never bound"）—— 见 §9 第 17 条。

机器可读的输出形状（`rows: N fail: M`）由 `tools/harness.mjs` 统一，
浏览器场景的行也是行，`tools/verify.sh` 与 CI 用同一个 grep 求和。
聚合器用 `json.JSONDecoder().raw_decode` 而不是手搓花括号计数 —— 中文文本里嵌套的 `{`
会让手搓计数永不归零，于是整个 suite 在聚合器里报错、**一个判决都不输出**。

## 9. 更正记录：一开始错在哪 → 现在为什么对

产品缺陷 5 处（1-5），测试自身写错 8 处（6-12、14），空断言 1 处（13），缺 suite 1 处（15），
台架与发布脚本缺陷 3 处（16-18）。每一条都有实测。

| # | 现象 | 定性 | 现在的依据 |
| --- | --- | --- | --- |
| 1 | `renderLegend` 往未绑定的 `el.legend` 上写 innerHTML，顶层抛错导致 `window.pentapack` 从未赋值，五个浏览器场景一起红 | 产品 bug（一处，五个症状） | `js/main.js` 的 `el` 表补 `legend`；一个 bug 不该被记成五个 |
| 2 | 块色对照有 DOM 没有样式：`.chip`/`.legend` 只活在 JS 里 | 产品 bug | `css/game.css` 补 `.legend/.chip`，色块由 app 内联的 `--chip` 上色 |
| 3 | 无 hash 启动被替换成 `#/campaign`，而那不是本游戏定义的链接（kind `unknown`、lot null），空路由落到白屏 | 产品 bug | 默认改成 `''`（`library.js:167` 文档化的"落到匣阵第一关"）；这个错还会污染分享链接 |
| 4 | `piecePoint` 对已下的块取 bbox 中心，V/U/W 是洞，抓取失败 | 产品 bug | `js/view.js:grabCentre()` 取最近被占据格中心 |
| 5 | 裸 `#/daily` 产出 `daily-daily-`（无日期） | 产品 bug | `resolveRoute(hash, today())` 注入日期；`test/library.test.mjs` 两行钉住"注入的 key 生效"与"链接上写了日期以链接为准" |
| 6 | `@play` 镜像行红：基线写死 | 测试错 | flip² = 恒等（独立 node 脚本量出 walk `rot 0→4, mirror 4→5, mirror 5→4`），基线改成 `turned` |
| 7 | `@play` 超额行红：`k+1` | 测试错 | 取回也要记账 → `k+2`（`game.js:6-11`、`grade` at `game.js:248`） |
| 8 | `@pointer` 七行里六行红：以为拖动能选中姿态 | 测试错 | 鼠标不能转块（§7），加 `turnTo()` 并把 `turned` 作为断言的一部分 |
| 9 | `@pointer` 取回行的算术 `placed === plan.length - 2` | 测试错 | 断言写成相对量 `downBefore.placed - 1`；顺带清掉一个遗留变量引用 |
| 10 | `@save` 解锁行断言"一个上锁按钮都没有" | 测试错（而且不合理） | 实际契约是 `globalIndex > s.unlock`（`main.js:206`）：`unlockTo(9)` → 30 个按钮里前 10 个可点、后 20 个灰 |
| 11 | `@save` 依赖执行顺序（`{"unlock": 9}` 残留） | 测试错 | 改走真实"清空"按钮路径（两次点击 + 重新 load），不再直接 `store.resetForTest()` |
| 12 | 原地旋转/镜像两行在 taster-01 上永不成立 | 测试前提错 | 对 30 关全量实测：**满盘解状态下没有一块能在原地转身**（`game.js:140`），taster-01 连单块也不给转（P/V/W → `blocked`，X → `noop`）。手势段换到 taster-02 的 V（单独放在姿态 2 @(2,2)：转→3，再镜像→0，锚点不变），而"转不过去"这条规则本身改由 `test/game.test.mjs` 在纯规则层钉住 |
| 13 | `@play` 的"完成判定不是填满就算"一行 `return true`，且所谓"换掉解答"是原样复制 | 空断言（假绿） | 真的把存档线改成 `x+1`，按真解答装满，断言 `done===false && anomaly==='second-solution'` 且面板有"异常" |
| 14 | 新写的 `test/game.test.mjs` 三行红 | 测试错 ×3（实测判定） | ① 新旧姿态可合法重叠，被保留的格不是 bug；② `done` 之后一切变更被 `code:'done'` 拒绝，浪费必须发生在收尾那一落之前；③ 锚点是 bbox 角，V 姿态 3 不覆盖自己锚点，`pieceAt` 读它是空的 |
| 15 | `game.js` 文件头指向一个从未存在的 `test/game.test.mjs` | 缺 suite | 补上，22 行；顺带发现 `tools/check.mjs` 与 `tools/proof.mjs` 只在 `npm test` 里跑、CI 不跑，已把 check 加进 CI 与本地门禁 |
| 16 | 一次一次性探针留下 9357 上的 Chrome 与 5197 上的服务，之后的门禁报 20/20 全过 —— 它驱动的是自己没启动的那个浏览器 | 台架缺陷 → 假绿 | `tools/verify.sh` 开跑前对两个端口各做一次 `net.connect`，有人在听就 `exit 6` 并打印持有者；收尾必须看到 Chrome 真退出才写 `ALL GREEN`（§8） |
| 17 | 本机 `=== ALL GREEN ===`，CI 的 browser job 却在第一行就废：`mktemp: too few X's in template 'pentapack'`，于是 `--user-data-dir=` 是空的，30 s 后只报 "devtools never bound on :9357" | 台架缺陷（平台差异） | macOS 的 `mktemp -t` 把参数当**前缀**，GNU 把它当**模板**且模板必须以 X 收尾。改成 `mktemp -d "${TMPDIR:-/tmp}/$TAG.XXXXXXXX"`（两边都吃，profile 仍带车道名），再加 exit 7：目录没建出来就当场退出，不让下一处失败顶着一个错误结论 |
| 18 | 建仓 API 回 201，org 上的 About 却是 `u4e94u8fdeu5323…` | 发布脚本缺陷 | curl 的 config 里 `data = <内联值>` 会做反斜杠转义：`json.dumps` 把中文写成 `\u4e94`，curl 再把 `\` 吃掉，GitHub 收到的就是字面 `u4e94`。改成 `data = "@file"`（curl 原样读文件字节），并对本仓 `PATCH` 修回正确描述 |

## 10. 没做与为什么没做

- **不做关卡编辑器**：编辑器的每一关都要重新过一遍"解数=1 + 深度测量"，那是烘焙流水线的活，
  不是 UI 的活。`#/random/<seed>?band=` 已经是可达面。
- **不在指针按下时现场跑 DLX** 做"这一步会不会死锁"的警告：见 §2.4 的代价表。
- **不做音效与图片**：`tools/check.mjs` 把"没有图片资产，也没有代码要图片"当断言。
- **不现场生成 campaign**：30 关是烘焙进 `js/data/lots.js` 的测量表。现场生成的话，
  文档里"这一关深度是 5"这句话就没有作者了。
