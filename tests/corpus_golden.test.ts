/**
 * 黄金样本回归：TS 必须逐字节复现 Python 生成的产物。
 *
 * 样本由 tests/fixtures/generate_corpus_fixtures.py 用 Python 实现生成并提交，
 * 所以这个测试在 CI 里**不需要 Python**（回归策略第 1 层，见 docs/plan-ts-migration.md）。
 *
 * 覆盖：分片文件字节（含 CJK/制表符/emoji/换行/5 位 seq/带点 sid/非 ASCII sid）、
 *      manifest JSON 字节（含 ensure_ascii=False）、mtime 钉法、以及写后读回。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as zc from "../extensions/zg-memory/lib/corpus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const GOLDEN = path.join(FIXTURES, "golden_segments");

interface Plan {
  files: { fname: string; start_ts: number; rows: zc.Row[] }[];
  manifest: zc.Manifest;
}

function loadPlan(): Plan {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "corpus_plan.json"), "utf8")) as Plan;
}

test("GoldenFixtures.segments_and_manifest_are_byte_identical", () => {
  const plan = loadPlan();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-gold-"));
  const segsDir = path.join(out, "segments");
  fs.mkdirSync(segsDir);

  for (const f of plan.files) zc.writeSegment(segsDir, f.fname, f.rows, f.start_ts);
  const manPath = path.join(out, "manifest.json");
  zc.saveManifest(manPath, plan.manifest);

  const goldenNames = fs.readdirSync(GOLDEN).sort();
  assert.deepEqual(fs.readdirSync(segsDir).sort(), goldenNames, "分片文件名集合");
  for (const name of goldenNames) {
    const expected = fs.readFileSync(path.join(GOLDEN, name));
    const actual = fs.readFileSync(path.join(segsDir, name));
    assert.deepEqual(actual, expected, `分片字节不一致: ${name}\n ts=${JSON.stringify(actual.toString("utf8"))}\n py=${JSON.stringify(expected.toString("utf8"))}`);
  }
  assert.deepEqual(
    fs.readFileSync(manPath),
    fs.readFileSync(path.join(FIXTURES, "golden_manifest.json")),
    "manifest 字节不一致（键序/缩进/非 ASCII 转义都算）",
  );
});

test("GoldenFixtures.mtime_is_pinned_to_first_message_ts", () => {
  const plan = loadPlan();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-gold-mt-"));
  for (const f of plan.files) {
    zc.writeSegment(out, f.fname, f.rows, f.start_ts);
    const mt = Math.round(fs.statSync(path.join(out, f.fname)).mtimeMs);
    // 容差 1ms：文件系统时间戳精度
    assert.ok(Math.abs(mt - f.start_ts) <= 1, `${f.fname}: mtime=${mt} 期望 ${f.start_ts}`);
  }
});

test("GoldenFixtures.reads_back_consistently", () => {
  const plan = loadPlan();
  const man = zc.loadManifest(path.join(FIXTURES, "golden_manifest.json"));
  for (const f of plan.files) {
    const rows = zc.readSegment(GOLDEN, f.fname, 1);
    const meta = man.segments[f.fname];
    // 行号是物理行号：文本里含 \n 的那一片会比 manifest 的 rows 多
    assert.ok(rows.length >= (meta.rows ?? 0), `${f.fname}: 读回行数 ${rows.length} < manifest ${meta.rows}`);
    assert.equal(rows[0].jsonlLine, f.rows[0].jsonlLine);
  }
  // 窗口/配对路径也应能在这份样本上跑通
  const win = zc.readWindow(GOLDEN, man, "sess-a", 3);
  assert.equal(win.idx, 0, "全局行 3 属于第 2 片的第一行");
  assert.equal(win.rows[0].text, "含\t制表符 的文本");
  const pair = zc.pairForGlobal(GOLDEN, man, "sess-a", 3);
  assert.equal(pair?.ref.session, "sess-a");
  assert.equal(pair?.ref.corpus_line, 3);
});
