# pi-zg-mem

给 [pi](https://pi.dev) coding agent 用的**跨 session 记忆**扩展：把 pi 的历史会话 JSONL 做成可语义检索的本地语料，
用 [zvec-grep](https://github.com/zvec-ai/zvec-grep)（`zg`：ripgrep + BM25 + 向量混合索引）建索引，
agent 通过两个工具主动召回以前的对话；命中后可以按 `(session, corpus_line)` 回指原始 JSONL 深钻（含 thinking / 工具调用）。

## 结构

```
extensions/zg-memory/
  index.ts           pi 扩展入口：注册 zg_memory_query / zg_memory_open + /zgmem 命令
  jsonl2corpus.py    ETL：pi 会话 JSONL → 可检索语料（分片、增量续读、原子写）
  zgmem_corpus.py    分片/配对共享库（被上面两个脚本 import）
  zgmem.py           检索与回指 CLI（query / show / ctx / sessions / refresh）
  README.md          设计与数据格式说明
skills/zg-memory/
  SKILL.md           面向 agent 的使用指引
docs/reviews/        历次代码评审记录
```

数据（语料 + manifest + 索引）不在本仓库内，默认落在 `~/.pi/agent/zgmem/<workspace>/`，
可用环境变量 `ZGMEM_DIR` / `ZGMEM_SCOPE` 覆盖。

## 安装

```bash
pi install ~/joyspace/pi-extensions/pi-zg-mem   # 本地路径，pi 直接引用不拷贝
pi list                                        # 确认已加入 settings
```

安装后 `/reload`（或重启 pi）生效。注意：**不要**同时保留一份 `~/.pi/agent/extensions/zg-memory/`
的副本，否则工具会重复注册。

## 开发

运行时不需要 npm 依赖（pi 自带 typebox / pi-coding-agent）。只有 `tsc` 类型检查需要它们：

```bash
mkdir -p extensions/zg-memory/node_modules
ln -s "$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/@earendil-works" \
      extensions/zg-memory/node_modules/@earendil-works
ln -s ../../@earendil-works/pi-coding-agent/node_modules/typebox \
      extensions/zg-memory/node_modules/typebox
```

python 侧直接用 `python3 extensions/zg-memory/zgmem.py --help` 调试即可（脚本自带 argparse）。

## 评审

- `docs/reviews/2026-09-22-planA-python-reviewer.md` —— 对"语料分片 + 增量建索引"重构的独立评审（结论 BLOCK：H1/H2/H3 + M1–M5 + L1–L6）。
