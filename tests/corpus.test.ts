/**
 * lib/corpus.ts（模块 A）的单元测试。
 *
 * 用例名沿用 Python 侧 tests/test_zgmem.py 的原名，便于逐条核对（见 docs/plan-ts-migration.md）。
 * 模块 A 原有欠账的两条已随模块 B 落地迁到 tests/etl.test.ts：
 *   - TestH1SeqAllocator.test_long_session_gets_all_fragments_into_manifest
 *   - TestIdempotent.test_frozen_prefix_is_stable_and_later_runs_stay_incremental
 * 仍未迁移的只剩下面这条（属模块 C 的 CLI 精修路径），完成前由 Python 侧负责：
 *   - TestH2HitRefinement.test_refine_hit_line_end_to_end
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as zc from "../extensions/zg-memory/lib/corpus.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-a-"));
}

// ---------- H1: 序号分配 ----------
test("TestH1SeqAllocator.test_seq_allocator_has_no_257_ceiling", () => {
  const segs = Array.from({ length: 257 }, (_, i) => ({ seq: i + 1 }));
  const gen = zc.seqAllocator(segs as never, 257);
  const out = Array.from({ length: 400 }, () => gen.next().value); // 修前第 258 次取号抛 StopIteration
  assert.deepEqual(out.slice(0, 2), [257, 258]);
  assert.equal(out[out.length - 1], 656);
});

test("TestH1SeqAllocator.test_seg_name_parse_beyond_9999", () => {
  assert.deepEqual(zc.parseSeg(zc.segName("s", 10000)), { sid: "s", seq: 10000 });
});

// ---------- 命名 ----------
test("TestParseSeg.trailing_newline_is_tolerated_like_python_dollar", () => {
  // Python 的 `$` 在非 multiline 下匹配"尾随换行之前"，所以这种名字在 Python 侧是合法分片。
  // 差分对拍发现的真分歧；文件名理论可含换行（POSIX 只禁 / 和 NUL），故选了完全对齐。
  assert.deepEqual(zc.parseSeg("sess.p0001.txt\n"), { sid: "sess", seq: 1 });
  assert.equal(zc.parseSeg("sess.p0001.txt\r"), null, "\\r 不在 `$` 的容忍范围内");
  assert.equal(zc.parseSeg("sess.p0001.txt\n\n"), null, "只容忍一个尾随换行");
  assert.equal(zc.isLegacyName("sess.p0001.txt\n"), false, "endsWith('.txt') 先短路，和 Python 一致");
});

test("TestParseSeg.legacy_and_shape_rules", () => {
  assert.equal(zc.isLegacyName("plain.txt"), true);
  assert.equal(zc.isLegacyName(".hidden.p0001.txt"), false);
  assert.equal(zc.isLegacyName("plain.md"), false);
  assert.equal(zc.isLegacyName(""), false);
  assert.deepEqual(zc.parseSeg("a.b.p0007.txt"), { sid: "a.b", seq: 7 }, "sid 贪婪，可含点");
  assert.equal(zc.parseSeg("sess.p100.txt"), null, "seq 至少 4 位");
  assert.deepEqual(zc.segName("中文-会话", 3), "中文-会话.p0003.txt");
});

// ---------- int() 严格等价 ----------
test("TestParsePythonInt.rejects_what_python_int_rejects", () => {
  // 这条是迁移计划点名要求的：int("12.0") 抛异常，Number("12.0") 会静默接受
  assert.equal(zc.parsePythonInt("12.0"), null);
  assert.equal(zc.parsePythonInt("1e3"), null);
  assert.equal(zc.parsePythonInt("0x10"), null);
  assert.equal(zc.parsePythonInt(""), null);
  assert.equal(zc.parsePythonInt("abc"), null);
  assert.equal(zc.parsePythonInt("+ 5"), null, "符号后不能有空格");
  assert.equal(zc.parsePythonInt("_1"), null);
  assert.equal(zc.parsePythonInt("1__0"), null);
  assert.equal(zc.parsePythonInt(null), null);
});

test("TestParsePythonInt.accepts_what_python_int_accepts", () => {
  assert.equal(zc.parsePythonInt("12"), 12);
  assert.equal(zc.parsePythonInt("+12"), 12);
  assert.equal(zc.parsePythonInt("-3"), -3);
  assert.equal(zc.parsePythonInt("0007"), 7);
  assert.equal(zc.parsePythonInt("1_000"), 1000);
  assert.equal(zc.parsePythonInt(" 42\t"), 42, "int() 容忍空白");
  assert.equal(zc.parsePythonInt("0"), 0, "0 是合法值，不能当假值丢掉");
});

// ---------- 行与读回 ----------
test("TestRowContract.line_roundtrip_with_tabs_and_unicode", () => {
  const dir = tmpdir();
  const rows = [
    { jsonlLine: 1, role: "user", ts: 1700000000001, text: "含\t制表符 的文本" },
    { jsonlLine: 2, role: "toolResult", ts: 1700000000002, text: "" },
    { jsonlLine: 3, role: "assistant", ts: 1700000000003, text: "emoji 🙂 中文" },
  ];
  zc.writeSegment(dir, "s.p0001.txt", rows);
  assert.equal(zc.rowBytes(rows[0]), Buffer.byteLength(zc.rowLine(rows[0]), "utf8"));
  assert.deepEqual(
    zc.readSegment(dir, "s.p0001.txt", 1).map((r) => [r.line, r.jsonlLine, r.role, r.ts, r.text]),
    [
      [1, 1, "user", 1700000000001, "含\t制表符 的文本"],
      [2, 2, "toolResult", 1700000000002, ""],
      [3, 3, "assistant", 1700000000003, "emoji 🙂 中文"],
    ],
  );
  assert.deepEqual(zc.readSegment(dir, "missing.p0001.txt", 1), []);
});

test("TestRowContract.bad_lines_are_skipped_but_line_numbers_are_physical", () => {
  const dir = tmpdir();
  // 第 2 行 jsonl_line 是 "12.0"（Python int() 会抛）→ 跳过，但第 3 行的物理行号仍是 3
  fs.writeFileSync(
    path.join(dir, "s.p0001.txt"),
    "1\tuser\t1700000000001\tok\n12.0\tuser\t1700000000002\tbad\n3\tuser\t1700000000003\tok\n",
  );
  const rows = zc.readSegment(dir, "s.p0001.txt", 10);
  assert.deepEqual(rows.map((r) => [r.line, r.jsonlLine, r.text]), [
    [10, 1, "ok"],
    [12, 3, "ok"],
  ]);
});

test("TestRowContract.crlf_and_trailing_newline", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "s.p0001.txt"), "1\tuser\t1700000000001\ta\r\n2\tuser\t1700000000002\tb\n");
  const rows = zc.readSegment(dir, "s.p0001.txt", 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.text), ["a", "b"], "Python 通用换行：\\r\\n 算行界");
});

// ---------- 配对（跨分片）----------
// 切分器有一条“切点不能落在 user 行上”的规则，所以正常切分不会把 user/assistant 拆到两片；
// 唯一的例外是**单条 user 行自身就超过字节上限**（独占一片），回复落到下一片（对应 s-big 那种巨行）。
// 这条路径只在 readWindow 的 needPrev/needNext 扩片时才会跑到，之前没有用例扫到。
test("TestH2HitRefinement.pair_crosses_shard_boundary_both_directions", () => {
  const dir = tmpdir();
  const man = zc.emptyManifest();
  // s.p0001.txt：只有一条 user，它的 assistant 回复在下一片
  zc.writeSegment(dir, "s.p0001.txt", [{ jsonlLine: 1, role: "user", ts: 1700000000001, text: "跨片提问" }]);
  zc.writeSegment(dir, "s.p0002.txt", [{ jsonlLine: 2, role: "assistant", ts: 1700000000002, text: "跨片回答" }]);
  zc.segments(man)["s.p0001.txt"] = {
    session_id: "s",
    seq: 1,
    rows: 1,
    start_jsonl_line: 1,
    start_corpus_line: 1,
    start_ts: 1700000000001,
    frozen: true,
  };
  zc.segments(man)["s.p0002.txt"] = {
    session_id: "s",
    seq: 2,
    rows: 1,
    start_jsonl_line: 2,
    start_corpus_line: 2,
    start_ts: 1700000000002,
    frozen: false,
  };

  // 从 assistant 往回找 user（needPrev：扩到上一片）
  const a = zc.pairForGlobal(dir, man, "s", 2);
  assert.equal(a?.role, "assistant");
  assert.equal(a?.user, "跨片提问");
  assert.equal(a?.assistant, "跨片回答");
  assert.equal(a?.ref.corpus_line, 2);

  // 从 user 往右找 assistant（needNext：扩到下一片）
  const u = zc.pairForGlobal(dir, man, "s", 1);
  assert.equal(u?.role, "user");
  assert.equal(u?.user, "跨片提问");
  assert.equal(u?.assistant, "跨片回答");
  assert.equal(u?.ref.corpus_line, 1);
});

// ---------- 切分 ----------
test("TestSplitPoint.cuts_only_when_limits_exceeded", () => {
  const mk = (roles: string[]) =>
    roles.map((role, i) => ({ jsonlLine: i + 1, role, ts: i + 1, text: "a" }));
  const allUser = mk(["user", "user", "user"]);

  assert.equal(zc.splitPoint(allUser, { rows: 10, bytes: 10000 }), null, "都不超限 -> 不切");
  assert.equal(zc.splitPoint([], { rows: 1, bytes: 1 }), null, "空输入不切");
  assert.equal(zc.splitPoint(allUser, { rows: 3, bytes: 10000 }), 3, "行数达到上限");
  assert.equal(zc.splitPoint(allUser, { rows: 10, bytes: 1 }), 3, "字节超限，但切点被“不能停在 user 行”推到末尾");

  // 边界规则：切点不能落在 user 行上（否则这轮的 assistant 回复会被切到下一片）
  const mixed = mk(["user", "assistant", "user", "assistant"]);
  assert.equal(zc.splitPoint(mixed, { rows: 2, bytes: 10000 }), 2);
  assert.equal(zc.splitPoint(mk(["user", "user", "assistant"]), { rows: 2, bytes: 10000 }), 3, "从 user 往后延伸到 assistant 之前");

  // 单行就超限：独占一片，不会返回 0
  assert.equal(zc.splitPoint(mk(["assistant"]), { rows: 1, bytes: 1 }), 1);
});

// ---------- 命中精修 ----------
test("TestH2HitRefinement.test_query_terms_mixes_ascii_and_cjk", () => {
  const terms = zc.queryTerms("zgmem_corpus.py 分片 seq 上限");
  assert.ok(terms.includes("zgmem_corpus"), `期望含 zgmem_corpus: ${JSON.stringify(terms)}`);
  assert.ok(terms.includes("分片"));
  assert.ok(terms.includes("seq"));
});

test("TestH2HitRefinement.test_pick_hit_row_finds_marker_inside_window", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    line: i + 1,
    jsonlLine: i + 1,
    role: i % 2 ? "user" : "assistant",
    ts: 0,
    text: `第 ${i + 1} 行 普通内容`,
  }));
  rows[79] = { line: 80, jsonlLine: 80, role: "assistant", ts: 0, text: "第 80 行 图书直播选题标记 在这里" };
  assert.equal(zc.pickHitRow(rows, 64, zc.queryTerms("图书直播选题标记")), 80);
});

test("TestH2HitRefinement.test_pick_hit_row_falls_back_to_block_start_on_pure_vector_hit", () => {
  const rows = Array.from({ length: 19 }, (_, i) => ({
    line: i + 1,
    jsonlLine: i + 1,
    role: "user",
    ts: 0,
    text: `第 ${i + 1} 行`,
  }));
  assert.equal(zc.pickHitRow(rows, 5, zc.queryTerms("毫无字面重叠的词")), 5);
  assert.equal(zc.pickHitRow(rows, 5, []), 5);
});

// ---------- 清理残留 ----------
test("TestSweepStaleTmp.old_swept_fresh_kept_others_untouched", () => {
  const dir = tmpdir();
  const now = Date.now();
  const files: [string, number][] = [
    [".a.p0001.txt.123.tmp", now - 7200_000],
    [".b.p0002.txt.456.tmp", now - 10_000],
    [".c.p0003.txt.789.tmp", now - 3600_000],
    ["a.p0001.txt", now - 7200_000],
    [".notmp", now - 7200_000],
  ];
  for (const [f, mt] of files) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, "x");
    fs.utimesSync(p, mt / 1000, mt / 1000);
  }
  const removed = zc.sweepStaleTmp(dir, 3600);
  assert.deepEqual(removed.sort(), [".a.p0001.txt.123.tmp", ".c.p0003.txt.789.tmp"]);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [".b.p0002.txt.456.tmp", ".notmp", "a.p0001.txt"]);
});

// ---------- manifest ----------
test("TestManifest.roundtrip_keeps_unicode_and_leaves_no_tmp", () => {
  const dir = tmpdir();
  const mpath = path.join(dir, "manifest.json");
  const man = zc.emptyManifest();
  zc.sessions(man)["中文-会话"] = { start_ts: 1, jsonl_size: 2 };
  zc.segments(man)["中文-会话.p0001.txt"] = {
    session_id: "中文-会话",
    seq: 1,
    start_jsonl_line: 1,
    start_corpus_line: 1,
    rows: 2,
    start_ts: 1,
    frozen: true,
  };
  zc.saveManifest(mpath, man);
  const raw = fs.readFileSync(mpath, "utf8");
  assert.ok(raw.includes("中文-会话"), "ensure_ascii=False：非 ASCII 不转义");
  assert.deepEqual(zc.loadManifest(mpath).segments, man.segments);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "原子写不留 .tmp",
  );
  assert.equal(zc.loadManifest(path.join(dir, "nope.json")).version, zc.MANIFEST_VERSION, "缺失 -> 空 manifest");
});
