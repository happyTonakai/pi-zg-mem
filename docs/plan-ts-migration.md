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
| F | `index.ts` | 改造 | 365 | 子进程执行体 `python3 <script>` → `node lib/*.ts`（**不是**进程内导入，理由见模块 F 小节） |
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
   （`~/.pi/agent/zgmem/`，当前 7 workspace / 244 个 `.txt` 分片 —— 该目录随会话增长，
   数字只是对拍当天的快照）。
   最后再做一次真 `zg` 端到端冒烟。

   CLI 边界（argparse 那一层）另有 `tests/differential/cli_differential.ts`：两侧比
   **stdout 字节 + stderr 字节 + 退出码**（`-h`/usage 的换行与缩进、`--who bogus` 之类的报错文本、
   `show --workspace all` 的拒绝路径都在内）。这一层是 25 个 Python 用例**盖不到**的 ——
   它们只覆盖库函数，而 cli.ts 是用户直接看的那一层。

现有 25 个用例的归属（迁移时按此对齐）：

- `TestH1SeqAllocator` 3 个 → A
- `TestH1EtlFailureIsVisible` 1 个 → B
- `TestH3MigrateCleanup` 5 个 → B
- `TestM1TailConsistency` 2 个 → B
- `TestIdempotent` 1 个 → A+B
- `TestH2HitRefinement` 4 个 → A+C
- `TestM2IndexRefresh` 9 个 → D

## 已知语义差异（需要决策 / 必须记录）

### 1. 跨进程锁：`fcntl.flock` → 原子创建 + 租约（已定：L1）

Python 用 `fcntl.flock(fh, LOCK_EX)`，**进程退出/崩溃时内核自动释放**。
Node **没有**原生 flock，macOS 也没有 `flock(1)` 命令（那是 util-linux）。
候选：

- **方案 L1（采用）**：`open(lock, 'wx')` 原子创建 + 写入 `{pid, ts}`，
  超过租约（`ZGMEM_LOCK_LEASE_MS`，默认 10 分钟）视为崩溃残留可接管。
  可移植、崩溃可恢复；代价是租约过期后理论上可双持锁（flock 不会）。
- 方案 L2：`mkdir` 原子锁（同样需租约，无额外好处）。
- 方案 L3：引入原生依赖（如 `proper-lockfile`）—— 违背本仓库零依赖取向，不建议。

结论：L1 足够，因为真正的抗损坏靠的是**原子写 + staging + manifest 快照回滚**，
锁只负责"别让两个刷新同时干活"。

**对拍观察（`interop/py-leftover-lock`）**：Python 的 flock 释放后**锁文件留在磁盘上（空文件）**，
L1 只能靠"文件年龄 > 租约"判定它是残留 —— 于是「刚跑完 Python refresh，再用 TS 跑 refresh」
要干等满租约才能开工（对拍里把租约压到 3s 才不至于真等 10 分钟：实测 py 47ms / ts 3046ms，
两侧 **字节输出一致**，差的只是等待时长）。**不为此加宽限**：该场景只存在于「Python 与 TS 交替跑」
的迁移期，而 Python 在 G 阶段整体删除；删干净后这就是一条纯 TS 语义 —— 崩溃留下的 `{pid, ts}` 锁
等满租约才被接管，正确性由原子写 + 快照回滚兜底。

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

### 模块 A `lib/corpus.ts` — 完成（2026-09-22，提交 `3a06538`）

验收对照：

- [x] `node --test` 全绿：18 个用例（`tests/corpus.test.ts` 15 + `tests/corpus_golden.test.ts` 3）；
      后经三轮 reviewer 补入跨分片配对用例，现为 19（`tests/corpus.test.ts` 16）
- [x] Python 用例对等：`TestH1SeqAllocator`(2/3)、`TestH2HitRefinement`(3/4) 已按原名迁移；
      当时剩余 3 条依赖模块 B/C（`test_long_session_gets_all_fragments_into_manifest`、
      `test_refine_hit_line_end_to_end`、`TestIdempotent`）—— 其中前两条与 `TestIdempotent`
      已在模块 B 落地时补齐，`test_refine_hit_line_end_to_end` 仍待模块 C（**已补**，见模块 C 小节）
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

### 模块 B `lib/etl.ts` — 完成（2026-09-23，提交 `23370f6`；配套 CI/类型检查见 `640c2d5`）

验收对照：

- [x] `node --test` 全绿：32 个用例（A 的 19 + B 的 13，`tests/etl.test.ts`），不依赖 Python
- [x] Python 用例对等：`TestH1EtlFailureIsVisible`(1)、`TestH3MigrateCleanup`(5)、
      `TestM1TailConsistency`(2)、`TestIdempotent`(1) 已按原名迁移；并补上了 A 的欠账
      `test_long_session_gets_all_fragments_into_manifest`、`test_frozen_prefix_is_stable_and_later_runs_stay_incremental`
      （原名 `TestIdempotent`）。`test_refine_hit_line_end_to_end` **仍未迁移**（属模块 C 的 CLI 精修
      路径，现只有 `pickHitRow` 单测），待 C 落地时补 —— 已登记在下方“未迁移用例”清单里。
      > 后续：该条已在模块 C 迁入 `tests/query.test.ts`，本段保留 B 落地当日的状态描述。
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

### 模块 C `lib/query.ts` — 完成（提交 `c12183c`）

只读路径（query / show / ctx / sessions）的移植，`lib/query.ts` 840 行，导出
`runQuery(opts, env)`、`runShow`、`runCtx`、`runSessions`、`loadScope`、`pickHitRow`、`pairFromJsonl`。

验收对照：

- [x] 差分对拍：`tests/differential/query_differential.ts` **116 项全绿**（合成语料 + 真实语料），
      比 stdout、退出码与 zg/rg 的 argv
- [x] pytest 用例对等：`TestH2HitRefinement.test_refine_hit_line_end_to_end` 已按原名迁入 `tests/query.test.ts`
- [x] 常驻回归：`tests/query.test.ts` 20 条（迁移用例 + 变异测试固化的断言），**不依赖 Python**

变异测试（`tests/differential/mutate_query.sh`）固化成常驻断言的点：rg 的 since 单位
（`now_ms - since*86400*1000`）、who 过滤 / `--session` glob / `pairFromJsonl` 兜底、跨 workspace 去重键必须含
session、show 截断 800 / ctx 截断 200 + 换行→空格、`limit = pool>top ? pool : top`、非法 session id。

### 模块 D `lib/refresh.ts` — 完成（提交 `c0f13f0`）

写入路径（ETL + `zg index` + 索引戳/重试），`lib/refresh.ts` 456 行，导出 `runRefresh(scope, opts, deps)`
与 `indexMarker`。

验收对照：

- [x] 差分对拍：`tests/differential/refresh_differential.ts` **759 项全绿**
- [x] Python 用例对等：`TestM2IndexRefresh.*` 9 条（`test_zgmem.py:332-598`）已按原名迁入 `tests/refresh.test.ts`
- [x] 常驻回归：`tests/refresh.test.ts` 9 条，守 M2 的三条历史 bug（无变化早退跳过修索引、
      `lease active` 谎报已更新、索引运行期间语料被改仍记成已索引）

与 Python 侧的逐条差异（进程内 `runRefresh` 代替起子进程断言 returncode、monkeypatch
`MAX_SEG_ROWS`→`ProcessOptions.limits`、ENOSPC 用目录冒充文件等）记在 `tests/refresh.test.ts` 文件头。

### 模块 E `lib/cli.ts` — 完成（提交 `666c8f2`）

argparse 兼容的 CLI 前端，`lib/cli.ts` 545 行，入口 `if (import.meta.main) process.exitCode = main(process.argv.slice(2))`。

验收对照：

- [x] 差分对拍：`tests/differential/cli_differential.ts` **148 项全绿** —— 比 stdout 字节 + stderr 字节 +
      退出码（`-h`/usage 的换行与缩进、`--who bogus` 之类的报错文本、`show --workspace all` 的拒绝路径都在内）。
      这一层是 25 个 Python 用例盖不到的（它们只覆盖库函数，cli.ts 是用户直接看的一层）
- [x] 模块 F 落地时在原命令上复跑一遍（`SKIP_REAL=1`）：**148 项全部一致**

对拍顺带得到一个结论：lease 锁唯一可观测地劣于 flock 的场景是「Python 释放后留下空锁文件」，
而 Python 在模块 G 整体删除 —— 已记入「已知语义差异」第 1 条。

### 模块 F `index.ts` — 完成

**决定（与原计划不同）：不是“进程内导入 lib”，而是保留子进程、只把执行体从 `python3` 换成 `node`。**

原计划写的「改为进程内导入」有两个问题，实测后改选：

1. **lib 是同步实现**（15 处 `spawnSync`，忠于 Python 的 `subprocess.run`）。进程内直调会占住 pi 的
   event loop → TUI 冻结。
2. 即便不看同步：刷新的触发点是 `agent_settled`，**每轮会话结束都会跑**，而真实语料（83MB / 250 分片）上
   冷 `zg index` 实测 **5.7s**（无变化 0.5s；hybrid 查询 1.1s；rg 查询 0.08s）。

保留子进程的收益：不占 event loop、崩溃隔离、`session_shutdown` 能中止（`liveAbort()`）。
改动本身只有几行，且两个入口的等价性已由差分对拍证明（`node lib/cli.ts` ≡ `python3 zgmem.py`、
`node lib/etl.ts` ≡ `python3 jsonl2corpus.py`）。备选方案记录在案：**F1** worker_threads（真进程内、
可 terminate，代价是 worker 引导 + 每次一个线程 + 失去崩溃隔离）、**F3** 把 lib 的 `spawnSync` 改 async
（长期最干净，但要重写 C/D 已验收代码）—— 两者都留作按需优化，不阻塞迁移。

改动清单：

- 常量：`PY_MEM`/`PY_ETL` → `LIB_CLI`/`LIB_ETL`（`lib/cli.ts` / `lib/etl.ts`）
- `runPy` → `runLib`：`execFileAsync(process.execPath, ["--experimental-strip-types", script, ...args], ...)`
  （`--experimental-strip-types`：node 22.6+ 要靠它直接跑 `.ts`，24 起默认开启但接受该 flag，
  显式带上让两个版本行为一致 —— 与 `ci.yml` 的口径相同）
- 7 个调用点全部换到 `runLib(LIB_*, ...)`：`buildFullIndex` 的 ETL、`scheduleRefresh` 的 refresh、
  工具 query / show / ctx、`/zgmem refresh`、`/zgmem sessions`
- 注释里“python 会把错误文本打到 stdout”改为“底层(CLI/zg)”，会话关闭钩子注释的 python → lib

验收对照：

- [x] `tsc --noEmit` 0 错误；TS 套件 **67 用例全绿**（F 前 61 + 新增 6；真机修复后又 +1 → 68，见下一小节）
- [x] `index.ts` 里不再有 `python3` / `*.py` 的**字符串字面量**执行目标（注释里保留历史叙述）
- [x] 新增常驻回归 `tests/runtime_boundary.test.ts`（6 条，**不依赖 Python，永久保留**）：
      ① 静态边界（无 python3/*.py 字面量、spawn 必须是 `process.execPath` + flag、`LIB_*` 目标存在且真被调用）；
      ② 真进程冒烟（`cli.ts -h` rc 0 且 usage 在 stdout；`etl.ts` 裸跑走用法分支 rc 2）；
      ③ 端到端 —— 用**与 `index.ts` 逐字相同**的 argv 形状驱动真实入口，全部走子进程：
      ETL → refresh(建) → refresh(无变化, no-op，断言 zg **没被再调**) → refresh(增量，断言 zg 正好再跑一次)
      → sessions → query(--mode rg --json) → show / ctx（假 zg 挂 PATH）
- [x] 模块 E 的 CLI 差分在原命令上复跑：148 项一致

**有意不覆盖**（维护本项时的取舍）：`index.ts` 的 pi 事件接线（`session_start` / `agent_settled` /
`enqueue` / `_epoch`）与工具 schema —— 要假一整套 pi runtime，成本大于收益，见「明确不做的项」L1。
F 之后 `index.ts` 与 lib 之间只剩 argv 送达这一件事，已由上面第 ③ 条钉住。

**验收后补的真机修复（Node `maxBuffer`，2026-09-23）**：真机上 `--mode rg` 在大 workspace（35 个 JSONL，
267 处命中）下**恒返回空**。原因是 `spawnSync` 默认 `maxBuffer` 只有 1 MiB，超限时它给的是
`error: spawnSync rg ENOBUFS` + `status=null`，而 rg 分支原来只看 `status !== 0 → return []` ——
于是“输出太大”被当成“没有命中”，**静默给出错答案**（Python 的 `subprocess.run` 没有这个上限，
所以差分对拍的 fixture 太小，一直没照出来）。修法：`lib/corpus.ts:subprocessMaxBuffer()` 把上限提到
256 MiB（`ZGMEM_SUBPROCESS_MAX_BUFFER` 可覆盖、每次调用都重读），三处 `spawnSync`
（`lib/query.ts` 的 rg / zg、`lib/refresh.ts` 的 zg）都用它，且 rg 分支改为**显式抛** `proc.error`。
回归：`tests/query.test.ts` 新增 `rgCandidates.raises_on_maxbuffer_instead_of_silently_returning_nothing`
（把上限压到 1 字节，钉住“必须抛、不许返回 []”）。

**同时确认（不是差异，不修）**：rg 模式下 `--top N` 的**名次本来就不稳定** —— rg 多线程跨 35 个文件时
输出顺序随机（同一 argv 连跑 4 次得到 4 种顺序），Python 与 TS 都如此（各连跑 6 次，各出现 3 种 top3 组合）。
所以模块 E 的差分脚本对 rg 各例用“序无关比较（rank 抹平）”是必要的，rg 模式的逐字节对拍只能在
单文件 fixture 上做。

**模块 G 的欠账**（F 不改，留给 G）：删 3 个 `.py`（`zgmem.py`/`jsonl2corpus.py`/`zgmem_corpus.py`）、
删 `extensions/zg-memory/tests/test_zgmem.py`、删 5 个差分脚本、CI 的 py job 与 pipeline job、
README 里 `python3` 的残留（含「需要 `python3` 在 PATH 上」这条前置条件）。

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
- [x] `TestH2HitRefinement.test_refine_hit_line_end_to_end` —— 已迁入 `tests/query.test.ts`（模块 C，超出原名用例）
- [x] `TestM2IndexRefresh.*`（9 条，`test_zgmem.py:332-598`）—— 已按原名迁入 `tests/refresh.test.ts`（模块 D）

**结论：`test_zgmem.py` 的 25 条已全部迁完**；该文件与 5 个差分脚本一起留给模块 G 删除。

### 测试/CI 缺口（三轮 reviewer 记录）

- [x] **测试发现兜底 + 入口覆盖**：CI 用 `--test-reporter=tap` 断言 `# pass ≥ 60`（当前 67：A 16 + A 黄金 3 + B 13 +
      C 20 + D 9 + F 6；node22 默认 TAP、node24 默认 spec，不锁 reporter 会在 22 上失效）；
      `find **/*.ts` 递归 `--check` 覆盖入口 `index.ts`，
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
- `tests/differential/*.ts`（corpus / etl / query / refresh / cli，共 5 个）是迁移期一次性证据，**故意不进 CI**
  （需要 Python 当裁判）；随模块 B–E 提交进仓库，待模块 G 删 Python 时一并删除。
  **F 起运行时已与 Python 无关**：端到端链路改由 `tests/runtime_boundary.test.ts` 常驻守着（不需要 Python）。
- **`python3` 已退出运行时，但仍在 CI 里当裁判**：`tests` job（25 个 py 用例）与 `pipeline` job
  （ETL → refresh 全链路）都是 Python 侧证据，模块 G 与 `.py` 一起删。

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
