#!/usr/bin/env python3
"""差分对拍的裁判侧：用 Python 实现（zgmem_corpus.py）计算一个 case 的结果。

只服务于迁移期（见 docs/plan-ts-migration.md）：由 corpus_differential.ts 调用，
逐函数与 lib/corpus.ts 对拍。迁移完成后本文件随 Python 实现一起删除。

约定：stdin 收一个 JSON case，stdout 输出规范化的 JSON 结果（sort_keys，便于比对）。
"""
import contextlib
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extensions", "zg-memory"))
import zgmem_corpus as zc  # noqa: E402


def rows_of(rs):
    """case 里的行用对象表示 -> Python 侧元组 (jl, role, ts, text)。"""
    return [(r["jsonlLine"], r["role"], r["ts"], r["text"]) for r in rs]


def segs_of(segs):
    """case 里的分片元数据 -> Python 侧 dict 列表（segs_for/seq_allocator 的入参形状）。"""
    return [{"fname": s["fname"], **{k: v for k, v in s.items() if k != "fname"}} for s in segs]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def row_digest(r):
    """行摘要 (line, jl, role, ts, nbytes, sha256前16) —— 语料里可能有整段图片二进制，
    不能把全文放进 JSON 来回传（会把 spawnSync 的 maxBuffer 撞爆）。
    两边都用同一个摘要就能做等价比对，而且冲突几率可忽略。"""
    b = r[4].encode("utf-8")
    return [r[0], r[1], r[2], r[3], len(b), hashlib.sha256(b).hexdigest()[:16]]


def canon(v):
    return json.loads(json.dumps(v, ensure_ascii=False, sort_keys=True, default=str))


def main():
    case = json.load(sys.stdin)
    op = case["op"]

    if op == "seg_name":
        out = [zc.seg_name(sid, seq) for sid, seq in case["pairs"]]

    elif op == "parse_seg":
        out = [list(s) if (s := zc.parse_seg(n)) else None for n in case["names"]]

    elif op == "is_legacy":
        out = [zc.is_legacy_name(n) for n in case["names"]]

    elif op == "row_line":
        out = [zc.row_line(r) for r in rows_of(case["rows"])]

    elif op == "row_bytes":
        out = [zc.row_bytes(r) for r in rows_of(case["rows"])]

    elif op == "split":
        out = []
        for c in case["cases"]:
            zc.MAX_SEG_ROWS = c["limits"]["rows"]
            zc.MAX_SEG_BYTES = c["limits"]["bytes"]
            out.append(zc.split_point(rows_of(c["rows"])))
        zc.MAX_SEG_ROWS = 200
        zc.MAX_SEG_BYTES = 64 * 1024

    elif op == "seq_alloc":
        gen = zc.seq_allocator(segs_of(case["segs"]), case["tail_seq"])
        out = [next(gen) for _ in range(case["take"])]

    elif op == "terms":
        out = [sorted(zc.query_terms(q)) for q in case["queries"]]

    elif op == "score":
        out = [zc.row_score(c["text"], c["terms"]) for c in case["cases"]]

    elif op == "pick":
        out = []
        for c in case["cases"]:
            # read_segment 的 5 元组形状喂给 pick_hit_row
            rows = [(r["line"], r["jsonlLine"], r["role"], r["ts"], r["text"]) for r in c["rows"]]
            out.append(zc.pick_hit_row(rows, c["start"], c["terms"], c.get("span")))

    elif op == "write":
        # 用 Python 侧写分片 + manifest，返回每个文件的 sha256 与 mtime(ms)
        d = case["dir"]
        os.makedirs(d, exist_ok=True)
        zc.save_manifest(case["manifest_path"], case["manifest"])
        files = []
        for f in case["files"]:
            zc.write_segment(d, f["fname"], rows_of(f["rows"]), start_ts=f.get("start_ts"))
            p = os.path.join(d, f["fname"])
            files.append({"name": f["fname"], "sha256": sha(p), "mtime_ms": round(os.stat(p).st_mtime * 1000)})
        out = {"files": sorted(files, key=lambda x: x["name"]), "manifest_sha256": sha(case["manifest_path"])}

    elif op == "read_segment":
        out = [list(r) for r in zc.read_segment(case["dir"], case["fname"], case["start"])]

    elif op == "read_segment_digest":
        out = [row_digest(r) for r in zc.read_segment(case["dir"], case["fname"], case["start"])]

    elif op == "window_digest":
        man = zc.load_manifest(case["manifest_path"])
        rows, idx = zc.read_window(case["dir"], man, case["sid"], case["target"])
        out = {"rows": [row_digest(r) for r in rows], "idx": idx}

    elif op == "window":
        man = zc.load_manifest(case["manifest_path"])
        rows, idx = zc.read_window(case["dir"], man, case["sid"], case["target"])
        out = {"rows": [list(r) for r in rows], "idx": idx}

    elif op == "pair":
        man = zc.load_manifest(case["manifest_path"])
        p = zc.pair_for_global(case["dir"], man, case["sid"], case["target"])
        out = dict(p) if p else None

    elif op == "sha_prefix":
        out = zc.sha256_prefix(case["path"], case["n"])

    elif op == "sweep":
        # Python 的 sweep_stale_tmp 会直接 print（计划里的已知差异 #2：TS lib 不打印，
        # 输出交给 cli.ts）。这里把它的 stdout 引到 stderr，否则 JSON 被打印污染。
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            out = zc.sweep_stale_tmp(case["dir"], max_age=case["max_age"])
        sys.stderr.write(buf.getvalue())

    elif op == "load_manifest":
        m = zc.load_manifest(case["manifest_path"])
        out = {"version": m.get("version"), "sessions": sorted(zc.sessions(m)), "segments": sorted(zc.segments(m))}

    else:
        raise SystemExit(f"unknown op: {op}")

    print(json.dumps(canon(out), ensure_ascii=False))


if __name__ == "__main__":
    main()
