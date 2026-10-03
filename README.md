# 五连块匣 · PENTAPACK

把五连块填进一只匣子，一格不留。零依赖、零构建：浏览器加载的就是仓库里的文件。

十二块的形状就是数据，玩法画面全部由 canvas 从几何画出来，**一块精灵图都不需要**。仓库里确实有图片：
十张图标、一张社交卡片、两块粒子贴图、一块毛毡纹理，共 14 张 PNG —— 它们由 `assets/gen/gen_art.py` 生成，
`tools/check.mjs` 逐个读 IHDR、按 sha256 对回生成器清单、再自己数一遍像素的颜色数，
所以"有图"与"图是占位的"都过不了闸。

在线：<https://z-biz-game.github.io/pentapack-cos/>　本地：`npm run dev` → <http://127.0.0.1:5197/>

这个仓的主张只有一句：**每一关的"只有解"是证明出来的，难度是量出来的，玩家看到的每个数字都能被机器复算。**
下面先写玩什么、怎么算合法，再写"难"这个字在这里的确切含义，最后写门禁本轮的实跑读数，
以及一把刀一刀砍在哪些字段上、哪些砍不动。

---

## 玩法

一块 `8×8` 的框，框里被 `mask` 挑出来的格子构成**匣**（不规则形状，面积恰好 `5k`）。
待置区里有 `k` 块五连块。把它们全部放进匣里，一格不留、一格不压。

屏幕左边是画布（匣 + 待置区），右边是读数面板和操作按钮，下面一块色对照条，再下面是匣阵抽屉。
面板上那六行是照抄数据的（`js/main.js:188-193`），没有一个数字是估的：

| 面板字段 | 印的是什么 | 从哪来 |
| --- | --- | --- |
| 块数 | `k`，单位"片五连块" | 关卡的 `pieces` 长度 |
| 解数 | `1`，后缀"已证明" | 烘焙时 DLX 穷举的结果（不是"我以为只有一个"） |
| 推理深度 | 一个整数，单位**假设框** | 两规则求解器实际进入过的最深假设层（`js/core/logic.js`） |
| 操作数 | 你走了几步，后缀"下限 k · 超 n" | `game.moves`，下界是 `k` |
| 用时 | 秒 | 外壳的计时器，不参与任何判定 |
| 最佳 | 历史最少步数 · 那次的用时 | `localStorage`，只降不升 |

### 操作

| 操作 | 效果 | 代价 |
| --- | --- | --- |
| 从待置区拖进匣子 | 放下那块 | 1 步 |
| 把已放下的块拖去别处 | 挪过去 | 1 步 |
| 把已放下的块拖回待置区 | 取回 | 1 步 |
| 双击匣上的块 | 原地顺时针转 90°；转过去会压叠就不转 | 0 步 |
| 右键 / 长按 480 ms | 镜像 | 0 步 |
| 原地按下再松开 | 什么都不做（`place` 报 `noop`） | 0 步 |
| 压叠 / 出框 / 落在匣外的落子 | 弹回原处（回位动画 200 ms） | **0 步** |
| `f` | 镜像最后动过的那块 | 0 步 |
| `u` / `h` / `r` | 撤销 / 提示 / 倒回本匣 | 提示 0 步 |
| `Esc` | 收起通关卡片 | — |

按钮：撤销、上一匣、提示、倒回、分享、再来一次、下一匣、清空存档（要按两次）。

`k` 块全部落下且与随包发布的那条解答一致 → 卡片上来，按 `操作数 - k` 评星。
**提示是查表不是搜索**：它读的是那条烘焙解答（`hintFor()`），所以它永远不与证明打架；
它只说"哪一块去哪一格"，两种情形分别叫 `in-tray`（还没上板）和 `misplaced`（位置不对）。

### 三种内容，同一套规则

```
#/                     匣阵第一关          #/lot/iron-03      指定关卡
#/daily                今天那一关          #/daily/2026-03-04 指定日期
#/random/<seed>        无尽匣              #/random/<seed>?band=hard  固定档位
```

匣阵 30 关 = 5 档 × 6 关。每日匣的种子就是日历键，所以同一日期在任何设备上是同一个盘面，
档位按年在五档之间轮转。随机匣由链接里的 seed 决定 —— 生成发生在点开的瞬间，代价在下面 §难点 里量着。

---

## 规则

一条一条来，每条都指出是哪个文件说了算。

1. **匣是框内被挑出的格子集合。** `mask` 是 64 个 `0/1`；被挑出的格必须四连通，且总数恰为 `5k`
   （`js/core/board.js:validateLevel`）。面积不对、形状不连通、块数不符，都在这里被拒。
2. **块就是那十二块五连块里的 `k` 块**，一关内不重复。每块可以用它的任意姿态：
   逐块姿态数 F8 I2 L8 P8 N8 T4 U4 V4 W4 X1 Y8 Z4，合计 **63** 个 fixed pentomino。
   这张表由 `test/pieces.test.mjs` 双向钉住：代码里的表要等于手抄的黄金值，两份文档里印的串
   也要等于代码里的表（这条本轮新加，之前 README 和 DESIGN 都写着 `U8`，十二个数字加起来 67，
   而同一句话的下一行说合计 63）。
3. **一次落子合法，当且仅当**这块的五个格子全部落在匣内、且不与别的块重叠。三种拒绝各有各的名字：

   | 码 | 情形 | 界面说法（`BOUNCE` 的原句） |
   | --- | --- | --- |
   | `out` | 伸出 8×8 边框 | 放下会超出边框 |
   | `off` | 在框内、但落在匣外 | 放下会落在匣子外 |
   | `overlap` | 压住别的块 | 放下会压住别的块 |

   三个名字在一处定义（`game.js:BOUNCE`），视图、提示文案、`@pointer` 断言都从那里取，
   所以不会出现第四种说法。**被拒绝的落子不计步**，这是步数经济学的一部分，不是宽容。
4. **锚点是这块包围盒的左上角，那一格里可能没有块。** 例如 V 的某个姿态，锚点本身不被覆盖，
   `pieceAt(锚点)` 读出来是空的。这不是 bug，是抓取几何的定义（DESIGN §2.5、§7）。
5. **步数是一个经济学**：落子 1、取回 1、挪动已上的块 1、旋转 0、镜像 0、被拒绝 0、原地重按 0。
   于是每一关的最少步数**恰好等于 k**，`操作数 - k` 就是"浪费了多少"。
6. **星级只看那条线**：`over = 操作数 - k`；`over = 0` → ★★★ 一次到位，
   `over = 1..2` → ★★ 干净装箱，`over ≥ 3` → ★ 反复挪动。
7. **匣满即锁**：`done` 之后 `place` 与 `takeBack` 一律返回 `code:'done'` 且不记账。
   所以"浪费"必须发生在最后那块落下之前。
8. **填满不等于完成。** 匣满之后把玩家的位置与随包发布的那条解答比对（`samePlacements`）：
   一致才算过；不一致 → `anomaly = 'second-solution'`，界面写"异常：出现了第二条解"，**不发星**。
   这条不是装饰：在"解数 = 1"已经被证明的前提下，"填满"与"等于那条解"是等价的，
   所以真出现第二种满盘就意味着我们的证明错了 —— `anomaly` 是这条依赖的哨兵。
9. **解锁只升不降，成绩只降不升**，两条都写在唯一写入方 `js/core/storage.js` 里，
   不在调用方各写一遍。同 hand 数下更快的用时算改进（本轮补的，见 §破坏试验 K17）。

---

## 难点：这个"难"字在这里的确切含义

### 为什么"填满"是一件难事

十二块五连块铺满一个矩形是经典的精确覆盖问题。铺法数量本身就在暴涨（`node tools/proof.mjs`，本轮实测）：

| 矩形 | 本质不同铺法（取矩形对称的商） | 公开值 | DLX 展开节点 |
| --- | --- | --- | --- |
| 3×20 | 2 | 2 | 34,783 |
| 4×15 | 368 | 368 | 922,440 |
| 5×12 | 1010 | 1010 | 2,507,589 |
| 6×10 | 2339 | 2339 | 4,050,281 |

`raw = 商 × 4` 是被断言的关系而不是巧合（矩形自身的旋转与镜像把每条本质铺法展开成 4 条固定铺法）。
这四行由 `test/anchor.test.mjs` 在 CI 里跑**真搜索**复算。也就是说：**在一个满盘里找出"那一种"铺法，
本身就要走几百万个搜索节点**。游戏的难，难在这棵树的存在；游戏的可信用，信用在它被数过。

### 难度量纲：推理深度，单位"假设框"

`js/core/logic.js` 只用两条推理规则：

- **R1** 某一格只剩一个还能盖住它的块 —— 定；
- **R2** 某个块只剩一个还放得下的位置 —— 定。

两条都不起作用而匣子没满时，求解器必须**猜**：取候选最少的空格（并列取低格号），假设一种铺法，
递归一层。**`推理深度` = 它为收完工真正进入过的最深假设层数**，0 表示这两条规则就推到底 ——
那是一次唯一性的**证明**，不是一个评级。

**诚实条款（这是本仓最重要的一段话）**：这个数属于上面这对规则，不属于谜题本身。
加第三条规则（"若这块放这里，X 格就无解了"），全屋的数都会掉。规则集带版本号
（`RULE_SET_VERSION = 1`）写在代码里、由 `test/logic.test.mjs` 钉住、并被 `test/library.test.mjs`
逐行盖在数据上。**规则一改，关卡必须重新烘焙**，因为包里每个深度数字都是关于这套规则的陈述。

### 难度是怎么分布的（本轮实测，决定性种子，任何机器可复算）

`node tools/balance.mjs` 把每个 (块数 k, 邻接偏置 bias) 格子跑 300 次独立的"一次装箱"，
并把深度窗口开到无限大 —— 所以下面这张表是**未被档位窗口过滤过的原始分布**，
也就是 `BANDS` 那五个窗口当初是照着什么选的（bias 2 那一列）：

| k | 唯一解盘数 / 300 | 实测推理深度分布（深度:盘数） |
| --- | --- | --- |
| 4 | 269 | 0:111 1:95 2:50 3:13 |
| 5 | 256 | 0:65 1:75 2:69 3:35 4:12 |
| 6 | 240 | 0:20 1:34 2:63 3:73 4:44 5:6 |
| 7 | 223 | 0:1 1:4 2:20 3:61 4:74 5:57 6:6 |
| 8 | 172 | 0:1 1:2 2:6 3:25 4:62 5:53 6:20 7:3 |

`8×8` 散框上深度真的铺满 0..7，且随 k 右移 —— 这句话在 `--check` 里是**逐 bias 断言的整数事实**，
不是抄在这段注释里的数。已出货的 30 关实测深度（按关卡序，`js/data/lots.js` 现算）：

| 档位 | 名称 | 块数 k | 深度窗口 | 这 6 关实测深度 | 全战役深度和 |
| --- | --- | --- | --- | --- | --- |
| taster | 上手匣 | 4 | 0–1 | 1,1,0,1,1,0 | 86 |
| easy | 常匣 | 5 | 1–3 | 2,2,2,2,1,2 | |
| mid | 中匣 | 6 | 2–4 | 3,4,3,2,3,4 | |
| hard | 硬匣 | 7 | 3–5 | 3,4,3,5,3,4 | |
| iron | 铁匣 | 8 | 4–7 | 4,5,6,4,7,4 | |

这 30 行序列现在被 `test/library.test.mjs` 当作**字面黄金值**钉住（本轮新加）：
重新烘焙如果让曲线变平，构建会红，而不是让某个玩家慢慢发现"铁匣和常匣一个感觉"。

### 玩家侧的难点在哪

- **手性**：`F L P N Y Z` 六块的镜像不能靠旋转得到，只能镜像（0 步，但得想起来）；
- **锚点空位**：抓的位置不等于块的位置（V、W、Y 的姿态经常这样）；
- **原地转不过去**：已上的块旋转后与邻块冲突就不转（`blocked`），得先挪开 —— 那就是 2 步；
- **一格都不许剩**：面积恒等式 `5k = 匣格数` 意味着任何一处错位都会在最后暴露，没有"差不多填满"。

---

## 生成流水线：四道闸

`tools/bake.mjs` 出货一关要走四道，任何一道对不上就 `throw`，全绿才写 `js/data/lots.js`：

1. **装箱构造**：在 8×8 框上带邻接偏置地逐块装箱，每次落块必须与已落的边相邻 —— 天生有解；
2. **DLX 后验**：`solveLevel(spec, 2)` 穷举到第二条解为止，**只留解数恰好为 1 的**；
3. **深度进窗**：用两规则求解器量深度，不在本档窗口内就丢；
4. **读回来再证一遍**：把序列化后的那一行重新解析、重新证明。

第四道是关键：它让"发布出去的数被验证过"这句话，说的是**发布出去的那几个字节**。
同一套复证跑在 CI 里（`test/library.test.mjs` 逐行：合法 → 解数 1 → 深度等于印着的数 →
档位就是那两个测量值所属的档），所以手改 `js/data/lots.js` 里任何一个 `depth`/`mask`/`solution`
都会把构建弄红（本轮 K10 砍在 `depth` 上，红了两条用例）。

另外两条会说话的分支：装箱那一步的落点**必须就是**那条唯一解（不是就抛错）；
DLX **数不完就说数不完**（撞熔断是抛错，不是"当成不唯一"悄悄丢盘）。
前者的刀砍不动任何用例 —— 因为 `解数 == 1` 已经蕴含它，它是把矛盾说出口，不是指望被触发；
后者本轮从"没有任何调用方能走到"改成了可注入的 `maxNodes`，于是它有了用例（K3）。

---

## 门禁清单（本轮 2026-09-30 实跑读数）

两层。**node 层 181 行 / 0 失败**（每条命令的退出码都写进日志再读回，不信管道尾巴）：

| 套件 | rows | 钉住的东西 |
| --- | --- | --- |
| `anchor.test.mjs` | 20 | 四行公开锚点走真搜索复算；`raw = 商 × 4`；不是十二块就复现不出表 |
| `board.test.mjs` | 15 | 行主序帧算术、mask 文本可逆、面积恒等式、九个非法 fixture 各被它写来的那条规则拒 |
| `dlx.test.mjs` | 12 | 矩阵就是棋盘、cover/uncover 字节级互逆、limit 截断不造不丢、熔断报成 `capped` 而不是报成数 |
| `game.test.mjs` | 23 | 步数经济学逐个分支、三个拒绝码、匣满即锁、`over` 的四档阶梯（本轮 +1） |
| `library.test.mjs` | 27 | 30 行从磁盘字节复证、路由三形态、每日只由日历键决定、深度序列的字面黄金表（本轮 +1） |
| `logic.test.mjs` | 11 | 规则对恰好两条、深度 0 是证明、两求解器在每个唯一盘上 agree、帧数上限会说出口 |
| `make.test.mjs` | 17 | 同 seed 同盘、出货盘全部合法+连通+唯一+在窗、记账等式、DLX 熔断抛错（本轮 +1） |
| `pieces.test.mjs` | 15 | 十二块互不重复、逐块姿态数、63、D₄ 群律、轨道-稳定子、**文档里印的那串**（本轮 +1） |
| `rng.test.mjs` | 8 | hashSeed 逐向量对外部实现、mulberry32 复现公开流、`todayKey` 拒读时钟 |
| `storage.test.mjs` | 10 | **本轮新建**：两条单调性、用时破平局、脏字段消毒、坏档退化、两次点击清档 |
| `tools/check.mjs` | 23 | 四条分层不变量（`js/core` 无 DOM/无时钟/无 `Math.random`、零依赖）+ 资产层两头闭合（IHDR、sha256 对回生成器、像素自己数）+ 数据只走一道门 + 无幽灵导出 |
| `tools/doctest.mjs` | 207 | **本轮新建，第六道闸**：本文档与 DESIGN 里每个能重算的数都对代码或现跑重算，并自钉自己的组数与项数（那一行行数由它文件头的钉值背书，改一处必红另一处） |

`rows` 是断言条数，不是"性质个数"；上面那 11 行里前 10 行相加 158、加 `check.mjs` 23 = 181，
就是本段标题那个"node 层 181 行"。最后一行 `doctest.mjs` 不在那 181 里：它数的是自己那份
钉值（`EXPECT_ROWS`），跟在这 11 行后面会把两个口径混成一个数。

**生成率台架** `node tools/balance.mjs --check`：**15 格 / 0 breach**（本轮 GATE_RC=0，本机 0.57 s）。
它断言的是纯整数：两条记账等式逐格成立、每一档在每个 bias 上都可达、
平均测量深度随 k 严格右移、没有任何一格摸到 DLX 节点上限或推理帧上限、
同一批种子重跑一遍直方图逐字相同。
它现在是 CI unit job 的 `Generator yield` 一步 —— 见下面那张"哪条命令真的在 CI 里跑"。

**公开锚点** `node tools/proof.mjs`：`anchors: 4 fail: 0`（PROOF_RC=0），上表那四行就是它的输出。

**浏览器层** `bash tools/verify.sh`（真实 headless Chrome，CDP 派发真实 `Input.dispatchMouseEvent`）：

```
@boot 16  @play 20  @routes 15  @save 15  @pointer 20      合计 86 行 / 0 失败
node 层同一次跑：181 行 / 0 失败（10 个套件 158 行 + tools/check.mjs 23 行）
console: (none)      chrome exited      === ALL GREEN ===
```

`balance --check` 不打印 `rows:`，所以它不进上面任何一个求和；它自己报"15 格 / 0 breach"。

`@pointer` 是这里最贵的一段：它不看内部变量，只看面板和棋盘，把一条认证解答从头点到装完；
`@save` 验的是真 `localStorage` 落盘（含"两次点击才清空"和脏字段退化）。
两层合计 **267 行断言 / 0 失败**。

**哪条命令真的在 CI 里跑**（本轮查出来的缺口就在这张表里）：

| 门禁 | unit job | browser job |
| --- | --- | --- |
| `node --check` 全树 / `tools/check.mjs` / `tools/doctest.mjs` / 10 个套件 | 跑 | 跳过（`SKIP_UNIT=1` 跳过 verify 的整个 node 层） |
| `tools/verify.sh` 的五个浏览器场景 + console + Chrome 退出 | 不跑 | 跑 |
| `tools/balance.mjs --check` | **本轮之前哪里都不跑** —— 只在 `verify.sh` 的 node 层里，而 browser job 把那一层整段跳过。现已是 unit job 的 `Generator yield` 一步 | 不跑 |
| `tools/proof.mjs` | 不单独跑（四个锚点的真穷举在 `anchor.test.mjs` 里，unit job 跑的是它） | 不跑 |

`472d535` 那次的 unit job 打印了 `rows:` 16 / 20 / 15 / 12 / 23 / 27 / 11 / 17 / 15 / 8 / 10
= **174 行 / fail 0**，但没有 `balance` —— 那一格当时只在开发机上跑。补上之后的 `cdf58d8`
（Linux runner，日志原文，不是徽章）：unit job 现在是 16 → `balance --check: 15 cells, 0 breaches`
→ 20/15/12/23/27/11/17/15/8/10，browser job `=== ALL GREEN ===`、
`@boot 16 @play 20 @routes 15 @save 15 @pointer 20`。CI 与 Deploy 都在该 SHA 上 success。
第四层是对**已上线站点**重跑浏览器层（`BASE_URL=https://z-biz-game.github.io/pentapack-cos/
SKIP_UNIT=1 WEB_PORT=5199 CDP_PORT=9359 bash tools/verify.sh`）：86 行 / fail 0 /
console `(none)` / `LIVE_RC=0`；根 URL 连测 6 次全 200，四个真实资产逐个 200，
一个故意不存在的路径回 404。

---

## 承诺表

一句承诺 → 哪条命令真的会因为它红 → 比的是什么 → 本轮读数。

| 承诺 | 谁让它红 | 比的是什么 | 本轮读数 |
| --- | --- | --- | --- |
| 每关解数恰好为 1 | `test/library.test.mjs` 逐行 DLX | 磁盘那行字节重新穷举到第 2 条解 | 30/30 行复证通过 |
| 出货深度是量出来的 | `test/logic.test.mjs` + `library` 复证 + 新黄金表 | 现测深度 vs 文件里印的数 vs 字面序列 | 全战役深度和 86 |
| 档位是查出来的不是贴的 | `test/make.test.mjs:bandName` | 手抄黄金点值 + 窗口两两不相交 | 5 档窗口，K4 会红 |
| 落子/取回/挪动各 1 步，旋转镜像与被拒 0 步 | `test/game.test.mjs` | 逐个分支的 `moves` 增量 | K7/K8 各红一条 |
| 星级线在 over=0 与 over=2 | `test/game.test.mjs`（本轮补） | `grade()` 的四档阶梯逐格 | K5/K6 从绿转红 |
| 满了不等于完成 | `game.test.mjs` + 浏览器 `@play` | 换掉解答后装满，必须报 `anomaly` | K9 红 |
| best 只降、unlock 只升、用时能破平局 | `test/storage.test.mjs`（本轮新建） | 写入方的单调守卫 | K11/K12/K17 从绿转红 |
| 每日匣只由日历键决定 | `library.test.mjs` | 不同日期不同盘 + 档位按年走 | K13 红 |
| 随机匣由链接 seed 决定 | `library.test.mjs` + `rng.test.mjs` | 外部实现的哈希向量 + 重跑一致 | K14 红 |
| 63 个姿态、D₄ 群律 | `pieces.test.mjs` | 代码表 = 手抄黄金 = 两份文档里印的那串 | K16 红（文档刀） |
| 公开锚点表 | `proof.mjs` + `anchor.test.mjs` | 与文献数字逐个等值 | 4 锚点 fail 0 |
| 每档在每个偏置上都生成得出来 | `tools/balance.mjs --check`（本轮新建，且是 CI unit job 的一步） | 记账等式 + 可达性 + 方向性 + 可复现 | 15 格 0 breach，K18 红 |
| 零依赖 / 分层不可越界 / 资产两头闭合 | `tools/check.mjs` | `package.json` 两个字段 + 全树 import/时钟/DOM 扫描 + 每张 PNG 的 IHDR、sha256 与像素 | 23 行 fail 0 |
| 文档里印的每个现值等于代码的现在值 | `tools/doctest.mjs`（本轮新建） | 代码/现跑为基准，逐个等式对文档那张表；解析不到就红 | 见下 |

---

## 破坏试验台账

台架在**仓外副本**上跑（`_tmp-pentapack-copy/`，真仓一个字节不动），一次只改一个字段，
needle 在目标文件里必须恰好出现 1 次（对不上就报 `ERROR`，不静默跳过）。它有**两条腿**，每把刀跑自己那条：

- **suites 腿**：10 个 `test/*.test.mjs` + `tools/check.mjs` + `balance --check`，收集 `FAIL` 行；
- **doctest 腿**（第六道闸上线时新添）：只跑 `node tools/doctest.mjs`，且"rc 非 0"不算过 ——
  `FAIL` 行里必须出现这把刀**点名**的那一条编号，红在隔壁等于这条承诺没人守（记 `NOT-NAMED`，不计入通过）。

结局五类：**红** / **不红** / **抛死（THROW）** / **被打断（ENV）** / **ERROR**。THROW 是这轮新认的一类：闸一行断言都没发就死了，
因为刀撞上的是一道**比第六道闸更早**的闸（DK3b，见表格下面）。ENV 是同一件事的另一半：现跑被机器占满时
被掐断的闸会少发断言，那种"红"不是刀咬出来的。
**37 枪 / 与预期不符 0 / `SAB_RC=0`**（`_tmp-pentapack-sab-run-r18.log`；两条腿各跑什么、几个套件，
由台架在运行开头自己打印，那两句也在日志里，所以这里的套件数不是手抄的）。
对照的是补闸前那一轮（`-r11`，17 枪 / 与预期不符 3）：K3、K5、K6、K11、K12 五枪当时是绿的，
那五处就是本轮找到的缺口；K17、K18 是补完之后新添的刀，一枪咬产品、一枪咬台架自己。
同一轮里 K15 从"期望红"改判成"不该红"，理由是那条断言本来就是自比 —— 依据写在下面。

| 刀 | 改哪里 | 预期 | 结果 | 谁咬住 |
| --- | --- | --- | --- | --- |
| K1 | `make.js` 解数判据 `!== 1` → `!== 2` | 红 | 红 | library + make |
| K2 | 关掉"装箱落点必须就是唯一解"的抛错 | **不该红** | 不红 | 逻辑上到不了的状态，见 §四道闸 |
| K3 | 关掉 DLX 熔断抛错 | 红 | 红（补闸前绿） | `make.test.mjs` 新增的 `maxNodes` 用例 |
| K4 | `BANDS.iron` 深度窗口 `[4,7]` → `[0,9]` | 红 | 红 | make + logic |
| K5 | 两星上界 `over <= 2` → `<= 3` | 红 | 红（补闸前绿） | `game.test.mjs` 新增的四档阶梯 |
| K6 | 三星线 `over <= 0` → `<= 1` | 红 | 红（补闸前绿） | 同上 |
| K7 | 旋转/镜像改成计 1 步 | 红 | 红 | `game.test.mjs` |
| K8 | 关掉"原地重按 = noop" | 红 | 红 | `game.test.mjs` |
| K9 | 完成判定无条件 `done`、吞掉 `anomaly` | 红 | 红 | `game.test.mjs` |
| K10 | 手改 `lots.js` 里一个 `depth` | 红 | 红 | library 复证 + logic |
| K11 | 拆掉 best 的单调守卫 | 红 | 红（补闸前绿） | `storage.test.mjs`（本轮新建） |
| K12 | `unlock` 的 `Math.max` → `Math.min` | 红 | 红（补闸前绿） | `storage.test.mjs` |
| K13 | 每日匣的 `dayOfYear` 变成常量 | 红 | 红 | `library.test.mjs` |
| K14 | `hashSeed` 少混高字节那一路 | 红 | 红 | `rng.test.mjs` |
| K15 | 把 `stats().mislabelled` 的推导改成自比 | **不该红** | 不红 | 见下面那段说明 |
| K16 | 把 README 里的 `U4` 改回 `U8` | 红 | 红 | `pieces.test.mjs` 的文档等式（本轮新建） |
| K17 | 去掉用时的破平局比较 | 红 | 红 | `storage.test.mjs` |
| K18 | 把 `balance --check` 的节点上界收到 10 | 红 | 红 | 台架自己的非零 rc（防空转） |
| DK1 | `main.js` 面板「块数」那格的第三种「片五连块」→「片六连块」 | 红 | 红 | D1f |
| DK2 | `game.js` 的 out 文案末尾多一个字 | 红 | 红 | D2c |
| DK3 | README 那串姿态数把 `X1` 抄成 `X2`（DESIGN 那串不动） | 红 | 红 | D3b |
| DK3b | `pieces.js` 的表把 X 的 1 改成 2 | **抛死** | 抛死 | pieces.js 的 import 期自检，第六道闸一行都没跑到 |
| DK4 | `proof.mjs` 的注释改回"anchor 调用它"那句谎 | 红 | 红 | D4m |
| DK5 | `balance.mjs` 全扫的 `DRAWS` 默认 300 → 250 | 红 | 红 | D5e |
| DK6 | `make.js` 档位表 mid 的名字「中匣」→「中盒」 | 红 | 红 | D6c |
| DK7 | `library.js` 空 hash 的落点 `ALL[0]` → `ALL[1]` | 红 | 红 | D7j |
| DK8 | `harness.mjs` 的行数打印改成 `rowcount N bad M` | 红 | 红 | D8b |
| DK9 | `bake.mjs` 四道闸的编号 `3.` → `3x.` | 红 | 红 | D9e |
| DK10 | `game.js` 头部插一行注释（把下面所有行号顶一格） | 红 | 红 | D10d |
| DK11 | `logic.js` 的 `RULE_SET_VERSION` 1 → 2 | 红 | 红 | D11a |
| DK12 | `package.json` 的 doctest 指到 `tools/doctestx.mjs` | 红 | 红 | D12a |
| DK13 | `server.cjs` 的默认端口 5197 → 5198 | 红 | 红 | D13f |
| DK14 | 把 U7 那条读数形状的正则改坏（`\d+ +@play` → `\d+ @@play`） | 红 | 红 | D14 |
| DK15 | 把闸自己钉的组数 `EXPECT_GROUPS` 15 → 16 | 红 | 红 | D15a |
| N1 | 改 `css/game.css` 的 `--bg` 色号 | 红 | 红 | `tools/check.mjs:125-128` 与 `tools/check.mjs:303`：meta theme-color、manifest `theme_color` 都拿 `--bg` 当基准 |
| N3 | 改一个没人读的色号 `--brass-dim` | 不该红 | 不红 | —（全仓 grep 过 `tools/`、`test/`、`js/`、`*.html`，没有一处闸读它） |
| N2 | 在 README 第 14 行那句散文后面加一句 | 不该红 | 不红 | —（本轮它先以 `ERROR needle count 0` 死过一次：重写 README 把旧句换了字，刀认的是原句。这就是台架自己的漂移探测） |

**两把"应当不红"的刀不是偷懒**，它们说明这条线为什么成立：

- K2 砍的是 `if (!sameSet(baked, verdict.placements)) throw`。`解数 == 1` 已经蕴含"构造那条就是它"，
  所以没有任何用例能走到这个分支。它的价值是把矛盾说出口，不是指望被触发。
- K15 砍的是 `stats()` 里 `bandName(lot.k, lot.depth)` 的调用（换成直接 echo 存的档位）。
  `mislabelled` 因此永远等于 0，而它自己是一个**派生视图**，对它做断言是自比。
  真正的闸在两处别的地方：`bandName` 被 `test/make.test.mjs` 用字面点值钉住（K4 就是在那儿咬的），
  出货数据的 (档位, 深度) 配对被 `library.test.mjs` 的逐行复证钉住。
  本轮另加了一条字面黄金序列（30 关的深度序列），所以曲线整体被抹平也会红。

**K5/K6/K11/K12 是本轮的真收获**，四把绿刀背后是四个真实缺陷：
1. `grade()` 的两条星级分界线谁都没测过 —— 真实对局里只能落在 `over = 0` 和 `over = 2`
   （匣满即锁，浪费必须发生在最后一块落下之前），所以中间那几格从来没被走过；
2. `storage.js` 的头部注释从第一个 commit 起就写着"和 `test/storage.test.mjs` 比对口径"，
   **那个文件不存在**，于是 `best` 只降、`unlock` 只升这两条只在浏览器层有闸，`npm test` 全绿也守不住；
3. 顺着这条线量出来的真 bug：写入方的单调守卫写的是 `old.moves <= rec.moves`，
   于是"同样步数、用时更短"这次改进被丢掉了 —— `record()` 已经算出 `improved: true`，
   磁盘上却还是旧的用时，而面板 `js/main.js:181` 印的正是 `${best.moves} 步 · ${best.seconds}s`。
   现在守卫比较 `(moves, seconds)` 这一对，并由 K17 守着。

另有六处是**台账自己**教的，不是产品缺陷，但同一条规矩：

1. K18 第一轮报了绿。刀没问题，是台架在跑、刀还在被改：那一轮（`-r12`）读到的是旧的 K18
   ——删一条断言的刀，在被删的那条断言本来就不参与判定时当然不红。补成"把上界收到本轮读数以下"
   之后，同一个位置报红，`balance --check: 14 breach(es)` + 非零 rc。**台账必须跑在树和刀都定稿之后**。
2. 重写 README 时把姿态数那串包进了反引号，`test/pieces.test.mjs` 的文档等式当场红（正则只吃空白
   分隔的 `F8 …`）。而上一份门禁日志里 pieces 还是 15/0 —— 因为 node 层在那次改写**之前**就跑完了。
   日志说的是它跑的那一刻的树，不是现在这棵树。所以这一版 README 的每一行读数都出自
   `_tmp-penta-verify-r17.log`（含 `VERIFY_RC=0` 与 `doctest rc: 0 / rows: 207 fail: 0` 那几行），
   改完文档的树重跑了一遍才算数。
3. **子集开关会把闸点成零断言然后退 0**。试点 DK1/DK14 时两把都报"绿"，日志只有 636 字节：
   台架把它的 `ONLY` 传进了子进程，而 `tools/doctest.mjs` 自己也认 `ONLY`（点名的组才跑）——
   于是闸以为有人让它只跑 `DK1,DK14` 这两组，一组都不存在，0 条断言、rc 0。修法两头各一半：
   台架的开关改名 `KNIVES`/`SAB_ONLY`，闸加了"点名的组没发声就红"（`FAIL ONLY 点名了没有发声的组`，
   实测 `DEADONLY_RC=1`）。**任何"绿色来得比闸的已知代价快"的读数都先当空转查**。
4. **suites 腿从前不跑 `tools/check.mjs`**（r11/r14 的循环里只有 `test/*.test.mjs`），
   所以 N1「改 CSS 色号不该红」从来不红 —— 它不是被证成的，是没被读过。把 check.mjs 收进同一条腿，
   N1 当场变红：`--bg` 是 meta theme-color 与 manifest `theme_color` 的比对基准。
   这条刀因此改判"红"，而阴性对照挪到 N3（一个没有任何闸读的色号）。
   **审计口径比被审对象窄时，"不该红"是台账的谎，不是产品的性质。**
5. **台账的 rc 从前不看"与预期不符"**：r16 那轮打出 `35 枪 / 与预期不符 2`，却还是 `SAB_RC=0`
   （只有 needle 打不中才退 2）。它对自己用了它一直在别人闸上找的那个毛病。现在 `与预期不符 > 0`
   退 1，并配阳性对照 `SAB_SELFTEST=mismatch`（把第一把刀的期望取反）：实测 `1 枪 / 与预期不符 1 / rc=1`。
   同一轮里 DK3 从代码侧改姿态数表，报的是 `NOT-NAMED` —— 那不是闸漏了，是 `js/core/pieces.js:135-148`
   的 import 期自检先抛，闸一行断言都没发；台账为此新增第四类结局 THROW，DK3 拆成文档侧（DK3）与
   代码侧（DK3b）两把，各自证明一件事。
6. **r17 的 DK6 报 `NOT-NAMED`，那把刀没问题，是这台机器当时被占满**。它要求点名
   `D4c tools/proof.mjs 的输出解析到 4 行`，而被打断的那次现跑只解析到 **3** 行（`proof` 的 180 s 超时被
   抢占，D4 后面几条走 `if (!g) continue` 少发）。这不是猜测：在副本里把那一个超时手工改成 3000 ms
   就能稳定复现，`node tools/doctest.mjs` 打出 `rows: 197 fail: 8`、`pin: … rows=207`（D4 实发 21 / 钉 31），
   8 条红分别是 D4c、D4d×2、D4j、D4k 与 D15b/D15c/D15e 那三条自钉（`_tmp-penta-env-probe.log`）。
   同一条 D4c 在 r17 报的是 3 行、在复现里报的是 2 行 —— 少几条由负载决定，这就更不是刀能选的东西。
   所以台账新增第五类结局 **ENV**（闸实发的项数 ≠ 它自己钉的项数）：命中的刀重跑一次，两次都留证据
   （`fails_all` 与 `raw_tail` 都写进日志），判"与预期不符"要两次都不对才算。**一把刀的红必须来自那把刀，
   不能来自我同时跑的别的东西 —— 也正因为如此，跑台账的时候我不在这台机器上并行跑别的闸。**

---

## package.json 脚本

```
npm run dev      node server.cjs 5197            # 本地开玩
npm test         check + doctest + 10 个 node 套件
npm run verify   bash tools/verify.sh            # 全套：node 层 + 真实 headless Chrome
npm run proof    node tools/proof.mjs            # 公开锚点表（本轮四行真搜索合计 18.0 s，本机读数）
npm run balance  node tools/balance.mjs          # 生成率全扫描（300 draws/格，本轮实测 2.3 s）
npm run bake     node tools/bake.mjs             # 重新出题+复证+写 lots.js（会覆盖数据文件）
npm run check    node tools/check.mjs            # 分层与资产自检 23 行
npm run doctest  node tools/doctest.mjs          # 文档数字闸：本文档与 DESIGN 里每个现值都对代码重算
npm run unit     逐个跑 test/*.test.mjs
npm run electron electron .                      # 桌面壳（本仓不装 electron，没跑过真实启动）
```

`dependencies` 与 `devDependencies` 都是 `{}`，由 `tools/check.mjs` 断言 —— 这是文件清单，不是安装说明书。

---

## 分层与不变量

```
js/core/    纯规则层：pieces → board → dlx → logic → make → library → game → storage → rng
js/data/    一张被复证过的测量表（bake 生成，别手改）
js/view.js  只画，不判；js/main.js 只装配，不推理
tools/      烘焙、分层自检、公开锚点、生成率台架、真事件门禁
test/       10 个 node 套件，跑在裸 node 上
```

四条不变量被 `tools/check.mjs` 机器化：`js/core` 里没有 DOM 字样（存储层例外，且只在 `try/catch` 后提）；
没有时钟、没有 `Math.random`（随机只来自注入的种子，`todayKey(date)` **拒绝**默认它的参数）；
零依赖；图片两头闭合（代码点名的资产都在磁盘上，磁盘上的资产都有代码点名，且每张的像素被自己数过）。
第二条不是洁癖：决定"是哪一关"的那次读表只有一处，`js/main.js:88`，
它把日历键注入 `resolveRoute()`。规则层自己伸手看表的话，同一链接在两次渲染里会给出两关，
而 node 套件永远不会发现这件事。

---

## 存档

一个版本化的 key：`pentapack.save.v1`（`js/core/storage.js:16`），值是单个 JSON。
三条规矩写在唯一写入方里：`best[id].moves` 只降不升（同 hand 数下用时可破平局）、
`unlock` 只升不降、清空要两次点击且武装状态存在档里（刷新不会解除武装 —— 能被刷新抹掉的清空不是清空）。
没有 `window`（node、隐私模式、无 profile 的 webview）就退化成内存档；
坏 JSON、负数、非对象、别的版本号统统退化成白纸，不抛异常。没有导出/导入 UI，只有清空。

---

## 目录

```
index.html            壳：顶栏 / 画布 / 读数面板 / 色对照 / 匣阵抽屉 / 通关卡片
manifest.webmanifest  PWA 安装清单（图标、主题色、start_url）
sw.js                 service worker：外壳离线，同源子资源 network-first（缓存永远不许赢过服务器）
css/game.css          全部样式，一个文件
js/core/pieces.js     十二块与 63 个 fixed 姿态、rot/mirror 下标、加载时自检
js/core/board.js      8×8 帧算术、mask 解析/打印、落点规则与三个拒绝码、validateLevel
js/core/dlx.js        Algorithm X + 舞蹈链：计数、提前停止、节点上限、solveLevel
js/core/logic.js      两条规则 + 假设搜索：推理深度在这里定案（带规则版本号）
js/core/make.js       档位表、装箱构造、四道闸的生成路径、yieldOf 的记账口径
js/core/library.js    查表：战役/每日/单关/随机 + 路由解析 + stats()
js/core/game.js       对局状态机：place/takeBack/rotate/flip/undo/reset/hintFor/grade
js/core/storage.js    存档：单调性、消毒、两次点击清档、无 window 退化
js/core/rng.js        hashSeed（FNV-1a 构造）+ mulberry32 + todayKey
js/data/lots.js       构建期产物：META + 30 行带实测深度的关卡（bake.mjs 写）
js/view.js            canvas 2D 程序绘制 + 命中几何 + 长按/双击/右键手势
js/audio.js           合成音效：一个振荡器一条包络，静音=挂起 context 且一个节点都不建
js/sw-register.js     只在 https 下注册 worker 的经典脚本（file:// 的 SecurityError 是异步的）
js/main.js            路由、DOM、存档写入、键盘、window.pentapack 测试钩子
server.cjs            零依赖静态服务器（默认 5197）
electron/main.cjs     桌面壳（复用 server.cjs，port:0）
tools/bake.mjs        出题 → 复证 → 写 lots.js
tools/check.mjs       分层与资产自检（23 行）
tools/doctest.mjs     文档数字闸：README 与 DESIGN 的每个现值对代码/现跑重算（15 组）
tools/proof.mjs       公开锚点表
tools/balance.mjs     生成率与深度直方图台架，--check 是整数闸
tools/harness.mjs     微型测试框架，node 与浏览器套件输出同一个 `rows:` 形状
tools/playtest.mjs    零依赖 CDP 驱动，@pointer 用真实 Input.dispatchMouseEvent
tools/verify.sh       一次性验收门（端口预检、SKIP_UNIT、Chrome 退出确认）
test/                 十个 node 套件 + 手算 fixture（期望值先于代码写死）
assets/icons/         十张图标（16→1024 与 maskable），由生成器出
assets/sprites/       两粒粉尘贴图
assets/textures/      一块毛毡纹理（匣的内衬）
assets/og-cover.png   社交卡片图
assets/gen/           gen_art.py 与它的 manifest.json（sha256 被 check.mjs 逐个对回磁盘）
```

---

## 端口与 URL 形态

| 用途 | 值 | 出处 |
| --- | --- | --- |
| 本地静态服务 | **5197** | `server.cjs:50,61` |
| 浏览器门禁 devtools | **9357** | `tools/verify.sh:21-22` |
| 端口预检 | 任一被占就拒绝开跑，并点名 owner | `tools/verify.sh:53-61` |
| 路由 | `#/`、`#/lot/<id>`、`#/daily[/<date>]`、`#/random/<seed>[?band=…]` | `js/core/library.js:parseRoute` + `resolveRoute` |
| 线上前缀 | `https://z-biz-game.github.io/pentapack-cos/` | Pages 项目页 |

本仓专属端口，与同系列其他仓不撞。开跑前先拒绝被占用的端口、跑完再确认 Chrome 真的退了 ——
端口撞车在这里不是麻烦，而是**假绿**（曾经有过一次：残留的 Chrome 让套件为一个它从没启动过的页面报 20/20）。

---

## 不承诺

写得越少，越容易被当成写了。这里明确不承诺的：

- **`推理深度` 不是组合学下界**。它是这套两规则求解器的实现测量；换规则集，全部数字作废（DESIGN §9 记了它曾怎么被写错）。
- **`balance --check` 的 40 draws 不是概率本身**。它是每次 CI 都跑的可达性与记账断言；
  要那组好看的百分比就 `npm run balance`（300 draws/格，约 2 s）。两者都是对固定种子串的承诺，不是对 seed 空间的承诺。
- **完成判定不现场跑 DLX**。它比对烘焙解答（DESIGN §2.4），依赖"解数 = 1"这条被逐行复证的性质。
  这条依赖由 `anomaly` 哨兵看着，但**玩家真填出第二条解的概率没有被测过**——按构造它应该是 0。
- **界面只在 8×8 及以下的烘焙匣与生成匣上被真事件验证过**；`@pointer` 走的是 campaign 前两档各一条解答，不是 30 关全打一遍。
- **没有毫秒层面的承诺**。`proof` 与 `balance` 打印的秒数是本机读数（本轮 18.0 s / 2.3 s），不进任何断言；
  `make.test.mjs` 里那条生成预算是保险丝，不是"手机上多快能玩"。
- **视图几何没有独立的数学闸**。命中盒与双击/长按的**手势行为**只在 `@pointer` 的真事件路径上被走过；
  `tools/doctest.mjs` 现在把两个常数钉成等式（文档那句 480 ms / 200 ms == `view.js` 的
  `LONG_PRESS_MS` 与 `BOUNCE_S` 现值，且 `BOUNCE` 那三句中文在代码里只有一处副本），
  但"坐标算得对不对"这件事仍然没有独立的解析闸。CSS 配色与其余中文文案仍然没有闸 —— 只有
  `pieces.test.mjs` 那条文档姿态数等式与 doctest 那几条形同的等式除外。
- **PWA 与音频没有被浏览器层断言**。`sw.js` 的缓存策略、`js/audio.js` 的"真静音"（挂起 context、
  静音时一个节点都不建）都过了 `node --check` 与 `tools/check.mjs` 的分层/资产闸，
  但 `@boot @play @routes @save @pointer` 这五个场景里没有一条是在断言它们 —— 音频图是否真的空，
  要靠 `js/audio.js` 自己的 `state()`，而那目前只有人工检查。
- **Electron 壳过 `node --check`，但仓库不装 electron，没有跑过真实启动。**
- **移动端断点已写、`touch-action: none` 已接，但没有真机验证**；UI 只有中文。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
