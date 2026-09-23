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

CI：新增 `ts-tests` job（node 24 + `node --test`，零依赖、不需要 Python）。
**在模块 A 就加而不是等到模块 G** —— 否则新写的回归在 CI 里根本不会执行。
