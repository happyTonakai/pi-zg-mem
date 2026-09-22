#!/usr/bin/env python3
"""
jsonl2corpus.py — pi session JSONL → zg 分片语料(v2, 增量续读)
============================================================
一个 session → 多个分片 <sid>.pNNNN.txt, 每片 <= ZGMEM_SEG_ROWS/SEG_BYTES;
只有最后一个"开放尾片"会被重写, 冻结片字节永不改动 → zg 增量索引只重嵌尾片。

增量续读: manifest 记 last_jsonl_line / last_offset / prefix_sha(已处理前缀的 sha256)。
  - 校验前缀 sha 未变 + 尾片末行与 last_jsonl_line 一致 → 只解析 last_offset 之后的新行
  - 任一校验失败(JSONL 被改写/压缩/resume) → 该 session 全量重建

用法:
  python3 jsonl2corpus.py <sessions_glob> <corpus_dir> [--rebuild]
    --rebuild  忽略既有状态, 强制全量重建所有匹配 session
"""
import glob
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zgmem_corpus as zc  # noqa: E402


def clean_text(text: str) -> str:
    # 只压缩空白。不做二次反转义: JSON 已解码, 字面反斜杠n/反斜杠引号 是代码内容本身
    return " ".join(text.split())


def row_of(raw: bytes, line_no: int):
    """一行 JSONL -> (line_no, role, ts, text); 非 user/assistant text 消息返回 None"""
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(d, dict) or d.get("type") != "message":
        return None
    msg = d.get("message") or {}
    role = msg.get("role")
    if role not in ("user", "assistant"):
        return None
    ts = msg.get("timestamp") or d.get("timestamp") or 0
    texts = []
    for c in msg.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            t = c.get("text")
            if t:
                texts.append(clean_text(t))
    if not texts:
        return None
    try:
        ts = int(ts)
    except (TypeError, ValueError):
        ts = 0
    return (line_no, role, ts, " ".join(texts))


def scan(path: str, start_offset: int, first_line_no: int, hasher):
    """从 start_offset(行边界)起顺序解析完整行; 已消费字节实时喂给 hasher
    yield (line_no, row_or_None, end_offset); 末尾无 \\n 的半行不消费(下次再说)"""
    no = first_line_no
    off = start_offset
    try:
        fb = open(path, "rb")
    except OSError:
        return
    with fb:
        try:
            fb.seek(start_offset)
        except OSError:
            return
        while True:
            raw = fb.readline()
            if not raw:
                return
            if not raw.endswith(b"\n"):
                return
            end = off + len(raw)
            hasher.update(raw)
            yield no, row_of(raw, no), end
            off = end
            no += 1


def _prefix_hasher(path: str, st, sess):
    """增量前置校验: 返回已喂入 [0:last_offset) 的 hasher, 不可增量返回 None"""
    lo = int(sess.get("last_offset") or 0)
    ps = sess.get("prefix_sha")
    if lo <= 0 or not ps or st.st_size < lo:
        return None
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            left = lo
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    return None
                h.update(b)
                left -= len(b)
    except OSError:
        return None
    return h if h.hexdigest() == ps else None


def _tail_consistent(corpus_dir: str, man: dict, sid: str, sess: dict) -> bool:
    """尾片末行的 jsonl_line 必须等于 manifest 记的 last_jsonl_line(防半程写坏后重复追加)"""
    tail = zc.open_tail(man, sid)
    if not tail:
        return True                       # 没有尾片(例如上次刚好整片冻结)
    rows = zc.read_segment(corpus_dir, tail["fname"], tail.get("start_corpus_line") or 1)
    if not rows:
        return False                      # 尾片文件缺失/损坏
    return rows[-1][1] == (sess.get("last_jsonl_line") or 0)


def can_continue(path: str, st, corpus_dir: str, man: dict, sid: str, sess: dict):
    if not sess:
        return None
    if os.path.abspath(path) != sess.get("jsonl_path"):
        return None
    if not _tail_consistent(corpus_dir, man, sid, sess):
        return None
    return _prefix_hasher(path, st, sess)


def drop_session_segments(corpus_dir: str, man: dict, sid: str):
    """删除该 session 的全部分片(v1 单文件 + 分片)与 manifest 条目(全量重建前调用)"""
    for fn, m in list(zc.segments(man).items()):
        if isinstance(m, dict) and m.get("session_id") == sid:
            man["segments"].pop(fn, None)
    for p in zc.corpus_files_of(corpus_dir, sid):
        try:
            os.unlink(p)
        except OSError:
            pass


def write_chunk(corpus_dir: str, man: dict, sid: str, rows, seq: int, start_global: int, frozen: bool):
    """写一片并登记 manifest"""
    fname = zc.seg_name(sid, seq)
    first_ts = rows[0][2] if rows else None
    zc.write_segment(corpus_dir, fname, rows, start_ts=first_ts)
    man["segments"][fname] = {
        "session_id": sid,
        "seq": seq,
        "rows": len(rows),
        "start_jsonl_line": rows[0][0] if rows else 0,
        "start_corpus_line": start_global,
        "start_ts": first_ts,
        "frozen": bool(frozen),
    }
    return fname


def process_session(path: str, corpus_dir: str, man: dict, force: bool = False):
    """返回 (状态串, 本次新增行数)"""
    sid = os.path.splitext(os.path.basename(path))[0]
    st = os.stat(path)
    sess = zc.sessions(man).get(sid)

    hasher = None if force else can_continue(path, st, corpus_dir, man, sid, sess)
    incremental = hasher is not None
    if not incremental:
        drop_session_segments(corpus_dir, man, sid)
        zc.sessions(man).pop(sid, None)
        sess = None
        hasher = hashlib.sha256()

    if incremental:
        first_line = (sess.get("last_jsonl_line") or 0) + 1
        start_offset = int(sess.get("last_offset") or 0)
    else:
        first_line = 1
        start_offset = 0

    new_rows = []
    last_no = (sess.get("last_jsonl_line") or 0) if incremental else 0
    last_off = start_offset
    for line_no, row, end in scan(path, start_offset, first_line, hasher):
        last_no, last_off = line_no, end
        if row:
            new_rows.append(row)

    segs = zc.segs_for(man, sid)
    tail = zc.open_tail(man, sid)
    if tail:
        tail_rows = [r[1:] for r in zc.read_segment(corpus_dir, tail["fname"], tail.get("start_corpus_line") or 1)]
        tail_seq = tail.get("seq") or 1
        start_global = tail.get("start_corpus_line") or 1
    else:
        tail_rows = []
        tail_seq = (max([s.get("seq") or 0 for s in segs] or [0])) + 1
        start_global = max([(s.get("start_corpus_line") or 1) + (s.get("rows") or 0) for s in segs] or [1])

    all_rows = tail_rows + new_rows
    n_new = len(new_rows)

    if n_new == 0 and tail_rows:
        # jsonl 变了但没产出新消息(例如只改了 toolResult 行): 尾片无需重写
        pass
    else:
        seqs = zc.seq_allocator(segs, tail_seq)
        chunks = []
        rest = all_rows
        while True:
            cut = zc.split_point(rest)
            if cut is None:
                break
            chunks.append(rest[:cut])
            rest = rest[cut:]
        for chunk in chunks:
            write_chunk(corpus_dir, man, sid, chunk, next(seqs), start_global, frozen=True)
            start_global += len(chunk)
        if rest:
            write_chunk(corpus_dir, man, sid, rest, next(seqs), start_global, frozen=False)
        elif tail:
            # 尾片被整体吃进冻结片(或本次无剩余): 旧尾片文件已由首个冻结片覆盖;
            # 若无冻结片且无剩余(空会话)则删除旧尾片, 避免残留
            if not chunks:
                try:
                    os.unlink(os.path.join(corpus_dir, zc.seg_name(sid, tail_seq)))
                except OSError:
                    pass

    total_rows = sum((m.get("rows") or 0) for m in zc.segments(man).values()
                     if m.get("session_id") == sid)
    prev_start_ts = (sess or {}).get("start_ts")
    if prev_start_ts is None and all_rows:
        prev_start_ts = all_rows[0][2] or None
    zc.sessions(man)[sid] = {
        "jsonl_path": os.path.abspath(path),
        "start_ts": prev_start_ts,
        "jsonl_mtime": int(st.st_mtime * 1000),
        "jsonl_size": st.st_size,
        "last_jsonl_line": last_no,
        "last_offset": last_off,
        "prefix_sha": hasher.hexdigest(),
        "rows": total_rows,
        "segments": sum(1 for m in zc.segments(man).values() if m.get("session_id") == sid),
    }
    mode = "inc" if incremental else "rebuild"
    return f"  {sid}  {total_rows} msgs / {zc.sessions(man)[sid]['segments']} segs  (+{n_new} {mode})", n_new


def migrate_cleanup(corpus_dir: str, man: dict):
    """v1→v2 / manifest 损坏迁移后: 清掉不再被 manifest 引用的遗留语料文件"""
    keep = set(zc.segments(man))
    for p in sorted(glob.glob(os.path.join(corpus_dir, "*.txt"))):
        b = os.path.basename(p)
        if b.startswith("."):
            continue
        if b in keep:
            continue
        if zc.parse_seg(b) or zc.is_legacy_name(b):
            try:
                os.unlink(p)
            except OSError:
                pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--rebuild" in sys.argv
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    glob_in, corpus_dir = args
    os.makedirs(corpus_dir, exist_ok=True)
    mpath = zc.manifest_path_for(corpus_dir)

    paths = sorted(glob.glob(glob_in))
    with zc.ManifestLock(mpath):
        raw = zc.load_manifest_raw(mpath)
        legacy = raw is not None and (not isinstance(raw, dict) or raw.get("version") != zc.MANIFEST_VERSION)
        man = zc.load_manifest(mpath)
        if not paths:
            print(f"no sessions matched: {glob_in}")
            sys.exit(1)
        if legacy:
            # 迁移: 处理该 sessions 目录下所有 jsonl, 避免旧语料变成查不到的孤儿
            sdir = os.path.dirname(os.path.abspath(glob_in))
            paths = sorted(set(paths) | set(glob.glob(os.path.join(sdir, "*.jsonl"))))
            print(f"manifest 非 v{zc.MANIFEST_VERSION}(迁移/损坏), 全量重建 {len(paths)} 个 session")

        total_new = 0
        for p in paths:
            try:
                status, n_new = process_session(p, corpus_dir, man, force=force)
            except Exception as e:
                print(f"  ETL 失败 {p}: {e}")
                continue
            total_new += n_new
            print(status)
        zc.save_manifest(mpath, man)
        if legacy:
            migrate_cleanup(corpus_dir, man)

    print(f"\n{len(paths)} 个 session, 本次新增 {total_new} 条")
    print(f"manifest v{man.get('version')}: {len(zc.sessions(man))} sessions / {len(zc.segments(man))} segments -> {mpath}")


if __name__ == "__main__":
    main()
