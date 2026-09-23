#!/usr/bin/env node
/**
 * 迁移期差分对拍：Python 实现（zgmem_corpus.py）当裁判，逐函数比对 lib/corpus.ts。
 *
 *   node tests/differential/corpus_differential.ts
 *
 * 三层覆盖：
 *   1. 纯函数：命名/切分/序号分配/词项提取/打分/命中精修/行序列化
 *   2. 写入产物逐字节：分片文件 sha256 + mtime + manifest JSON sha256
 *   3. 读取路径：read_segment / read_window / pair_for_global / load_manifest / sweep
 *
 * 只用于迁移期（见 docs/plan-ts-migration.md 第 3 层证据），迁移完成后连同 Python 实现一起删。
 * 永久回归靠 tests/fixtures 黄金样本 + tests/*.test.ts。
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zc from "../../extensions/zg-memory/lib/corpus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "corpus_probe.py");

let oks = 0;
const problems: string[] = [];

/** 递归排序键，消除对象键序差异；数组顺序保留（顺序本身是语义）。 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function py(c: unknown): unknown {
  const r = spawnSync("python3", [PROBE], {
    input: JSON.stringify(c),
    encoding: "utf8",
    // 真实语料里有整段图片二进制，探针输出可能很大；撞上上限只会得到 status=null
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim().slice(0, 600);
    throw new Error(`probe exit ${r.status}${r.error ? ` (${(r.error as Error).message})` : ""}: ${msg}`);
  }
  return JSON.parse(r.stdout);
}

/** 把一个 case 同时喂给 Python 与 TS，比对规范化结果。 */
function check(label: string, c: unknown, tsValue: unknown, normalize: (v: unknown) => unknown = (v) => v) {
  let expected: unknown;
  try {
    expected = normalize(py(c));
  } catch (e) {
    problems.push(`[裁判异常] ${label}: ${(e as Error).message}\n  case=${JSON.stringify(c).slice(0, 300)}`);
    return;
  }
  const a = stable(expected);
  const b = stable(normalize(tsValue));
  if (a === b) oks++;
  else problems.push(`[不一致] ${label}\n  py=${a.slice(0, 500)}\n  ts=${b.slice(0, 500)}`);
}

// ---------- 确定性随机 ----------
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// 故意混入：制表符、换行、CJK、代理对(emoji)、NUL、前后空格
const POOL = ["a", "b", "z", "A", "_", "9", " ", "\t", "\n", "中", "文", "字", "。", "é", "\u0000", "🙂"];
const ROLES = ["user", "assistant", "toolResult", "system", "role with space"];

interface R {
  jsonlLine: number;
  role: string;
  ts: number;
  text: string;
}

function genRows(rng: () => number, n: number): R[] {
  const rows: R[] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.floor(rng() * 60);
    let text = "";
    for (let k = 0; k < len; k++) text += POOL[Math.floor(rng() * POOL.length)];
    rows.push({
      jsonlLine: Math.floor(rng() * 50) + 1,
      role: ROLES[Math.floor(rng() * ROLES.length)],
      ts: Math.floor(rng() * 2e12) + 1,
      text,
    });
  }
  return rows;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zgdiff-"));
const toTuple = (r: zc.CorpusRow) => [r.line, r.jsonlLine, r.role, r.ts, r.text];

/**
 * 与 probe 的 row_digest 必须逐字段对应：真实语料里有整段图片二进制，
 * 不能把全文来回传（会撞爆 spawnSync 的 maxBuffer，且输出不可读）。
 * [line, jsonlLine, role, ts, 字节数, sha256 前 16 位]
 */
function digestRows(rows: zc.CorpusRow[]): unknown[] {
  return rows.map((r) => {
    const b = Buffer.from(r.text, "utf8");
    return [r.line, r.jsonlLine, r.role, r.ts, b.length, crypto.createHash("sha256").update(b).digest("hex").slice(0, 16)];
  });
}

// ---------- 第 1 层：纯函数 ----------
function phasePure() {
  const rng = makeRng(20260922);

  // 命名
  const pairs: [string, number][] = [
    ["sess", 1],
    ["sess", 0],
    ["sess", 9999],
    ["sess", 10000],
    ["sess", -1],
    ["a.b.c", 42],
    ["中文-会话", 7],
    ["", 3],
  ];
  check("seg_name", { op: "seg_name", pairs }, pairs.map(([s, q]) => zc.segName(s, q)));

  const names = [
    "sess.p0001.txt",
    "sess.p9999.txt",
    "sess.p10000.txt",
    "sess.p100.txt",
    "sess.p000.txt",
    "sess.p0001.txt.bak",
    "a.b.p0007.txt",
    "中文.p0002.txt",
    "plain.txt",
    ".hidden.p0001.txt",
    "sess.p0001.txt\n",
  ];
  // py 返回元组 (sid, seq)，TS 返回对象 —— 只差形状，对拍前统一成元组
  check(
    "parse_seg",
    { op: "parse_seg", names },
    names.map((n) => {
      const p = zc.parseSeg(n);
      return p ? [p.sid, p.seq] : null;
    }),
  );
  check("is_legacy", { op: "is_legacy", names }, names.map((n) => zc.isLegacyName(n)));

  // 行序列化
  const rows = genRows(rng, 40);
  check("row_line", { op: "row_line", rows }, rows.map((r) => zc.rowLine(r)));
  check("row_bytes", { op: "row_bytes", rows }, rows.map((r) => zc.rowBytes(r)));

  // 切分：小阈值逼出各种切点
  const splitCases = [];
  for (const [limRows, limBytes] of [
    [3, 1000],
    [1, 1000],
    [5, 40],
    [2, 1],
    [200, 65536],
    [7, 300],
  ] as [number, number][]) {
    for (const n of [0, 1, 2, 3, 6, 9, 17]) {
      splitCases.push({ rows: genRows(rng, n), limits: { rows: limRows, bytes: limBytes } });
    }
  }
  check(
    "split_point",
    { op: "split", cases: splitCases },
    splitCases.map((c) => zc.splitPoint(c.rows, c.limits)),
  );

  // 序号分配
  for (const [segs, tail] of [
    [[], 0],
    [[{ fname: "a.p0001.txt", seq: 1, frozen: true }], 1],
    [
      [
        { fname: "a.p0001.txt", seq: 1, frozen: true },
        { fname: "a.p0003.txt", seq: 3, frozen: false },
      ],
      3,
    ],
    [[{ fname: "a.p0002.txt", seq: 2, frozen: false }], 5],
    [[{ fname: "a.p0009.txt", seq: 9, frozen: true }], 0],
  ] as [Record<string, unknown>[], number][]) {
    const gen = zc.seqAllocator(segs as never, tail);
    const kase = { op: "seq_alloc", segs, tail_seq: tail, take: 6 };
    check(
      `seq_alloc(${segs.length}/${tail})`,
      kase,
      [0, 1, 2, 3, 4, 5].map(() => gen.next().value),
    );
  }

  // 词项与打分
  const queries = [
    "hello world",
    "中文检索",
    "a b c",
    "混合 mixed 中文 and English words",
    "单字 x",
    "!!! ,,, ???",
    "ABC_def_123",
    "重复重复 重复",
    "  spaces   everywhere  ",
    "",
    "🙂 emoji 汉字",
  ];
  check(
    "query_terms",
    { op: "terms", queries },
    queries.map((q) => [...zc.queryTerms(q)].sort()),
    (v) => v,
  );

  const scoreCases = queries.map((q) => ({ text: genRows(rng, 1)[0].text, terms: [...zc.queryTerms(q)].sort() }));
  check(
    "row_score",
    { op: "score", cases: scoreCases },
    scoreCases.map((c) => zc.rowScore(c.text, c.terms)),
  );

  // 命中精修
  const pickCases = [];
  for (const span of [40, 1, 3, 100]) {
    for (const start of [1, 4, 20]) {
      const n = 1 + Math.floor(rng() * 12);
      const lines = [];
      for (let i = 0; i < n; i++) {
        const r = genRows(rng, 1)[0];
        lines.push({ ...r, line: i + 1 });
      }
      const q = queries[Math.floor(rng() * queries.length)];
      const terms = [...zc.queryTerms(q)].sort();
      pickCases.push({ rows: lines, start, terms, span });
    }
  }
  check(
    "pick_hit_row",
    { op: "pick", cases: pickCases },
    pickCases.map((c) => zc.pickHitRow(c.rows as never, c.start, c.terms, c.span)),
  );

  // 前缀哈希
  const big = path.join(tmpRoot, "big.bin");
  const buf = Buffer.alloc(2 * 1024 * 1024 + 123);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) % 251;
  fs.writeFileSync(big, buf);
  for (const n of [0, 1, 10, 1000, 1024 * 1024, 1024 * 1024 + 1, buf.length, buf.length + 1]) {
    check(`sha_prefix(${n})`, { op: "sha_prefix", path: big, n }, zc.sha256Prefix(big, n));
  }
  check("sha_prefix(missing)", { op: "sha_prefix", path: path.join(tmpRoot, "nope"), n: 5 }, zc.sha256Prefix(path.join(tmpRoot, "nope"), 5));
}

// ---------- 第 2/3 层：产物与读取 ----------
function buildPlan(rng: () => number) {
  const sids = ["sess-a", "sess-b"];
  const plan: { fname: string; rows: R[]; startTs: number }[] = [];
  const man = zc.emptyManifest();
  man.sessions = {};
  man.segments = {};
  for (const sid of sids) {
    const nseg = 1 + Math.floor(rng() * 3);
    let globalLine = 1;
    const all: R[] = [];
    man.sessions[sid] = { start_ts: 0, jsonl_size: 0 };
    for (let seq = 1; seq <= nseg; seq++) {
      const rows = genRows(rng, Math.floor(rng() * 7));
      all.push(...rows);
      const fname = zc.segName(sid, seq);
      const startTs = rows.length ? rows[0].ts : Math.floor(rng() * 2e12) + 1;
      man.segments[fname] = {
        session_id: sid,
        seq,
        start_corpus_line: globalLine,
        rows: rows.length,
        frozen: seq < nseg,
        start_ts: startTs,
        start_jsonl_line: 0,
      };
      globalLine += rows.length;
      plan.push({ fname, rows, startTs });
    }
    if (all.length) {
      man.sessions[sid] = { start_ts: all[0].ts, jsonl_size: all.length };
    }
  }
  return { plan, man };
}

function phaseArtifacts() {
  const rng = makeRng(777);
  const shared = path.join(tmpRoot, "shared");
  const tsDir = path.join(tmpRoot, "ts");
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(tsDir, { recursive: true });
  const manShared = path.join(tmpRoot, "shared-manifest.json");
  const manTs = path.join(tmpRoot, "ts-manifest.json");

  const { plan, man } = buildPlan(rng);
  const kase = {
    op: "write",
    dir: shared,
    manifest_path: manShared,
    manifest: man,
    files: plan.map((f) => ({ fname: f.fname, rows: f.rows, start_ts: f.startTs })),
  };

  for (const f of plan) zc.writeSegment(tsDir, f.fname, f.rows as never, f.startTs);
  zc.saveManifest(manTs, man);

  const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const tsResult = {
    files: plan
      .map((f) => ({
        name: f.fname,
        sha256: sha(path.join(tsDir, f.fname)),
        mtime_ms: Math.round(fs.statSync(path.join(tsDir, f.fname)).mtimeMs),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    manifest_sha256: sha(manTs),
  };
  check("write 产物逐字节(分片+manifest)", kase, tsResult, (v) => {
    const o = v as { files: { name: string }[]; manifest_sha256: string };
    return { files: [...o.files].sort((a, b) => (a.name < b.name ? -1 : 1)), manifest_sha256: o.manifest_sha256 };
  });

  // 读取路径：两边都读 Python 写出来的 shared
  for (const f of plan) {
    for (const start of [1, 5, 1000]) {
      check(
        `read_segment(${f.fname},${start})`,
        { op: "read_segment", dir: shared, fname: f.fname, start },
        zc.readSegment(shared, f.fname, start).map(toTuple),
      );
    }
  }

  for (const sid of Object.keys(man.sessions)) {
    for (const target of [1, 2, 3, 50]) {
      const w = zc.readWindow(shared, zc.loadManifest(manShared), sid, target);
      check(
        `read_window(${sid},${target})`,
        { op: "window", dir: shared, manifest_path: manShared, sid, target },
        { rows: w.rows.map(toTuple), idx: w.idx },
      );
      const p = zc.pairForGlobal(shared, zc.loadManifest(manShared), sid, target);
      check(
        `pair_for_global(${sid},${target})`,
        { op: "pair", dir: shared, manifest_path: manShared, sid, target },
        p,
      );
    }
  }

  const m = zc.loadManifest(manShared);
  check(
    "load_manifest",
    { op: "load_manifest", manifest_path: manShared },
    { version: m.version, sessions: Object.keys(m.sessions ?? {}).sort(), segments: Object.keys(m.segments ?? {}).sort() },
  );

  // sweep：两边各喂一份内容/mtime 相同的副本，比对删除清单与剩余文件
  const now = Date.now();
  const mkSweepDir = (name: string) => {
    const d = path.join(tmpRoot, name);
    fs.mkdirSync(d, { recursive: true });
    const files: [string, number][] = [
      [".a.p0001.txt.123.tmp", now - 7200_000], // 老 -> 该删
      [".b.p0002.txt.456.tmp", now - 10_000], // 新 -> 保留
      [".c.p0003.txt.789.tmp", now - 3600_000], // 正好边界
      ["a.p0001.txt", now - 7200_000], // 正式分片 -> 绝不动
      [".notmp", now - 7200_000],
    ];
    for (const [f, mt] of files) {
      const p = path.join(d, f);
      fs.writeFileSync(p, "x");
      fs.utimesSync(p, mt / 1000, mt / 1000);
    }
    return d;
  };
  const dA = mkSweepDir("sweepA");
  const dB = mkSweepDir("sweepB");
  const maxAge = 3600;
  check(
    "sweep_stale_tmp",
    { op: "sweep", dir: dA, max_age: maxAge },
    zc.sweepStaleTmp(dB, maxAge),
    (v) => [...(v as string[])].sort(),
  );
  const leftA = fs.readdirSync(dA).sort();
  const leftB = fs.readdirSync(dB).sort();
  if (stable(leftA) === stable(leftB)) oks++;
  else problems.push(`[不一致] sweep 剩余文件\n  py=${stable(leftA)}\n  ts=${stable(leftB)}`);
}

// ---------- 第 4 层：真实语料 ----------
/**
 * 拿真实语料（默认 ~/.pi/agent/zgmem/<workspace>/{corpus,manifest.json}）跑同一套比对。
 * 合成数据碰不到的分布（真实 JSONL 文本、真实分片边界、真实 manifest）全在这一层。
 */
function phaseRealCorpus() {
  const root = process.env.ZGMEM_DIR || path.join(os.homedir(), ".pi", "agent", "zgmem");
  if (!fs.existsSync(root)) {
    console.log(`  (跳过真实语料：${root} 不存在)`);
    return;
  }
  let wsCount = 0;
  let segCount = 0;
  let rowCount = 0;
  for (const ws of fs.readdirSync(root).sort()) {
    const manPath = path.join(root, ws, "manifest.json");
    const corpusDir = path.join(root, ws, "corpus");
    if (!fs.existsSync(manPath) || !fs.existsSync(corpusDir)) continue;
    wsCount++;
    const man = zc.loadManifest(manPath);
    check(
      `real:load_manifest(${ws})`,
      { op: "load_manifest", manifest_path: manPath },
      {
        version: man.version,
        sessions: Object.keys(man.sessions ?? {}).sort(),
        segments: Object.keys(man.segments ?? {}).sort(),
      },
    );

    const segNames = Object.keys(man.segments ?? {}).sort();
    for (const fname of segNames) {
      segCount++;
      const rows = zc.readSegment(corpusDir, fname, 1);
      rowCount += rows.length;
      check(
        `real:read_segment(${ws}/${fname})`,
        { op: "read_segment_digest", dir: corpusDir, fname, start: 1 },
        digestRows(rows),
      );
      // 非差分不变量：manifest 记的行数应与文件实际可解析行数一致
      const meta = man.segments[fname];
      if ((meta.rows ?? 0) !== rows.length) {
        problems.push(`[真实语料不变量] ${ws}/${fname}: manifest.rows=${meta.rows} 但文件解析出 ${rows.length} 行`);
      }
    }

    for (const sid of Object.keys(man.sessions ?? {}).sort()) {
      for (const target of [1, 2, 5, 20, 50, 120, 400, 1500]) {
        const w = zc.readWindow(corpusDir, man, sid, target);
        check(
          `real:read_window(${ws}/${sid},${target})`,
          { op: "window_digest", dir: corpusDir, manifest_path: manPath, sid, target },
          { rows: digestRows(w.rows), idx: w.idx },
        );
        check(
          `real:pair_for_global(${ws}/${sid},${target})`,
          { op: "pair", dir: corpusDir, manifest_path: manPath, sid, target },
          zc.pairForGlobal(corpusDir, man, sid, target),
        );
      }
    }
  }
  console.log(`  真实语料：${wsCount} workspace / ${segCount} 分片 / ${rowCount} 行`);
}

function main() {
  const t0 = Date.now();
  phasePure();
  phaseArtifacts();
  phaseRealCorpus();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (problems.length) {
    console.error(`\n✗ 差分对拍失败 ${problems.length} 项（通过 ${oks}，${dt}s）\n`);
    for (const p of problems.slice(0, 12)) console.error(p + "\n");
    if (problems.length > 12) console.error(`… 另有 ${problems.length - 12} 项\n`);
    process.exit(1);
  }
  console.log(`✓ 差分对拍全绿：${oks} 项一致（${dt}s）`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main();
