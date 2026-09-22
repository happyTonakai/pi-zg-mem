审查完毕。所有结论都有实测证据（沙箱 `/tmp/zgb3..6`、`/tmp/zgpin`、`/tmp/zgprobe2`、真实 workspace `/tmp/zge2e`）。

---

# 总评：**BLOCK**（1 个静默数据/语义错误 + 1 个可永久卡死会话与整 workspace 索引的缺陷 + 1 个会删用户文件的迁移清理）

核心机制（分片、全局行号、prefix 续读、原子写、flock）设计是站得住的——我重点验证了"重建后 ref 是否稳定""无 prefix_sha 是否丢历史""并发是否损坏语料"，结论都是**安全**（详见文末"已验证 OK"）。问题集中在**错误处理/失败传播**和**zg 命中的粒度契约**上。

---

## HIGH

### H1 分片 seq 分配器只有 257 个号 → ETL 半途崩溃，且被吞成 exit 0，留下不一致 manifest 和永久无法摄入的会话
`jsonl2corpus.py:288-296`、`zgmem_corpus.py:364-367`

```python
# zgmem_corpus.py:364-367
return itertools.chain([tail_seq],
    range(max(max_seq, tail_seq) + 1, max(max_seq, tail_seq) + 1 + 256))   # ← 只有 257 个号
# jsonl2corpus.py:214/217  next(seqs)  → 第 258 次 StopIteration
# jsonl2corpus.py:288-293  每会话 try/except Exception 只 print("ETL 失败 …") 然后 continue
# jsonl2corpus.py:296      zc.save_manifest(mpath, man)   ← 失败后照样落盘
```

复现（6.8MB / 52,000 行 jsonl，默认 200 行/片 → 需要 260 片）：

```
  ETL 失败 /tmp/zgb6/big.jsonl:            ← 异常信息为空（StopIteration）
manifest v2: 0 sessions / 257 segments -> /tmp/zgb6/manifest.json
true exit=0                                 ← 关键：退出码 0
磁盘：big.p0001..p0257.txt 共 257 个文件；manifest.sessions 为空、segments 有 257 条（孤儿）
重跑：同样崩溃 → 永久
```

后果链：
1. `cmd_refresh` 用 `out.returncode != 0` 判失败（`zgmem.py:177-181`）→ **永远判不出来**；`if changed and etl_fail == len(changed) and not deleted`（`:183-185`）是死代码。
2. 实测走真实 refresh：`变更 1 个` + `索引已更新 (1 changed, 0 deleted)`，exit 0 —— **全链路报成功，实际该会话 0 条入语料**。
3. 因为 `sessions` 里没条目，该 jsonl 每次都算"变更"→ 每次 refresh 都重崩；若它是本轮唯一变更，workspace 索引从此不再更新（虽然 guard 是死代码，但 ETL stdout 被丢弃、索引照跑，语料永远缺这个会话）。
4. `seq > 9999` 时 `seg_name` 产出 5 位数字，`_SEG_RE`（`zgmem_corpus.py:36`）`\d{4}` 不再匹配 → 该片对 `parse_seg` 隐形，且被 `is_legacy_name` 认成 legacy（→ 迁移时会被当垃圾删）。

最小修法：
```python
# zgmem_corpus.py:367
return itertools.chain([tail_seq], itertools.count(max(max_seq, tail_seq) + 1))
# zgmem_corpus.py:36
_SEG_RE = re.compile(r"^(?P<sid>.+)\.p(?P<seq>\d{4,})\.txt$")
# jsonl2corpus.py:288-296  失败不许静默：收集 failed，任一失败 → sys.exit(1)，且失败时不 save_manifest
```

### H2 ref 取的是 zg 命中窗口的**起始行**，不是命中行 → query/show/ctx 的回指系统性错位（最大偏移=整个窗口）
`zgmem.py:365-377`

```python
m = re.search(r"([0-9A-Za-z_.-]+\.txt):(\d+)", s)      # :365  只取冒号后第一个数字
gline = (meta.get("start_corpus_line") or 1) + int(cstart) - 1   # :377
```

zg 的实体粒度是**多行窗口**，输出是窗口区间 `file.txt:64-100`，并把窗口首行当预览回显。实测（120 行语料，唯一标记只出现在第 80 行）：

```
#1 matchedBy=fts+vector big.p0001.txt:64-100     entities=4
64	64	user	1	填充内容 第64行 关于索引分片          ← 区间起点，不是命中行
```
小文件整个文件就是一个实体：5 行文件 → `doc.txt:1-5`。我的所有 workspace 里 harness 的 query 都返回**会话第一条消息**（`line=1`），与此完全一致。

影响：agent 拿到的 pair 和它能喂给 `show/ctx` 的 `ref.corpus_line` 指向命中窗口的第一条消息，偏移可达窗口长度（默认 200 行/片时可到 200 行）。`show/ctx` 本身没错——是输入行号错。这直接违反"ref 必须能回指到同一条"的设计要求。

最小修法：解析完整区间并定位行：
```python
m = re.search(r"([0-9A-Za-z_.-]+\.txt):(\d+)(?:-(\d+))?", s)
lo, hi = int(m.group(2)), int(m.group(3) or m.group(2))
# 在 [lo,hi] 内按 query token 覆盖率挑行（BM25-ish 十行代码），或整段返回/打印区间让 agent 用 ctx --span 深钻
```
备选：`zg query --trace`（"Include per-hit indexed search trace"）看能否直接给命中 offset；`zg query --help` 里没有其它行级选项，`--preview none` 恰好把能定位的信息丢掉了。

### H3 `migrate_cleanup()` 会删掉语料目录里任何非隐藏 `.txt`
`jsonl2corpus.py:256` + `zgmem_corpus.py:55-58`

```python
if zc.parse_seg(b) or zc.is_legacy_name(b):   # is_legacy_name = 任意 *.txt 且不是分片名
    if b not in refs: os.unlink(...)
```

实测（`/tmp/zgmig`）：

```
deleted count: None
survivors: ['.keep.p0002.txt', 'keep.p0001.txt']
=> notes.txt deleted?  True        ← 用户放的无关 txt 被删；orphan.p0003.txt、a1b2…txt 同删
```

触发：任何 v1 manifest（= 每个存量用户第一次升级必跑一次，`jsonl2corpus.py:276-283/297-298`）或 manifest 损坏成非 dict。修法：删除条件必须绑定"这个文件名属于某个已知 session"：
```python
seg = zc.parse_seg(b); sid = seg[0] if seg else (b[:-4] if b.endswith(".txt") else None)
if sid and sid in zc.sessions(man) and b not in refs: os.unlink(...)
```
（另外 `migrate_cleanup` 返回 `None`，调用方拿不到删除数，顺手 `return n`。）

---

## MED

### M1 `_tail_consistent()` 把"jsonl 末行不产语料行"误判成损坏 → 尾片追加的常见路径退化成全会话重建
`jsonl2corpus.py:107-115`（配合 `row_of` 丢弃 toolResult / 纯 toolCall / 纯 thinking 行，`jsonl2corpus.py:31-47`）

`last_jsonl_line` 逐行前进（含不产语料行的行），却拿它跟"尾片最后一条**语料**行的 jsonl_line"比对。于是只要会话文件末尾是工具结果/工具调用（agent 干活时的常态），下次 ETL 一律 `can_continue → None → drop_session_segments + 全量重建`。

实测（zgf1，模拟真实 pi 事件流 10 次追加）：

```
 1 user text          -> rebuild
 3 toolResult recv    -> rebuild
 4 assistant text     -> rebuild      ← 级联
 9 toolResult recv    -> rebuild
10 assistant text     -> rebuild      ← 级联
```
4/10 次追加触发全量重建。成本侧我做了澄清验证：冻结片内容+mtime 不变 → zg 只重嵌尾片（`/tmp/zgpin`：追加后把 mtime 钉回原值，zg 仍报 `1 modified` 且标记可查 → 钉 mtime **不影响**变更检测）。所以损失是 ETL 侧全会话重解析/重写 + M4 的删除窗口，而不是重嵌——但"成本与历史总量解耦"在活跃会话上不成立，且这个 rebuild 在 `cmd_refresh` 里**看不见**（成功时不打印 ETL 的 `rebuild/inc` 状态行，`zgmem.py:177-181` 只在失败时 print）。

修法：manifest 里记 `last_row_jsonl_line`（最后一条产出语料行的 jsonl 行号），`_tail_consistent` 改比它；`last_jsonl_line` 仍留给续读偏移用。顺带在 `cmd_refresh` 成功时打印 ETL 状态行。

### M2 "无变化"早退把索引步骤也一起跳过 → 索引缺失/上轮失败后永久不修复
`zgmem.py:165-167`、`:187-199`

```
$ rm -rf /tmp/zgb3/w/corpus/.zvec-grep
$ zgmem.py refresh --sessions-dir … --workspace w
无变化, 无需更新                      ← exit 0
$ zgmem.py query --workspace w -- 内容条目
Error: No zvec-grep index found for this workspace / ZVEC_GREP.ENGINE.SERVICE.WORKSPACE_INDEX_NOT_FOUND
```
并发场景同理：两个 refresh 同时跑，输家 `zg index` 报 `ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE`，但 `cmd_refresh` 打一行 `zg index失败:` 之后**照样**打印 `索引已更新 (1 changed, 0 deleted)` 并 exit 0；此后每轮都是"无变化"，索引永久落后于语料。

修法：把早退改成"且索引存在"：
```python
if not changed and not deleted and os.path.exists(os.path.join(CORPUS_DIR, ".zvec-grep", "index.zvec")):
    print("无变化, 无需更新"); return
```
并把 `zg index` 失败变成非零退出 + 打印"索引未更新（下轮会重试）"，别报"索引已更新"。

### M3 `ZGMEM_SCOPE` 未经校验就拼路径（`use_workspace` 校验了，派生路径没校验）
`zgmem.py:26-32`（对照 `:69` 的 `re.fullmatch(r"[A-Za-z0-9._-]+", ws) or ".." in ws` 拒绝）

`SCOPE_DIR = _derive_workspace()` 直接返回 `os.environ["ZGMEM_SCOPE"]`，而 `CORPUS_DIR` 在 argparse 之前就由它拼出。`ZGMEM_SCOPE=../../x` 会让所有命令（含会 `unlink` 的 `migrate_cleanup`、`drop_session_segments`）作用到 `ZGMEM_HOME` 之外。修法：在 `_derive_workspace` 里复用同一正则/`..` 检查，不合法就退回 `"github"`。

### M4 重建先删后写：并发读者看到语料文件缺失，崩溃窗口留下悬空 ref
`jsonl2corpus.py:157-168` + `:128-137`（`drop_session_segments` 先 unlink 所有分片，之后才 `write_chunk`），manifest 直到 `:296` 才落盘。

窗口内：并发 `zg index`/query 看不到文件；进程在此被杀 → 盘上 manifest 仍指向已删文件，`read_segment` 空 → query 命中被丢、`show/ctx` 打 "bad corpus line"，直到下一轮 refresh（此时 jsonl mtime 与 manifest 不符 → 会重建，能自愈，所以不是永久损坏）。修法：新片写 tmp 后 `os.replace` 覆盖，**删旧片放到 manifest 落盘之后**。

### M5 `split_point` 的配对边界循环可让片无限超字节上限
`zgmem_corpus.py:307-325`

```python
while cut < len(rows) and rows[cut - 1][1] == "user":
    cut += 1
```
只要末尾是 user 行就继续往后吃（pi 会出现连续 user 行），且每多吃一条 assistant 行都不看大小 → 一个"长问句+长回答"，或一串连续 user 行，会让单片远超 `ZGMEM_SEG_BYTES`（我的 120 行夹具被 zg 切成 4 个实体，单实体已含数十行）。它同时决定 zg 的实体粒度 → 直接放大 H2 的偏移和每次重嵌成本。安全性没问题（`cut` 严格递增、`cut ≤ len(rows)`、单行超限时 `cut=1`，不会越界/死循环）。

修法：记下扩边界前的 `cut0`，扩完后若 `nbytes` 仍超过硬上限（如 `max(2*MAX_SEG_BYTES, MAX_SEG_BYTES + 最大单行字节)`）就回退到 `cut0`（宁可拆开一对）。附带两个小问题：外层 `while True` 每次对剩余 rows 重算 `sum(row_bytes(r))`（O(块数×字节) 的重复 UTF-8 编码，重建时可观）；`len(rows) < MAX_SEG_ROWS` 使得正好 MAX_SEG_ROWS 行也强制切。

---

## LOW

- **L1** `zgmem.py:273-303`：`_pair_from_jsonl` 兜底返回 `ref.corpus_line = 0`（`:295`），这种 ref 无法被 `show/ctx` 解析（`find_segment` 找不到含 0 的片 → "bad corpus line"）。pair 里已带正文，影响有限；建议注解 `0 = 不可寻址`，或让 show/ctx 在 corpus_line=0 时用 `jsonl_line` 兜底。
- **L2** `jsonl2corpus.py:276`：`legacy = raw is not None and version != 2` —— manifest **文件不存在**时不走迁移分支，也不调 `migrate_cleanup`，于是残留的 v1 `<sid>.txt` 永远留盘、被 zg 索引、却被 `zgmem.py:366` 的 `in zc.segments(MANIFEST)` 静默过滤 → 白烧 embedding 预算的隐形重复。
- **L3** 静默 `except OSError`：`jsonl2corpus.py:66,71`（`scan` 打不开/seek 失败 → 直接 return，会话被当空文件重建并写入 `rows=0, last_offset=0`，中间的 query 会看到空会话）、`:136`（unlink 失败 → 孤儿分片日后变隐形重复）、`:259`。建议至少 stderr 告警。
- **L4** `zgmem_corpus.py:36` 的正则贪婪 `(?P<sid>.+)`：session 名里含 `.pNNNN`（`zgmem.py:307` 的 `--session` 校验是允许点号的）时，它的 legacy `<sid>.txt` 会被 `parse_seg` 认成另一个 session 的分片，`corpus_files_of`（`:370-380`）随后可能把这个文件删掉。
- **L5** 非 POSIX 下 `ManifestLock` 退化为无锁（`zgmem_corpus.py:38-41,100-108`）：两个实例并发 refresh 时 manifest 读改写会互相覆盖（丢 session 条目）。建议加 O_EXCL 锁文件兜底或明确文档化。
- **L6** `zgmem.py:435-470` `cmd_ctx` 每次把整个 jsonl 读进内存（74MB 会话 = 每次深钻全量解析；`cmd_show` 命中即停，好得多）。非本次重构引入，但它是 ref 深钻的主入口，建议流式+命中窗口。

---

## 已验证 OK（你 7 个问题里"没问题"的部分）

1. **分片边界**：`split_point` 不会越界/死循环（`cut` 严格递增、`cut ≤ len(rows)`）；单行超限独占一片（`cut=1`）。
2. **seq 不冲突**：`max(max_seq, tail_seq)+1`；尾片沿用自身 seq 覆盖旧尾片文件，而 `tail_rows` 在写之前已读出（`jsonl2corpus.py:186-198`）——正确。尾片被整体吃进冻结片时先写冻结片（复用尾片名）覆盖，`elif not chunks: os.unlink` 只在空会话路径触发，无害且容错 OSError。
3. **无尾片时 `_tail_consistent → True` 安全**：有数据的会话最后一定留开放尾片（末尾 `rest` 恒 `frozen=False`，`:217`），"无尾片"只可能是还没行；之后追加走 `tail_seq = max(seqs)+1`、`start_global = max(start+rows)`，编号正确且连续。
4. **重建后 ref 稳定**：`drop_session_segments` + `split_point` 对同一行集是确定性的 → 分片边界/seq/`start_corpus_line` 复现一致，旧 ref 仍指向同一 jsonl 行（唯一会重编号的触发是改 `ZGMEM_SEG_ROWS/BYTES`）。
5. **旧 manifest 无 `prefix_sha` 不丢历史**：`_prefix_hasher`（`:86-105`）对 `lo<=0 / 无 ps / size<lo` 一律 `return None` → 全量重建，绝不会"跳过已消费部分"。
6. **`start_corpus_line` 全局编号**：续读时 `start_global = tail["start_corpus_line"]`、逐片 `+= len(chunk)`；`find_segment/local_line_of/corpus_row/pair_for_global/read_window` 语义一致、跨片配对正确。
7. **并发不损坏数据**：两个 refresh/`zg index` 实测（`/tmp/zgb4`）语料最终正好 8 行、无重复，manifest `last_offset/rows` 一致；flock + 原子 `os.replace` + 锁内 `load_manifest` 有效。丢的是索引步骤（M2），不是损坏。
8. **删除路径**：`cmd_refresh` 把 prune manifest 放在早退之前（`:157-171`，注释也写了这个意图），删文件+删 manifest 条目+随后 `zg index` 能出 "N deleted"，无悬空引用。
9. **安全**：全部子进程 list-form、无 `shell=True`（`zgmem.py:177,189,230,350`）；`use_workspace` 校验 workspace 名（`:69`）；`--session` 进 rg glob 前校验（`:307`）且用 `-e`/`--glob basename` 隔离；session id 不含 `/`；`clean_text`（`jsonl2corpus.py:26-28`）压缩空白，消息无法注入 TSV 列/行。唯一路径穿越口是 M3。
10. **`query --workspace all`**：逐 workspace 跑 zg、`ref.workspace` 标注、按 `(session, jsonl_line)` 去重（与 corpus line 在会话内 1:1）、坏 workspace 在 all 模式下跳过、排序稳定（同相关度按 `list_workspaces()` 序）。相关度在每个 workspace 内重新从 `1/(order+1)` 起算，跨 workspace 平局是任意但确定的。

---

## 覆盖盲区（建议补测）

- **H2 是最大的未测假设**：现有测试只验证了"ref 能解析到一条 jsonl"，没验证"解析到**命中的那条**"。
- 单轮 >256 片（H1）、ETL 中途被 kill（M4）、`ZGMEM_SEG_ROWS/BYTES` 改动后的 ref 重编号、非 POSIX 无 flock（L5）均无测试。
- 两个 **pi 实例**（而非两个 CLI）同时 refresh 未测；TS 侧 `enqueue` 是进程内的，跨进程仍只有 manifest flock（`zg index` 阶段无跨进程锁 → M2）。最小修法：在 `zg index` 外再套一个 workspace 级 flock（与 manifest 同一把或 `<ws>/.zg.index.lock`），失败时让本轮 refresh 非零退出并保证下轮重试。

**建议修复顺序**：H1（会卡死会话+静默失败）→ H3（删用户文件）→ H2（召回质量，需先跟 zg 契约对齐）→ M2（索引永不修复）→ M1/M4/M5。