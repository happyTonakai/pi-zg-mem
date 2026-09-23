#!/usr/bin/env python3
"""生成黄金样本（golden fixtures）：用 Python 实现写出期望产物，提交到仓库。

    python3 tests/fixtures/generate_corpus_fixtures.py

产物：
    tests/fixtures/corpus_plan.json        —— 输入（分片行 + manifest），TS 侧据此复现
    tests/fixtures/golden_segments/*.txt   —— 期望的分片文件字节
    tests/fixtures/golden_manifest.json    —— 期望的 manifest.json 字节

为什么要有它：差分对拍（tests/differential/）需要 Python 才能跑，CI 里没有 Python。
黄金样本把"Python 当裁判"这一步固化下来 —— TS 只需逐字节复现这些文件，
CI 就不依赖 Python 了（见 docs/plan-ts-migration.md 回归策略第 1 层）。

⚠️ 只在**确认 Python 行为是正确**的时候重新生成；一旦重新生成，diff 必须逐字节 review。
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "extensions", "zg-memory"))
import zgmem_corpus as zc  # noqa: E402

T = 1_700_000_000_000  # 固定的基准时间戳，保证产物可复现


def R(jl, role, ts, text):
    return (jl, role, ts, text)


# 覆盖点：CJK、制表符、空文本、含换行文本、emoji(代理对)、5 位 seq、带点的 sid、非 ASCII sid
FILES = [
    ("sess-a.p0001.txt", 1_700_000_000_000, [R(1, "user", T + 1, "普通内容 filler"), R(2, "assistant", T + 2, "第二个 回复")]),
    ("sess-a.p0002.txt", 1_700_000_010_000, [R(3, "user", T + 3, "含\t制表符 的文本"), R(4, "toolResult", T + 4, "")]),
    ("sess-a.p10000.txt", 1_700_000_020_000, [R(5, "user", T + 5, "第 10000 片，验证 5 位 seq")]),
    ("sess-b.p0001.txt", 1_700_000_030_000, [R(1, "user", T + 6, "带换行的\n文本 会被拆成两行"), R(2, "assistant", T + 7, "emoji 🙂 和 中文")]),
    ("a.b.p0007.txt", 1_700_000_040_000, [R(1, "user", T + 8, "sid 里带点")]),
    ("中文-会话.p0001.txt", 1_700_000_050_000, [R(1, "user", T + 9, "非 ASCII sid，测 manifest 的 ensure_ascii=False")]),
]


def build_manifest():
    man = zc.empty_manifest()
    man["sessions"] = {
        "sess-a": {"first_ts": T + 1, "last_ts": T + 5},
        "sess-b": {"first_ts": T + 6, "last_ts": T + 7},
        "a.b": {"first_ts": T + 8, "last_ts": T + 8},
        "中文-会话": {"first_ts": T + 9, "last_ts": T + 9},
    }
    man["segments"] = {}
    start = {"sess-a": 1, "sess-b": 1, "a.b": 1, "中文-会话": 1}
    for i, (fname, start_ts, rows) in enumerate(FILES):
        sid, seq = zc.parse_seg(fname)
        man["segments"][fname] = {
            "session_id": sid,
            "seq": seq,
            "start_corpus_line": start[sid],
            "rows": len(rows),
            "frozen": i < len(FILES) - 1,
            "start_ts": start_ts,
            "end_ts": rows[-1][2] if rows else start_ts,
        }
        start[sid] += len(rows)
    return man


def main():
    gold = os.path.join(HERE, "golden_segments")
    shutil.rmtree(gold, ignore_errors=True)
    os.makedirs(gold)
    man = build_manifest()
    for fname, start_ts, rows in FILES:
        zc.write_segment(gold, fname, rows, start_ts=start_ts)
    zc.save_manifest(os.path.join(HERE, "golden_manifest.json"), man)

    plan = {
        "_comment": "由 generate_corpus_fixtures.py 生成；改 Python 实现后要重新生成并逐字节 review diff",
        "files": [{"fname": f, "start_ts": ts, "rows": [{"jsonlLine": r[0], "role": r[1], "ts": r[2], "text": r[3]} for r in rows]} for f, ts, rows in FILES],
        "manifest": man,
    }
    with open(os.path.join(HERE, "corpus_plan.json"), "w", encoding="utf-8") as fh:
        import json

        json.dump(plan, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"wrote {len(FILES)} segments + manifest + plan -> {HERE}")


if __name__ == "__main__":
    main()
