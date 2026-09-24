# zg-memory

把 pi 的历史会话（JSONL）变成一个**可语义查询的本地记忆层** —— 一个 pi extension，
用 [zvec-grep](https://github.com/zvec-ai/zvec-grep) (`zg`) 做检索、用原始 JSONL 做
source of truth，供 agent 在需要历史记忆时**主动召回**。

> 面向使用者的介绍、安装与实测数据见仓库根目录的 [英文 README](../../README.md) · [中文 README](../../README.zh.md)。
> 本文是**设计与数据格式**的深入说明（为什么分片、manifest 长什么样、增量成本从哪来）。

```
~/.pi/agent/sessions/**/*.jsonl     原始会话（完整：时间/角色/thinking/工具调用）
        │  lib/etl.ts（清洗：只留 user/assistant 文本，去掉噪声）
        ▼
~/.pi/agent/zgmem/<scope>/corpus/   干净语料（按 session 分片: <session>.p0001.txt, p0002, … + 尾片；每行带源行号）
        │  zg index（多语言向量 + BM25 混合索引；只重嵌发生变化的片）
        ▼
zg_memory_query  ←——  agent 主动召回（对话对 + ref）
zg_memory_open   ←——  回指 JSONL 深钻（thinking / 工具调用 / 扩展上下文）
```

## 设计原则

1. **zg 只是发现层，JSONL 才是记录源。** corpus 只存干净文本用于检索；召回后用
   `(session, line)` 指针回指原始 JSONL，任何深度信息（时间戳、thinking、工具调用）
   都能无损取回，不依赖索引是否存过这些字段。
2. **结构编码在文件系统里。** 一个会话切成多片（默认每片 ≤200 条消息且 ≤64KB，按 `user` 问句
   边界切、不拆散问答对），文件名 `<session>.p0001.txt` 编码顺序，每片 mtime 钉在**该片首条消息的
   时间**（语义时间，稳定不变）—— `zg` 的 `--modified-after/before` 由此变成"语义时间过滤"。
   更关键的是：`zg index` 的增量是**按文件判变更**（变了就整文件重嵌），所以把会话切小片之后，
   每轮刷新的 embedding 成本只跟**尾片**（≤阈值）相关，与历史总量、会话总长**解耦**。
   最后一个未冻结的片叫**尾片**，新消息总是追加进尾片；尾片涨过阈值才冻结成新片。
3. **纯相关性排序，不做时间衰减。** 检索系统不做"遗忘"（与记忆系统的定位矛盾）：
   排序只按 zg 相关性名次 `1/rank`；每条命中都带时间戳，早期与近期记忆冲突时由 agent 自行裁决。

## 组件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | pi extension：注册 2 个工具 + 1 个命令 + 生命周期钩子；工具/命令都走 `node lib/*.ts` 子进程 |
| `lib/corpus.ts` | 分片 / 配对共享库：切片切分、`(session, line)` 回指、manifest 读写 |
| `lib/etl.ts` | ETL：JSONL → 干净语料**分片**（一行一条消息 `行号\t角色\t时间\t文本`），维护 `manifest.json` v2（corpus 分片 ↔ JSONL 映射、前缀哈希/offset 变更检测、分片元数据）；原子写 + 文件锁 + 单实例（flock） |
| `lib/query.ts` | 只读路径：`query / show / ctx / sessions` |
| `lib/refresh.ts` | 写入路径：ETL + `zg index` + 索引戳/重试 |
| `lib/cli.ts` | argparse 兼容的 CLI 前端：`node lib/cli.ts <cmd>` |

> **运行时 = `index.ts` + `lib/*.ts`，纯 Node**：`index.ts` 起的是
> `node --experimental-strip-types lib/cli.ts` / `lib/etl.ts` 子进程。
> Python → TypeScript 迁移已完成（模块 A–F 逐模块对拍验收，模块 G 删掉全部 Python 与差分脚手架），
> 本仓已无任何 `.py`。计划与逐模块证据见 [docs/plan-ts-migration.md](../../docs/plan-ts-migration.md)。

## 给 agent 的工具

### `zg_memory_query`
语义/关键字检索历史记忆，返回 Top-N 条**对话对**（命中消息 + 其问答伙伴），每条带
`ref = { session, corpus_line, jsonl_line }`。

| 参数 | 说明 |
| --- | --- |
| `query` | 问题或关键词（精确 token 也可） |
| `top_k` | 返回条数（1-10，默认 3） |
| `scope` | `all`=整个索引 / `current` 只搜当前会话 |
| `who` | 限定命中消息是 `user` 还是 `assistant` 说的 |
| `since_days` | 只搜最近 N 天（按会话开始时间硬过滤） |
| `workspace` | workspace 名，或 `all` = 扇出合并所有已初始化 workspace；缺省=当前 |
| `mode` | `auto`/`hybrid`/`fts`/`rg`，见下 |

**搜索范围矩阵（workspace × session）**：

| 范围 | 怎么表达 |
| --- | --- |
| 当前 workspace 的当前 session | `scope=current` |
| 当前 workspace 的全部 session | 默认（`scope=all`） |
| 指定 workspace 的全部 session | `--workspace <name>`（或工具参数 `workspace`） |
| 所有 workspace | `--workspace all`（各 workspace 独立索引，按 eff 合并排序，ref 带 `workspace`） |

**mode 自动路由**（`mode=auto` 默认，按 query 形态判断）：

| 形态 | 路由 | 机制 |
| --- | --- | --- |
| 中文 / 描述性问题 | `hybrid` | zg 的 fts+向量 |
| camelCase 符号、大写错误码 | `fts` | BM25 词法 |
| `path:line`、≥16 位长 token、hash | `rg` | 直接 `rg -n -F` 扫原始 JSONL（不经 embedding） |

### `zg_memory_open`
对命中的一条深钻：
- `mode=full` —— 读那条消息的**原始 JSONL 记录**：thinking、工具调用、完整文本
- `mode=ctx` —— 读它**前后 `span` 条**消息，渲染成可读对话（含工具输出）

### `/zgmem` 命令
```bash
/zgmem refresh    # 增量：扫描 sessions 目录，只重刷 mtime/size 变化的会话
/zgmem reindex    # 全量重建（语料脚本变更后）
/zgmem sessions   # 列出已索引的会话
```

## 语料分片（v2，为什么每轮只重嵌一小片）

**问题**：`zg index` 的增量粒度是**文件**。v1 是"一 session 一 txt"，所以只要会话还在长，
那个文件每轮都变 → 每轮都要重嵌**整个会话**（实测 723KB 会话追加 3 字节 = 6.7s，且随会话线性增长）。

**方案 A（已实现）**：把会话切成定长分片，只让**尾片**变化。

| 机制 | 说明 |
| --- | --- |
| 冻结片 | 一旦切出就永不再改（mtime 钉在首条消息时间）→ zg 视为 unchanged，**不重嵌** |
| 尾片 | 每个 session 至多 1 个未冻结片；新消息追加进它，只有它每轮重写、重嵌 |
| 阈值 | `ZGMEM_SEG_ROWS`（默认 200 行）/ `ZGMEM_SEG_BYTES`（默认 64KB），任一超出即冻结 |
| 配对边界 | 切点不会把 user 问句和它的 assistant 回答拆到两片（跨片配对由 `pair_for_global` 兜底） |
| 崩溃/中断 | 既有前缀哈希 + offset 续读，也校验"尾片末行 == manifest 记的 last_jsonl_line"，不满足就整会话重建 |

**实测**（本机，`local/potion-multilingual-128m`）：

| 场景 | v1 | v2 |
| --- | --- | --- |
| 4.2MB / 259 行的会话，追加 3 条消息后刷新 | 整会话重写 + 重嵌（数秒且随会话增长） | **4.6s**（其中 zg 固定开销 ~4s，尾片仅 21KB） |
| 32 个会话 / 12MB JSONL 的 workspace 首次迁移 | — | **7.7s**（一次性：重建分片 + 全量重嵌） |

v1 → v2 自动迁移：manifest 版本不匹配时重建该 sessions 目录全部会话，并清理不再被引用的
遗留 `<session>.txt`（`migrate_cleanup`）；`zg index` 会把已删文件的向量一起清掉（实测 `1 deleted`）。

**还想要更快**：现在是"尾片重嵌"。若要做 fragment 级复用（只嵌新增行、复用旧向量），
需要改上游 `zg` 的索引格式（方案 D，暂不做）。

## 维护（为什么是 extension 而不是 skill）

skill 只能在被调用时"读文档"，无法维护索引。extension 订阅生命周期：

- **`agent_settled`**：每轮对话彻底结束后，后台 `zgmem refresh` —— 扫描 sessions 目录，
  与 manifest 中记录的 `jsonl_mtime`/`jsonl_size` 对比，**只重跑有变化的** jsonl（含
  subagent 独立会话、被恢复重写的旧会话），再增量更新 zg 索引（只重嵌变化文件）。
  无变化时秒退。
- **`session_start`**：懒初始化 —— 首次使用时发现索引缺失会全量构建。
- 被删除/归档的会话自动从 corpus 移除。

实测成本（本机数据）：单轮增量刷新 = ETL 0.05s + `zg index` 增量（固定 ~4s + 只重嵌尾片）；
单次查询约 1s；无变化时秒退（0.04s）。
三个真实 workspace 的首次迁移：32 会话/12MB JSONL → 7.7s；78 会话/74MB JSONL → 9s；
12 会话/4.2MB JSONL → 7s（一次性）。
**代价下限**：即使只重嵌一个小尾片，单轮也要 ~4-5s —— 这是 `zg` 每次调用都要重新加载
embedding 模型（无变更时 zg 直接秒退、不加载）。想再降只能改上游（方案 D）。

## CLI 用法（脱离 pi 也能用）

```bash
# 克隆目录下（通过 pi 安装则为
# ~/.pi/agent/git/github.com/happyTonakai/pi-zg-mem/extensions/zg-memory/lib/cli.ts）
Z=./extensions/zg-memory/lib/cli.ts

node --experimental-strip-types $Z query "codegraph 和 zvec 有什么区别" --top 3
node --experimental-strip-types $Z query "上次那个报错码" --mode rg
node --experimental-strip-types $Z query "上周说过什么" --since 7
node --experimental-strip-types $Z query "..." --workspace all   # 跨所有 workspace
node --experimental-strip-types $Z query "..." --json            # 结构化输出（含 ref 与 ts）

node --experimental-strip-types $Z show <session> <corpus_line> --full   # 深钻单条
node --experimental-strip-types $Z ctx <session> <corpus_line> --span 5  # 扩展上下文
node --experimental-strip-types $Z sessions                              # 列会话
node --experimental-strip-types $Z refresh --sessions-dir <dir>          # 增量刷新
```

环境变量：`ZGMEM_SCOPE`（可选，显式指定 workspace；缺省时**自动派生**：按 `PI_SESSION_FILE` 会话目录 slug（去首尾 `-`）→ 否则回退唯一已初始化 workspace → 再回退 `github`，因此**移全局后每项目天然隔离**）、`ZGMEM_DIR`、`ZGMEM_EMBEDDING`
（默认 `local/potion-multilingual-128m`，中文内容必需）。

## 现状与边界

**已完成**：ETL、混合+精确召回（纯相关性排序）、回指深钻、增量维护、extension 工具暴露，
全部有实测验证（tsc 0 错、加载冒烟通过、四路由命中正确）。

**有意不做 / 待办**：
- **只做主动召回**（被动捕获/自动摘要沉淀）明确为下一步，本版不含。
- **Python → TypeScript 迁移已完成**：模块 A–F 逐模块移植并有逐字节差分证据，模块 G 删掉了全部 Python
  实现、Python 用例与差分脚手架 —— 运行时与 CI 都不再需要 `python3`。
- **fragment 级向量复用**（只嵌新增行、复用已冻结片的向量）需要改上游 `zg` 的索引格式，
  暂不做；当前用"分片 + 尾片"近似达到"每轮成本有界"（方案 A）。
- workspace 已按会话目录派生（全局可用）；跨 workspace 检索只覆盖已初始化过的项目，
  **从不打开的项目不预建**（用户决策：没启动过的会话不重要，放着即可）。
- 首次全量建索引已改后台（`session_start` 不 await、single-flight，查询撞上共享同一 promise）。
- 依赖 `zg`、`rg` 在 PATH 上（需要 Node 22.6+ 或 24+）；**仅适配 macOS/Linux**（win32 的 `zg.cmd`/路径分隔未处理）。
- 时间过滤粒度 = 会话文件（`mtime` 戳为会话开始时间），非消息级。