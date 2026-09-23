# 迁移计划：Python → TypeScript

目标：把 zg-memory 的运行时从 Python 迁到 TypeScript，**行为零变化**，逐模块迁移，
每一步都有可复核的回归证据。完成后 pi 扩展不再需要 `python3`。

## 为什么做

1. `python3` 是我们自己造出来的依赖 —— 底层引擎 `@zvec/zvec-grep` 是纯 Node/TS
   （`bin: dist/cli/index.js`，`engines: node >= 22`，包内 `.py` 文件数 **0**）。
2. 去掉一道本不该存在的 subprocess 边界：现在靠解析 stdout/退出码通信，
   并因此养出过 bug（`index.ts:259`：「python 会把错误文本打到 stdout；
   不能再伪装成没有命中」），还要额外做孤儿进程清理（`index.ts:92,360`）。
3. 安装门槛：`README.md:207` 要求 `zg`、`rg`、`python3` 同时存在；
   macOS 的 `/usr/bin/python3` 依赖 Xcode CLT，Windows 完全未处理（`README.md:203`）。
4. CI 矩阵可从 3 个 Python 版本 × 2 平台塌缩为单一 Node 矩阵。
5. 为将来发布 npm 包铺路 —— 否则 Python 依赖会被写进 npm 包的安装要求里。

## 工具链约束（已实测，不是推测）

| 约束 | 依据 |
|---|---|
| 多文件 TS 可用**相对导入**，必须带 `.ts` 扩展名 | `~/.pi/agent/extensions/subagent/index.ts:26` → `import ... from "./agents.ts"` |
| 入口发现规则是 `*/index.ts`，子目录模块不会被当成独立扩展 | `docs/extensions.md:115-120`、`:235-240`（"Directory with index.ts - for multi-file extensions"） |
| 无需构建：`node v24.16.0` 原生剥离类型 | 探针 `node main.ts` → `TS-RUN-OK 42` |
| 测试直接用 `node --test *.test.ts`，零依赖 | 探针 → `pass 1 / fail 0` |

**因此代码必须只使用"可擦除语法"**（erasable syntax only），否则 `node x.ts`
无法直接运行：不能用 `enum`、`namespace`、装饰器、构造函数参数属性。
类型注解、`interface`、`type`、`as` 都可以。

## 模块划分与顺序

按依赖关系（不是按文件大小）排序。当前 Python 代码 2156 行，TS `index.ts` 365 行。

| 步 | 目标文件 | 来源 | 行数 | 为什么这个顺序 |
|---|---|---|---|---|
| A | `lib/corpus.ts` | `zgmem_corpus.py` | 464 | 地基：分片/manifest/锁/原子写/切分，ETL 与 CLI 都依赖它 |
| B | `lib/etl.ts` | `jsonl2corpus.py` | 387 | 纯转换 + 增量续读；产物可逐字节 diff |
| C | `lib/query.ts` | `zgmem.py`（查询侧） | ~ | 只读路径：query/show/ctx/sessions + 命中精修 |
| D | `lib/refresh.ts` | `zgmem.py`（刷新侧） | ~ | 写入路径：ETL + zg index + 索引戳/重试 |
| E | `lib/cli.ts` | `zgmem.py`（入口） | ~ | 独立 CLI：`node lib/cli.ts <cmd>`，保留现有命令行 UX |
| F | `index.ts` | 改造 | 365 | 改为**进程内**导入 lib，去掉 `python3` 子进程 |
| G | 清理 | — | — | 删 Python、改 CI、改 README/docs |

## 绞杀者式上线

Python 在**全部门类通过验收前不删**。`index.ts` 按命令逐条切换（`refresh` 用 py、
`query` 用 ts 这类中间状态是允许的、也是安全的），每条命令只有在对应回归全绿后才切。

## 回归策略（三层证据，每层都要）

1. **黄金样本（golden fixtures，永久保留）**
   用 Python 实现作为 oracle 生成输入/输出快照（合成 JSONL 会话 → 期望的
   `manifest.json` + 分片文件字节），提交到 `tests/fixtures/`。
   TS 实现必须**逐字节复现**。这样 CI 不再需要 Python，而回归强度不降 ——
   Python 只在生成快照时当一次裁判。
2. **测试逐条对等（永久保留）**
   `tests/test_zgmem.py` 现有 25 个用例（清单见下）按名字一一迁到 `tests/*.test.ts`
   （`unittest` → `node:test`）。**用例数只许多不许少**，迁移时必须能对齐清单。
3. **差分对拍（迁移期一次性证据，完成即弃）**
   对同一批输入分别跑 Python 与 TS，比对产物字节级一致；并在**真实语料**上跑
   （`~/.pi/agent/zgmem/`，当前 33 文件 / 308531 字节）。
   最后再做一次真 `zg` 端到端冒烟。

现有 25 个用例的归属（迁移时按此对齐）：

- `TestH1SeqAllocator` 3 个 → A
- `TestH1EtlFailureIsVisible` 1 个 → B
- `TestH3MigrateCleanup` 5 个 → B
- `TestM1TailConsistency` 2 个 → B
- `TestIdempotent` 1 个 → A+B
- `TestH2HitRefinement` 4 个 → A+C
- `TestM2IndexRefresh` 9 个 → D

## 已知语义差异（需要决策 / 必须记录）

### 1. 跨进程锁：`fcntl.flock` → ？（待拍板）

Python 用 `fcntl.flock(fh, LOCK_EX)`，**进程退出/崩溃时内核自动释放**。
Node **没有**原生 flock，macOS 也没有 `flock(1)` 命令（那是 util-linux）。
候选：

- **方案 L1（建议）**：`open(lock, 'wx')` 原子创建 + 写入 `{pid, ts}`，
  超过租约（如 10 分钟）视为崩溃残留可接管。可移植、崩溃可恢复；
  代价是租约过期后理论上可双持锁（Python 的 flock 不会）。
- 方案 L2：`mkdir` 原子锁（同样需租约，无额外好处）。
- 方案 L3：引入原生依赖（如 `proper-lockfile`）—— 违背本仓库零依赖取向，不建议。

我的判断：L1 足够，因为真正的抗损坏靠的是**原子写 + staging + manifest 快照回滚**，
锁只负责"别让两个刷新同时干活"。**但这确实弱于 flock，需要你确认接受。**

### 2. 库函数不再 `print`

`sweep_stale_tmp` / `migrate_cleanup` 现在直接打印。移植后：lib 层**返回值**，
由 `cli.ts` 负责格式化输出，且格式必须与现在逐字节一致（否则 CLI 回归对不上）。
好处：库可测、无副作用。

### 3. Python `int()` 与 JS `Number()` 不等价

`read_segment` 用 `int(parts[0])` 解析行号，`int("12.0")` 会抛异常 → 该行被跳过；
而 JS `Number("12.0") === 12` 会**静默接受**，导致坏行被吃进来。
必须实现严格版 `parsePythonInt`（可选正负号 + 数字，允许下划线），
并且**这一点要有专门的测试**。（同类差异：Python `rstrip("\n")` 只去 `\n`。）

## 验收标准（每个模块通用）

一个模块只有在以下条件全部满足后才算迁移完成：

- [ ] `node --test` 全绿，且该模块对应的 Python 用例已逐条对等覆盖
- [ ] 对同一输入，Python 与 TS 产物**逐字节一致**（含 manifest JSON 字节）
- [ ] 在真实语料上差分对拍无差异（模块 A、B、D）
- [ ] 无新增运行时依赖（只用 Node 标准库）
- [ ] 只用可擦除语法（`node x.ts` 能直接跑）
- [ ] README / docs 同步（仅最后一个模块）

## 回滚

迁移期 Python 原文件、`index.ts` 的 Python 调用路径都保留在 `main` 上；
每个模块一个提交，出问题 `git revert` 单点即可，不必回退整条迁移。

---

## 迁移进度

### 模块 A `lib/corpus.ts` — 完成（2026-09-22）

验收对照：

- [x] `node --test` 全绿：18 个用例（`tests/corpus.test.ts` 15 + `tests/corpus_golden.test.ts` 3）
- [x] Python 用例对等：`TestH1SeqAllocator`(2/3)、`TestH2HitRefinement`(3/4) 已按原名迁移；
      剩余 3 条依赖模块 B/C（`test_long_session_gets_all_fragments_into_manifest`、
      `test_refine_hit_line_end_to_end`、`TestIdempotent`），在 B/C 落地时必须补
- [x] 产物逐字节一致：`tests/fixtures/` 黄金样本（分片 + manifest，覆盖 CJK/制表符/emoji/
      含换行文本/5 位 seq/带点 sid/非 ASCII sid）
- [x] 真实语料差分：**7 workspace / 241 分片 / 8267 行，与 Python 零差异**
- [x] 无新增运行时依赖（只用 `node:fs/path/crypto`）
- [x] 只用可擦除语法：`node extensions/zg-memory/lib/corpus.ts` 可直接跑

证据工具（迁移完成即删）：

- `tests/differential/corpus_differential.ts` — 3631 项对拍（纯函数 + 产物字节 + 真实语料）
- `tests/differential/corpus_probe.py` — Python 裁判。真实语料按“逐行 sha256 + 字节数”摘要比对：
  语料里有整段 JPEG 二进制（工具结果里的图片），全文回传会撞爆 `spawnSync` 的 maxBuffer

差分对拍抓到的**真分歧**（已修，均有用例钉住）：

1. `parseSeg`：Python 的 `$` 在非 multiline 下还匹配“尾随换行之前”的位置，
   所以 `"sess.p0001.txt\n"` 在 Python 侧是合法分片名；JS 的 `$` 不吃这个，必须显式
   去掉一个尾随 `\n` 才能对齐（文件名理论可含换行：POSIX 只禁 `/` 和 NUL）。
2. `sweep_stale_tmp` 直接往 stdout 打印 — 这正是“已知语义差异 #2”的实证。
   对拍器把它的 stdout 引到 stderr；TS 侧 lib 不打印，格式化输出归 `cli.ts`。

残余差异（已记录、**不可达**，不修）：`parsePythonInt` 只认 ASCII 数字且受 `Number` 精度限制，
而 Python `int()` 还接受 Unicode 数字、整数无上界。我们自己写入的语料永远是 ASCII 十进制。

CI：新增 `ts-tests` job（**node 22 + 24 × ubuntu + macOS**，零依赖、不需要 Python）；
**在模块 A 就加而不是等到模块 G** —— 否则新写的回归在 CI 里根本不会执行。

模块 B 落地时对 CI 的补充：

- 矩阵加 **node 22**（迁移后的最低支持版本）。类型擦除在 22.6 就有，但 22 需要显式
  `--experimental-strip-types`（24 起默认开启），所以 CI 命令统一带上这个 flag，两版行为一致
- “每个模块都能被直接执行”这条断言换成 `--check`（语法：不含不可擦除构造）+
  `import('./lib/x.ts')`（顶层可执行）。原来直接 `node "$f"` 对带 main guard 的 CLI 型模块
  （`lib/etl.ts`）会走用法分支 `exit 2`，那是**正确行为**却会让断言误报

### 模块 B `lib/etl.ts` — 完成（2026-09-23）

验收对照：

- [x] `node --test` 全绿：30 个用例（A 的 18 + B 的 12，`tests/etl.test.ts`），不依赖 Python
- [x] Python 用例对等：`TestH1EtlFailureIsVisible`(1)、`TestH3MigrateCleanup`(5)、
      `TestM1TailConsistency`(2)、`TestIdempotent`(1) 已按原名迁移；并补上了 A 的欠账
      `test_long_session_gets_all_fragments_into_manifest`、`test_frozen_prefix_is_stable_and_later_runs_stay_incremental`
      （原名 `TestIdempotent`）。`test_refine_hit_line_end_to_end` **仍未迁移**（属模块 C 的 CLI 精修
      路径，现只有 `pickHitRow` 单测），待 C 落地时补 —— 已登记在下方“未迁移用例”清单里。
- [x] 产物逐字节一致：`tests/fixtures/etl/`（7 个会话 / 9 个分片 + manifest）。
      manifest 用 `ensure_ascii=False + indent=2`（与 Python `save_manifest` 同参），
      测试里把临时会话目录换成 `__SESSIONS_DIR__` 占位符后整文件字节比对；分片直接字节比对
- [x] 真实语料差分：**7 workspace / 210 session 文件 / 172.5MB / 1247 项对拍，与 Python 零差异**
- [x] 增量语义自证：**增量续读的结果 == 强制全量重建（`--rebuild`）的结果**（语义相等，见下）
- [x] 无新增运行时依赖；只用可擦除语法

差分对拍覆盖的三个阶段（`tests/differential/etl_differential.ts`，迁移期一次性证据）：

1. **截断**：把每个 JSONL 砍到约 60% 处（`floor(len*0.6)`，大概率切在半行上），两侧从零建 —— 逼出「半行」处理差异
2. **续读**：恢复完整内容后**不做 rebuild** 再跑一次 —— 逼出半行补齐 / 追加 / frozen 前缀复用差异
3. **重建**：两侧都 `--rebuild` —— Python/TS 互比，且必须（语义上）等于阶段 2 的增量结果

阶段 3 对阶段 2 只做**语义比较**（`stableStringify` 递归排序键后深比较），不比字节：
manifest 的 `segments` 是普通对象，键的插入顺序在“重建”与“增量”下合法地不同（重建先把旧条目删除、
再按本轮处理先后重新登记，增量让旧条目留在原位）。集合与每个条目的内容完全一致 —— Python 自己重建也有同样差异
（实测两边对称：字节数相同、集合相同、payload 相同）。键序对下游无意义：`openTail` 与查询都按
`seq` 字段与 manifest 成员关系走，`zgmem` 列 session 时还显式 `sort`。两侧都跑这一断言：
否则“某个实现的重建结果 != 它自己的增量结果”到底算不算差异就说不清。

写对拍器时踩的坑（**别再用共享父目录**）：manifest 与锁文件都在 corpus 目录的**上一级**
（`zc.manifestPathFor`），所以每个 run 必须有自己的父目录。第一版让 py/ts 共用一个父目录，
结果 TS 在等 Python 留下的锁，**锁租约 10 分钟**，对拍直接卡死 10 分钟才报错。

二轮 reviewer 抓到的真分歧（已修，均有用例或对拍证据钉住）：

1. **字符串型 timestamp 被静默变成 0**：`pyIntOfString` 的正则由 `\u{XX}` 拼成，flags 却只有 `g`；
   无 `u` 时 `\u{9}` 不是合法转义，字符类降级为字面集合，把 ASCII 数字/十六进制字母当空白剥掉。
   结果 `int("1700000000000")` 在 TS 侧得到 `null` → `ts=0`。修法是补 `u`（`"gu"`）。
   真实 pi 写的 timestamp 是 number，171.7MB 对拍覆盖不到 —— 这正是“差分只证明测到的输入一致”的例子。
2. **`"message": []` 使整个 session 消失**：Python `d.get("message") or {}` 把 falsy 的 `[]`/`{}`/`""`/`0`
   归一成 `{}` 后跳过该行；JS 里 `[]` 是 truthy，`[] || {}` 仍是 `[]` → `isPlainObject([])` 为假 → 抛异常
   → 该 session 回滚、**整会话不入语料**、退出码 2（Python 只是跳过一行）。新增 `pyTruthy`/`pyOr` 对齐，
   同一族的 `c["text"]` 判定也一并改掉。
3. **`jsonl_mtime` 在舍入边界差 1**：Python `int(st.st_mtime * 1000)` 走 double 秒（`tv_sec + tv_nsec/1e9`）；
   TS 原先用 `Number(ns)/1e9*1000`，舍入点不同。改为读 bigint 纳秒后照抄 Python 运算顺序。
   分片字节不受影响（`int(ts)` 是整数），只有 manifest 字节不一致 —— 单测/分片对拍看不到。
4. `migrateCleanup` 的输出行序：Python 在循环里先逐条 print `清理失败`、循环结束才汇总；原 TS 写反了。
5. `fnmatch` 的 `[^…]`：Python `translate` 对首字符 `^` 做转义（匹配字面 `^`），TS 原先当取反类。
6. `scan` 的超长单行拼接由单缓冲区改为块列表（原写法每读一块就整体重拷，单行 L 字节耗 `O(L²/CHUNK)`）。

### 已知残余差异（已记录，**不修**）

- **非标准 JSON 字面量 `NaN` / `Infinity` / `-Infinity`**：Python `json.loads` 默认接受这三个字面量，
  JS `JSON.parse` 拒绝。实测（只有 `NaN` 的行）：Python 把该行以 `ts=0` 收进语料，TS 直接丢行，
  **两侧都 exit 0**（静默丢一行）；带 `±Infinity` 时 Python `int(inf)` 抛 `OverflowError`（不在
  `except (TypeError, ValueError)` 内）→ 整个 session 回滚，而 TS 只丢行。
  不修的理由：真实 pi 写 JSONL 用的是标准编码器，永不产生这三个字面量 —— 172.5MB 真实语料差分
  **0 差异**就是证据；要忠实复刻还得把“Python 因 Infinity 整个 session 失败”这个本身就别扭的行为
  一并搬过来，代价大于收益。**若哪天上游真的产生这类行，此处是第一个要动的地方。**

### 未迁移的 Python 用例（清单，避免被当成已迁移）

`extensions/zg-memory/tests/test_zgmem.py` 的用例按模块登记迁移状态：

- [x] `TestH1SeqAllocator.*` / `TestH2HitRefinement.*` → `tests/corpus.test.ts`
- [x] `TestH1EtlFailureIsVisible` / `TestH3MigrateCleanup` / `TestM1TailConsistency` / `TestIdempotent`
      → `tests/etl.test.ts`
- [ ] `TestH2HitRefinement.test_refine_hit_line_end_to_end` —— 依赖尚未迁移的 CLI 精修路径（模块 C）
- [ ] `TestM2IndexRefresh.*`（11 条，`test_zgmem.py:332-598`）—— 测尚未迁移的 `zgmem.py`（模块 C/D）

### 测试/CI 缺口（三轮 reviewer 记录）

- [x] **测试发现兜底 + 入口覆盖**：CI 用 `--test-reporter=tap` 断言 `# pass ≥ 28`（node22 默认 TAP、
      node24 默认 spec，不锁 reporter 会在 22 上失效）；`find **/*.ts` 递归 `--check` 覆盖入口 `index.ts`，
      `import()` 仅对零依赖的 `lib/*.ts`（`index.ts` 依赖 peerDependency `typebox`，CI 无 `npm ci`）。
- [x] **静态类型检查**：新增 `typecheck` CI job（独立 node22 job，不随 OS/node 矩阵翻倍）+
      `tsconfig.json`（`strict`/`noEmit`/`allowImportingTsExtensions`）。CI 只装两个 devDependency
      （`typescript` + `@types/node`，`npm i --legacy-peer-deps`，**不装 peerDependencies** —— pi 解包 400MB+），
      peer 由 `types/peers.d.ts` 的环境声明桩住。本地 `tsc --noEmit -p tsconfig.json` 与 CI 一致，当前 0 错误。
- [x] **真实 CLI 入口在 CI 执行**：新增 CI 步骤用已提交的 `tests/fixtures/etl/sessions` 起子进程直接跑
      `etl.ts "$sessions/*.jsonl" "$corpus"`，断言分片落盘、manifest 生成（在 corpus 上一级）、摘要行输出。
- [x] **黄金样本盲区**：补了 mtime 变而内容不变仍 `(+0 inc)`（`tests/etl.test.ts`，`canContinue` 只比 `prefix_sha`）、
      非 ASCII sid 端到端（ETL 写分片名 + manifest 键 + `ensure_ascii=False`）、user/assistant 配对跨分片边界
      （`tests/corpus.test.ts`，`readWindow` 的 needPrev/needNext 扩片）。
- `tests/differential/etl_differential.ts` 是迁移期一次性证据，**故意不进 CI**；是否随模块 B 一并提交
  由仓库决定（当前 untracked）。

> **黄金样本盲区（未修，已知）**：`tests/etl.test.ts` 的黄金样本只对「Python 序列化出来的 manifest 文件」
> 换成 `__SESSIONS_DIR__` 占位符后整字节比对，因此**只在 Python 写过那些键上生效**：若 TS 侧多写一个
> schema 之外的键，黄金样本看不到。缓解：TS 侧 manifest 由 `CorpusManifest` 类型约束，且差分器阶段 3 的
> `stableStringify` 逐键深比较（真实语料 1247 项对拍零差异）会抓到多/少键。

### 类型检查的支撑条件（三轮 reviewer 变异验证）

- **`types/peers.d.ts` 是关键支点**：CI 不装 peerDependencies，类型检查能过**完全依赖**它。变异验证：
  删掉该文件后 `tsc` 报 `TS2307 Cannot find module 'typebox'` / `'@earendil-works/pi-coding-agent'`（exit 1）。
  `index.ts:1-11` 的 6 个 peer import（`typebox`、`@sinclair/typebox`、`pi-coding-agent`、`pi-ai`、`pi-tui`、`pi-types`）
  都由它桩住、无遗漏。因它是个无保护的普通文件，`ci.yml` 的 typecheck job 里加了 `test -f types/peers.d.ts` 兜底。
- **依赖可复现性**：仓库不提交 `package-lock.json`（零运行时依赖），类型检查依赖的可复现性靠
  `package.json` 里的**精确版本**（`typescript 5.6.3` / `@types/node 22.19.19`）保证。
- 模块收集用 `while IFS= read -r` 循环而非 `mapfile`（后者需 bash 4+）：已在 macOS 默认 bash 3.2
  下逐字复现通过，Runner（bash 5）无影响。

### 明确不做的项

- **L1 `index.ts` 功能覆盖**：*won't fix*。CI 里没有 pi runtime，功能性覆盖需 stub 整个 peer（成本高）。
  已覆盖的层次：语法（`--check`）+ 类型（`tsc`）+ 生态里的真进程执行（`etl.ts` 子进程步骤）。
- **L2 `shuf` 依赖**：全仓 `rg shuf`（`*.ts`/`*.py`/`*.yml`/`*.sh`，排除 `node_modules`）**零命中**，
  差分脚本也无随机/`shuf` —— 该标签已过期，关闭。
