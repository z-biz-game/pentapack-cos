# 五连块匣 - 交付报告

| 项 | 值 |
| --- | --- |
| **App 名称** | 五连块匣 · PENTAPACK |
| 仓库 | z-biz-game-pentapack-cos |
| 品类 | 益智 · 装箱（pentomino exact cover） |
| 依赖 | 0（`dependencies` 与 `devDependencies` 都是 `{}`，零构建、零二进制资产，由 `tools/check.mjs` 断言） |
| node 断言 | 174 行 / 0 失败（10 个 suite 共 158 行 + 分层自检 16 行；源码里 764 处 `eq/ok` 调用点；`balance --check` 不报 `rows:`，另记 15 格 / 0 breach） |
| 浏览器断言 | 86 行 / 0 失败（`@boot 16 @play 20 @routes 15 @save 15 @pointer 20`），脏 console `(none)` |
| 求解器校订 | 4 个公开锚点全对：3×20=2、4×15=368、5×12=1010、6×10=2339（`nodes` 与耗时见 §实测记录） |
| 内容 | 30 关烘焙（5 档 × 6 关，900 格匣面）+ 每日匣 + 随机匣；每关随包发布 `解数=1` 证明与 `推理深度` 测量 |
| 门禁 | `bash tools/verify.sh` → `=== ALL GREEN ===` / `exit 0`，本机 web 5197 + devtools 9357 的真实 headless Chrome |
| 上线 | <https://z-biz-game.github.io/pentapack-cos/>（200）；CI 与 Deploy 在 `61bd51f` 同 SHA 双绿，日志自打印 160/86 行、fail 0；线上重跑浏览器层 86 行 / fail 0 —— 全部实测见 §发布记录 |

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
test/  anchor board dlx game library logic make pieces rng storage  （10 个 suite）+ fixture.mjs
tools/ bake.mjs proof.mjs check.mjs balance.mjs harness.mjs playtest.mjs verify.sh
.github/workflows/  ci.yml  pages.yml
```

浏览器要下载的全部东西 = `index.html + css/ + js/`：14 个文件、3,515 行；
`js/core/` 2,026 行；测试与台架 4,539 行（比 shipped 还多，这是刻意的）。

## 门禁实跑记录（本机一次真跑，`bash tools/verify.sh`）

```
--- test/anchor.test.mjs   rows: 20 fail: 0     （内含四个公开锚点的真穷举）
--- test/board.test.mjs    rows: 15 fail: 0
--- test/dlx.test.mjs      rows: 12 fail: 0
--- test/game.test.mjs     rows: 23 fail: 0     （步数经济学与拒绝码 + 本轮补的星级四档阶梯）
--- test/library.test.mjs  rows: 27 fail: 0     （30 关逐关从序列化行复证 + 深度黄金表）
--- test/logic.test.mjs    rows: 11 fail: 0
--- test/make.test.mjs     rows: 17 fail: 0     （含本轮补的 DLX 熔断抛错）
--- test/pieces.test.mjs   rows: 15 fail: 0     （63 个 fixed 姿态、D4 群律、两份文档里印的那串）
--- test/rng.test.mjs      rows:  8 fail: 0
--- test/storage.test.mjs  rows: 10 fail: 0     （本轮新建：两条单调性、用时破平局、脏档退化）
--- tools/check.mjs        rows: 16 fail: 0     （分层：无依赖 / core 无 DOM / core 无时钟）
--- tools/balance.mjs --check   15 cells, 0 breaches / balance rc: 0（不报 rows，故不进求和）
=== @boot 16  @play 20  @routes 15  @save 15  @pointer 20   全部 fail: 0
=== console (must be empty of errors) === (none)
chrome exited
=== ALL GREEN ===
VERIFY_RC=0
```

`VERIFY_RC` 是脚本自己的退出码，被写进同一份日志再读回（`bash tools/verify.sh; echo "VERIFY_RC=$?"`），
不信管道尾巴；balance 那一行同理用 `BALANCE_RC` 落在脚本里。

`node tools/proof.mjs`（求解器对公开数字的校订，PROOF_RC=0；毫秒只是本机读数，不进任何断言）：

```
3x20  orbits     2 (published     2) | raw     8 = orbits x 4 | nodes    34783 |    92ms
4x15  orbits   368 (published   368) | raw  1472 = orbits x 4 | nodes   922440 |  2141ms
5x12  orbits  1010 (published  1010) | raw  4040 = orbits x 4 | nodes  2507589 |  6159ms
6x10  orbits  2339 (published  2339) | raw  9356 = orbits x 4 | nodes  4050281 |  9783ms
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

产品缺陷 5 处（1-5），测试自己写错 8 处（6-12、14），空断言 1 处（13），台架与发布脚本缺陷 3 处
（15、17、18），覆盖缺口 1 处（16）。完整的定性过程与依据在 `DESIGN.md` §9；这里是清点。

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
| 16 | `game.js` 文件头指向一个从未存在的 `test/game.test.mjs` | 覆盖缺口 | 补 suite（当时 22 行，本轮 23 行）；并把 `tools/check.mjs` 同时接进本地门禁与 CI unit job（此前只有 `npm test` 跑它） |
| 17 | 本机 `=== ALL GREEN ===` 而 CI 的 browser job 在第一步就废：`mktemp: too few X's in template 'pentapack'` → `--user-data-dir=` 空 → 30 s 后只报 "devtools never bound on :9357" | 台架缺陷（平台差异） | macOS 的 `mktemp -t` 把参数当前缀，GNU 把它当模板且模板必须以 X 结尾。改成 `mktemp -d "${TMPDIR:-/tmp}/$TAG.XXXXXXXX"`（两边都接受，profile 目录仍带车道前缀），并加 exit 7：目录没真建出来就当场退出，不让下一个失败顶着误导性的结论 |
| 18 | 建仓 API 回 201，但 org 上的 About 是一串 `u4e94u8fdeu5323…` | 发布脚本缺陷 | curl 的 config 里 `data = <内联>` 会做反斜杠转义处理：`json.dumps` 先把中文转成 `\u4e94`，curl 再把 `\` 吃掉。改为 `data = "@file"`（curl 原样读文件字节），并对本仓 `PATCH /repos/…` 修回正确的中文描述 |
| 19 | 四把刀砍在**健康**的仓上报绿：K3（DLX 熔断的抛错没有调用方，`capped` 分支永远走不到）、K5/K6（`grade()` 的两条星级分界线无人测）、K11/K12（`best` 只降 / `unlock` 只升只在浏览器层有闸，`npm test` 全绿守不住） | 覆盖缺口 | `solveLevel` 补第三个形参把 `maxNodes` 透传给 `searchCount`（熔断分支从此有调用方）；`game.test.mjs` 补四档阶梯；新建 `test/storage.test.mjs`（10 行）。全部只加闸，没有放宽任何一条 want |
| 20 | 顺着 K11 量出来的真 bug：写入方守卫写的是 `old.moves <= rec.moves`，"同 hand 数、用时更短"这次改进被丢掉 —— `record()` 已算出 `improved: true`，磁盘上还是旧秒数，而面板 `js/main.js:181` 印的正是这一对 | 产品 bug | 守卫改比 `(moves, seconds)` 这一对（`js/core/storage.js`），由 K17 守着。**修的是写入方，不是测试** |
| 21 | README 与 DESIGN 都手抄着 `U8`，十二个数字加起来 67，而同一句话的下一行说合计 63；代码侧的表是对的 | 文档在说谎，且没有闸看得见 | 两处改回 `U4`；`test/pieces.test.mjs` 新增"文档里那串 == 代码里那张表"的等式，文档从此是**被断言的面**。本轮它立刻又咬了一次：重写 README 时把那串包进反引号，正则当场红——改的是文档，不是正则 |
| 22 | `js/core/library.js:12` 的注释引用 `tools/balance.mjs` 并写"每关约 1 ms 实测"，而那个文件**从没在这个仓里存在过**（`git log -- tools/balance.mjs` 为空） | 理由注释没有台架 | 补 `tools/balance.mjs`（15 格 × 300 draws 的生成率扫描 + `--check` 的整数等式）并接进 `npm run verify`，注释里的引用从此是真的；ms 措辞改成"本机读数"，因为没有任何断言比它 |
| 23 | `js/core/make.js` 的 BANDS 窗口注释贴着一段"实测深度直方图"，但那些数没有任何一条命令产出过 | 注释是编的 | 换成 `rawSweep()` 本轮真测的 window-free 直方图（`_tmp-penta-balance-full-r13.log`），并把"平均深度随 k 右移"这条方向性做成 `--check` 每次 CI 都断言的整数比较 |
| 24 | 破坏试验台账第一轮报"K18 与预期不符"：台账进程在跑，同一把刀还在被改（旧 K18 是"删一条断言"，被删的那条本来不参与判定，当然不红） | 台架自欺 | 换成防空转版本（把 `balance --check` 的节点上界收到本轮读数以下 → `14 breach(es)` + 非零 rc）；规矩写进 README §台账：**台账必须跑在树和刀都定稿之后**，本轮的 20 枪因此重跑了一遍（`_tmp-pentapack-sab-run-r14.log`：20 枪 / 0 与预期不符 / `SAB_RC=0`）。同一轮里 N2 那把对照刀以 `ERROR needle count 0` 死过一次 —— 它认的是重写前的旧 README 句子，针打不中就点名，不静默跳过 |
| 25 | README 写着"`balance --check` 挂在 `npm run verify` 的 node 层里，所以 CI 每次都跑它"，而 `472d535` 的 CI 日志里 `balance` 出现 **0 次**：browser job 设 `SKIP_UNIT=1`，verify.sh 把整个 node 层（含 balance）跳过去了 | 承诺没有 CI 覆盖（文档说得比门禁严） | 把它变成 unit job 的 `Generator yield` 一步（本机 0.59 s，加在 Linux runner 上不成负担），并在 README 补一张"哪条命令真的在 CI 里跑"的表：unit 跑什么、browser 跑什么、`proof` 为什么不必单独跑（它的四个锚点由 `anchor.test.mjs` 在 unit job 里真穷举） |：台账进程在跑，同一把刀还在被改（旧 K18 是"删一条断言"，被删的那条本来不参与判定，当然不红） | 台架自欺 | 换成防空转版本（把 `balance --check` 的节点上界收到本轮读数以下 → `14 breach(es)` + 非零 rc）；规矩写进 README §台账：**台账必须跑在树和刀都定稿之后**，本轮的 20 枪因此重跑了一遍 |

另外三处属于"红是因为门禁变严了"，不是回归：console grep 加宽到 `[log:*]`；聚合器由手搓花括号
计数换成 `json.JSONDecoder().raw_decode`（中文文本里嵌套的 `{` 会让前者永不归零，于是整个 suite
**一个判决都不输出**）；端口与兄弟仓专属化（web 5197 / devtools 9357）。

## 发布记录

上线流程按 `z-biz-game-slide15-cos` 那次已验证的做法：建组织仓 → **先** `POST /repos/<r>/pages
{"build_type":"workflow"}`（GITHUB_TOKEN 无权创建 Pages 站点，第一次 push 之后再建就来不及）→
push → 读 Actions 自己打印的行数（绿徽章不是证明）→ 对线上 URL 重跑浏览器门禁。

（2026-09-28 实测。绿徽章不是证明：下面每一条要么是 API/日志里的原文，要么是一条真跑的输出。）

- 远端仓：<https://github.com/z-biz-game/pentapack-cos> —— `visibility public`、`default_branch main`、
  `homepage https://z-biz-game.github.io/pentapack-cos/`。
- 顺序：`POST /orgs/z-biz-game/repos`(201) → **紧接着** `POST /repos/…/pages {"build_type":"workflow"}`(201，
  仓还是空的也接受) → `git push -u origin main`。先 enable 再 push 是省掉抢跑的钥匙：GITHUB_TOKEN
  无权创建 Pages 站点，push 之后再 enable 的话，push 触发的那条 deploy 一定红在 configure-pages 上。
- 作者/committer：两个提交都是 `z-biz-game <bot@z-biz-game.dev>`（per-repo `-c` 设置，不动全局身份）。
- 按 `head_sha` 分组的 run 结论（同一仓的 CI 与 Pages 是两条 run，重跑还会原地改结论，所以不看"最新几条"）：

  | SHA | run | 结论 |
  | --- | --- | --- |
  | `3a40888` | CI 36375043541 | **failure** —— browser job 的 "Headless playtest" 死在 `mktemp: too few X's`，见 §9 第 17 条 |
  | `3a40888` | Deploy 36375043546 | success（站点在第一个 SHA 就发出去了） |
  | `61bd51f` | CI 36375338526 | success（unit + browser 两个 job） |
  | `61bd51f` | Deploy 36375338476 | success（`actions/deploy-pages@v4`，`Created deployment for 61bd51f…`） |

- CI 日志自己打印的数字（Linux runner，`61bd51f`）：unit job 十段合计 **rows 160 / fail 0**；
  browser job `@boot 16 / @play 20 / @routes 15 / @save 15 / @pointer 20`，
  `=== console === (none)`，`chrome exited`，`=== ALL GREEN ===`。**与本机同一套数字**，
  所以那 86 行在 runner 上确实被跑过，不是跳过了才绿的。
- 站点连通：`curl -o /dev/null -w '%{http_code}' https://z-biz-game.github.io/pentapack-cos/`
  连测 6 次（11:53:11–11:53:23）全 **200**。
- 产物清单：`index.html` 引用的两个本地文件（`css/game.css`、`js/main.js`）都 200；
  仓内 `js/` + `css/` 共 **13 个文件逐个对线上取，missing 0** —— 少拷一个的形态就是这里红。
- 线上重跑浏览器层（第三层，只有真站点能给）：
  `BASE_URL=https://z-biz-game.github.io/pentapack-cos/ SKIP_UNIT=1 WEB_PORT=5199 CDP_PORT=9359 bash tools/verify.sh`
  → 86 行 / fail 0 / console `(none)` / chrome exited / **exit 0**。
- 顺手修的一处发布脚本缺陷：建仓时 `description` 到达 org 上是 `u4e94u8fdeu5323…`（§9 第 18 条），
  已 `PATCH /repos/…` 写回正确的中文；脚本改为 `data = "@file"`，下一仓不再重演。

## 已知边界

- 界面只在 8×8 及以下的烘焙匣与生成匣上被真事件验证过。
- `推理深度` 属于那两条被钉住的规则，不是组合学下界；规则一改必须重新烘焙，包里的数才有作者。
- 完成判定依赖"解数 = 1"，这条依赖由 `anomaly` 哨兵与 CI 逐关复证兜住，不是由注释兜住。
- Electron 壳（`electron/main.cjs`）在仓里但未被门禁驱动：门禁驱动的是浏览器版本，
  同一个 `index.html`。
