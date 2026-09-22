# zg-memory — pi 历史会话记忆检索（主动召回）

本扩展把 pi 的历史 session（JSONL）做成一个可语义查询的记忆层。它提供两个工具，agent 可直接调用：

- **`zg_memory_query`**：语义/关键字检索历史记忆，返回 Top-N 条"对话对"（命中消息 + 其问答伙伴），每条带 `ref`。
  参数：`query`(问题)、`top_k`、`scope=all|current`、`who=user|assistant`、`since_days`、
  `workspace`(workspace 名或 `all` 跨全部)、`mode=auto|hybrid|fts|rg`。
- **`zg_memory_open`**：对命中的一条做深钻。`mode=full` 看该条原始记录（thinking/工具调用）；`mode=ctx` 看它前后上下文对话。
  参数：`session`、`corpus_line`（来自 query 返回的 ref）、`mode`、`span`。

## 何时主动使用（给 agent）
- 想不起以前说过/做过什么、或用户说"上次/上周/以前我们说过X"。
- 需要**跨 session 的上下文**（本工作区历史所有会话）。
- 语义/模糊查找历史问题（name/关键词记不清时），比硬匹配更合适。
- **精确 token 查找**（错误码、commit hash、路径:行号、驼峰标识符）→ 也用 `zg_memory_query`：
  mode=auto 会自动路由到 fts/rg 做字面精确匹配，比纯向量召回可靠得多。
- 命中某条记忆后又想"继续往上下文看"或"看当时的思考/工具调用" → 用 `zg_memory_open` 深钻。
- 时间敏感的问题（"最近/上周说过…"）→ 用 `since_days` 硬过滤；每条命中都带时间戳，
  新旧记忆冲突由你自行裁决（本系统**不做时间衰减/遗忘**）。

## 不要过度使用
- 模糊检索有延迟（要跑 zg）；确定的历史细节（确切文件名/符号）优先用 rg/grep 直接查 JSONL。
- 不要为"当前对话刚发生的事"调用——只在需要**更早/跨会话**记忆时用。

## 维护（自动）
- 每轮对话结束（`agent_settled`）扩展会在后台**扫描 sessions 目录仅刷新有变化的 jsonl**（mtime/大小对比），
  再增量 zg 索引——被恢复重写的旧会话也会被覆盖（subagent 临时会话不在 sessions 目录内，不参与）。
- 手动：`/zgmem refresh` 增量；`/zgmem reindex` 全量重建（语料脚本变更后）。
- 增量粒度 = **尾片**（每 session 一个未冻结片，默认 ≤200 行且 ≤64KB）；冻结片永不变、不重嵌。
- 范围：workspace 按会话目录自动派生，数据存 `~/.pi/agent/zgmem/<workspace>/`。

## 架构
- **zg = 语义发现层**（干净文本索引，多语言 embedding）。
- **原始 JSONL = source of truth**（时间/thinking/工具调用都在），深钻靠回指 JSONL，不经 zg。
- 每个 session 的语料切成多片（`<session>.p0001.txt` …）＋ 1 个尾片（增量高效的关键）：新消息只进尾片，
  zg 的增量是“按文件判变更”，所以每轮只重嵌那一小片，与历史总量解耦；manifest 映射分片 ↔ JSONL 路径。