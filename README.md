# pi-zg-mem

[![License](https://img.shields.io/github/license/happyTonakai/pi-zg-mem)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#install)
[![Made for pi](https://img.shields.io/badge/made%20for-pi-8A2BE2)](https://pi.dev)
[![Requires zvec-grep](https://img.shields.io/badge/requires-zvec--grep%20%28zg%29-blue)](https://github.com/zvec-ai/zvec-grep)

> **English** · [中文](README.zh.md)

**Cross-session memory for the [pi](https://pi.dev) coding agent.** Your session history is write-only by default — it piles up on disk and nobody ever reads it again. This makes all of it searchable, and lets the agent drill back into the original transcript when it needs the details.

Two tools, backed by [`zvec-grep`](https://github.com/zvec-ai/zvec-grep) (`zg` — ripgrep + BM25 + multilingual embeddings):

| Tool | What it does |
| --- | --- |
| `zg_memory_query` | Recall across every past session — semantic *or* literal. Returns top-N **conversation pairs** (the matching message plus its partner), each with a `ref`. |
| `zg_memory_open` | Drill into a hit: the raw JSONL record (thinking, tool calls, full text) or the conversation around it. |

Everything runs locally: no cloud, no API keys, no telemetry. The embedding model runs in-process on your machine.

## The problem

You ask "how did we fix that flaky auth test?" and the agent has no idea — that was three weeks and forty sessions ago.

- **Sessions are write-only.** `pi --resume` lists recent sessions by first prompt. Finding a *topic* from last month means opening files one by one.
- **`rg` over JSONL is literal only.** It works if you remember the exact identifier. It cannot find the conversation where you described the symptom in different words — or in Chinese, or mixed.
- **The interesting part is never in the summary.** What you actually want is that one assistant message, its reasoning, and the tool call it made. That lives in the JSONL, buried in thousands of lines of noise.

## What a recall looks like

```
> you:  we hit that index-staleness bug again — how did we fix it last time?

  zg_memory_query("index staleness lease rebuild")        ← agent decides to recall
  → 3 hits, 2 sessions, 2026-09-18 … 2026-09-22

  zg_memory_open(session=…, corpus_line=…, mode=ctx)      ← drills into the hit
  → the real conversation: the wrong first attempt, the review comment
    that found it, and the fix that shipped
```

*(trimmed output; the real thing returns full text. This is the shape of the interaction, not a canned transcript.)*

The point is that the second step is **lossless**. `zg` is only the discovery layer — it holds clean text for ranking. Everything you ask for afterwards is read straight out of the original JSONL, so timestamps, thinking blocks and tool calls are all still there.

## How it works

```
~/.pi/agent/sessions/**/*.jsonl     raw sessions (complete: timestamps / roles / thinking / tool calls)
        │
        │  jsonl2corpus.py     clean: keep user+assistant text, drop the noise
        ▼
~/.pi/agent/zgmem/<workspace>/corpus/     clean corpus, sharded per session
        │        <session>.p0001.txt, p0002, … + one unfrozen tail shard
        │        one line per message: <jsonl_line>\t<role>\t<time>\t<text>
        │
        │  zg index             hybrid embeddings + BM25, re-embeds changed files only
        ▼
zg_memory_query  ──►  the agent recalls (conversation pair + ref)
zg_memory_open   ──►  drill back into the JSONL (thinking / tool calls / surrounding context)
```

**Design principles**

1. **`zg` is a discovery layer; the JSONL is the source of truth.** The corpus only holds the clean text needed for ranking. Recall returns a `(session, corpus_line)` pointer and the drill-down reads the original file — deep detail never depends on what the index happened to store.
2. **Structure lives in the filesystem.** A session is split into shards at `user`-turn boundaries (so a question and its answer never get separated), filenames encode order, and each shard's `mtime` is pinned to the timestamp of its **first** message. That turns `zg --modified-after/--before` into semantic-time filtering for free. More importantly, it makes incremental cost **bounded**: see below.
3. **Pure relevance ranking, no time decay.** A memory system that "forgets" contradicts its own purpose. Ranking is just `1/rank` from `zg`; every hit carries a timestamp, and the agent arbitrates when old and new memories disagree.
4. **Workspaces are derived, not configured.** The index is keyed by session directory, so every project gets its own isolated memory automatically.

## Install

**Prerequisites**

| Need | Why | Check |
| --- | --- | --- |
| [`pi`](https://pi.dev) | host agent | `pi --version` |
| [`zvec-grep`](https://github.com/zvec-ai/zvec-grep) | the search engine (`zg`) | `npm i -g @zvec/zvec-grep && zg --version` |
| `rg` (ripgrep) | literal-mode search | `rg --version` |
| `python3` | the ETL + CLI | `python3 --version` |

```bash
pi install git:github.com/happyTonakai/pi-zg-mem
pi list          # confirm the package is registered
```

Then `/reload` (or restart pi). From a local clone, `pi install /absolute/path/to/pi-zg-mem` works too.

> **Don't keep two copies.** If you also have a `~/.pi/agent/extensions/zg-memory/` directory, the tools get registered twice. Keep exactly one.

**First run.** Nothing to build: on the first query (or the first `session_start`) the index is built in the background for the current workspace. A large history takes seconds — 78 sessions / 74 MB of JSONL measured **9 s** end-to-end. `session_start` never blocks; a query that arrives during the build waits on the same in-flight job.

**Verify it works**

```bash
python3 extensions/zg-memory/tests/test_zgmem.py     # 25 offline tests, no network, no zg needed
```

## Usage

### From the agent

`zg_memory_query`:

| Param | Meaning |
| --- | --- |
| `query` | Question or keywords. Exact tokens work too. |
| `top_k` | Number of pairs (1–10, default 3) |
| `scope` | `all` = whole index · `current` = this session only |
| `who` | Restrict the matching message to `user` or `assistant` |
| `since_days` | Only sessions started within the last N days |
| `workspace` | Workspace name, or `all` to fan out and merge every initialized workspace |
| `mode` | `auto` / `hybrid` / `fts` / `rg` — see below |

`zg_memory_open`: `session` + `corpus_line` (from a hit's `ref`), `mode=full` (the raw record) or `mode=ctx` (surrounding conversation, `span` messages either side).

The agent also gets a [skill](skills/zg-memory/SKILL.md) telling it **when** to reach for memory — and when not to (a keyword you already know is usually faster with `rg`).

**`mode=auto` routes by query shape**, which is what makes this reliable rather than merely fuzzy:

| Query looks like | Route | Mechanism |
| --- | --- | --- |
| Chinese / a described symptom | `hybrid` | `zg` fts + embeddings |
| `camelCase` symbol, uppercase error code | `fts` | BM25 lexical |
| `path:line`, ≥16-char token, hash | `rg` | literal `rg -n -F` over the raw JSONL, no embedding involved |

### From the shell

The CLI works without pi. From a clone:

```bash
Z=./extensions/zg-memory/zgmem.py     # or ~/.pi/agent/git/github.com/happyTonakai/pi-zg-mem/extensions/zg-memory/zgmem.py when installed via pi

python3 $Z query "codegraph vs zvec-grep" --top 3
python3 $Z query "that error code from last week" --mode rg
python3 $Z query "what did we say last week" --since 7
python3 $Z query "..." --workspace all           # across every workspace
python3 $Z query "..." --json                    # structured output, with ref + ts

python3 $Z show <session> <corpus_line> --full    # one raw record
python3 $Z ctx  <session> <corpus_line> --span 5  # surrounding conversation
python3 $Z sessions                               # list indexed sessions
python3 $Z refresh --sessions-dir <dir>           # incrementally refresh
```

Inside pi, `/zgmem refresh`, `/zgmem reindex` and `/zgmem sessions` do the same.

## The interesting engineering: why refresh is cheap

`zg index` decides staleness **per file** — a file that changed gets re-embedded *whole*. That is fine for a document store and terrible for a growing session log: the naive layout ("one `.txt` per session") re-embeds the entire history every single turn.

Measured on a 723 KB session, appending 3 bytes cost **6.7 s**, growing linearly with the session.

So sessions are **sharded**, and only the last shard is ever allowed to change:

| | |
| --- | --- |
| **Frozen shards** | Cut once, never rewritten; `mtime` pinned to their first message. `zg` sees them as unchanged and skips them forever. |
| **Tail shard** | At most one per session; new messages append here. This is the only file that gets re-embedded per turn. |
| **Thresholds** | `ZGMEM_SEG_ROWS` (default 200 rows) / `ZGMEM_SEG_BYTES` (default 64 KB) — whichever trips first freezes the shard. |
| **Pair boundaries** | Splits never separate a user turn from its answer. |
| **Crash safety** | Prefix hashing + offset resume *and* a check that the tail shard's last line matches the manifest's `last_jsonl_line`; otherwise the session is rebuilt. |

Result: per-turn cost is decoupled from history size — it depends only on the tail shard.

| Scenario (author's machine, `local/potion-multilingual-128m`) | Before | After |
| --- | --- | --- |
| 4.2 MB / 259-message session, append 3 messages, refresh | whole-session rewrite + re-embed (seconds, growing) | **4.6 s** (of which ~4 s is fixed `zg` startup; the tail shard was 21 KB) |
| First migration, 32 sessions / 12 MB JSONL | — | **7.7 s**, one time |
| 78 sessions / 74 MB JSONL | — | **9 s**, one time |

Steady state per turn: ETL `0.05 s` + incremental `zg index` (~4 s fixed model load + the tail shard only); a single query is ~1 s; when nothing changed, refresh exits in `0.04 s`.

**The floor is ~4–5 s.** Every `zg` call reloads the embedding model. Going below that means fragment-level vector reuse, which requires changing `zg`'s index format upstream — deliberately not done here. See [the deep dive](extensions/zg-memory/README.md) for the full v1→v2 rationale and numbers.

## Maintenance is automatic

The extension subscribes to pi's lifecycle, so the index does not rot:

- **`agent_settled`** — after each turn settles, refresh in the background: rescan the sessions directory, compare `mtime`/`size` against the manifest, and re-run only the JSONL files that changed (including rewritten/resumed sessions). Then update the `zg` index incrementally. No-ops are instant.
- **`session_start`** — lazy init; builds the index on first use.
- **`session_shutdown`** — aborts in-flight `python`/`zg` child processes, so a quit never leaves orphan processes or half-written state.

Deleted and archived sessions drop out of the corpus (their vectors are removed by `zg index`; measured as `1 deleted`).

## Privacy

This indexes **all of your session history** — including thinking blocks and tool calls, which routinely contain secrets, tokens, private paths and proprietary code.

- Nothing leaves your machine: no network calls, local embedding model, local index.
- The data lives outside this repo, in `~/.pi/agent/zgmem/<workspace>/` (override with `ZGMEM_DIR` / `ZGMEM_SCOPE`). It is indexed plaintext — **never commit it**, and treat that directory as sensitive as `~/.pi/agent/sessions/` itself.

## Status, limits, roadmap

**Working and tested:** the ETL, hybrid + exact recall, drill-down, incremental maintenance, the extension surface. 25 offline tests (`python3 extensions/zg-memory/tests/test_zgmem.py`), plus a real-`zg` end-to-end smoke test. The current design went through two rounds of independent review; findings and fixes are in [`docs/reviews/`](docs/reviews/).

**Known limits**

- **Recall only.** Passive capture / automatic summarization into durable notes is not in this version — it's the deliberate next step.
- **Per-turn refresh cost has a ~4 s floor** (fixed `zg` model load), even when re-embedding only a small tail shard.
- **macOS / Linux only.** Windows (`python` vs `python3`, `zg.cmd`, path separators) is unhandled.
- Cross-workspace search covers only workspaces that have been initialized — projects you never opened in pi are not pre-indexed.
- **No time decay.** Ranking is pure relevance; conflicting old/new memories are resolved by the agent, not by the ranker.
- Time filtering granularity is the session file (its `mtime` is the session start), not individual messages.
- Needs `zg`, `rg`, `python3` on `PATH`.

## Repository layout

```
extensions/zg-memory/
  index.ts           pi extension: registers zg_memory_query / zg_memory_open + the /zgmem command
  jsonl2corpus.py    ETL: session JSONL → sharded, searchable corpus (+ manifest, atomic writes, locking)
  zgmem_corpus.py    sharding / pair-matching shared library (imported by both)
  zgmem.py           recall + drill-down CLI (query / show / ctx / sessions / refresh)
  tests/             25 offline tests
  README.md          design + corpus format deep dive
skills/zg-memory/    agent-facing usage guidance
docs/reviews/        independent review records
```

## Development

No runtime npm dependencies (pi provides `typebox` / `pi-coding-agent`). Only `tsc` type-checking needs them:

```bash
mkdir -p extensions/zg-memory/node_modules
ln -s "$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/@earendil-works" \
      extensions/zg-memory/node_modules/@earendil-works
ln -s ../../@earendil-works/pi-coding-agent/node_modules/typebox \
      extensions/zg-memory/node_modules/typebox
```

The Python side needs nothing but the standard library — run it directly:

```bash
python3 extensions/zg-memory/zgmem.py --help
python3 extensions/zg-memory/tests/test_zgmem.py
```

## License

[MIT](LICENSE)
