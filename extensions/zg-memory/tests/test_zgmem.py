#!/usr/bin/env python3
"""zg-memory 回归测试(不需要 zg / 嵌入模型, 全离线)

跑: python3 extensions/zg-memory/tests/test_zgmem.py
覆盖评审报告里的 H1/H2/H3/M1/M2, 每条都对着"修之前会怎么错"写断言。

  H1 分片 seq 只有 257 个号 -> 长会话 StopIteration 且 ETL 静默 exit 0
  H2 ref 指向 zg 命中块首行, 不是真正命中的那行
  H3 migrate_cleanup 删掉语料目录里用户自己的 .txt
  M1 尾片校验拿 last_jsonl_line 比语料末行 -> 会话末尾有 toolResult 就每轮全量重建
  M2 "无变化"早退连 zg index 一起跳过 -> 索引被删/上轮失败后永久不修; 并发 lease 也谎报"索引已更新"
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from unittest import mock

warnings.simplefilter("ignore", ResourceWarning)

EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXT_DIR)

# 隔离测试用的数据目录(必须在 import zgmem 之前设好)
_TMP_HOME = tempfile.mkdtemp(prefix="zgmem-test-home-")
os.environ["ZGMEM_DIR"] = _TMP_HOME
os.environ.pop("ZGMEM_SCOPE", None)
os.environ.pop("PI_SESSION_FILE", None)

import jsonl2corpus as j2c      # noqa: E402
import zgmem as zm              # noqa: E402
import zgmem_corpus as zc       # noqa: E402


# ---------- 造数据 ----------
def msg_line(role: str, text: str, ts: int = 1_700_000_000_000) -> str:
    return json.dumps({"type": "message",
                       "message": {"role": role, "timestamp": ts,
                                   "content": [{"type": "text", "text": text}]}},
                      ensure_ascii=False)


def tool_result_line(ts: int = 1_700_000_000_000) -> str:
    """非 user/assistant 文本消息: 不进语料, 但会推进 last_jsonl_line(M1 的成因)"""
    return json.dumps({"type": "toolResult",
                       "message": {"role": "tool", "timestamp": ts,
                                   "content": [{"type": "toolResult", "content": "ok"}]}},
                      ensure_ascii=False)


def make_session(dirpath: str, sid: str, n: int = 4, tail=()):
    p = os.path.join(dirpath, f"{sid}.jsonl")
    lines = []
    for i in range(n):
        lines.append(msg_line("user" if i % 2 == 0 else "assistant", f"{sid} 第 {i} 条消息"))
    lines.extend(tail)
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return p


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zgmem-test-")
        self.sessions = os.path.join(self.tmp, "sessions")
        os.makedirs(self.sessions, exist_ok=True)
        self.corpus = os.path.join(self.tmp, "corpus")
        os.makedirs(self.corpus, exist_ok=True)
        self.mpath = zc.manifest_path_for(self.corpus)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def process(self, path, man, force=False):
        status, n_new = j2c.process_session(path, self.corpus, man, force=force)
        zc.save_manifest(self.mpath, man)      # 很多用例是 process 完再从磁盘读回
        return status, n_new

    def load(self):
        return zc.load_manifest(self.mpath)


# ---------- H1 ----------
class TestH1SeqAllocator(Base):
    def test_seq_allocator_has_no_257_ceiling(self):
        segs = [{"seq": i} for i in range(1, 258)]
        seqs = zc.seq_allocator(segs, 257)
        out = [next(seqs) for _ in range(400)]          # 修前第 258 次取号抛 StopIteration
        self.assertEqual(out[:2], [257, 258])
        self.assertEqual(out[-1], 656)

    def test_seg_name_parse_beyond_9999(self):
        self.assertEqual(zc.parse_seg(zc.seg_name("s", 10000)), ("s", 10000))

    def test_long_session_gets_all_fragments_into_manifest(self):
        """600 条消息 + 每片 1 行的极限设置 -> 远超前 257 片的旧上限"""
        path = make_session(self.sessions, "long", n=600)
        with mock.patch.object(zc, "MAX_SEG_ROWS", 1):
            status, n_new = self.process(path, zc.empty_manifest())
        man = self.load()
        segs = zc.segs_for(man, "long")
        self.assertGreater(len(segs), 257)              # 修前这里会半程崩掉
        self.assertEqual(len(segs), len(man["segments"]))
        self.assertEqual([s["seq"] for s in segs], sorted(s["seq"] for s in segs))
        self.assertEqual(sum(s["rows"] for s in segs), 600)
        self.assertIn("600 msgs", status)


class TestH1EtlFailureIsVisible(Base):
    def test_failed_session_exits_nonzero_and_is_absent(self):
        good = make_session(self.sessions, "good", n=2)
        bad = make_session(self.sessions, "bad", n=2)
        real = j2c.process_session

        def fake(path, corpus_dir, man, force=False):
            if os.path.basename(path).startswith("bad"):
                raise RuntimeError("boom")
            return real(path, corpus_dir, man, force=force)

        buf = io.StringIO()
        with mock.patch.object(j2c, "process_session", side_effect=fake), \
                mock.patch.object(sys, "argv", ["jsonl2corpus.py", os.path.join(self.sessions, "*.jsonl"), self.corpus]), \
                contextlib.redirect_stdout(buf):
            with self.assertRaises(SystemExit) as cm:
                j2c.main()
        self.assertEqual(cm.exception.code, 2)          # 修前: 吞异常 + exit 0
        out = buf.getvalue()
        self.assertIn("RuntimeError: boom", out)
        self.assertIn("失败 1/2", out)
        man = self.load()
        self.assertIn("good", zc.sessions(man))
        self.assertNotIn("bad", zc.sessions(man))
        self.assertTrue(zc.segs_for(man, "good"))


# ---------- H3 ----------
class TestH3MigrateCleanup(Base):
    def test_only_own_artifacts_are_removed(self):
        keep_sid, dead_sid = "keep", "dead"
        files = {
            "notes.txt": "用户自己放在语料目录里的笔记",             # 绝不能被删
            "keep.p0001.txt": "1\tuser\t1\t在用的分片\n",          # manifest 里的分片
            "keep.txt": "1\tuser\t1\tv1 单文件遗留\n",             # 已知 session 的 v1 遗留 -> 删
            f"{dead_sid}.txt": "1\tuser\t1\t已删 session 的 v1\n",  # 已知(旧 manifest) -> 删
            "gone.p0003.txt": "1\tuser\t1\t孤儿分片\n",            # 未知 session 的孤儿片 -> 删
            ".hidden.txt": "隐藏文件\n",                          # 隐藏 -> 不碰
        }
        for name, body in files.items():
            with open(os.path.join(self.corpus, name), "w", encoding="utf-8") as f:
                f.write(body)
        man = zc.empty_manifest()
        zc.segments(man)["keep.p0001.txt"] = {"session_id": keep_sid, "seq": 1, "rows": 1,
                                             "start_jsonl_line": 1, "start_corpus_line": 1,
                                             "start_ts": 1, "frozen": True}
        zc.sessions(man)[keep_sid] = {"jsonl_path": "/x/keep.jsonl"}

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            j2c.migrate_cleanup(self.corpus, man, prev_sids={keep_sid, dead_sid})
        left = set(os.listdir(self.corpus))
        self.assertIn("notes.txt", left)                 # 修前: 被当 legacy 删掉
        self.assertIn("keep.p0001.txt", left)
        self.assertIn(".hidden.txt", left)
        self.assertNotIn("keep.txt", left)
        self.assertNotIn(f"{dead_sid}.txt", left)
        self.assertNotIn("gone.p0003.txt", left)
        self.assertIn("清理遗留语料 3 个", buf.getvalue())

    def test_unknown_legacy_file_is_kept(self):
        with open(os.path.join(self.corpus, "random.txt"), "w") as f:
            f.write("x\n")
        man = zc.empty_manifest()
        j2c.migrate_cleanup(self.corpus, man, prev_sids=set())
        self.assertIn("random.txt", os.listdir(self.corpus))

    def test_no_manifest_still_sweeps_orphan_shards(self):
        """manifest 整个不在(换目录/损坏/先删了)时: 语料目录里的**孤儿分片**要清掉,
        否则它被 zg 索引、却在查询侧被过滤掉 -> 隐形重复(评审 L2)"""
        make_session(self.sessions, "live", n=2)          # dead 的 jsonl 不存在
        if os.path.exists(self.mpath):
            os.unlink(self.mpath)
        for name in ("live.p0001.txt", "dead.p0001.txt"):
            with open(os.path.join(self.corpus, name), "w", encoding="utf-8") as f:
                f.write("1\tuser\t1\t旧语料\n")
        with open(os.path.join(self.corpus, "notes.txt"), "w", encoding="utf-8") as f:
            f.write("用户自己的笔记\n")          # 不是任何 session: 绝不能删(H3)

        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["jsonl2corpus.py", os.path.join(self.sessions, "*.jsonl"), self.corpus]), \
                contextlib.redirect_stdout(buf):
            j2c.main()
        left = set(os.listdir(self.corpus))
        self.assertNotIn("dead.p0001.txt", left)  # 修前: raw is None -> legacy=False -> 从不 cleanup
        self.assertIn("notes.txt", left)          # H3 不能因 L2 的修法回退
        self.assertTrue(zc.segs_for(self.load(), "live"))
        self.assertIn("清理遗留语料 1 个", buf.getvalue())

    def test_stale_staging_and_tmp_are_swept_fresh_kept(self):
        """硬杀留下的 .staging/.tmp 要被清掉, 但刚写的(别的进程正在写)不能动(评审 LOW-5)"""
        path = make_session(self.sessions, "s1", n=2)
        man = zc.empty_manifest()
        j2c.process_session(path, self.corpus, man)
        zc.save_manifest(self.mpath, man)
        seg = sorted(zc.segments(man))[0]        # s1.p0001.txt

        stale = [f".{seg}.staging", f"..{seg}.staging.99999.tmp", f".{seg}.12345.tmp"]
        for name in stale:
            p = os.path.join(self.corpus, name)
            with open(p, "w", encoding="utf-8") as f:
                f.write("半成品\n")
            os.utime(p, (0, 0))                  # 很老 -> 硬杀残留
        fresh = f".{seg}.fresh.staging"
        with open(os.path.join(self.corpus, fresh), "w", encoding="utf-8") as f:
            f.write("另一个进程正在写的\n")

        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["jsonl2corpus.py", os.path.join(self.sessions, "*.jsonl"), self.corpus]), \
                contextlib.redirect_stdout(buf):
            j2c.main()
        left = set(os.listdir(self.corpus))
        for name in stale:
            self.assertNotIn(name, left)         # 修前: 永久残留
        self.assertIn(fresh, left)               # 正在写的半成品: 不能删
        self.assertIn("清理残留半成品 3 个", buf.getvalue())

    def test_v1_flat_manifest_prev_sids_is_honoured(self):
        """v1 是扁平的 {<sid>.txt: ...}; prev_sids 解析不出来 -> 已删 session 的 legacy .txt 永远留着(评审 LOW-1)"""
        path = make_session(self.sessions, "live", n=2)
        with open(self.mpath, "w", encoding="utf-8") as f:      # v1 扁平 manifest
            json.dump({"live.txt": {"jsonl_path": path, "last_offset": 0},
                       "dead.txt": {"jsonl_path": "/gone/dead.jsonl", "last_offset": 0}}, f)
        for name in ("live.txt", "dead.txt"):
            with open(os.path.join(self.corpus, name), "w", encoding="utf-8") as f:
                f.write("1\tuser\t1\tv1 单文件遗留\n")

        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["jsonl2corpus.py", os.path.join(self.sessions, "*.jsonl"), self.corpus]), \
                contextlib.redirect_stdout(buf):
            j2c.main()
        left = set(os.listdir(self.corpus))
        self.assertNotIn("dead.txt", left)     # 修前: prev_sids=set() -> 当成"不是我们的产物"留下
        self.assertNotIn("live.txt", left)     # 在用的 session 的 v1 遗留也要清掉
        self.assertTrue(zc.segs_for(self.load(), "live"))


# ---------- M1 ----------
class TestM1TailConsistency(Base):
    def test_second_run_is_incremental_with_trailing_toolresult(self):
        path = make_session(self.sessions, "sess", n=3, tail=[tool_result_line()])
        man = zc.empty_manifest()
        self.process(path, man)
        zc.save_manifest(self.mpath, man)
        sess = zc.sessions(man)["sess"]
        # 尾片末条语料行 != 扫过的最后一行 JSONL —— 这正是旧校验拿 last_jsonl_line 比时必然失败的原因
        self.assertLess(sess["last_row_jsonl_line"], sess["last_jsonl_line"])

        man2 = self.load()
        status, n_new = self.process(path, man2)
        self.assertIn("(+0 inc)", status)                 # 修前: 这里每轮都是 "(+0 rebuild)"
        self.assertEqual(n_new, 0)
        self.assertEqual(len(zc.segs_for(man2, "sess")), 1)

    def test_append_after_toolresult_is_incremental(self):
        path = make_session(self.sessions, "sess", n=3, tail=[tool_result_line()])
        man = zc.empty_manifest()
        self.process(path, man)
        zc.save_manifest(self.mpath, man)

        with open(path, "a", encoding="utf-8") as f:      # 追加: toolResult + 新消息
            f.write(tool_result_line(1_700_000_100_000) + "\n")
            f.write(msg_line("user", "追加的一条新问题", 1_700_000_100_001) + "\n")
        man2 = self.load()
        status, n_new = self.process(path, man2)
        self.assertIn("(+1 inc)", status)                 # 修前: rebuild
        self.assertEqual(zc.sessions(man2)["sess"]["rows"], 4)


# ---------- H2 ----------
class TestH2HitRefinement(Base):
    def test_query_terms_mixes_ascii_and_cjk(self):
        terms = zc.query_terms("zgmem_corpus.py 分片 seq 上限")
        self.assertIn("zgmem_corpus", terms)
        self.assertIn("分片", terms)
        self.assertIn("seq", terms)

    def test_pick_hit_row_finds_marker_inside_window(self):
        # 模拟 zg: 块首行 64, 真正命中的行在 80(评审复现过的偏移)
        rows = [(i, i, "user" if i % 2 else "assistant", 0, f"第 {i} 行 普通内容") for i in range(1, 121)]
        rows[79] = (80, 80, "assistant", 0, "第 80 行 图书直播选题标记 在这里")
        picked = zc.pick_hit_row(rows, 64, zc.query_terms("图书直播选题标记"))
        self.assertEqual(picked, 80)

    def test_pick_hit_row_falls_back_to_block_start_on_pure_vector_hit(self):
        rows = [(i, i, "user", 0, f"第 {i} 行") for i in range(1, 20)]
        self.assertEqual(zc.pick_hit_row(rows, 5, zc.query_terms("毫无字面重叠的词")), 5)
        self.assertEqual(zc.pick_hit_row(rows, 5, []), 5)

    def test_refine_hit_line_end_to_end(self):
        """真语料: zg 给块首行, 精修后 ref 指向真正命中的那一行"""
        rows = []
        for i in range(1, 101):
            txt = "普通内容 filler" if i != 80 else "图书直播选题 的唯一标记行"
            rows.append(msg_line("user" if i % 2 else "assistant", f"{txt} #{i}", 1_700_000_000_000 + i))
        sid = "hitsess"
        with open(os.path.join(self.sessions, f"{sid}.jsonl"), "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")

        ws = "ws-h2"
        corpus = os.path.join(_TMP_HOME, ws, "corpus")
        os.makedirs(corpus, exist_ok=True)
        man_path = zc.manifest_path_for(corpus)
        man = zc.load_manifest(man_path)
        j2c.process_session(os.path.join(self.sessions, f"{sid}.jsonl"), corpus, man)
        zc.save_manifest(man_path, man)

        zm.use_workspace(ws)
        cname, meta = next(iter(zc.segments(man).items()))
        block_start = 64                                  # zg 只给分片内行号(块首行)
        self.assertEqual(zm._refine_hit_line(cname, meta, block_start, "图书直播选题"), 80)
        with mock.patch.object(zm, "_REFINE_HITS", False):
            self.assertEqual(zm._refine_hit_line(cname, meta, block_start, "图书直播选题"), block_start)


# ---------- M2 ----------
class TestM2IndexRefresh(Base):
    def _fake_zg(self, code: int, out: str):
        """在 PATH 前置一个假 zg; 记录调用到 FAKE_ZG_LOG"""
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir, exist_ok=True)
        log = os.path.join(self.tmp, "zg-calls.log")
        p = os.path.join(bindir, "zg")
        with open(p, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\necho "$@" >> "{log}"\necho "{out}"\nexit {code}\n')
        os.chmod(p, 0o755)
        return bindir, log

    def _refresh(self, ws, sessions_dir, bindir, marker_touch=None):
        env = dict(os.environ)
        env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
        env["ZGMEM_DIR"] = _TMP_HOME
        env.pop("PI_SESSION_FILE", None)
        env.pop("ZGMEM_SCOPE", None)
        proc = subprocess.run([sys.executable, os.path.join(EXT_DIR, "zgmem.py"),
                               "refresh", "--sessions-dir", sessions_dir, "--workspace", ws],
                              capture_output=True, text=True, env=env, timeout=120)
        return proc

    def _prepare(self, ws="ws-m2"):
        sessions = os.path.join(self.tmp, "ws-m2-sessions")
        os.makedirs(sessions, exist_ok=True)
        path = make_session(sessions, "s1", n=4)
        corpus = os.path.join(_TMP_HOME, ws, "corpus")
        os.makedirs(corpus, exist_ok=True)
        man = zc.load_manifest(zc.manifest_path_for(corpus))
        j2c.process_session(path, corpus, man)
        zc.save_manifest(zc.manifest_path_for(corpus), man)
        return sessions, corpus, path

    def _zg_calls(self, log):
        if not os.path.exists(log):
            return 0
        with open(log, encoding="utf-8") as f:
            return sum(1 for l in f if l.strip())

    def test_missing_index_is_repaired_even_with_no_changes(self):
        sessions, corpus, path = self._prepare()
        bindir, log = self._fake_zg(0, "indexed 1 files")
        marker = os.path.join(corpus, ".zvec-grep", "index.zvec")
        os.makedirs(os.path.join(marker, "seg"), exist_ok=True)   # zg 建出来的是**目录**

        # 索引在, 但从来没有过"成功索引"的状态戳(旧版本遗留/刚升级): 必须补跑一次把戳建起来
        p0 = self._refresh("ws-m2", sessions, bindir)
        self.assertIn("补跑索引", p0.stdout)
        self.assertIn("索引已更新", p0.stdout)
        self.assertEqual(self._zg_calls(log), 1)

        # 戳已建好 + 无变化: 真的没事做, 一次 zg 都不该跑
        # (修前 isfile 判目录 -> 每轮都白跑一整轮嵌入)
        p1 = self._refresh("ws-m2", sessions, bindir)
        self.assertIn("无变化", p1.stdout)
        self.assertIn("索引已是最新", p1.stdout)
        self.assertEqual(self._zg_calls(log), 1)

        shutil.rmtree(marker)                             # 索引被删(或上轮失败)
        p2 = self._refresh("ws-m2", sessions, bindir)
        self.assertEqual(p2.returncode, 0)
        self.assertIn("索引缺失, 重建索引", p2.stdout)      # 修前: "无变化, 无需更新" 直接 return
        self.assertIn("索引已更新", p2.stdout)
        self.assertEqual(self._zg_calls(log), 2)           # 修前这里一次 zg 都没跑

    def test_lease_active_does_not_claim_index_updated(self):
        sessions, corpus, path = self._prepare("ws-lease")
        bindir, log = self._fake_zg(1, "ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE: somebody else owns writes")
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:       # 制造变化 -> 走到索引阶段
            f.write(msg_line("user", "新的问题", 1_700_000_200_000) + "\n")

        proc = self._refresh("ws-lease", sessions, bindir)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("lease active", proc.stdout)
        self.assertNotIn("索引已更新", proc.stdout)         # 修前: 照样说"索引已更新"
        self.assertTrue(os.path.exists(log))

    def test_index_failure_is_reported_and_exits_nonzero(self):
        sessions, corpus, path = self._prepare("ws-fail")
        bindir, log = self._fake_zg(4, "fatal: embedding model unavailable")
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(msg_line("user", "新的问题", 1_700_000_300_000) + "\n")

        proc = self._refresh("ws-fail", sessions, bindir)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("zg index 失败", proc.stdout)
        self.assertNotIn("索引已更新", proc.stdout)

    def test_index_failure_is_retried_on_next_refresh(self):
        """上轮 zg index 失败后, 下一轮必须真的重试——修前会一直报"无变化, 索引已是最新"(评审 HIGH-1)"""
        sessions, corpus, path = self._prepare("ws-retry")
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)
        bindir_ok, log = self._fake_zg(0, "indexed 1 files")
        self.assertEqual(self._refresh("ws-retry", sessions, bindir_ok).returncode, 0)   # 先成功一次, 建立状态戳
        base = self._zg_calls(log)

        with open(path, "a", encoding="utf-8") as f:
            f.write(msg_line("user", "只有这轮才有的新问题", 1_700_000_500_000) + "\n")

        bindir_bad, _ = self._fake_zg(4, "fatal: embedding model unavailable")
        p_bad = self._refresh("ws-retry", sessions, bindir_bad)
        self.assertEqual(p_bad.returncode, 3)
        self.assertEqual(self._zg_calls(log), base + 1)

        # 关键: 这轮 jsonl 没变化, 但上轮索引失败过 -> 绝不能早退
        bindir_ok2, _ = self._fake_zg(0, "indexed 1 files")
        p_retry = self._refresh("ws-retry", sessions, bindir_ok2)
        self.assertEqual(p_retry.returncode, 0)
        self.assertNotIn("索引已是最新", p_retry.stdout)     # 修前: 正是这句 -> 永久放弃重试
        self.assertIn("索引已更新", p_retry.stdout)
        self.assertEqual(self._zg_calls(log), base + 2)

    def test_empty_corpus_still_runs_zg_index(self):
        """语料被删光但索引还在: 也要跑 zg index, 否则已删文件的向量永远留在索引里(评审 LOW-3)"""
        sessions, corpus, path = self._prepare("ws-empty")
        for f in os.listdir(corpus):                       # 手工清空语料(模拟被删光)
            if f.endswith(".txt"):
                os.unlink(os.path.join(corpus, f))
        bindir, log = self._fake_zg(0, "indexed 1 files")
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)

        p = self._refresh("ws-empty", sessions, bindir)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(self._zg_calls(log), 1)           # 修前: "语料目录为空, 跳过索引" -> 永不清理

    def test_write_failure_keeps_old_segments_and_manifest(self):
        """重建时写新片失败(ENOSPC): 旧分片字节不动, manifest 条目不动, 不留 staging 垃圾(评审 MED-1)"""
        def blobs():
            out = {}
            for f in os.listdir(self.corpus):
                if f.endswith(".txt"):
                    with open(os.path.join(self.corpus, f), "rb") as fh:
                        out[f] = fh.read()
            return out

        path = make_session(self.sessions, "w1", n=20)
        with mock.patch.object(zc, "MAX_SEG_ROWS", 5):
            self.process(path, zc.empty_manifest())        # 先建好语料(4 片)
        before = blobs()
        self.assertGreaterEqual(len(before), 2)            # 需要 ≥2 片才能在第 2 片注入失败
        man = self.load()
        man_before = json.loads(json.dumps(man))

        real = zc.write_segment
        calls = {"n": 0}

        def flaky(corpus_dir, fname, rows, start_ts=None):
            if fname.endswith(".staging"):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise OSError(28, "No space left on device")
            return real(corpus_dir, fname, rows, start_ts=start_ts)

        # force=True -> 走入重建路径(追加消息是增量的, 只重写一片, 造不出"写第 2 片时挂")
        with mock.patch.object(zc, "MAX_SEG_ROWS", 5), mock.patch.object(zc, "write_segment", flaky):
            with self.assertRaises(OSError):
                j2c.process_session(path, self.corpus, man, force=True)

        self.assertGreaterEqual(calls["n"], 2)
        self.assertEqual(before, blobs())                  # 修前: 旧片被 unlink, 只剩写成的第 1 片
        self.assertEqual([f for f in os.listdir(self.corpus) if ".staging" in f], [])
        self.assertEqual(man_before, json.loads(json.dumps(man)))   # 修前: session 条目已被摘掉

    def test_etl_failure_exits_2_but_still_indexes(self):
        """ETL 挂了(会话文件读不了)也要: 退出码非 0 + zg 索引照跑 + 旧语料不被清掉"""
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root 下 chmod 000 拦不住读, 没法制造 ETL 失败")
        sessions, corpus, path = self._prepare("ws-etl")
        bindir, log = self._fake_zg(0, "indexed 1 files")
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)

        man_before = zc.load_manifest(zc.manifest_path_for(corpus))
        names = sorted(zc.segments(man_before))
        self.assertTrue(names)
        blob = {}
        for f in names:
            with open(os.path.join(corpus, f), "rb") as fh:
                blob[f] = fh.read()

        with open(path, "a", encoding="utf-8") as f:      # 先造变化, 否则"无变化"早退不会进 ETL
            f.write(msg_line("user", "新的问题", 1_700_000_400_000) + "\n")
        os.chmod(path, 0)                                  # ETL 子进程读不了 -> 必然失败
        try:
            proc = self._refresh("ws-etl", sessions, bindir)
        finally:
            os.chmod(path, 0o644)

        self.assertEqual(proc.returncode, 2)               # 修前: 吞异常 + exit 0
        self.assertIn("ETL 失败", proc.stdout)
        self.assertIn("PermissionError", proc.stdout)
        self.assertIn("索引已更新", proc.stdout)            # ETL 失败也不阻断 zg 索引
        with open(log, encoding="utf-8") as f:
            self.assertIn("index .", f.read())

        man_after = zc.load_manifest(zc.manifest_path_for(corpus))
        self.assertIn("s1", zc.sessions(man_after))        # 会话条目没被拿掉
        self.assertEqual(names, sorted(zc.segments(man_after)))
        for f, b in blob.items():                          # 旧分片字节没被清空重写
            with open(os.path.join(corpus, f), "rb") as fh:
                self.assertEqual(b, fh.read())

    def test_corpus_change_during_index_is_not_declared_indexed(self):
        """索引**运行期间**别的实例往语料里写了新行: 戳只能描述 index 启动时的语料,
        否则下一轮会谎报"索引已是最新", 那一行永久搜不到(评审 MED-2)"""
        def disk_fp(corpus):
            files = [p for p in os.listdir(corpus) if p.endswith(".txt") and not p.startswith(".")]
            total, newest = 0, 0.0
            for f in files:
                st = os.stat(os.path.join(corpus, f))
                total += st.st_size
                newest = max(newest, st.st_mtime)
            return {"files": len(files), "bytes": total, "newest_mtime": int(newest * 1000)}

        sessions, corpus, path = self._prepare("ws-race")
        shard = os.path.join(corpus, sorted(f for f in os.listdir(corpus) if f.endswith(".txt"))[0])
        os.makedirs(os.path.join(corpus, ".zvec-grep", "index.zvec"), exist_ok=True)   # 索引本来就在
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir, exist_ok=True)
        log = os.path.join(self.tmp, "zg-calls.log")
        # 假 zg: 在"索引期间"往语料追加一行(等价于并发 refresh 的 ETL 落在索引窗口内)
        with open(os.path.join(bindir, "zg"), "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\necho "$@" >> "{log}"\n'
                    f'printf \'99\\tuser\\t1700000000000\\t索引期间被别的实例写进来的行\\n\' >> "{shard}"\n'
                    'exit 0\n')
        os.chmod(os.path.join(bindir, "zg"), 0o755)

        p0 = self._refresh("ws-race", sessions, bindir)
        self.assertEqual(p0.returncode, 0)
        self.assertIn("索引已更新", p0.stdout)
        self.assertEqual(self._zg_calls(log), 1)

        # 关键: 戳必须描述"索引启动时"的语料, 而不是索引跑完之后被改过的语料
        with open(os.path.join(_TMP_HOME, "ws-race", "index-stamp.json"), encoding="utf-8") as f:
            stamp = json.load(f)
        disk = disk_fp(corpus)
        self.assertNotEqual(stamp["bytes"], disk["bytes"])   # 修前: 现场取戳 -> 与磁盘完全相等
        self.assertNotEqual(stamp, disk)                      # 修前: 正是这个相等 -> 下一轮早退

        # 行为面: 那次索引没覆盖到新行 -> 下一轮绝不能早退, zg 必须再跑
        p1 = self._refresh("ws-race", sessions, bindir)
        self.assertNotIn("索引已是最新", p1.stdout)             # 修前: 谎报已最新
        self.assertEqual(self._zg_calls(log), 2)               # 修前: 一次 zg 都不跑

    def test_refresh_sweeps_stale_tmp_without_any_change(self):
        """没有任何 session 变化时 ETL 根本不会被调用, 但 refresh 也必须清扫硬杀残留
        (真机冒烟发现的缺口: 只在 jsonl2corpus 里扫, 残留会永久留着)"""
        sessions, corpus, path = self._prepare("ws-sweep")
        bindir, log = self._fake_zg(0, "indexed 1 files")
        seg = sorted(zc.segments(zc.load_manifest(zc.manifest_path_for(corpus))))[0]
        stale = os.path.join(corpus, f".{seg}.staging")
        with open(stale, "w", encoding="utf-8") as f:
            f.write("半成品\n")
        os.utime(stale, (0, 0))
        fresh = os.path.join(corpus, f".{seg}.fresh.staging")
        with open(fresh, "w", encoding="utf-8") as f:
            f.write("另一个进程正在写的\n")

        p = self._refresh("ws-sweep", sessions, bindir)
        self.assertEqual(p.returncode, 0)
        self.assertIn("清理残留半成品 1 个", p.stdout)
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(fresh))


class TestIdempotent(Base):
    def test_frozen_prefix_is_stable_and_later_runs_stay_incremental(self):
        """冻结分片字节永不变 -> 无变化轮次不重写任何片、也不分配新片号"""
        path = make_session(self.sessions, "s", n=50)
        with mock.patch.object(zc, "MAX_SEG_ROWS", 5):
            man = zc.empty_manifest()
            self.process(path, man)
            names = sorted(zc.segments(man))
            metas = [zc.segments(man)[f] for f in names]
            self.assertEqual(sum(m["rows"] for m in metas), 50)
            self.assertEqual(sum(1 for m in metas if not m["frozen"]), 1)   # 只有一个开放尾片
            blob = {}
            for f in names:
                with open(os.path.join(self.corpus, f), "rb") as fh:
                    blob[f] = fh.read()

            with open(path, "a", encoding="utf-8") as f:
                f.write(msg_line("user", "追加第 51 条", 1_700_000_600_000) + "\n")

            man2 = self.load()
            status, n_new = self.process(path, man2)
            self.assertIn("(+1 inc)", status)              # 追加不改整轮重建
            self.assertEqual(n_new, 1)
            zc.save_manifest(self.mpath, man2)
            for f, meta in zc.segments(man).items():        # 冻结前缀字节不变
                if meta.get("frozen") and f in zc.segments(man2):
                    with open(os.path.join(self.corpus, f), "rb") as fh:
                        self.assertEqual(blob[f], fh.read())

            before = sorted(zc.segments(man2))
            man3 = self.load()
            status3, n3 = self.process(path, man3)
            self.assertIn("(+0 inc)", status3)
            self.assertEqual(n3, 0)
            self.assertEqual(before, sorted(zc.segments(man3)))   # 本轮不再写任何片


if __name__ == "__main__":
    unittest.main(verbosity=2)
