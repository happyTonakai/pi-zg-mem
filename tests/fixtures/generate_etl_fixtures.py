#!/usr/bin/env python3
"""生成 ETL(模块 B)的**黄金样本**: tests/fixtures/etl/{sessions,expected}

迁移期的"裁判"是 Python 版 jsonl2corpus.py。生成一次之后提交进仓库,
之后 TS 侧的回归(node --test)不再需要 Python —— 与模块 A 的
tests/fixtures/generate_corpus_fixtures.py 同一套路。

跑: python3 tests/fixtures/generate_etl_fixtures.py

样本刻意覆盖这些边界(每一条都对应一个"容易写错"的地方):
  - 常规 user/assistant 文本 + 时间戳
  - CJK / emoji / 制表符 / 连续空白(clean_text 的空白折叠)
  - 末行没有换行(半行不消费、不喂 hasher)
  - 畸形 JSON 行 / 非 message 行 / role 不是 user|assistant / 非 text 的内容块
  - 空 session(只有噪声行 -> 0 条语料, 仍要登记)
  - 410 条消息 -> 按 200 行上限切成 3 片(多片 + 冻结片 + 开放尾片)
  - 单条 70KB 文本 -> 按 64KB 字节上限切分
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "extensions", "zg-memory")
FIXTURES = os.path.join(HERE, "etl")
SESSIONS = os.path.join(FIXTURES, "sessions")
EXPECTED = os.path.join(FIXTURES, "expected")
MTIME = 1_700_000_000                                       # 固定 mtime, 让 manifest 可逐字节比对
PLACEHOLDER = "__SESSIONS_DIR__"


def msg(role, text, ts):
    return json.dumps({"type": "message",
                       "message": {"role": role, "timestamp": ts,
                                   "content": [{"type": "text", "text": text}]}},
                      ensure_ascii=False)


def noise(ts):
    return json.dumps({"type": "toolResult",
                       "message": {"role": "tool", "timestamp": ts,
                                   "content": [{"type": "toolResult", "content": "ok"}]}},
                      ensure_ascii=False)


def write(name, lines, trailing_newline=True):
    p = os.path.join(SESSIONS, name)
    body = "\n".join(lines) + ("\n" if trailing_newline else "")
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    os.utime(p, (MTIME, MTIME))
    return p


def build_sessions():
    shutil.rmtree(SESSIONS, ignore_errors=True)
    os.makedirs(SESSIONS, exist_ok=True)

    # 1) 常规 + 空白折叠 + CJK/emoji/制表符
    write("s-small.jsonl", [
        msg("user", "  用\t\ttab  和  多空格 \n 换行  的问句  ", 1_700_000_001_000),
        noise(1_700_000_001_500),
        msg("assistant", "回答里有 CJK 与 emoji 🎉 和 \"引号\" 与反斜杠 n 字面量", 1_700_000_002_000),
        msg("user", "第二个问题", 1_700_000_003_000),
    ])

    # 2) 末行没有换行 -> 半行不消费
    write("s-noeol.jsonl", [
        msg("user", "完整的一行", 1_700_000_010_000),
        msg("assistant", "最后一行没有换行结尾", 1_700_000_011_000),
    ], trailing_newline=False)

    # 3) 全是噪声: 畸形 JSON / 非 message / role 不对 / 内容块不是 text / text 为空
    write("s-noise.jsonl", [
        "{ this is not json",
        json.dumps({"type": "session_start", "id": "x"}),
        json.dumps({"type": "message", "message": {"role": "system", "timestamp": 1,
                                                   "content": [{"type": "text", "text": "系统消息"}]}}),
        json.dumps({"type": "message", "message": {"role": "user", "timestamp": 2,
                                                   "content": [{"type": "image", "url": "x.png"}]}}),
        json.dumps({"type": "message", "message": {"role": "assistant", "timestamp": 3,
                                                   "content": [{"type": "text", "text": "   "}]}}),
        noise(4),
    ])

    # 4) 空文件
    write("s-empty.jsonl", [])

    # 5) 410 条 -> 3 片(200/200/10)
    write("s-long.jsonl", [msg("user" if i % 2 == 0 else "assistant", f"long 第 {i} 条", 1_700_000_100_000 + i)
                           for i in range(410)])

    # 6) 单条 70KB -> 触发字节上限切分
    #    注意要有 **两对** 问答: split_point 的配对边界规则会把 "user 问句 + 它的回答"
    #    绑在同一片里
    write("s-big.jsonl", [
        msg("user", "B" * 70_000, 1_700_000_200_000),
        msg("assistant", "跟在超大行后面的回答", 1_700_000_200_001),
        msg("user", "第二对问句", 1_700_000_200_002),
        msg("assistant", "第二对回答", 1_700_000_200_003),
    ])

    # 7) sid 里带点(parse_seg/legacy 名的边界)
    write("s.with.dot.jsonl", [
        msg("user", "sid 里有点", 1_700_000_300_000),
        msg("assistant", "一样要能进语料", 1_700_000_300_001),
    ])


def main():
    build_sessions()
    tmp_root = tempfile.mkdtemp(prefix="zgmem-etl-fixtures-")
    corpus = os.path.join(tmp_root, "corpus")
    try:
        subprocess.run([sys.executable, os.path.join(EXT_DIR, "jsonl2corpus.py"),
                        os.path.join(SESSIONS, "*.jsonl"), corpus], check=True,
                       stdout=subprocess.DEVNULL)
        shutil.rmtree(EXPECTED, ignore_errors=True)
        os.makedirs(os.path.join(EXPECTED, "corpus"), exist_ok=True)
        shutil.copy(os.path.join(tmp_root, "manifest.json"), os.path.join(EXPECTED, "manifest.json"))
        for name in sorted(os.listdir(corpus)):
            if name.endswith(".txt"):
                shutil.copy(os.path.join(corpus, name), os.path.join(EXPECTED, "corpus", name))

        # manifest 里的 jsonl_path 是绝对路径 -> 换成占位符, 测试时再填回临时目录
        mp = os.path.join(EXPECTED, "manifest.json")
        with open(mp, encoding="utf-8") as f:
            raw = f.read()
        raw = raw.replace(json.dumps(SESSIONS)[1:-1], PLACEHOLDER)
        with open(mp, "w", encoding="utf-8") as f:
            f.write(raw)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    n_seg = len(os.listdir(os.path.join(EXPECTED, "corpus")))
    print(f"黄金样本已生成: {len(os.listdir(SESSIONS))} 个 session, {n_seg} 个分片 -> {EXPECTED}")


if __name__ == "__main__":
    main()
