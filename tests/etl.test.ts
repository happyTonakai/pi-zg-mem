/**
 * 模块 B（lib/etl.ts ← jsonl2corpus.py）的回归。
 *
 * 用例名**沿用 Python 原名**（extensions/zg-memory/tests/test_zgmem.py），便于逐条对照：
 *   TestH1SeqAllocator.test_long_session_gets_all_fragments_into_manifest
 *   TestH1EtlFailureIsVisible.test_failed_session_exits_nonzero_and_is_absent
 *   TestH3MigrateCleanup × 5
 *   TestM1TailConsistency × 2
 *   TestIdempotent × 1
 *   + 黄金样本逐字节比对（Python 只当生成器，跑测试不需要它）
 *
 * 两处有意偏离 Python 原测试，都记在对应用例注释里：
 *   1) 没有 mock.patch：ESM 导出不可打桩，改为制造**真实的失败会话**（更接近真实路径）；
 *   2) 库层不再 print（评审：库函数不写 stdout），清理条数改为断言返回值而不是 stdout 文本，
 *      相应的 CLI 文案由 test_no_manifest_still_sweeps_orphan_shards 覆盖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as zc from "../extensions/zg-memory/lib/corpus.ts";
import * as j2c from "../extensions/zg-memory/lib/etl.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ETL = path.join(HERE, "fixtures", "etl");
const PLACEHOLDER = "__SESSIONS_DIR__";
/** 生成器 tests/fixtures/generate_etl_fixtures.py 用的固定 mtime。 */
const FIXTURE_MTIME = 1_700_000_000;
const MSG_TS = 1_700_000_000_000;

// ---------- 造数据（对应 Python 的 msg_line / tool_result_line / make_session）----------

interface Msg {
  type: string;
  message: { role: string; timestamp: number; content: unknown[] };
}

function msgLine(role: string, text: string, ts: number = MSG_TS): string {
  return JSON.stringify({
    type: "message",
    message: { role, timestamp: ts, content: [{ type: "text", text }] },
  });
}

/** 非 user/assistant 文本消息：不进语料，但会推进 last_jsonl_line（M1 的成因）。 */
function toolResultLine(ts: number = MSG_TS): string {
  return JSON.stringify({
    type: "toolResult",
    message: { role: "tool", timestamp: ts, content: [{ type: "toolResult", content: "ok" }] },
  });
}

function makeSession(dir: string, sid: string, n = 4, tail: string[] = []): string {
  const p = path.join(dir, `${sid}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(msgLine(i % 2 === 0 ? "user" : "assistant", `${sid} 第 ${i} 条消息`));
  }
  lines.push(...tail);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// ---------- Base（对应 Python 的 Base.setUp/process/load）----------

interface Base {
  tmp: string;
  sessions: string;
  corpus: string;
  mpath: string;
  /** py: `Base.process` —— process_session + save_manifest（很多用例要从磁盘读回）。 */
  process(p: string, man: zc.Manifest, force?: boolean): { status: string; nNew: number };
  load(): zc.Manifest;
}

function mkBase(): Base {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-test-"));
  const sessions = path.join(tmp, "sessions");
  const corpus = path.join(tmp, "corpus");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(corpus, { recursive: true });
  const mpath = zc.manifestPathFor(corpus);
  return {
    tmp,
    sessions,
    corpus,
    mpath,
    process(p, man, force = false) {
      const { status, nNew } = j2c.processSession(p, corpus, man, { force });
      zc.saveManifest(mpath, man);
      return { status, nNew };
    },
    load: () => zc.loadManifest(mpath),
  };
}

/** 建临时工作区跑用例，结束就删（对应 Python 的 setUp/tearDown）。 */
function withBase(fn: (b: Base) => void): void {
  const b = mkBase();
  try {
    fn(b);
  } finally {
    fs.rmSync(b.tmp, { recursive: true, force: true });
  }
}

/** 跑 ETL CLI 并捕获 stdout/stderr（对应 Python 的 redirect_stdout + mock argv）。 */
function runCli(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = j2c.etlMain(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

function writeFile(p: string, body: string): void {
  fs.writeFileSync(p, body, "utf8");
}

const SEG_LIMITS = (rows: number): zc.SegLimits => ({ rows, bytes: 64 * 1024 });

// ---------- 已知残余差异的常驻守卫：非标准 JSON 字面量 ----------

/**
 * A3（第三轮评审：Module G 删掉 Python 后零守卫的静默错答案）。
 *
 * Python 的 `json.loads` 默认接受 `NaN` / `Infinity` / `-Infinity`（JS 的 `JSON.parse` 拒绝），
 * 于是这三个字面量成为**已记录的残余差异**（docs/plan-ts-migration.md「已知残余差异」）：
 *   - 只含 `NaN` 的行：Python `int(nan)` 抛 ValueError → 被 row_of 的 `except (TypeError, ValueError)`
 *     兜住 → **该行以 `ts=0` 收进语料**；TS 侧 `JSON.parse` 直接抛 → rowOf 返回 null → **丢行**。
 *   - 含 `±Infinity` 的行：Python `int(inf)` 抛 OverflowError（**不在** except 内）→ **整个 session 回滚**；
 *     TS 侧同样只丢这一行，session 照常成功。
 *   两侧都 exit 0（所以我们说的“静默”是真的静默）。
 *
 * 不修的理由：真实 pi 写 JSONL 用标准编码器，永不产生这三个字面量（172.5MB 真实语料差分 0 差异）。
 * 本用例钉的是 TS 的**现状**：G 之后这三类字面量再无别的守卫，改动这里必须先改那段文档。
 */
test("nonstandard_json_literals_drop_only_the_line (A3)", () => {
  withBase((b) => {
    const rawTs = (ts: string, text: string): string =>
      `{"type":"message","message":{"role":"user","timestamp":${ts},"content":[{"type":"text","text":"${text}"}]}}`;
    const p = path.join(b.sessions, "nonstd.jsonl");
    writeFile(
      p,
      [
        rawTs("NaN", "NAN_MARKER"),
        msgLine("user", "正常一条"),
        rawTs("-Infinity", "NEG_INF_MARKER"),
        rawTs("Infinity", "INF_MARKER"),
        msgLine("assistant", "正常两条"),
      ].join("\n") + "\n",
    );

    const man = zc.emptyManifest();
    // Python 侧 ±Infinity 会让整个 session 失败（CLI 退出码 2 + 整轮回滚）；TS 只丢行 → 不缺不抛，
    // 所以“process 没抛异常 + 摘要里还是 2 msgs”就是“session 照常成功”的可观测证据。
    const { status } = b.process(p, man);
    assert.match(status, /2 msgs/, `TS 不会因 ±Infinity 回滚整个 session（与 Python 的差异之一）: ${status}`);
    const rows = zc.sessionRowsFull(b.corpus, man, "nonstd");
    assert.deepEqual(
      rows.map((r) => r.text),
      ["正常一条", "正常两条"],
      "三个非标准字面量的行全部被 JSON.parse 拒绝丢弃（Python 侧 NaN 行会以 ts=0 留下）",
    );
  });
});

// ---------- H1 ----------
// py: TestH1SeqAllocator.test_long_session_gets_all_fragments_into_manifest
// 另外两条 seq_allocator 用例已在 tests/corpus.test.ts（模块 A）覆盖。
test("test_long_session_gets_all_fragments_into_manifest", () => {
  withBase((b) => {
    // 600 条消息 + 每片 1 行的极限设置 -> 远超前 257 片的旧上限
    const p = makeSession(b.sessions, "long", 600);
    const man = zc.emptyManifest();
    const { status } = j2c.processSession(p, b.corpus, man, { limits: SEG_LIMITS(1) });
    // Python 靠 monkeypatch 模块常量 MAX_SEG_ROWS；TS 侧上限是显式参数，不用动全局状态。
    const segs = zc.segsFor(man, "long");
    assert.ok(segs.length > 257, `分片数应远超 257，实际 ${segs.length}`);
    assert.equal(segs.length, Object.keys(zc.segments(man)).length);
    assert.deepEqual(
      segs.map((s) => s.seq),
      segs.map((s) => s.seq).sort((x, y) => x - y),
    );
    assert.equal(
      segs.reduce((a, s) => a + s.rows, 0),
      600,
    );
    assert.ok(status.includes("600 msgs"), status);
  });
});

// py: TestH1EtlFailureIsVisible.test_failed_session_exits_nonzero_and_is_absent
test("test_failed_session_exits_nonzero_and_is_absent", () => {
  withBase((b) => {
    makeSession(b.sessions, "good", 2);
    // Python 用 mock.patch 把 process_session 换成抛 RuntimeError。ESM 导出不能打桩，
    // 所以这里造一个**真实的失败会话**：message 不是对象 -> row_of 抛 TypeError。
    // 走的是同一条 "单会话异常" 路径，而且顺带验证了失败原因确实被报出来。
    writeFile(path.join(b.sessions, "bad.jsonl"), '{"type":"message","message":"oops"}\n');

    const r = runCli([path.join(b.sessions, "*.jsonl"), b.corpus]);
    assert.equal(r.code, 2); // 修前: 吞异常 + exit 0
    assert.match(r.err, /TypeError: 'string' object has no attribute 'get'/);
    assert.match(r.out, /失败 1\/2/);
    const man = b.load();
    assert.ok(zc.sessions(man)["good"], "好的 session 要进 manifest");
    assert.equal(zc.sessions(man)["bad"], undefined);
    assert.ok(zc.segsFor(man, "good").length);
    // 失败的 session 不能留下半截分片（回滚语义）
    assert.deepEqual(zc.corpusFilesOf(b.corpus, "bad"), []);
  });
});

// ---------- H3 ----------
// py: TestH3MigrateCleanup.test_only_own_artifacts_are_removed
test("test_only_own_artifacts_are_removed", () => {
  withBase((b) => {
    const files: Record<string, string> = {
      "notes.txt": "用户自己放在语料目录里的笔记", // 绝不能被删
      "keep.p0001.txt": "1\tuser\t1\t在用的分片\n", // manifest 里的分片
      "keep.txt": "1\tuser\t1\tv1 单文件遗留\n", // 已知 session 的 v1 遗留 -> 删
      "dead.txt": "1\tuser\t1\t已删 session 的 v1\n", // 已知(旧 manifest) -> 删
      "gone.p0003.txt": "1\tuser\t1\t孤儿分片\n", // 未知 session 的孤儿片 -> 删
      ".hidden.txt": "隐藏文件\n", // 隐藏 -> 不碰
    };
    for (const [name, body] of Object.entries(files)) writeFile(path.join(b.corpus, name), body);

    const man = zc.emptyManifest();
    zc.segments(man)["keep.p0001.txt"] = {
      session_id: "keep",
      seq: 1,
      rows: 1,
      start_jsonl_line: 1,
      start_corpus_line: 1,
      start_ts: 1,
      frozen: true,
    };
    zc.sessions(man)["keep"] = { jsonl_path: "/x/keep.jsonl" };

    const res = j2c.migrateCleanup(b.corpus, man, ["keep", "dead"]);
    // Python 断言的是 stdout 里的 "清理遗留语料 3 个"：库层不 print 了，直接断言返回值更强。
    assert.deepEqual(res.removed.slice().sort(), ["dead.txt", "gone.p0003.txt", "keep.txt"]);
    assert.deepEqual(res.failed, []);
    const left = new Set(fs.readdirSync(b.corpus));
    assert.ok(left.has("notes.txt"), "用户自己的 notes.txt 绝不能被当 legacy 删掉");
    assert.ok(left.has("keep.p0001.txt"));
    assert.ok(left.has(".hidden.txt"));
    assert.ok(!left.has("keep.txt"));
    assert.ok(!left.has("dead.txt"));
    assert.ok(!left.has("gone.p0003.txt"));
  });
});

// py: TestH3MigrateCleanup.test_unknown_legacy_file_is_kept
test("test_unknown_legacy_file_is_kept", () => {
  withBase((b) => {
    writeFile(path.join(b.corpus, "random.txt"), "x\n");
    const res = j2c.migrateCleanup(b.corpus, zc.emptyManifest(), []);
    assert.deepEqual(res.removed, []);
    assert.ok(fs.readdirSync(b.corpus).includes("random.txt"));
  });
});

// py: TestH3MigrateCleanup.test_no_manifest_still_sweeps_orphan_shards
test("test_no_manifest_still_sweeps_orphan_shards", () => {
  withBase((b) => {
    // manifest 整个不在(换目录/损坏/先删了)时: 语料目录里的**孤儿分片**要清掉,
    // 否则它被 zg 索引、却在查询侧被过滤掉 -> 隐形重复(评审 L2)
    makeSession(b.sessions, "live", 2); // dead 的 jsonl 不存在
    fs.rmSync(b.mpath, { force: true });
    for (const name of ["live.p0001.txt", "dead.p0001.txt"]) {
      writeFile(path.join(b.corpus, name), "1\tuser\t1\t旧语料\n");
    }
    writeFile(path.join(b.corpus, "notes.txt"), "用户自己的笔记\n"); // 不是任何 session: 绝不能删(H3)

    const r = runCli([path.join(b.sessions, "*.jsonl"), b.corpus]);
    assert.equal(r.code, 0);
    const left = new Set(fs.readdirSync(b.corpus));
    assert.ok(!left.has("dead.p0001.txt")); // 修前: raw is None -> legacy=False -> 从不 cleanup
    assert.ok(left.has("notes.txt")); // H3 不能因 L2 的修法回退
    assert.ok(zc.segsFor(b.load(), "live").length);
    assert.match(r.out, /清理遗留语料 1 个/);
  });
});

// py: TestH3MigrateCleanup.test_stale_staging_and_tmp_are_swept_fresh_kept
test("test_stale_staging_and_tmp_are_swept_fresh_kept", () => {
  withBase((b) => {
    // 硬杀留下的 .staging/.tmp 要被清掉, 但刚写的(别的进程正在写)不能动(评审 LOW-5)
    const p = makeSession(b.sessions, "s1", 2);
    const man = zc.emptyManifest();
    b.process(p, man);
    const seg = Object.keys(zc.segments(man)).sort()[0]; // s1.p0001.txt

    const stale = [`.${seg}.staging`, `..${seg}.staging.99999.tmp`, `.${seg}.12345.tmp`];
    for (const name of stale) {
      const q = path.join(b.corpus, name);
      writeFile(q, "半成品\n");
      fs.utimesSync(q, 0, 0); // 很老 -> 硬杀残留
    }
    const fresh = `.${seg}.fresh.staging`;
    writeFile(path.join(b.corpus, fresh), "另一个进程正在写的\n");

    const r = runCli([path.join(b.sessions, "*.jsonl"), b.corpus]);
    const left = new Set(fs.readdirSync(b.corpus));
    for (const name of stale) assert.ok(!left.has(name), `${name} 应被清掉`); // 修前: 永久残留
    assert.ok(left.has(fresh), "正在写的半成品不能删");
    assert.match(r.out, /清理残留半成品 3 个/);
  });
});

// py: TestH3MigrateCleanup.test_v1_flat_manifest_prev_sids_is_honoured
test("test_v1_flat_manifest_prev_sids_is_honoured", () => {
  withBase((b) => {
    // v1 是扁平的 {<sid>.txt: ...}; prev_sids 解析不出来 -> 已删 session 的 legacy .txt 永远留着(评审 LOW-1)
    const p = makeSession(b.sessions, "live", 2);
    writeFile(
      b.mpath,
      JSON.stringify({
        "live.txt": { jsonl_path: p, last_offset: 0 },
        "dead.txt": { jsonl_path: "/gone/dead.jsonl", last_offset: 0 },
      }),
    );
    for (const name of ["live.txt", "dead.txt"]) {
      writeFile(path.join(b.corpus, name), "1\tuser\t1\tv1 单文件遗留\n");
    }

    const r = runCli([path.join(b.sessions, "*.jsonl"), b.corpus]);
    const left = new Set(fs.readdirSync(b.corpus));
    assert.ok(!left.has("dead.txt")); // 修前: prev_sids=set() -> 当成"不是我们的产物"留下
    assert.ok(!left.has("live.txt")); // 在用的 session 的 v1 遗留也要清掉
    assert.ok(zc.segsFor(b.load(), "live").length);
    assert.match(r.out, /manifest 非 v2\(迁移\/损坏\), 全量重建 1 个 session/);
  });
});

// ---------- start_ts 回退（差分对拍实测回归）----------
// 上一轮因为文件被截在「第一行有效消息之前」而把 start_ts 写成显式 null 时，
// 续读补齐后必须回退到 all_rows[0].ts —— Python 判的是 `is None`，不是“键不存在”。
// 修前 TS 用 `=== undefined` 判空，导致这类 session 的 start_ts 永久僵在 null
//（真实语料上 4 个 workspace 命中，manifest 各少 9n 字节）。
test("test_incremental_fills_start_ts_when_previous_run_had_none", () => {
  withBase((b) => {
    // 第一轮：文件里只有一行 toolResult（不产生语料行），但已推进 last_offset/prefix_sha
    const p = path.join(b.sessions, "sess.jsonl");
    fs.writeFileSync(p, `${toolResultLine()}\n`);
    const man = zc.emptyManifest();
    b.process(p, man);
    assert.equal(zc.sessions(man)["sess"].start_ts, null);
    assert.equal(zc.sessions(man)["sess"].rows, 0);
    assert.ok((zc.sessions(man)["sess"].last_offset ?? 0) > 0); // 有前缀可续读

    // 第二轮：追加首条真正消息 —— 走增量分支，start_ts 必须补上这一行的 ts
    const TS1 = 1_700_000_500_000;
    fs.appendFileSync(p, `${msgLine("user", "第一条真正进语料的消息", TS1)}\n`);
    const man2 = b.load();
    const { status } = b.process(p, man2);
    assert.match(status, /\(\+1 inc\)/);
    assert.equal(zc.sessions(man2)["sess"].start_ts, TS1); // 修前: null
    assert.equal(zc.sessions(man2)["sess"].rows, 1);
  });
});

// ---------- M1 ----------
// py: TestM1TailConsistency.test_second_run_is_incremental_with_trailing_toolresult
test("test_second_run_is_incremental_with_trailing_toolresult", () => {
  withBase((b) => {
    const p = makeSession(b.sessions, "sess", 3, [toolResultLine()]);
    const man = zc.emptyManifest();
    b.process(p, man);
    const sess = zc.sessions(man)["sess"];
    // 尾片末条语料行 != 扫过的最后一行 JSONL —— 这正是旧校验拿 last_jsonl_line 比时必然失败的原因
    // 可选字段，此处两者必然已写入；加 ! 仅为过 strict 的“可能 undefined”（非空断言）
    assert.ok(sess.last_row_jsonl_line! < sess.last_jsonl_line!);

    // mtime 变而内容不变：仍应 (+0 inc) —— canContinue 只看 prefix_sha，不看 mtime（评审 M1）
    fs.utimesSync(p, 1_800_000_000, 1_800_000_000);
    const man2 = b.load();
    const { status, nNew } = b.process(p, man2);
    assert.match(status, /\(\+0 inc\)/); // 修前: 这里每轮都是 "(+0 rebuild)"
    assert.equal(nNew, 0);
    assert.equal(zc.segsFor(man2, "sess").length, 1);
  });
});

// py: TestM1TailConsistency.test_append_after_toolresult_is_incremental
test("test_append_after_toolresult_is_incremental", () => {
  withBase((b) => {
    const p = makeSession(b.sessions, "sess", 3, [toolResultLine()]);
    const man = zc.emptyManifest();
    b.process(p, man);

    fs.appendFileSync(p, `${toolResultLine(1_700_000_100_000)}\n${msgLine("user", "追加的一条新问题", 1_700_000_100_001)}\n`);
    const man2 = b.load();
    const { status } = b.process(p, man2);
    assert.match(status, /\(\+1 inc\)/); // 修前: rebuild
    assert.equal(zc.sessions(man2)["sess"].rows, 4);
  });
});

// ---------- TestIdempotent ----------
// py: TestIdempotent.test_frozen_prefix_is_stable_and_later_runs_stay_incremental
test("test_frozen_prefix_is_stable_and_later_runs_stay_incremental", () => {
  withBase((b) => {
    // 冻结分片字节永不变 -> 无变化轮次不重写任何片、也不分配新片号
    const p = makeSession(b.sessions, "s", 50);
    const man = zc.emptyManifest();
    // Python 靠 monkeypatch MAX_SEG_ROWS=5；TS 侧每片上限是显式参数（对应 Base.process）
    j2c.processSession(p, b.corpus, man, { limits: SEG_LIMITS(5) });
    zc.saveManifest(b.mpath, man);

    const names = Object.keys(zc.segments(man)).sort();
    const metas = names.map((f) => zc.segments(man)[f]);
    assert.equal(
      metas.reduce((a, m) => a + m.rows, 0),
      50,
    );
    assert.equal(metas.filter((m) => !m.frozen).length, 1); // 只有一个开放尾片
    const blob: Record<string, Buffer> = {};
    for (const f of names) blob[f] = fs.readFileSync(path.join(b.corpus, f));

    fs.appendFileSync(p, `${msgLine("user", "追加第 51 条", 1_700_000_600_000)}\n`);

    const man2 = b.load();
    const { status, nNew } = b.process(p, man2);
    assert.match(status, /\(\+1 inc\)/); // 追加不改整轮重建
    assert.equal(nNew, 1);
    for (const [f, meta] of Object.entries(zc.segments(man2))) {
      // 冻结前缀字节不变。用 man2 自己的 frozen 标志（评审 M5：原先读的是上一轮 man 的标志）
      if (meta.frozen && f in blob) {
        assert.deepEqual(fs.readFileSync(path.join(b.corpus, f)), blob[f], `${f} 被重写了`);
      }
    }

    const before = Object.keys(zc.segments(man2)).sort();
    const man3 = b.load();
    const { status: status3, nNew: n3 } = b.process(p, man3);
    assert.match(status3, /\(\+0 inc\)/);
    assert.equal(n3, 0);
    assert.deepEqual(Object.keys(zc.segments(man3)).sort(), before); // 本轮不再写任何片
  });
});

// ---------- M2 ----------
// py: 无直接对应。模块 A 黄金样本已覆盖非 ASCII sid，这里补 B 的端到端：
// ETL 写出的分片名 + manifest 键 + ensure_ascii=False 串起来跑一遍。
test("non_ascii_sid_survives_etl_and_manifest", () => {
  withBase((b) => {
    const p = makeSession(b.sessions, "中文-会话", 2);
    const man = zc.emptyManifest();
    b.process(p, man);
    const man2 = b.load();
    const seg = zc.segName("中文-会话", 1);
    assert.ok(man2.segments[seg], `manifest 应含 ${seg}`);
    assert.equal(man2.segments[seg].session_id, "中文-会话");
    assert.equal(man2.segments[seg].rows, 2);
    assert.ok(fs.existsSync(path.join(b.corpus, seg))); // 分片真的落盘
    // manifest 文件里非 ASCII 不转义（Python 侧 ensure_ascii=False）
    assert.ok(fs.readFileSync(b.mpath, "utf8").includes("中文-会话"));
  });
});

// ---------- 黄金样本（Python 只当生成器，回归不需要它）----------
test("test_golden_etl_output_matches_python", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-golden-"));
  try {
    const sessions = path.join(tmp, "sessions");
    fs.cpSync(path.join(FIXTURES_ETL, "sessions"), sessions, { recursive: true });
    // 固定 mtime: manifest 里存了 jsonl_mtime，不固定就逐字节比对不了
    for (const f of fs.readdirSync(sessions)) {
      fs.utimesSync(path.join(sessions, f), FIXTURE_MTIME, FIXTURE_MTIME);
    }
    const corpus = path.join(tmp, "corpus");
    const r = runCli([path.join(sessions, "*.jsonl"), corpus]);
    assert.equal(r.code, 0, r.err);

    const expCorpus = path.join(FIXTURES_ETL, "expected", "corpus");
    assert.deepEqual(fs.readdirSync(corpus).sort(), fs.readdirSync(expCorpus).sort());
    for (const f of fs.readdirSync(expCorpus)) {
      assert.deepEqual(
        fs.readFileSync(path.join(corpus, f)),
        fs.readFileSync(path.join(expCorpus, f)),
        `${f} 与 Python 产物不一致`,
      );
    }

    // manifest: 会话目录是临时路径, 文本级换成占位符后逐字节比对
    // （与 Python save_manifest 同为 ensure_ascii=False + indent=2，纯路径替换不破坏字节一致性）
    const got = fs.readFileSync(path.join(tmp, "manifest.json"), "utf8").split(sessions).join(PLACEHOLDER);
    assert.equal(got, fs.readFileSync(path.join(FIXTURES_ETL, "expected", "manifest.json"), "utf8"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
