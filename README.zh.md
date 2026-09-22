# pi-zg-mem

[![CI](https://github.com/happyTonakai/pi-zg-mem/actions/workflows/ci.yml/badge.svg)](https://github.com/happyTonakai/pi-zg-mem/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/happyTonakai/pi-zg-mem)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#安装)
[![Made for pi](https://img.shields.io/badge/made%20for-pi-8A2BE2)](https://pi.dev)
[![Requires zvec-grep](https://img.shields.io/badge/requires-zvec--grep%20%28zg%29-blue)](https://github.com/zvec-ai/zvec-grep)

> [English](README.md) · **中文**

**给 [pi](https://pi.dev) coding agent 的跨 session 记忆。** 默认情况下，你的会话历史是"只写"的——它们堆在磁盘上，之后再也没人读过。这个扩展让它们全部可检索，并让 agent 在需要细节时回指到原始记录。

两个工具，底层是 [`zvec-grep`](https://github.com/zvec-ai/zvec-grep)（`zg`：ripgrep + BM25 + 多语言向量）：

| 工具 | 作用 |
| --- | --- |
| `zg_memory_query` | 跨所有历史会话召回——语义**或**字面精确。返回 Top-N 条**对话对**（命中消息 + 它的问答伙伴），每条带 `ref`。 |
| `zg_memory_open` | 对命中项深钻：原始 JSONL 记录（thinking、工具调用、完整文本），或它前后的上下文对话。 |

全部本地运行：不联网、不需要 API key、无遥测，embedding 模型就在你机器上跑。

## 要解决的问题

你问"上次那个 flaky 的 auth 测试是怎么修的？"——agent 一脸茫然。那是三周前、四十个 session 之前的事了。

- **会话是只写的。** `pi --resume` 只按首条 prompt 列最近会话。想找上个月的某个**话题**，只能一个个文件翻。
- **拿 `rg` 检索 JSONL 只能字面匹配。** 记得住确切标识符时很好用；但你用别的说法、中文、或中英混着描述症状时，它就找不到了。
- **真正有用的东西从不在摘要里。** 你要的往往是那一条 assistant 消息、它的推理过程、以及它当时调的哪个工具——而那些都在 JSONL 里，埋在几千行噪声下面。

## 一次召回长什么样

```
> 你：上次那个"索引僵死"的 bug 最后怎么解的？

  zg_memory_query("索引僵死 lease 重建")            ← agent 决定主动召回
  → 3 条命中，2 个 session，2026-09-18 … 2026-09-22

  zg_memory_open(session=…, corpus_line=…, mode=ctx)  ← 对命中项深钻
  → 当时的真实对话：失败的第一版方案、评审里发现它的那条 comment、
    以及最后落地的修法
```

*（输出经过裁剪；真实结果是完整文本。这里展示的是交互形态，不是预置的演示记录。）*

关键在于第二步是**无损的**。`zg` 只是发现层，只存用于排序的干净文本；之后你要的一切都直接从原始 JSONL 里读出来，所以时间戳、thinking、工具调用原封不动都在。

## 工作方式

```
~/.pi/agent/sessions/**/*.jsonl     原始会话（完整：时间 / 角色 / thinking / 工具调用）
        │
        │  jsonl2corpus.py     清洗：只留 user + assistant 文本，去掉噪声
        ▼
~/.pi/agent/zgmem/<workspace>/corpus/     干净语料，按 session 分片
        │        <session>.p0001.txt, p0002, … + 一个未冻结的尾片
        │        一行一条消息：<jsonl 行号>\t<角色>\t<时间>\t<文本>
        │
        │  zg index             向量 + BM25 混合索引，只重嵌发生变化的文件
        ▼
zg_memory_query  ──►  agent 召回（对话对 + ref）
zg_memory_open   ──►  回指 JSONL 深钻（thinking / 工具调用 / 上下文）
```

**设计原则**

1. **`zg` 是发现层，JSONL 才是记录源。** 语料只存用于排序的干净文本；召回返回 `(session, corpus_line)` 指针，深钻直接读原始文件——深度信息从不取决于索引里恰好存了什么。
2. **结构编码在文件系统里。** 会话按 `user` 问句边界切分（问答对绝不被拆到两片），文件名编码顺序，每片 `mtime` 钉在该片**首条**消息的时间——`zg --modified-after/--before` 于是免费变成了"语义时间过滤"。更重要的是，它让增量成本**有界**，见下文。
3. **纯相关性排序，不做时间衰减。** 一个会"遗忘"的记忆系统是自相矛盾的。排序只按 `zg` 名次取 `1/rank`；每条命中都带时间戳，新旧记忆冲突时由 agent 自己裁决。
4. **workspace 自动派生，无需配置。** 索引按会话目录分键，每个项目天然拥有隔离的记忆。

## 安装

**环境要求**

| 需要 | 用途 | 检查 |
| --- | --- | --- |
| [`pi`](https://pi.dev) | 宿主 agent | `pi --version` |
| [`zvec-grep`](https://github.com/zvec-ai/zvec-grep) | 搜索引擎（`zg`） | `npm i -g @zvec/zvec-grep && zg --version` |
| `rg`（ripgrep） | 字面精确模式 | `rg --version` |
| `python3` | ETL + CLI（3.9+） | `python3 --version` |

```bash
pi install git:github.com/happyTonakai/pi-zg-mem
pi list          # 确认已注册
```

然后 `/reload`（或重启 pi）。本地克隆也可以用 `pi install /绝对路径/pi-zg-mem`。

> **不要留两份副本。** 如果你同时还放着 `~/.pi/agent/extensions/zg-memory/`，工具会被注册两次。只留一份。

**首次运行。** 没有构建步骤：第一次查询（或首次 `session_start`）时会在后台为当前 workspace 建索引。历史很大也就是几秒——78 个会话 / 74 MB JSONL 实测端到端 **9 秒**。`session_start` 从不阻塞；建索引期间到来的查询会共享同一个进行中的任务。

**验证是否正常**

```bash
python3 extensions/zg-memory/tests/test_zgmem.py     # 25 个离线用例，不联网、不需要 zg
```

这套用例就是 [CI](.github/workflows/ci.yml) 跑的东西——Python 3.9 / 3.11 / 3.13，Ubuntu 与 macOS 双平台，除标准库外什么都没装。CI 另外还端到端跑一遍真实入口（ETL → 无变化 refresh → 增量 refresh），免得这条管线悄悄坏掉。

## 使用

### 给 agent 用

`zg_memory_query`：

| 参数 | 说明 |
| --- | --- |
| `query` | 问题或关键词。精确 token 也可以。 |
| `top_k` | 返回条数（1–10，默认 3） |
| `scope` | `all` = 整个索引 · `current` = 只搜当前会话 |
| `who` | 限定命中消息是 `user` 还是 `assistant` 说的 |
| `since_days` | 只搜最近 N 天内开始的会话 |
| `workspace` | workspace 名，或 `all` 跨所有已初始化 workspace 扇出合并 |
| `mode` | `auto` / `hybrid` / `fts` / `rg`，见下 |

`zg_memory_open`：`session` + `corpus_line`（来自命中的 `ref`），`mode=full`（原始记录）或 `mode=ctx`（前后各 `span` 条上下文）。

**什么时候**该用记忆写在工具描述里——它一直在上下文中，不像 skill 还得先被加载。字面还是语义的取舍由下面的 `mode=auto` 路由决定。

**`mode=auto` 按 query 形态路由**，这是它可信而不只是"模糊"的原因：

| query 形态 | 路由 | 机制 |
| --- | --- | --- |
| 中文 / 描述一个症状 | `hybrid` | `zg` 的 fts + 向量 |
| `camelCase` 符号、大写错误码 | `fts` | BM25 词法 |
| `path:line`、≥16 位长 token、hash | `rg` | 直接 `rg -n -F` 扫原始 JSONL，不经 embedding |

### 脱离 pi 直接用

CLI 不依赖 pi。在克隆目录里：

```bash
Z=./extensions/zg-memory/zgmem.py     # 通过 pi 安装后则在 ~/.pi/agent/git/github.com/happyTonakai/pi-zg-mem/extensions/zg-memory/zgmem.py

python3 $Z query "codegraph 和 zvec-grep 有什么区别" --top 3
python3 $Z query "上次那个报错码" --mode rg
python3 $Z query "上周说过什么" --since 7
python3 $Z query "..." --workspace all           # 跨所有 workspace
python3 $Z query "..." --json                    # 结构化输出（含 ref 与时间戳）

python3 $Z show <session> <corpus_line> --full    # 单条原始记录
python3 $Z ctx  <session> <corpus_line> --span 5  # 前后上下文
python3 $Z sessions                               # 列出已索引会话
python3 $Z refresh --sessions-dir <dir>           # 增量刷新
```

在 pi 里则用 `/zgmem refresh`、`/zgmem reindex`、`/zgmem sessions`。

## 最有意思的工程问题：为什么刷新很便宜

`zg index` 的变更判定粒度是**文件**——变了的文件整体重嵌。这对文档库没问题，但对一个持续增长的会话日志是灾难：最朴素的布局（"一个 session 一个 `.txt`"）会导致每轮都重嵌整个历史。

实测：723 KB 的会话，追加 3 个字节 → **6.7 秒**，且随会话长度线性增长。

所以会话被**分片**，并且只允许最后一片变化：

| | |
| --- | --- |
| **冻结片** | 切出一次，永不再改；`mtime` 钉在首条消息时间。`zg` 认为它没变，此后永远跳过。 |
| **尾片** | 每个 session 至多一个；新消息追加进这里。每轮唯一会被重嵌的文件。 |
| **阈值** | `ZGMEM_SEG_ROWS`（默认 200 行）/ `ZGMEM_SEG_BYTES`（默认 64 KB），任一先到即冻结该片。 |
| **配对边界** | 切点不会把 user 问句和它的回答拆开。 |
| **崩溃安全** | 既有前缀哈希 + offset 续读，**也**校验尾片末行与 manifest 记的 `last_jsonl_line` 一致；不一致就整会话重建。 |

结果是每轮成本与历史总量解耦——只跟尾片相关。

| 场景（作者本机，`local/potion-multilingual-128m`） | 改造前 | 改造后 |
| --- | --- | --- |
| 4.2 MB / 259 条消息的会话，追加 3 条消息后刷新 | 整会话重写 + 重嵌（数秒，且随会话增长） | **4.6 秒**（其中约 4 秒是 `zg` 固定启动开销；尾片仅 21 KB） |
| 首次迁移：32 个会话 / 12 MB JSONL | — | **7.7 秒**（一次性） |
| 78 个会话 / 74 MB JSONL | — | **9 秒**（一次性） |

稳态下每轮：ETL `0.05 秒` + `zg index` 增量（约 4 秒模型加载 + 仅尾片）；单次查询约 1 秒；无变化时刷新 `0.04 秒` 秒退。

**下界就是约 4–5 秒。** 因为每次调 `zg` 都要重新加载 embedding 模型。想再低，就得做 fragment 级向量复用，那需要改上游 `zg` 的索引格式——本项目有意不做。完整的 v1→v2 推导与实测数据见[深入文档](extensions/zg-memory/README.md)。

## 维护是自动的

扩展订阅了 pi 的生命周期，所以索引不会烂掉：

- **`agent_settled`** —— 每轮对话彻底结束后在后台刷新：重扫 sessions 目录，与 manifest 里的 `mtime`/`size` 对比，**只重跑有变化的** JSONL（包括被恢复重写的旧会话），再增量更新 `zg` 索引。无变化时秒退。
- **`session_start`** —— 懒初始化；首次使用时建索引。
- **`session_shutdown`** —— 中止在跑的 `python`/`zg` 子进程，退出时不会留下孤儿进程或半写状态。

被删除、归档的会话自动从语料中移除（它们的向量由 `zg index` 一并清掉，实测 `1 deleted`）。

## 隐私

它会索引你的**全部会话历史**——包括 thinking 和工具调用，而这些内容里经常有密钥、token、私有路径和公司代码。

- 数据不出本机：不联网、本地 embedding 模型、本地索引。
- 数据放在本仓库之外：`~/.pi/agent/zgmem/<workspace>/`（可用 `ZGMEM_DIR` / `ZGMEM_SCOPE` 覆盖）。它是明文索引——**永远不要提交它**，并把该目录视为和 `~/.pi/agent/sessions/` 同等敏感。

## 现状、边界与后续

**已完成并验证：** ETL、混合 + 精确召回、回指深钻、增量维护、extension 工具暴露。25 个离线用例（`python3 extensions/zg-memory/tests/test_zgmem.py`），外加真机 `zg` 端到端冒烟。当前设计经过两轮独立评审，结论与修复记录在 [`docs/reviews/`](docs/reviews/)。

**已知边界**

- **只做主动召回。** 被动捕获 / 自动沉淀成长期笔记不在本版内——那是有意留的下一步。
- **每轮刷新成本有约 4 秒的下界**（`zg` 固定模型加载），即使只重嵌一个小尾片。
- **仅 macOS / Linux。** Windows（`python` vs `python3`、`zg.cmd`、路径分隔符）未处理。
- 跨 workspace 检索只覆盖初始化过的 workspace——你从未在 pi 里打开过的项目不会预先建索引。
- **不做时间衰减。** 排序是纯相关性；新旧记忆冲突由 agent 裁决，而不是排序器。
- 时间过滤粒度是会话文件（其 `mtime` 即会话开始时间），不是消息级。
- 依赖 `zg`、`rg`、`python3` 在 `PATH` 上。

## 仓库结构

```
extensions/zg-memory/
  index.ts           pi 扩展：注册 zg_memory_query / zg_memory_open + /zgmem 命令
  jsonl2corpus.py    ETL：会话 JSONL → 分片可检索语料（含 manifest、原子写、文件锁）
  zgmem_corpus.py    分片 / 配对共享库（被上面两个脚本 import）
  zgmem.py           召回与回指 CLI（query / show / ctx / sessions / refresh）
  tests/             25 个离线用例
  README.md          设计与语料格式深入说明
docs/reviews/        独立评审记录
```

## 开发

运行时不需要 npm 依赖（pi 自带 `typebox` / `pi-coding-agent`）。只有 `tsc` 类型检查需要它们：

```bash
mkdir -p extensions/zg-memory/node_modules
ln -s "$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/@earendil-works" \
      extensions/zg-memory/node_modules/@earendil-works
ln -s ../../@earendil-works/pi-coding-agent/node_modules/typebox \
      extensions/zg-memory/node_modules/typebox
```

Python 侧除标准库外无依赖，直接跑即可：

```bash
python3 extensions/zg-memory/zgmem.py --help
python3 extensions/zg-memory/tests/test_zgmem.py
```

## 许可

[MIT](LICENSE)
