#!/usr/bin/env python3
"""
zgmem — pi 记忆查询封装 (zg 语义召回 + 回指 JSONL 深钻)
========================================================
主动记忆检索: zg 负责语义发现, 原始 JSONL 是 source of truth.

用法:
  zgmem query "<Q>" [--top k] [--who user|assistant] [--since 天数]
                   [--session <id前缀>] [--json]
      -> 语义召回, 返回 top-k 个"对话对"(命中消息 + 其对话伙伴), 带 ref

  zgmem show <session_id> <corpus_line> [--full]
      -> 深钻单条: 显示该消息的 thinking / toolCall / toolResult
         corpus_line 是 zg 命中的 corpus txt 行号
  zgmem ctx <session_id> <corpus_line> [--span N]
      -> 扩展上下文: 读该消息前后 N 条 JSONL 消息

  zgmem sessions
      -> 列出当前索引的 session
"""
import json, sys, os, glob, subprocess, argparse, datetime, time, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zgmem_corpus as zc      # 分片语料布局 + manifest v2 共享层

# ---------- 配置 ----------
ZGMEM_HOME = os.path.join(os.path.expanduser("~"), ".pi", "agent", "zgmem")
if "ZGMEM_DIR" in os.environ:
    ZGMEM_HOME = os.environ["ZGMEM_DIR"]
def _derive_workspace() -> str:
    """workspace 派生: env > PI_SESSION_FILE 会话目录 slug > 唯一已初始化 workspace > github"""
    ws = os.environ.get("ZGMEM_SCOPE")
    if ws:
        return ws
    psf = os.environ.get("PI_SESSION_FILE")
    if psf:
        slug = os.path.basename(os.path.dirname(psf)).strip("-")
        if slug:
            return slug
    try:
        avail = [n for n in os.listdir(ZGMEM_HOME)
                 if os.path.isfile(os.path.join(ZGMEM_HOME, n, "manifest.json"))]
    except OSError:
        avail = []
    if len(avail) == 1:
        return avail[0]
    return "github"

# workspace 目录 (每项目独立一个 zg 索引)
SCOPE_DIR = _derive_workspace()
CORPUS_DIR = os.path.join(ZGMEM_HOME, SCOPE_DIR, "corpus")
_mpath = os.path.join(ZGMEM_HOME, SCOPE_DIR, "manifest.json")
MANIFEST = zc.load_manifest(_mpath)
EMBEDDING = os.environ.get("ZGMEM_EMBEDDING", "local/potion-multilingual-128m")
EXT_DIR = os.path.dirname(os.path.abspath(__file__))
# zg 索引是否已建成(与 index.ts 的 indexMarker 同口径); 随 workspace 切换, 故用函数取
INDEX_MARKER_REL = os.path.join(".zvec-grep", "index.zvec")
# 命中行精修(H2): zg 只报块首行, 块内真正命中行自己找; =0 关闭
_REFINE_HITS = os.environ.get("ZGMEM_HIT_REFINE", "1") not in ("0", "false", "no")


def list_workspaces():
    """扫描 ~/.pi/agent/zgmem/* 返回已初始化(manifest 存在)的 workspace 名"""
    if not os.path.isdir(ZGMEM_HOME):
        return []
    return sorted(n for n in os.listdir(ZGMEM_HOME)
                  if os.path.isfile(os.path.join(ZGMEM_HOME, n, "manifest.json")))


def use_workspace(ws: str):
    """切换当前 workspace 的 CORPUS_DIR/MANIFEST (每个 workspace 独立一个 zg 索引)"""
    global SCOPE_DIR, CORPUS_DIR, MANIFEST
    if not re.fullmatch(r"[A-Za-z0-9._-]+", ws or "") or ".." in (ws or ""):
        raise SystemExit(f"非法 workspace 名: {ws!r}")
    mpath = os.path.join(ZGMEM_HOME, ws, "manifest.json")
    if not os.path.isfile(mpath):
        avail = ", ".join(list_workspaces()) or "无"
        raise SystemExit(f"workspace '{ws}' 未初始化 (缺 {mpath}); 已有: {avail}")
    SCOPE_DIR = ws
    CORPUS_DIR = os.path.join(ZGMEM_HOME, ws, "corpus")
    MANIFEST = zc.load_manifest(mpath)


# ---------- 读取 ----------
def corpus_meta(session_id: str) -> dict:
    return zc.sessions(MANIFEST).get(session_id)


def corpus_row(session_id: str, corpus_line: int):
    """全局 corpus 行号 -> (jsonl_line, role, ts, text); 定位失败返回 None"""
    seg = zc.find_segment(MANIFEST, session_id, corpus_line)
    if not seg:
        return None
    rows = zc.read_segment(CORPUS_DIR, seg["fname"], seg.get("start_corpus_line") or 1)
    for r in rows:
        if r[0] == corpus_line:
            return r[1], r[2], r[3], r[4]
    return None


def jsonl_path_for(session_id: str) -> str:
    m = corpus_meta(session_id)
    return m["jsonl_path"] if m else None


# ---------- 对话对构建 ----------
# 行读取/配对实现见 zgmem_corpus: read_segment / session_rows_full / pair_for_global / build_pair


def fmt_pair(p, i):
    ts = datetime.datetime.fromtimestamp(p["ts"] / 1000).strftime("%Y-%m-%d %H:%M") if p["ts"] else "?"
    u = (p["user"] or "")[:200]
    a = (p["assistant"] or "")[:300]
    header = (f"--- [{i}] {ts} [{p['ref'].get('workspace','')}] session={p['ref']['session'][:20]} "
              f"line={p['ref']['jsonl_line']} (role={p['role']})\n")
    if not u and not a:
        raw = (p.get("text") or "")[:300]
        return header + f"  RAW     : {raw}\n"
    return header + f"  USER     : {u}\n  ASSISTANT: {a}\n"


# ---------- 命令 ----------
def _prune_manifest(session_ids):
    """删除已消失 session 的 manifest 条目(v2: sessions + 其 segments)
    跨进程 flock + 原子写; manifest 损坏/非 v2 时放弃写回而非清空"""
    mpath = os.path.join(ZGMEM_HOME, SCOPE_DIR, "manifest.json")
    dead = set(session_ids)
    with zc.ManifestLock(mpath):
        disk = zc.load_manifest_raw(mpath)
        if not isinstance(disk, dict) or disk.get("version") != zc.MANIFEST_VERSION:
            print("警告: manifest 非 v2 或不可读, 跳过 prune 写回(绝不清空)")
            return
        disk.setdefault("sessions", {})
        disk.setdefault("segments", {})
        for sid in dead:
            disk["sessions"].pop(sid, None)
        for fn in [fn for fn, m in list(disk["segments"].items())
                   if isinstance(m, dict) and m.get("session_id") in dead]:
            disk["segments"].pop(fn, None)
        zc.save_manifest(mpath, disk)


def _index_marker() -> str:
    return os.path.join(CORPUS_DIR, INDEX_MARKER_REL)


def _index_stamp_path() -> str:
    """“语料已成功索引”的状态戳(我们自己的目录, 不动 zg 的 .zvec-grep)"""
    return os.path.join(ZGMEM_HOME, SCOPE_DIR, "index-stamp.json")


def _corpus_fingerprint() -> dict:
    """语料指纹(片段数/总字节/最新 mtime)

    只看“语料变没变”。总字节数是可靠的那一项: 新增消息一定让它变大。
    不能拿“语料 mtime > 索引 mtime”当陈旧判据 —— write_segment 把 mtime 钉在
    首条消息的语义时间上(可能比索引时间早得多), 那样判会漏掉新追加的尾片。"""
    files = _corpus_files()
    newest, total = 0.0, 0
    for p in files:
        try:
            st = os.stat(p)
        except OSError:
            continue
        newest = max(newest, st.st_mtime)
        total += st.st_size
    return {"files": len(files), "bytes": total, "newest_mtime": int(newest * 1000)}


def _index_stamp_ok() -> bool:
    """语料是否与“上一次成功索引”时完全一致(没戳=上轮没成功过)"""
    try:
        with open(_index_stamp_path(), encoding="utf-8") as f:
            stamp = json.load(f)
    except (OSError, ValueError):
        return False
    return stamp == _corpus_fingerprint()


def _mark_indexed(fp: dict = None):
    """记下“成功索引过的语料状态”。fp 必须由调用方在 _run_index() **之前**取好

    否则会把“索引期间别的实例写进来的语料”一并声明成已索引 -> 下一轮早退,
    那些行就永久搜不到了(评审 MED-2)。"""
    try:
        p = _index_stamp_path()
        tmp = p + f".{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_corpus_fingerprint() if fp is None else fp, f)
        os.replace(tmp, p)
    except OSError as e:
        print("警告: 索引状态戳写入失败(下轮会白跑一次 zg index):", e)


def _clear_index_stamp():
    try:
        os.unlink(_index_stamp_path())
    except OSError:
        pass


def _corpus_files():
    """语料目录里的分片文件(非隐藏)"""
    return [p for p in glob.glob(os.path.join(CORPUS_DIR, "*.txt"))
            if not os.path.basename(p).startswith(".")]


def _run_index():
    """跑 zg 增量索引 -> None=成功; "lease-active"=另一个 zg 进程在写本 root; 其它=错误文本"""
    proc = subprocess.run(["zg", "index", ".", "--embedding", EMBEDDING], cwd=CORPUS_DIR,
                          capture_output=True, text=True, timeout=300)
    if proc.returncode == 0:
        return None
    out = ((proc.stderr or "") + (proc.stdout or "")).strip()
    if "DAEMON_LEASE_ACTIVE" in out:
        return "lease-active"
    return out or f"zg index 退出码 {proc.returncode}"


def cmd_refresh(args):
    """扫描 sessions 目录, 只重跑 mtime/size 变化的 jsonl(ETL 内部再前缀校验+增量续读), 然后 zg 增量索引"""
    import glob as _glob
    sessions_dir = args.sessions_dir or os.path.dirname(os.environ.get("PI_SESSION_FILE", ""))
    if not sessions_dir or not os.path.isdir(sessions_dir):
        print("no sessions dir"); return
    changed = []
    deleted = []
    now_m = {}
    sess_map = zc.sessions(MANIFEST)
    skipped = []
    for p in sorted(_glob.glob(os.path.join(sessions_dir, "*.jsonl"))):
        sid = os.path.splitext(os.path.basename(p))[0]
        try:
            st = os.stat(p)
        except OSError as e:                      # 断链/竞态删除: 不因它整轮崩掉
            skipped.append(f"{os.path.basename(p)}: {e}")
            continue
        now_m[sid] = (st.st_mtime, st.st_size)
        prev = sess_map.get(sid)
        if prev is None or int(st.st_mtime * 1000) != prev.get("jsonl_mtime") or st.st_size != prev.get("jsonl_size"):
            changed.append(p)
    for s in skipped:
        print(f"跳过无法 stat 的会话文件 {s}")
    # sessions 目录有效但为空: 拒绝清理, 防止误删全部语料
    if not now_m and sess_map:
        print(f"sessions 目录无 jsonl, 拒绝清理 {len(sess_map)} 条 manifest (安全起见不 prune)")
        return
    # 已从 manifest 消失的 jsonl (被删除/归档): 同步删该 session 的全部分片与 manifest 条目
    for sid in list(sess_map):
        if sid not in now_m:
            deleted.append(sid)
            for p in zc.corpus_files_of(CORPUS_DIR, sid):
                try: os.unlink(p)
                except OSError: pass
    if changed or deleted:
        print(f"变更 {len(changed)} 个, 删除 {len(deleted)} 个")
    # prune 先落盘(在任何 early-return 之前, 避免"文件已删但键永留"); ETL 的 merge 在其后读到已 prune 的 manifest
    if deleted:
        _prune_manifest(deleted)
    # 硬杀残留的半成品片: 没有任何 session 变化时 ETL 根本不会被调用, 所以这里也扫一次(LOW-5)。
    # 只拿一小段锁(ETL 子进程会抢同一把锁, 不能在持锁时起它)
    with zc.ManifestLock(_mpath):
        zc.sweep_stale_tmp(CORPUS_DIR)
    etl_fail = []
    for p in changed:
        try:
            out = subprocess.run([sys.executable, os.path.join(EXT_DIR, "jsonl2corpus.py"), p, CORPUS_DIR],
                                 capture_output=True, text=True, timeout=300)
            if out.returncode != 0:
                etl_fail.append(p)
                print(out.stderr or out.stdout)
        except Exception as e:
            etl_fail.append(p)
            print("ETL 失败", p, e)
    # 无变化 + 索引在 + 上轮索引确实成功过: 真没事情做
    # (索引不存在, 或上轮 zg index 失败/lease-active -> 绝不能早退, 否则新语料永远搜不到)
    # zg 建出来的 .zvec-grep/index.zvec 是**目录**(与 index.ts 的 existsSync 同口径), 不能用 isfile
    if not (changed or deleted) and os.path.exists(_index_marker()) and _index_stamp_ok():
        print("无变化, 索引已是最新")
        return
    if not os.path.exists(_index_marker()):
        print("索引缺失, 重建索引")
    elif not (changed or deleted):
        print("上轮索引未成功(或语料已变), 补跑索引")
    rc = 0
    index_err = None
    if not _corpus_files() and not os.path.exists(_index_marker()):
        print("语料目录为空且索引未建过, 跳过索引")
    else:
        # zg 增量索引(冻结分片 size+mtime 不变 -> 只重嵌开放尾片)
        # 语料被清空时也要跑: 让 zg 把已删文件的向量一起清掉(LOW-3)
        # 戳必须在跑索引**之前**取: 它只能描述 zg index 启动时就已经存在的语料
        fp_before = _corpus_fingerprint()
        index_err = _run_index()
        if index_err is None:
            _mark_indexed(fp_before)
            print(f"索引已更新 ({len(changed)} changed, {len(deleted)} deleted)")
        elif index_err == "lease-active":
            # 另一个窗口/仓库的 zg 正在写本 root: 不是错误, 但绝不能报"索引已更新"
            # 清掉状态戳 -> 下一轮必然会重试(D2/评审 HIGH-1)
            _clear_index_stamp()
            print("另一个 zg 进程正在写本 workspace 的索引(lease active), 本次未更新索引; 下一轮会重试")
        else:
            _clear_index_stamp()
            print("zg index 失败:", index_err)
            rc = 3
    # 重载 manifest, 保证本进程内后续读取一致(prune 已在 ETL 前落盘)
    try:
        MANIFEST.clear()
        MANIFEST.update(zc.load_manifest(os.path.join(ZGMEM_HOME, SCOPE_DIR, "manifest.json")))
    except Exception as e:
        print("警告: manifest 重载失败, 保持内存态:", e)
    if etl_fail:
        print(f"注意: {len(etl_fail)}/{len(changed)} 个 session ETL 失败, 这些会话本轮未入语料(修掉原因后重跑即可)")
        if rc == 0:
            rc = 2
    if rc:
        sys.exit(rc)


def _looks_exact(q: str) -> str:
    """启发式: 判断 query 是不是'精确 token'型, 返回路由: rg | fts | hybrid"""
    import re
    # 错误码/key:value/路径行号: 冒号分隔的强 token
    if re.search(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+", q):
        return "rg"
    # 路径样式
    if re.search(r"[A-Za-z0-9_.~-]+/[A-Za-z0-9_.~-]+", q):
        return "rg"
    # 长难 token / hash
    if re.search(r"[A-Za-z0-9]{16,}", q):
        return "rg"
    # camelCase 符号
    if re.search(r"[a-z][A-Z][A-Za-z]*", q) or re.search(r"[A-Z]{2,}", q):
        return "fts"
    return "hybrid"


def _rg_candidates(args, limit, ws_name):
    """rg 模式: 在该 workspace 已索引的会话 JSONL 上 literal 匹配, 返回 pairs(rg 序)"""
    import re as _re
    targets = sorted({m["jsonl_path"] for m in zc.sessions(MANIFEST).values() if m.get("jsonl_path")})
    if not targets:
        return []
    # -H: 单文件 target 也打文件名(否则解析全挂); -e: query 以 '-' 开头时与 rg 选项隔离
    cmd = ["rg", "-n", "-F", "--no-heading", "-H", "-e", args.query]
    if getattr(args, "session", None):
        cmd += ["--glob", f"{os.path.basename(args.session)}.jsonl"]
    proc = subprocess.run(cmd + targets, capture_output=True, text=True)
    if proc.returncode != 0:
        return []
    j2s = {m["jsonl_path"]: sid for sid, m in zc.sessions(MANIFEST).items()}
    rows_cache = {}
    pairs = []
    seen = set()
    for l in proc.stdout.splitlines():
        m = _re.match(r"^(.+?):(\d+):", l)
        if not m:
            continue
        path, jl = m.group(1), int(m.group(2))
        key = (path, jl)
        if key in seen:
            continue
        seen.add(key)
        if getattr(args, "who", "all") != "all":
            pass  # role 过滤在拿到 pair 后做
        sid = j2s.get(path)
        pair = None
        if sid:
            rows = rows_cache.setdefault(sid, zc.session_rows_full(CORPUS_DIR, MANIFEST, sid))
            idx = next((i for i, r in enumerate(rows) if r[1] == jl), None)
            if idx is not None:
                pair = zc.build_pair(rows, idx)
                pair["ref"]["session"] = sid
        if pair is None:
            pair = _pair_from_jsonl(path, jl)  # toolResult 等不在语料里的命中兜底
        if pair is None:
            continue
        pair["ref"]["workspace"] = ws_name
        if getattr(args, "who", "all") != "all" and pair["role"] != args.who:
            continue
        if getattr(args, "since", 0):
            cutoff = (time.time() - args.since * 86400) * 1000
            if (pair.get("ts") or 0) < cutoff:
                continue
        pairs.append(pair)
        if len(pairs) >= limit:
            break
    return pairs


def _pair_from_jsonl(path, jl):
    """兜底: corpus 没有该行(toolResult/thinking), 直接从 JSONL 合成 pair"""
    try:
        with open(path, encoding="utf-8") as f:
            for i, ln in enumerate(f, 1):
                if i != jl:
                    continue
                d = json.loads(ln)
                msg = d.get("message", {})
                role = msg.get("role", "?")
                try:
                    ts = int(msg.get("timestamp") or d.get("timestamp") or 0)
                except (TypeError, ValueError):
                    ts = 0
                parts = []
                for c in msg.get("content") or []:
                    if isinstance(c, dict):
                        t = c.get("text") or c.get("thinking") or ""
                        if t:
                            parts.append(t)
                txt = " ".join(parts).replace("\n", " ")
                return {
                    "ref": {"session": os.path.basename(path)[:-6], "corpus_line": 0, "jsonl_line": jl},
                    "role": role, "ts": ts, "text": txt,
                    "user": txt if role == "user" else "",
                    "assistant": txt if role == "assistant" else "",
                }
    except Exception:
        return None
    return None


def _refine_hit_line(cname: str, meta: dict, cstart: int, query: str, span: int = None) -> int:
    """zg 命中 -> 真正的命中行(全局行号)

    zg 给的行号是命中块的**首行**(实测块首行可以比真正命中的行早 16 行), 块内到底哪一行
    被命中只能自己找: 同片内从块首行往后限窗, 取 query 词元覆盖分最高的一行;
    纯向量命中(无词元覆盖)时退回块首行 —— 比乱指一行更诚实。
    ZGMEM_HIT_REFINE=0 可关闭精修。"""
    start = (meta.get("start_corpus_line") or 1) + int(cstart) - 1
    if not _REFINE_HITS:
        return start
    rows = zc.read_segment(CORPUS_DIR, cname, meta.get("start_corpus_line") or 1)
    return zc.pick_hit_row(rows, start, zc.query_terms(query), span=span)


def cmd_query(args):
    # session id 会进 rg/zg 的 glob 模式, 先拒绝元字符(防模式放宽)
    if getattr(args, "session", None) and not re.fullmatch(r"[A-Za-z0-9._-]+", args.session):
        print("非法 session id"); return
    mode = getattr(args, "mode", "auto") or "auto"
    if mode == "auto":
        mode = _looks_exact(args.query)
    if mode == "hybrid" and args.query.startswith("-"):
        mode = "fts"   # zg query 位置参数以 '-' 开头会被 zg 解析成选项; fts 走 --fts 带值参数天然安全

    pool = getattr(args, "pool", 0) or 0
    limit = pool if pool > args.top else args.top

    # workspace 维度: 名字=单 workspace; all=所有已初始化 workspace 扇出合并
    ws = getattr(args, "workspace", None) or SCOPE_DIR
    workspaces = list_workspaces() if ws == "all" else [ws]

    candidates = []  # (base_relevance, pair)
    seen_global = set()   # 跨 workspace 扇出去重: (session, jsonl_line)
    for w in workspaces:
        try:
            use_workspace(w)
        except SystemExit as e:
            if len(workspaces) == 1:
                print(str(e))
                return
            continue
        if mode == "rg":
            for order, pair in enumerate(_rg_candidates(args, limit, w)):
                gkey = (pair["ref"].get("session"), pair["ref"].get("jsonl_line"))
                if gkey in seen_global:
                    continue
                seen_global.add(gkey)
                candidates.append((1.0 / (order + 1), pair))
            continue

        cmd = ["zg", "query"]
        cmd += ["--fts", args.query] if mode == "fts" else [args.query]
        cmd += ["--limit", str(limit), "--preview", "none"]
        if args.session:
            cmd += ["-g", f"{args.session}*"]
        if getattr(args, "since", 0):
            since_ms = int((datetime.datetime.now() - datetime.timedelta(days=args.since)).timestamp() * 1000)
            cmd += ["--modified-after", str(since_ms)]

        proc = subprocess.run(cmd, cwd=CORPUS_DIR, capture_output=True, text=True)
        if proc.returncode != 0:
            if len(workspaces) == 1:
                print(proc.stderr or proc.stdout)
                return
            continue

        # 解析 zg 输出: 每行像  "#1 matchedBy=fts+vector 2026-....txt:32" 或 "...p0003.txt:73-94", 保序去重
        hits = []
        seen = set()
        # 只解析 '#N matchedBy=... file.txt:line[-end]' 命中头行; 语料正文回显可能含 xxx.txt:123 字样
        # zg 给了块内窗口时记下末尾: 精修就在这个窗口内找命中行, 不用再猜它的块大小(评审 LOW-2)
        for ln in proc.stdout.splitlines():
            s = ln.strip()
            if not s.startswith("#"):
                continue
            m = re.search(r"([0-9A-Za-z_.-]+\.txt):(\d+)(?:-(\d+))?", s)
            if m and m.group(1) in zc.segments(MANIFEST):
                key = (m.group(1), int(m.group(2)), int(m.group(3)) if m.group(3) else None)
                if key not in seen:
                    seen.add(key)
                    hits.append(key)

        for order, (cname, cstart, cend) in enumerate(hits):
            meta = zc.segments(MANIFEST).get(cname)
            if not isinstance(meta, dict):
                continue
            sid = meta.get("session_id")
            wspan = max(0, cend - cstart) if cend else None
            gline = _refine_hit_line(cname, meta, cstart, args.query, span=wspan)
            pair = zc.pair_for_global(CORPUS_DIR, MANIFEST, sid, gline)
            if pair is None:
                continue
            pair["ref"]["workspace"] = w
            if getattr(args, "who", "all") != "all" and pair["role"] != args.who:
                continue
            gkey = (pair["ref"]["session"], pair["ref"].get("jsonl_line"))
            if gkey in seen_global:
                continue
            seen_global.add(gkey)
            candidates.append((1.0 / (order + 1), pair))   # zg 相关性名次 -> 基础相关

    if not candidates:
        print("[]" if args.json else "(无命中)")
        return

    # 纯相关性排序; 不做时间衰减(检索系统不做遗忘, 时间戳随结果返回由 agent 自行裁决新旧)
    candidates.sort(key=lambda c: c[0], reverse=True)

    pairs = [c[1] for c in candidates[: args.top]]

    if args.json:
        print(json.dumps(pairs, ensure_ascii=False, indent=2))
        return
    for i, p in enumerate(pairs, 1):
        print(fmt_pair(p, i))


def cmd_show(session_id, corpus_line, full):
    jpath = jsonl_path_for(session_id)
    if not jpath:
        print("unknown session", session_id); return
    # 从分片语料定位 jsonl 行号
    rec = corpus_row(session_id, corpus_line)
    if not rec:
        print("bad corpus line"); return
    jl = rec[0]
    with open(jpath, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            if i == jl:
                d = json.loads(line)
                msg = d.get("message", {})
                print(f"session={session_id} jsonl_line={jl} role={msg.get('role')} ts={msg.get('timestamp')}")
                for c in msg.get("content", []):
                    if not isinstance(c, dict):
                        continue
                    t = c.get("type")
                    val = c.get("text") or c.get("thinking") or ""
                    if t in ("text", "thinking", "ToolCall", "toolCall") or full:
                        print(f"\n[{t}]\n{val[:800]}")
                # toolResult
                if "toolResult" in msg or msg.get("role") == "tool":
                    print("\n[toolResult field present]")
                return
    print("jsonl line not found")


def cmd_ctx(session_id, corpus_line, span):
    jpath = jsonl_path_for(session_id)
    if not jpath:
        print("unknown session", session_id); return
    rec = corpus_row(session_id, corpus_line)
    if not rec:
        print("bad corpus line"); return
    target = rec[0]
    rows = []
    with open(jpath, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "message":
                continue
            rows.append((i, d.get("message", {})))
    # 找 target 索引
    tidx = next((i for i, r in enumerate(rows) if r[0] == target), None)
    if tidx is None:
        print("line not found"); return
    lo = max(0, tidx - span)
    hi = min(len(rows), tidx + span + 1)
    for i in range(lo, hi):
        ln, msg = rows[i]
        role = msg.get("role")
        ts = datetime.datetime.fromtimestamp((msg.get("timestamp") or 0) / 1000).strftime("%H:%M") if msg.get("timestamp") else "?"
        for c in msg.get("content", []):
            if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                print(f"[{ts} {role}] {c['text'][:200]}".replace("\n", " "))
        if msg.get("role") == "tool":
            print(f"[{ts} toolResult] (工具输出)")
    print(f"\n(共 {hi - lo} 条, 目标在 jsonl_line={target})")


def cmd_sessions(ws=None):
    def _dump():
        for sid, m in sorted(zc.sessions(MANIFEST).items(), key=lambda kv: kv[1].get("start_ts") or 0, reverse=True):
            ts = datetime.datetime.fromtimestamp((m.get("start_ts") or 0) / 1000).strftime("%Y-%m-%d") if m.get("start_ts") else "?"
            print(f"{ts}  {sid}  ({m.get('rows', 0)} msgs / {m.get('segments', 0)} segs)")
    if ws == "all":
        for w in list_workspaces():
            use_workspace(w)
            print(f"## {w}")
            _dump()
        return
    _dump()


def main():
    ap = argparse.ArgumentParser(prog="zgmem")
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("query")
    q.add_argument("query")
    q.add_argument("--top", type=int, default=3)
    q.add_argument("--who", choices=["user", "assistant", "all"], default="all")
    q.add_argument("--since", type=int, default=0)
    q.add_argument("--pool", type=int, default=0, help="候选池大小(> top 时先取池再截断)")
    q.add_argument("--session", default=None)
    q.add_argument("--workspace", default=None,
                   help="workspace 名或 'all'(仅 query: 扇出所有已初始化 workspace); 缺省=ZGMEM_SCOPE")
    q.add_argument("--json", action="store_true")
    q.add_argument("--mode", choices=["auto", "hybrid", "fts", "rg"], default="auto",
                   help="auto=启发式路由; hybrid=fts+向量; fts=BM25词法; rg=JSONL字面精确匹配")
    q.set_defaults(fn=cmd_query)

    r = sub.add_parser("refresh")
    r.add_argument("--sessions-dir", default=None, help="会话目录; 缺省用当前 session 所在目录")
    r.add_argument("--workspace", default=None, help="目标 workspace; 缺省=ZGMEM_SCOPE")
    r.set_defaults(fn=cmd_refresh)

    s = sub.add_parser("show")
    s.add_argument("session_id"); s.add_argument("corpus_line", type=int)
    s.add_argument("--full", action="store_true")
    s.add_argument("--workspace", default=None, help="目标 workspace; 缺省=ZGMEM_SCOPE")
    s.set_defaults(fn=lambda a: cmd_show(a.session_id, a.corpus_line, a.full))

    c = sub.add_parser("ctx")
    c.add_argument("session_id"); c.add_argument("corpus_line", type=int)
    c.add_argument("--span", type=int, default=3)
    c.add_argument("--workspace", default=None, help="目标 workspace; 缺省=ZGMEM_SCOPE")
    c.set_defaults(fn=lambda a: cmd_ctx(a.session_id, a.corpus_line, a.span))

    ss = sub.add_parser("sessions")
    ss.add_argument("--workspace", default=None, help="目标 workspace 或 'all'; 缺省=ZGMEM_SCOPE")
    ss.set_defaults(fn=lambda a: cmd_sessions(getattr(a, "workspace", None)))

    a = ap.parse_args()
    # workspace 维度: query/sessions 支持 'all'(内部扇出), show/ctx 必须具体 workspace
    ws = getattr(a, "workspace", None)
    if ws == "all" and a.cmd in ("show", "ctx"):
        print(f"{a.cmd} 需要具体 workspace, 不能用 all"); return
    if ws and ws != "all":
        use_workspace(ws)
    a.fn(a)


if __name__ == "__main__":
    main()