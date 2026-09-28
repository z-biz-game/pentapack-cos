# 五连块匣 - 交付报告

| 项 | 值 |
| --- | --- |
| **App 名称** | 五连块匣 · PENTAPACK |
| 仓库 | z-biz-game-pentapack-cos |
| 品类 | 益智 · 装箱（pentomino exact cover） |
| 依赖 | 0（`dependencies` 与 `devDependencies` 都是 `{}`，零构建、零二进制资产，由 `tools/check.mjs` 断言） |
| node 断言 | 160 行 / 0 失败（9 个 suite 共 144 行 + 分层自检 16 行；源码里 709 处 `eq/ok` 调用点） |
| 浏览器断言 | 86 行 / 0 失败（`@boot 16 @play 20 @routes 15 @save 15 @pointer 20`），脏 console `(none)` |
| 求解器校订 | 4 个公开锚点全对：3×20=2、4×15=368、5×12=1010、6×10=2339（`nodes` 与耗时见 §实测记录） |
| 内容 | 30 关烘焙（5 档 × 6 关，900 格匣面）+ 每日匣 + 随机匣；每关随包发布 `解数=1` 证明与 `推理深度` 测量 |
| 门禁 | `bash tools/verify.sh` → `=== ALL GREEN ===` / `exit 0`，本机 web 5197 + devtools 9357 的真实 headless Chrome |
| 上线 | 见 §发布记录 |

## 任务摘要

把五连块装箱做成**每个数字都能被机器复算**的关卡包，并把"完成"这件事建立在证明而不是宽容上：

1. 关卡由装箱构造（天生有解）→ **DLX 后验解数 == 1** → 两规则求解器**测量**推理深度 → 深度落进
   档位窗口 → **把序列化后的那一行重新读回来再证一遍**；第四道闸让"发布出去的数被验证过"
   这句话关于的是发布出去的字节，CI 里 `test/library.test.mjs` 跑同一条复证。
2. 难度是数出来的：`推理深度` 是求解器为收工**真正进过的最深假设层**，规则集固定并导出
   （`RULES`、`RULE_SET_VERSION = 1`），界面档位由 `(k, depth)` 反查（`bandName`），
   所以屏上那两个字与它下面的两个数同源。
3. 步数是经济学：落子 1 / 取回 1 / 拖动 1 / 旋转与镜像 0 / 被拒绝的落子 0，
   于是 k 块关卡下界恰为 k，星级量的是 `moves - k`。
4. 完成判定比对烘焙解答而不现场搜索 DLX；一旦玩家填出另一种满盘，那是证明错了，
   报 `anomaly = 'second-solution'` 而不是发星（`DESIGN.md` §2.4）。

## 真实文件清单

```
README.md  DESIGN.md  deliverable.md  LICENSE  package.json  .gitignore
index.html  css/game.css  server.cjs  electron/main.cjs
js/main.js  js/view.js
js/core/  pieces.js board.js dlx.js logic.js make.js library.js game.js storage.js rng.js   （9 个，纯规则层）
js/data/lots.js                                   30 关测量表（tools/bake.mjs 生成，勿手改）
test/  anchor board dlx game library logic make pieces rng  （9 个 suite）+ fixture.mjs
tools/ bake.mjs proof.mjs check.mjs harness.mjs playtest.mjs verify.sh
.github/workflows/  ci.yml  pages.yml
```

浏览器要下载的全部东西 = `index.html + css/ + js/`：14 个文件、3,493 行；
`js/core/` 2,004 行；测试与台架 3,896 行（比 shipped 还多，这是刻意的）。

## 门禁实跑记录（本机一次真跑，`bash tools/verify.sh`）

```
--- test/anchor.test.mjs   rows: 20 fail: 0     （内含四个公开锚点的真穷举）
--- test/board.test.mjs    rows: 15 fail: 0
--- test/dlx.test.mjs      rows: 12 fail: 0
--- test/game.test.mjs     rows: 22 fail: 0     （本次新增：步数经济学与拒绝码）
--- test/library.test.mjs  rows: 26 fail: 0     （30 关逐关从序列化行复证）
--- test/logic.test.mjs    rows: 11 fail: 0
--- test/make.test.mjs     rows: 16 fail: 0
--- test/pieces.test.mjs   rows: 14 fail: 0     （63 个 fixed 姿态与 D4 群律）
--- test/rng.test.mjs      rows:  8 fail: 0
--- tools/check.mjs        rows: 16 fail: 0     （分层：无依赖 / core 无 DOM / core 无时钟）
=== @boot 16  @play 20  @routes 15  @save 15  @pointer 20   全部 fail: 0
=== console (must be empty of errors) === (none)
chrome exited
=== ALL GREEN ===   exit 0
```

`node tools/proof.mjs`（求解器对公开数字的校订，本机实测）：

```
3x20  orbits     2 (published     2) | raw     8 = orbits x 4 | nodes    34783 |   147ms
4x15  orbits   368 (published   368) | raw  1472 = orbits x 4 | nodes   922440 |  3896ms
5x12  orbits  1010 (published  1010) | raw  4040 = orbits x 4 | nodes  2507589 | 10840ms
6x10  orbits  2339 (published  2339) | raw  9356 = orbits x 4 | nodes  4050281 | 18310ms
anchors: 4 fail: 0
```

档位与深度（`js/data/lots.js` 里烘焙时测到的数，按关卡序）：

```
taster k=4 窗口 0-1  实测 1,1,0,1,1,0
easy   k=5 窗口 1-3  实测 2,2,2,2,1,2
mid    k=6 窗口 2-4  实测 3,4,3,2,3,4
hard   k=7 窗口 3-5  实测 3,4,3,5,3,4
iron   k=8 窗口 4-7  实测 4,5,6,4,7,4
```

## 改动表：一开始错在哪 → 现在为什么对

产品缺陷 5 处，测试自身写错 10 处。完整的定性过程与依据在 `DESIGN.md` §9；这里是清点。

| # | 现象 | 定性 | 处理 |
| --- | --- | --- | --- |
| 1 | `renderLegend` 往未绑定的 `el.legend` 写 innerHTML → 顶层抛错 → `window.pentapack` 从未赋值 → 五个浏览器场景一起红 | 产品 bug（一处，五个症状） | `js/main.js` 的 `el` 表补 `legend` |
| 2 | 块色对照有 DOM 无样式（`.chip`/`.legend` 只活在 JS 里） | 产品 bug | `css/game.css` 补 `.legend/.chip`，色块由 app 内联的 `--chip` 上色 |
| 3 | 无 hash 启动被替换成 `#/campaign`，而那不是本游戏定义的链接（kind `unknown`、lot null） | 产品 bug | 默认改成文档化的 `''`（落匣阵第一关）；同一处错误也会污染分享链接 |
| 4 | 裸 `#/daily` 产出 `daily-daily-`（无日期） | 产品 bug | `resolveRoute(hash, today())` 由调用方注入日期；两行 node 断言钉住优先级 |
| 5 | `piecePoint` 对已下的块取 bbox 中心，而 V/U/W 的中心是洞 → 抓取失败 | 产品 bug | `js/view.js:grabCentre()` 改为"离盒中心最近的被占据格中心" |
| 6 | `@play` 镜像行基线写死 | 测试错 | flip² = 恒等，实测行走 `rot 0→4, mirror 4→5, mirror 5→4`；基线改 `turned` |
| 7 | `@play` 超额行 `k+1` | 测试错 | 取回也记账 → `k+2`（依据 `js/core/game.js:6-11`） |
| 8 | `@pointer` 七行里六行红：断言假设"拖动能选中姿态" | 测试错 | 鼠标不能转块；加 `turnTo()`（旋转+镜像生成 D₄）并把 `turned` 写进断言 |
| 9 | `@pointer` 取回行算术 `placed === plan.length - 2` | 测试错 | 改相对量 `downBefore.placed - 1`，并清掉遗留变量引用 |
| 10 | `@save` 解锁行断言"一个上锁按钮都没有"（任何合理阶梯都不会这样） | 测试错 | 按真实契约重写：`unlockTo(9)` → 30 个按钮前 10 可点、后 20 灰（`main.js:206`） |
| 11 | `@save` 依赖执行顺序（残留 `{"unlock": 9}`） | 测试错 | 改走真实"清空"按钮两次点击 + 重新 load，不再用 `store.resetForTest()` |
| 12 | 原地旋转/镜像两行在 taster-01 上永不成立 | 测试前提错 | 对 30 关全量实测：满盘解状态下没有一块能在原地转身（`game.js:140`），taster-01 单块也不给转（P/V/W `blocked`、X `noop`）。手势段换到 taster-02 的 V（转 2→3、镜像 3→0、锚点不变），"转不过去"这条规则本身下沉给 `test/game.test.mjs` 在纯规则层钉 |
| 13 | `@play` 的"完成判定不是填满就算"一行 `return true`，所谓"换掉解答"是原样复制 | 空断言（假绿） | 真改成 `x+1`，按真解答装满，断言 `done===false && anomaly==='second-solution'` 且面板有"异常" |
| 14 | 新写的 `test/game.test.mjs` 三行红 | 测试错 ×3（实测定性） | ① 新旧姿态可合法重叠，被保留的格不是 bug；② `done` 之后一切变更被拒（浪费必须发生在收尾那一落之前）；③ 锚点是 bbox 角，V 姿态 3 不覆盖自己锚点 |
| 15 | 门禁曾在**别人（上一次自己）留下的** Chrome/服务上跑出 20/20 | 台架缺陷 → 假绿 | `tools/verify.sh` 开跑前检查 9357/5197 是否已被占用，占用则 `exit 6` 并打印持有者；收尾确认 Chrome 真退出才算绿 |
| 16 | `game.js` 文件头指向一个从未存在的 `test/game.test.mjs` | 覆盖缺口 | 补 22 行 suite；并把 `tools/check.mjs` 同时接进本地门禁与 CI unit job（此前只有 `npm test` 跑它） |

另外三处属于"红是因为门禁变严了"，不是回归：console grep 加宽到 `[log:*]`；聚合器由手搓花括号
计数换成 `json.JSONDecoder().raw_decode`（中文文本里嵌套的 `{` 会让前者永不归零，于是整个 suite
**一个判决都不输出**）；端口与兄弟仓专属化（web 5197 / devtools 9357）。

## 发布记录

上线流程按 `z-biz-game-slide15-cos` 那次已验证的做法：建组织仓 → **先** `POST /repos/<r>/pages
{"build_type":"workflow"}`（GITHUB_TOKEN 无权创建 Pages 站点，第一次 push 之后再建就来不及）→
push → 读 Actions 自己打印的行数（绿徽章不是证明）→ 对线上 URL 重跑浏览器门禁。

（本节在部署完成后按实测填写：仓 URL、CI run 与 Deploy run 的结论、Pages 部署产物清单、
以及对 `https://z-biz-game.github.io/pentapack-cos/` 重跑 `@boot/@play/@routes/@save/@pointer` 的
行数与失败数。）

## 已知边界

- 界面只在 8×8 及以下的烘焙匣与生成匣上被真事件验证过。
- `推理深度` 属于那两条被钉住的规则，不是组合学下界；规则一改必须重新烘焙，包里的数才有作者。
- 完成判定依赖"解数 = 1"，这条依赖由 `anomaly` 哨兵与 CI 逐关复证兜住，不是由注释兜住。
- Electron 壳（`electron/main.cjs`）在仓里但未被门禁驱动：门禁驱动的是浏览器版本，
  同一个 `index.html`。
