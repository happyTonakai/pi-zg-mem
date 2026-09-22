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
import copy
import glob
import hashlib
import json
import os
import sys
import traceback

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

    yield (line_no, row_or_None, end_offset); 末尾无 \\n 的半行不消费(下次再说)
    读不了(权限/IO 错)就抛出去: 早先这里静默 return, 结果是"会话读不到"被当成空会话
    写进 manifest(0 条), 全链路还报成功。"""
    no = first_line_no
    off = start_offset
    fb = open(path, "rb")
    with fb:
        fb.seek(start_offset)
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
    """尾片末行必须与 manifest 记的"尾片末条语料行的 jsonl_line"一致(防半程写坏后重复追加)

    不能拿 last_jsonl_line 比: 它是"扫描到的最后一行 JSONL", 而语料只收 user/assistant
    文本消息 —— 会话末尾总是 toolResult/toolCall(agent 干活时的常态), 两者天然不等,
    会导致每轮刷新都整会话重建。旧 manifest 无 last_row_jsonl_line 时退回旧比较(一次性重建后即有该键)。
    """
    tail = zc.open_tail(man, sid)
    if not tail:
        return True                       # 没有尾片(例如上次刚好整片冻结/空会话)
    rows = zc.read_segment(corpus_dir, tail["fname"], tail.get("start_corpus_line") or 1)
    if not rows:
        return False                      # 尾片文件缺失/损坏
    want = sess.get("last_row_jsonl_line")
    if want is None:
        want = sess.get("last_jsonl_line") or 0
    return rows[-1][1] == want


def can_continue(path: str, st, corpus_dir: str, man: dict, sid: str, sess: dict):
    if not sess:
        return None
    if os.path.abspath(path) != sess.get("jsonl_path"):
        return None
    if not _tail_consistent(corpus_dir, man, sid, sess):
        return None
    return _prefix_hasher(path, st, sess)


def _register_segment(man: dict, sid: str, fname: str, rows, seq: int, start_global: int, frozen: bool):
    """登记一个分片(调用方保证文件已经写成功)"""
    man["segments"][fname] = {
        "session_id": sid,
        "seq": seq,
        "rows": len(rows),
        "start_jsonl_line": rows[0][0] if rows else 0,
        "start_corpus_line": start_global,
        "start_ts": rows[0][2] if rows else None,
        "frozen": bool(frozen),
    }


def process_session(path: str, corpus_dir: str, man: dict, force: bool = False):
    """返回 (状态串, 本次新增行数)"""
    sid = os.path.splitext(os.path.basename(path))[0]
    st = os.stat(path)
    sess = zc.sessions(man).get(sid)

    hasher = None if force else can_continue(path, st, corpus_dir, man, sid, sess)
    incremental = hasher is not None
    if incremental:
        first_line = (sess.get("last_jsonl_line") or 0) + 1
        start_offset = int(sess.get("last_offset") or 0)
    else:
        first_line = 1
        start_offset = 0
        hasher = hashlib.sha256()

    new_rows = []
    last_no = (sess.get("last_jsonl_line") or 0) if incremental else 0
    last_off = start_offset
    for line_no, row, end in scan(path, start_offset, first_line, hasher):
        last_no, last_off = line_no, end
        if row:
            new_rows.append(row)

    segs = zc.segs_for(man, sid)
    tail = zc.open_tail(man, sid)
    if not incremental:
        # 重建: 分片号/全局行号从 1 重排(删旧分片推迟到新片写成功之后, 见下)
        segs = []
        tail = None
        tail_rows = []
        tail_seq = 1
        start_global = 1
    elif tail:
        tail_rows = [r[1:] for r in zc.read_segment(corpus_dir, tail["fname"], tail.get("start_corpus_line") or 1)]
        tail_seq = tail.get("seq") or 1
        start_global = tail.get("start_corpus_line") or 1
    else:
        tail_rows = []
        tail_seq = (max([s.get("seq") or 0 for s in segs] or [0])) + 1
        start_global = max([(s.get("start_corpus_line") or 1) + (s.get("rows") or 0) for s in segs] or [1])

    all_rows = tail_rows + new_rows
    n_new = len(new_rows)

    # 下面先"算 + 写", 新片全部落盘成功后才丢旧分片/登记 manifest:
    # 重建时若写片阶段出错(ENOSPC/os.replace 失败/被 kill), 旧语料与 manifest 条目原样保留(评审 MED-1)
    planned = []                       # [(fname, rows, seq, start_global, frozen)]
    if n_new == 0 and tail_rows:
        # jsonl 变了但没产出新消息(例如只改了 toolResult 行): 尾片无需重写
        pass
    else:
        seqs = zc.seq_allocator(segs, tail_seq)
        rest = all_rows
        while True:
            cut = zc.split_point(rest)
            if cut is None:
                break
            chunk = rest[:cut]
            seq = next(seqs)
            planned.append((zc.seg_name(sid, seq), chunk, seq, start_global, True))
            start_global += len(chunk)
            rest = rest[cut:]
        if rest:
            seq = next(seqs)
            planned.append((zc.seg_name(sid, seq), rest, seq, start_global, False))
        elif tail:
            # 尾片被整体吃进冻结片(或本次无剩余): 旧尾片文件已由首个冻结片覆盖;
            # 若无冻结片且无剩余(空会话)则删除旧尾片, 避免残留
            if not planned:
                try:
                    os.unlink(os.path.join(corpus_dir, zc.seg_name(sid, tail_seq)))
                except OSError:
                    pass
                zc.segments(man).pop(zc.seg_name(sid, tail_seq), None)   # 别留指向已删文件的条目

    # 重建: 先记下"旧状态", 但删除推迟到新片写成功之后
    old_files = list(zc.corpus_files_of(corpus_dir, sid)) if not incremental else []
    old_fnames = [fn for fn, m in list(zc.segments(man).items())
                  if isinstance(m, dict) and m.get("session_id") == sid] if not incremental else []

    # 先把新片写成隐藏的 staging 文件(不碰现有语料), 全部写成功后再一次性换入。
    # 任何一片写失败(ENOSPC/os.replace 失败/被 kill)都只会留下可清理的 staging,
    # 旧分片与 manifest 条目原样不动(评审 MED-1)
    staged = []                        # [(staging_path, final_path)]
    try:
        for fname, rows, seq, sg, frozen in planned:
            staging = f".{fname}.staging"
            zc.write_segment(corpus_dir, staging, rows, start_ts=rows[0][2] if rows else None)
            staged.append((os.path.join(corpus_dir, staging), os.path.join(corpus_dir, fname)))
        for s, final in staged:
            os.replace(s, final)
    except BaseException:
        for s, _ in staged:
            try:
                os.unlink(s)
            except OSError:
                pass
        raise

    if not incremental:
        new_names = {p[0] for p in planned}
        for p in old_files:
            if os.path.basename(p) in new_names:
                continue                       # 本次重写过的片留着(内容已是新的)
            try:
                os.unlink(p)
            except OSError:
                pass
        for fn in old_fnames:
            man["segments"].pop(fn, None)
        zc.sessions(man).pop(sid, None)
        sess = None

    for fname, rows, seq, sg, frozen in planned:
        _register_segment(man, sid, fname, rows, seq, sg, frozen)

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
        "last_row_jsonl_line": all_rows[-1][0] if all_rows else 0,
        "last_offset": last_off,
        "prefix_sha": hasher.hexdigest(),
        "rows": total_rows,
        "segments": sum(1 for m in zc.segments(man).values() if m.get("session_id") == sid),
    }
    mode = "inc" if incremental else "rebuild"
    return f"  {sid}  {total_rows} msgs / {zc.sessions(man)[sid]['segments']} segs  (+{n_new} {mode})", n_new


def migrate_cleanup(corpus_dir: str, man: dict, prev_sids=()):
    """v1→v2 / manifest 损坏迁移后: 清掉不再被引用的遗留语料文件

    只删"确属本工具产物"的文件, 名字对不上的一概不碰:
      - v1 单文件 <sid>.txt: 仅当 sid 是已知 session(旧 manifest 或新 manifest 里有);
      - 分片 <sid>.pNNNN.txt: 仅当 sid 已不存在(孤儿片); 已知 session 的片保留(查询侧本就会
        过滤掉不在 manifest 里的文件, 留着无害, 误删才是灾难)。
    历史上这里删任何非隐藏 .txt -> 用户放在语料目录里的 notes.txt 会在迁移时被删掉(评审 H3)。
    """
    keep = set(zc.segments(man))
    known = set(zc.sessions(man)) | set(prev_sids or ())
    removed = []
    for p in sorted(glob.glob(os.path.join(corpus_dir, "*.txt"))):
        b = os.path.basename(p)
        if b.startswith(".") or b in keep:
            continue
        seg = zc.parse_seg(b)
        if seg and seg[0] in known:
            continue                      # 已知 session 的分片: 不动
        if not seg and not (zc.is_legacy_name(b) and os.path.splitext(b)[0] in known):
            continue                      # 既不是分片、也不是已知 session 的 v1 文件: 不是我们的产物
        try:
            os.unlink(p)
            removed.append(b)
        except OSError as e:
            print(f"  清理失败 {b}: {e}")
    if removed:
        head = ", ".join(removed[:5]) + (" ..." if len(removed) > 5 else "")
        print(f"  清理遗留语料 {len(removed)} 个: {head}")


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
        # 迁移前旧 manifest 的 session 名单: migrate_cleanup 只按它判断"哪些遗留文件是我们的"
        # v1 是扁平 {<sid>.txt: {...}} 而不是 {"sessions": {...}} —— 早先这里只认后者,
        # 于是 prev_sids 恒为空集, jsonl 已消失的 legacy 文件永远不会被清理(评审 LOW-1)
        _prev = raw.get("sessions") if isinstance(raw, dict) else None
        if isinstance(_prev, dict):
            prev_sids = set(_prev)
        elif isinstance(raw, dict):
            prev_sids = {k[:-len(".txt")] for k in raw if isinstance(k, str) and k.endswith(".txt")}
        else:
            prev_sids = set()
        man = zc.load_manifest(mpath)
        if not paths:
            print(f"no sessions matched: {glob_in}")
            sys.exit(1)
        # 老用户升级路径: manifest 整个不在(换目录/先删了), 但语料目录里还塞着 .txt。
        # 若不管, 已知 session 的 v1 单文件会"被 zg 索引、却在查询侧被过滤掉" -> 隐形重复(评审 L2)。
        # 不设 legacy=True: 那是"非 v2->全量重建本目录所有 jsonl"的语义, 比 L2 要的重。
        cleanup = legacy or (raw is None and bool(glob.glob(os.path.join(corpus_dir, "*.txt"))))
        zc.sweep_stale_tmp(corpus_dir)   # LOW-5(共享实现; zgmem refresh 里也调一次)
        if legacy:
            # 迁移: 处理该 sessions 目录下所有 jsonl, 避免旧语料变成查不到的孤儿
            sdir = os.path.dirname(os.path.abspath(glob_in))
            paths = sorted(set(paths) | set(glob.glob(os.path.join(sdir, "*.jsonl"))))
            print(f"manifest 非 v{zc.MANIFEST_VERSION}(迁移/损坏), 全量重建 {len(paths)} 个 session")

        total_new = 0
        etl_fail = []
        for p in paths:
            snapshot = copy.deepcopy(man)      # 失败回滚: 绝不把半截状态落盘(评审 MED-1)
            try:
                status, n_new = process_session(p, corpus_dir, man, force=force)
            except Exception as e:
                # 不能只 print 一行就 continue: 历史上这里吞掉异常 + 结尾 exit 0,
                # 让"整个 session 没进语料"看起来和成功一模一样(评审 H1)。
                traceback.print_exc()
                etl_fail.append((p, e))
                man.clear()
                man.update(snapshot)
                continue
            total_new += n_new
            print(status)
        zc.save_manifest(mpath, man)
        if cleanup:
            migrate_cleanup(corpus_dir, man, prev_sids)

    print(f"\n{len(paths)} 个 session, 本次新增 {total_new} 条")
    print(f"manifest v{man.get('version')}: {len(zc.sessions(man))} sessions / {len(zc.segments(man))} segments -> {mpath}")
    if etl_fail:
        print(f"\n失败 {len(etl_fail)}/{len(paths)} 个 session(未入语料, 语料不完整):")
        for p, e in etl_fail:
            print(f"  - {os.path.basename(p)}: {type(e).__name__}: {e}")
        print("  修掉原因后重跑本命令即可: 失败的 session 已回滚(旧分片与 manifest 条目保持原样), 语料里没有半截会话")
        sys.exit(2)


if __name__ == "__main__":
    main()
