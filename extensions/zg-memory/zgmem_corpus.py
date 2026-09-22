#!/usr/bin/env python3
"""
zgmem_corpus — 分片语料布局 + manifest v2 的共享读写层
=====================================================
布局: <corpus_dir>/<session_id>.p<NNNN>.txt   (每 session 多个分片)
  - 每片 <= ZGMEM_SEG_ROWS 行且 <= ZGMEM_SEG_BYTES 字节(单行超限时允许超)
  - 只有最后一个分片(frozen=false, "开放尾片")会被重写(追加新消息)
  - 已冻结分片(frozen=true)字节永不改动 -> zg 增量索引直接跳过
  - 分片边界优先落在"配对边界"(不让 user 问句与它的 assistant 回答分处两片)

行格式(与 v1 完全一致): <jsonl_line>\t<role>\t<epoch_ms>\t<text>

manifest v2 (~/.pi/agent/zgmem/<ws>/manifest.json):
  {"version": 2,
   "sessions": {<sid>: {jsonl_path, start_ts, jsonl_mtime, jsonl_size,
                        last_jsonl_line, last_offset, prefix_sha, rows}},
   "segments": {"<sid>.p0001.txt": {session_id, seq, rows, start_jsonl_line,
                                    start_corpus_line, start_ts, frozen}}}

ref 里的 corpus_line = 该 session 内跨分片的全局行号(1-based), 语义与 v1 一致;
分片切分不改变已有行的全局行号(切分只是把尾片拆成"同一起点的冻结片"+"起点后移的尾片"),
因此已发出的 ref 在分片后依然有效。
"""
import fcntl as _fcntl
import glob
import hashlib
import itertools
import json
import os
import re

MANIFEST_VERSION = 2
MAX_SEG_ROWS = int(os.environ.get("ZGMEM_SEG_ROWS", "200"))
MAX_SEG_BYTES = int(os.environ.get("ZGMEM_SEG_BYTES", str(64 * 1024)))

_SEG_RE = re.compile(r"^(?P<sid>.+)\.p(?P<seq>\d{4})\.txt$")

try:
    import fcntl
except ImportError:          # 非 POSIX: 无 flock, 退化为仅原子写
    fcntl = None


# ---------- 命名 ----------
def seg_name(sid: str, seq: int) -> str:
    return f"{sid}.p{seq:04d}.txt"


def parse_seg(fname: str):
    """分片文件名 -> (sid, seq); 非分片名返回 None"""
    m = _SEG_RE.match(fname or "")
    return (m.group("sid"), int(m.group("seq"))) if m else None


def is_legacy_name(fname: str) -> bool:
    """v1 时代的单文件语料名 <sid>.txt(非分片、非隐藏 tmp)"""
    return bool(fname) and fname.endswith(".txt") and not fname.startswith(".") and not parse_seg(fname)


# ---------- manifest ----------
def empty_manifest() -> dict:
    return {"version": MANIFEST_VERSION, "sessions": {}, "segments": {}}


def manifest_path_for(corpus_dir: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(corpus_dir)), "manifest.json")


def load_manifest(path: str) -> dict:
    """读 v2 manifest; 缺失/损坏/旧版本 -> 空 manifest(调用方按"全量重建"处理)"""
    try:
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
    except FileNotFoundError:
        return empty_manifest()
    except Exception:
        return empty_manifest()
    if (not isinstance(m, dict) or m.get("version") != MANIFEST_VERSION
            or not isinstance(m.get("sessions"), dict) or not isinstance(m.get("segments"), dict)):
        return empty_manifest()
    return m


def load_manifest_raw(path: str):
    """原样读磁盘 manifest(不判断版本); 不存在返回 None"""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


class ManifestLock:
    """跨进程互斥(flock); 非 POSIX 退化为 lock 文件存在但不上锁"""

    def __init__(self, manifest_path: str):
        self.lock_path = manifest_path + ".lock"
        self.fh = None

    def __enter__(self):
        try:
            self.fh = open(self.lock_path, "w")
            if fcntl:
                fcntl.flock(self.fh, fcntl.LOCK_EX)
        except OSError:
            self.fh = None
        return self

    def __exit__(self, *exc):
        if self.fh:
            try:
                self.fh.close()
            except OSError:
                pass
        return False


def save_manifest(path: str, man: dict):
    """原子写(调用方负责持锁): 先 tmp(dot 前缀避免被 zg 索引) 再 replace"""
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, f".manifest.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------- 行 ----------
def row_line(row) -> str:
    """(jsonl_line, role, ts, text) -> 语料行"""
    return f"{row[0]}\t{row[1]}\t{row[2]}\t{row[3]}\n"


def row_bytes(row) -> int:
    return len(row_line(row).encode("utf-8"))


def _split_row(line: str):
    parts = line.rstrip("\n").split("\t", 3)
    return parts if len(parts) == 4 else None


def read_segment(corpus_dir: str, fname: str, start_corpus_line: int):
    """读一个分片 -> [(全局行号, jsonl_line, role, ts, text)]; 文件缺失返回 []"""
    rows = []
    try:
        fh = open(os.path.join(corpus_dir, fname), encoding="utf-8")
    except OSError:
        return rows
    with fh:
        for local, line in enumerate(fh, 1):
            parts = _split_row(line)
            if not parts:
                continue
            try:
                jl, ts = int(parts[0]), int(parts[2])
            except ValueError:
                continue
            rows.append((start_corpus_line + local - 1, jl, parts[1], ts, parts[3]))
    return rows


# ---------- 分片索引 ----------
def sessions(man: dict) -> dict:
    """返回 man['sessions'] 本体(可写); 缺失则就地创建"""
    if not isinstance(man, dict):
        return {}
    s = man.get("sessions")
    if not isinstance(s, dict):
        s = {}
        man["sessions"] = s
    return s


def segments(man: dict) -> dict:
    """返回 man['segments'] 本体(可写); 缺失则就地创建"""
    if not isinstance(man, dict):
        return {}
    s = man.get("segments")
    if not isinstance(s, dict):
        s = {}
        man["segments"] = s
    return s


def segs_for(man: dict, sid: str):
    """某 session 的分片元数据, 按 seq 升序 -> [{fname, meta...}]"""
    out = [{"fname": fn, **m} for fn, m in segments(man).items()
           if isinstance(m, dict) and m.get("session_id") == sid]
    out.sort(key=lambda s: s.get("seq") or 0)
    return out


def open_tail(man: dict, sid: str):
    """该 session 的开放尾片(可写)元数据; 没有返回 None"""
    tail = None
    for s in segs_for(man, sid):
        if not s.get("frozen"):
            tail = s
    return tail


def find_segment(man: dict, sid: str, global_line: int):
    """全局行号 -> 分片元数据(含 start_corpus_line/rows); 找不到返回 None"""
    for s in segs_for(man, sid):
        start = s.get("start_corpus_line") or 1
        if start <= global_line < start + (s.get("rows") or 0):
            return s
    return None


def local_line_of(sid: str, man: dict, global_line: int):
    """全局行号 -> (fname, local_line, meta); 找不到返回 (None, None, None)"""
    s = find_segment(man, sid, global_line)
    if not s:
        return None, None, None
    return s["fname"], global_line - (s.get("start_corpus_line") or 1) + 1, s


def session_rows_full(corpus_dir: str, man: dict, sid: str):
    """整会话全部行的拼接(全局行号升序)"""
    rows = []
    for s in segs_for(man, sid):
        rows.extend(read_segment(corpus_dir, s["fname"], s.get("start_corpus_line") or 1))
    return rows


def read_window(corpus_dir: str, man: dict, sid: str, target_global: int):
    """读命中行 + 必要时向左右邻接分片扩展, 直到能凑齐配对
    返回 (rows, idx); 目标行无法定位时返回 (rows, None)"""
    segs = segs_for(man, sid)
    if not segs:
        return [], None
    i = 0
    for k, s in enumerate(segs):
        start = s.get("start_corpus_line") or 1
        if start <= target_global:
            i = k
    lo = hi = i
    rows = read_segment(corpus_dir, segs[lo]["fname"], segs[lo].get("start_corpus_line") or 1)
    while True:
        idx = next((k for k, r in enumerate(rows) if r[0] == target_global), None)
        if idx is None:
            # 目标行不在该分片(分片被重建/行号过期): 若还能扩就继续找
            if lo > 0:
                lo -= 1
                rows = read_segment(corpus_dir, segs[lo]["fname"], segs[lo].get("start_corpus_line") or 1) + rows
                continue
            if hi + 1 < len(segs):
                hi += 1
                rows = rows + read_segment(corpus_dir, segs[hi]["fname"], segs[hi].get("start_corpus_line") or 1)
                continue
            return rows, None
        need_prev = rows[idx][2] != "user" and not find_prev(rows, idx, "user")
        need_next = rows[idx][2] != "assistant" and not find_next(rows, idx, "assistant")
        if need_prev and lo > 0:
            lo -= 1
            rows = read_segment(corpus_dir, segs[lo]["fname"], segs[lo].get("start_corpus_line") or 1) + rows
            continue
        if need_next and hi + 1 < len(segs):
            hi += 1
            rows = rows + read_segment(corpus_dir, segs[hi]["fname"], segs[hi].get("start_corpus_line") or 1)
            continue
        return rows, idx


# ---------- 配对 ----------
def find_prev(rows, idx, role):
    for j in range(idx - 1, -1, -1):
        if rows[j][2] == role:
            return rows[j][4]
    return ""


def find_next(rows, idx, role):
    for j in range(idx + 1, len(rows)):
        if rows[j][2] == role:
            return rows[j][4]
    return ""


def build_pair(rows, idx):
    """命中 idx -> 对话对(hit 行 + 其 user/assistant 伙伴)"""
    line_no, jl, role, ts, text = rows[idx]
    user_txt = text if role == "user" else find_prev(rows, idx, "user")
    asst_txt = text if role == "assistant" else find_next(rows, idx, "assistant")
    return {
        "ref": {"session": "", "jsonl_line": jl, "corpus_line": line_no},
        "role": role,
        "ts": ts,
        "user": user_txt,
        "assistant": asst_txt,
    }


def pair_for_global(corpus_dir: str, man: dict, sid: str, target_global: int):
    """全局行号 -> pair(跨分片配对); 无法定位返回 None"""
    rows, idx = read_window(corpus_dir, man, sid, target_global)
    if idx is None:
        return None
    p = build_pair(rows, idx)
    p["ref"]["session"] = sid
    return p


# ---------- 切分 ----------
def split_point(rows):
    """rows=[(jl, role, ts, text)]: 不需要切分返回 None, 否则返回切点(1..len(rows))"""
    total = sum(row_bytes(r) for r in rows)
    if len(rows) < MAX_SEG_ROWS and total <= MAX_SEG_BYTES:
        return None
    cut, nbytes, n = 0, 0, 0
    for r in rows:
        rb = row_bytes(r)
        if cut > 0 and (n >= MAX_SEG_ROWS or nbytes + rb > MAX_SEG_BYTES):
            break
        nbytes += rb
        n += 1
        cut += 1
    if cut <= 0:
        cut = 1                      # 单行就超限: 独占一片
    cut = min(cut, len(rows))
    # 配对边界: 别把 user 问句留在上一片而它的 assistant 回答落到下一片
    while cut < len(rows) and rows[cut - 1][1] == "user":
        cut += 1
    return cut


def write_segment(corpus_dir: str, fname: str, rows, start_ts=None):
    """原子写一个分片, 并把 mtime 钉在该片首条消息时间(语义时间, 且稳定不变)"""
    os.makedirs(corpus_dir, exist_ok=True)
    tmp = os.path.join(corpus_dir, f".{fname}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(row_line(r) for r in rows)
    os.replace(tmp, os.path.join(corpus_dir, fname))
    if start_ts:
        try:
            os.utime(os.path.join(corpus_dir, fname), (start_ts / 1000, start_ts / 1000))
        except OSError:
            pass


def sha256_prefix(path: str, nbytes: int):
    """文件前 nbytes 字节的 sha256; 文件短于 nbytes 返回 None"""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            left = nbytes
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    return None
                h.update(b)
                left -= len(b)
    except OSError:
        return None
    return h.hexdigest()


def new_hasher():
    return hashlib.sha256()


def seq_allocator(segs, tail_seq):
    """分片 seq 分配: 尾片沿用原 seq(文件名稳定), 其后编号从 max(已有 seq, 尾片 seq)+1 递增"""
    max_seq = max([s.get("seq") or 0 for s in segs] or [0])
    return itertools.chain([tail_seq], range(max(max_seq, tail_seq) + 1, max(max_seq, tail_seq) + 1 + 256))


def corpus_files_of(corpus_dir: str, sid: str):
    """该 session 在磁盘上的所有语料文件(分片 + v1 单文件)"""
    out = []
    for p in glob.glob(os.path.join(corpus_dir, f"{glob_escape(sid)}*")):
        b = os.path.basename(p)
        if b.startswith("."):
            continue
        seg = parse_seg(b)
        if (seg and seg[0] == sid) or (is_legacy_name(b) and b == f"{sid}.txt"):
            out.append(p)
    return out


def glob_escape(s: str) -> str:
    return re.sub(r"([*?\[\]])", r"[\1]", s or "")
