/**
 * lib/refresh.ts（模块 D）的单元测试。
 *
 * 用例名沿用 Python 侧 `extensions/zg-memory/tests/test_zgmem.py#TestM2IndexRefresh` 的原名，
 * 便于逐条核对（见 docs/plan-ts-migration.md）。M2 系列守的是这三条历史 bug：
 *   - "无变化"早退连 `zg index` 一起跳过 → 索引被删/上轮失败后永久不修；
 *   - 并发 `lease active` 也谎报"索引已更新"；
 *   - 索引**运行期间**语料被别的实例改动，却仍被记成"已索引"。
 *
 * 与 Python 侧的差异（逐条登记）：
 *  1. 不起子进程跑 CLI，而是进程内调 `refresh.runRefresh(scope, opts)`，断言 `{out, code}`。
 *     Python 侧断言 `proc.returncode`，这里对应 `code`；stdout 对应 `out`。
 *     模块 E（lib/cli.ts）落地后，CLI 层的落地/退出码另有差分对拍（ `tests/differential/refresh_*`，
 *     已随模块 G 删除）；CLI 边界的常驻守护现在是 `tests/runtime_boundary.test.ts` 的真进程路径。
 *  2. 假 zg 仍然走 PATH 前置（跟 Python 一样：`runIndex` 真的 spawn "zg"），只有 lease/
 *     失败等分支才用注入的 `deps.zgIndex`。
 *  3. `test_etl_failure_exits_2_but_still_indexes`：Python 用 `chmod 000` 造 PermissionError，
 *     这里照旧（`geteuid()==0` 时跳过，root 拦不住）。同一分支的"目录冒充 jsonl"（EISDIR，
 *     root 也成立）由下一个用例 `...eisdir...` 覆盖（该变体原是差分脚本里的一例，模块 G 删脚本后留在仓库里）。
 *  4. `test_write_failure_keeps_old_segments_and_manifest`：Python monkeypatch `write_segment`
 *     在第 2 片注入 ENOSPC；TS 无法改模块导出（ESM 命名空间只读），改成**在第 2 片的临时文件
 *     路径上预先放一个目录** → `write_file` 必然 EISDIR，同样挂在第 2 片、同样走回滚路径。
 *  5. 分片行数上限：Python monkeypatch 模块常量 `MAX_SEG_ROWS`，TS 走 `ProcessOptions.limits`。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import * as zc from "../extensions/zg-memory/lib/corpus.ts";
import * as etl from "../extensions/zg-memory/lib/etl.ts";
import * as q from "../extensions/zg-memory/lib/query.ts";
import * as rf from "../extensions/zg-memory/lib/refresh.ts";

const EMBEDDING = "fake-embedding";
/** 造数据用的固定时间戳（与 Python 侧 1_700_000_000_000 一致）。 */
const T0 = 1_700_000_000_000;

interface Env {
  root: string;
  home: string;
  sessions: string;
  ws: string;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-d-"));
}

/** py: Base.setUp + TestM2IndexRefresh._prepare 的目录布局（ZGMEM_DIR/<ws>/corpus）。 */
function setup(ws = "ws-m2"): Env {
  const root = tmpdir();
  const home = path.join(root, "zgmem");
  const sessions = path.join(root, `${ws}-sessions`);
  const wsDir = path.join(home, ws);
  fs.mkdirSync(path.join(wsDir, "corpus"), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  // 起始 manifest：真正的 v2 空 manifest（`loadScope` 也要求 workspace 已初始化）
  fs.writeFileSync(path.join(wsDir, "manifest.json"), '{"version": 2, "sessions": {}, "segments": {}}');
  return { root, home, sessions, ws };
}

/** Scope 是磁盘快照，每次用之前重新读，避免拿着过期 manifest。 */
function scopeOf(env: Env): q.Scope {
  return q.loadScope(env.ws, env.home, true);
}

/** py: msg_line */
function msgLine(role: string, text: string, ts: number = T0): string {
  return JSON.stringify({
    type: "message",
    message: { role, timestamp: ts, content: [{ type: "text", text }] },
  });
}

/** py: make_session */
function makeSession(dir: string, sid: string, n = 4): string {
  const p = path.join(dir, `${sid}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(msgLine(i % 2 === 0 ? "user" : "assistant", `${sid} 第 ${i} 条消息`));
  }
  fs.writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

/** py: TestM2IndexRefresh._prepare —— 先直接跑一次 ETL 把语料建好（不走 refresh）。 */
function prepare(env: Env, sid = "s1", n = 4): string {
  const p = makeSession(env.sessions, sid, n);
  const scope = scopeOf(env);
  const man = zc.loadManifest(scope.manifestPath);
  etl.processSession(p, scope.corpusDir, man);
  zc.saveManifest(scope.manifestPath, man);
  return p;
}

/**
 * py: _fake_zg —— PATH 前置一个假 zg：记调用、输出固定文本、返回固定退出码。
 * 日志路径固定（同一 Env 里多个假 zg 共用，与 Python 一样），便于数调用次数。
 */
function fakeZg(env: Env, code: number, out: string): { bindir: string; log: string; calls: () => number } {
  const bindir = path.join(env.root, "bin");
  fs.mkdirSync(bindir, { recursive: true });
  const log = path.join(env.root, "zg-calls.log");
  const p = path.join(bindir, "zg");
  fs.writeFileSync(p, `#!/bin/sh\necho "$@" >> "${log}"\necho "${out}"\nexit ${code}\n`);
  fs.chmodSync(p, 0o755);
  const calls = (): number => {
    if (!fs.existsSync(log)) return 0;
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  };
  return { bindir, log, calls };
}

/** 跑一次 refresh：PATH 里带上假 zg（跟 Python 的子进程调法等价），跑完还原。 */
function refresh(env: Env, bindir: string, deps: rf.RefreshDeps = {}): rf.RefreshResult {
  const old = process.env.PATH;
  process.env.PATH = `${bindir}${path.delimiter}${old ?? ""}`;
  try {
    return rf.runRefresh(scopeOf(env), { sessionsDir: env.sessions, embedding: EMBEDDING }, deps);
  } finally {
    process.env.PATH = old;
  }
}

/** 语料目录里的分片：名字 → 字节。 */
function blobs(corpusDir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const f of fs.readdirSync(corpusDir)) {
    if (f.endsWith(".txt") && !f.startsWith(".")) {
      out[f] = fs.readFileSync(path.join(corpusDir, f));
    }
  }
  return out;
}

/** 造出"索引已建过"的痕迹：zg 建的 `index.zvec` 是**目录**（不是文件）。 */
function makeMarker(corpusDir: string): string {
  const marker = rf.indexMarker({ corpusDir } as q.Scope);
  fs.mkdirSync(path.join(marker, "seg"), { recursive: true });
  return marker;
}

// ---------- M2: 索引与早退 ----------

test("TestM2IndexRefresh.test_missing_index_is_repaired_even_with_no_changes", () => {
  const env = setup();
  prepare(env);
  const { bindir, calls } = fakeZg(env, 0, "indexed 1 files");
  const marker = makeMarker(scopeOf(env).corpusDir);

  // 索引在，但从来没有过"成功索引"的状态戳（旧版本遗留/刚升级）：必须补跑一次把戳建起来
  const p0 = refresh(env, bindir);
  assert.match(p0.out, /补跑索引/);
  assert.match(p0.out, /索引已更新/);
  assert.equal(calls(), 1);

  // 戳已建好 + 无变化：真的没事做，一次 zg 都不该跑
  // （修前 isFile 判目录 → 每轮都白跑一整轮嵌入）
  const p1 = refresh(env, bindir);
  assert.match(p1.out, /无变化/);
  assert.match(p1.out, /索引已是最新/);
  assert.equal(calls(), 1);

  fs.rmSync(marker, { recursive: true, force: true }); // 索引被删（或上轮失败）
  const p2 = refresh(env, bindir);
  assert.equal(p2.code, 0);
  assert.match(p2.out, /索引缺失, 重建索引/); // 修前："无变化, 无需更新" 直接 return
  assert.match(p2.out, /索引已更新/);
  assert.equal(calls(), 2); // 修前这里一次 zg 都没跑
});

test("TestM2IndexRefresh.test_lease_active_does_not_claim_index_updated", () => {
  const env = setup("ws-lease");
  const p = prepare(env);
  const { bindir, log } = fakeZg(env, 1, "ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE: somebody else owns writes");
  makeMarker(scopeOf(env).corpusDir);
  fs.appendFileSync(p, `${msgLine("user", "新的问题", T0 + 200_000)}\n`); // 制造变化 → 走到索引阶段

  const proc = refresh(env, bindir);
  assert.equal(proc.code, 0);
  assert.match(proc.out, /lease active/);
  assert.ok(!proc.out.includes("索引已更新"), "lease 期间绝不能报索引已更新"); // 修前：照样说"索引已更新"
  assert.ok(fs.existsSync(log));
});

test("TestM2IndexRefresh.test_index_failure_is_reported_and_exits_nonzero", () => {
  const env = setup("ws-fail");
  const p = prepare(env);
  const { bindir } = fakeZg(env, 4, "fatal: embedding model unavailable");
  makeMarker(scopeOf(env).corpusDir);
  fs.appendFileSync(p, `${msgLine("user", "新的问题", T0 + 300_000)}\n`);

  const proc = refresh(env, bindir);
  assert.equal(proc.code, 3);
  assert.match(proc.out, /zg index 失败/);
  assert.ok(!proc.out.includes("索引已更新"));
});

test("TestM2IndexRefresh.test_index_failure_is_retried_on_next_refresh", () => {
  // 上轮 zg index 失败后，下一轮必须真的重试 —— 修前会一直报"无变化, 索引已是最新"（评审 HIGH-1）
  const env = setup("ws-retry");
  const p = prepare(env);
  makeMarker(scopeOf(env).corpusDir);
  const ok = fakeZg(env, 0, "indexed 1 files");
  assert.equal(refresh(env, ok.bindir).code, 0); // 先成功一次，建立状态戳
  const base = ok.calls();

  fs.appendFileSync(p, `${msgLine("user", "只有这轮才有的新问题", T0 + 500_000)}\n`);

  const bad = fakeZg(env, 4, "fatal: embedding model unavailable");
  const pBad = refresh(env, bad.bindir);
  assert.equal(pBad.code, 3);
  assert.equal(ok.calls(), base + 1);

  // 关键：这轮 jsonl 没变化，但上轮索引失败过 → 绝不能早退
  const ok2 = fakeZg(env, 0, "indexed 1 files");
  const pRetry = refresh(env, ok2.bindir);
  assert.equal(pRetry.code, 0);
  assert.ok(!pRetry.out.includes("索引已是最新"), "上轮失败过就不能早退"); // 修前：正是这句 → 永久放弃重试
  assert.match(pRetry.out, /索引已更新/);
  assert.equal(ok2.calls(), base + 2);
});

test("TestM2IndexRefresh.test_empty_corpus_still_runs_zg_index", () => {
  // 语料被删光但索引还在：也要跑 zg index，否则已删文件的向量永远留在索引里（评审 LOW-3）
  const env = setup("ws-empty");
  prepare(env);
  const scope = scopeOf(env);
  for (const f of fs.readdirSync(scope.corpusDir)) {
    if (f.endsWith(".txt")) fs.unlinkSync(path.join(scope.corpusDir, f));
  }
  const { bindir, calls } = fakeZg(env, 0, "indexed 1 files");
  makeMarker(scope.corpusDir);

  const p = refresh(env, bindir);
  assert.equal(p.code, 0);
  assert.equal(calls(), 1); // 修前："语料目录为空, 跳过索引" → 永不清理
});

test("TestM2IndexRefresh.test_write_failure_keeps_old_segments_and_manifest", () => {
  // 重建时写新片失败（ENOSPC）：旧分片字节不动，manifest 条目不动，不留 staging 垃圾（评审 MED-1）
  const env = setup("ws-rebuild");
  const scope = scopeOf(env);
  const p = makeSession(env.sessions, "w1", 20);
  const limits: zc.SegLimits = { rows: 5, bytes: zc.MAX_SEG_BYTES };
  const man1 = zc.emptyManifest();
  etl.processSession(p, scope.corpusDir, man1, { limits });
  zc.saveManifest(scope.manifestPath, man1);

  const before = blobs(scope.corpusDir);
  const names = Object.keys(before).sort();
  assert.ok(names.length >= 2, `需要 ≥2 片才能在第 2 片注入失败，实际 ${names.length} 片`);

  const man2 = zc.loadManifest(scope.manifestPath);
  const manBefore = JSON.stringify(man2);

  // 让第 2 片的临时文件写不进去：预先在这个路径上放一个**目录**
  // （py: monkeypatch write_segment 在第 2 次 .staging 写入时抛 ENOSPC）
  const staging = `.${names[1]}.staging`;
  const blocker = path.join(scope.corpusDir, `.${staging}.${process.pid}.tmp`);
  fs.mkdirSync(blocker);

  // force=True → 走重建路径（追加消息是增量的，只重写一片，造不出"写第 2 片时挂"）
  assert.throws(() => etl.processSession(p, scope.corpusDir, man2, { force: true, limits }));
  fs.rmdirSync(blocker);

  assert.deepEqual(blobs(scope.corpusDir), before, "旧分片必须原样保留"); // 修前：旧片被 unlink，只剩写成的第 1 片
  assert.deepEqual(
    fs.readdirSync(scope.corpusDir).filter((f) => f.includes(".staging")),
    [],
    "不能留 staging 垃圾",
  );
  assert.equal(JSON.stringify(man2), manBefore, "manifest 条目必须原样"); // 修前：session 条目已被摘掉
});

test("TestM2IndexRefresh.test_etl_failure_exits_2_but_still_indexes", (t) => {
  // ETL 挂了（会话文件读不了）也要：退出码非 0 + zg 索引照跑 + 旧语料不被清掉
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    t.skip("root 下 chmod 000 拦不住读，没法制造 ETL 失败（EISDIR 变体见下一个用例）");
    return;
  }
  const env = setup("ws-etl");
  const scope = scopeOf(env);
  const p = prepare(env);
  const { bindir, log } = fakeZg(env, 0, "indexed 1 files");
  makeMarker(scope.corpusDir);

  const manBefore = zc.loadManifest(scope.manifestPath);
  const names = Object.keys(zc.segments(manBefore)).sort();
  assert.ok(names.length > 0);
  const blob = blobs(scope.corpusDir);
  assert.deepEqual(Object.keys(blob).sort(), names);

  fs.appendFileSync(p, `${msgLine("user", "新的问题", T0 + 400_000)}\n`); // 先造变化，否则"无变化"早退不会进 ETL
  fs.chmodSync(p, 0); // ETL 读不了 → 必然失败
  let proc: rf.RefreshResult;
  try {
    proc = refresh(env, bindir);
  } finally {
    fs.chmodSync(p, 0o644);
  }

  assert.equal(proc.code, 2); // 修前：吞异常 + exit 0
  assert.match(proc.out, /ETL 失败/); // 注意行里的"个 session ETL 失败"
  assert.match(proc.out, /EACCES|permission denied/i); // py: PermissionError
  assert.match(proc.out, /索引已更新/); // ETL 失败也不阻断 zg 索引
  assert.match(fs.readFileSync(log, "utf8"), /index \./);

  const manAfter = zc.loadManifest(scope.manifestPath);
  assert.ok(zc.sessions(manAfter)["s1"], "会话条目没被拿掉");
  assert.deepEqual(Object.keys(zc.segments(manAfter)).sort(), names);
  assert.deepEqual(blobs(scope.corpusDir), blob, "旧分片字节没被清空重写");
});

test("TestM2IndexRefresh.test_etl_failure_eisdir_exits_2_but_still_indexes", () => {
  // 同上一用例的分支，但失败由“目录冒充 <sid>.jsonl”制造 → read 必然 EISDIR，
  // **root 下也成立**，所以不需要 skip。（原是差分脚本 scenarioEtlFail 的一例，
  // 模块 G 删脚本后把它变成常驻用例，免得 root 环境下这条分支彻底没覆盖。）
  const env = setup("ws-etl-dir");
  const scope = scopeOf(env);
  const p = prepare(env);
  const { bindir, log } = fakeZg(env, 0, "indexed 1 files");
  makeMarker(scope.corpusDir);

  const manBefore = zc.loadManifest(scope.manifestPath);
  const names = Object.keys(zc.segments(manBefore)).sort();
  assert.ok(names.length > 0);
  const blob = blobs(scope.corpusDir);

  fs.appendFileSync(p, `${msgLine("user", "新的问题", T0 + 400_000)}\n`); // 先造变化，否则“无变化”早退不会进 ETL
  fs.mkdirSync(path.join(env.sessions, "broken.jsonl"), { recursive: true }); // ETL 读目录 → EISDIR

  const proc = refresh(env, bindir);

  assert.equal(proc.code, 2); // 有 session ETL 失败 → 退出码 2
  assert.match(proc.out, /ETL 失败/);
  assert.match(proc.out, /EISDIR/);
  assert.match(proc.out, /注意: 1\/2 个 session ETL 失败/);
  assert.match(proc.out, /索引已更新/); // ETL 失败也不阻断 zg 索引
  assert.match(fs.readFileSync(log, "utf8"), /index \./);

  // 好会话的条目还在、旧分片也没被清空（内容只能往后追加：s1 那个新行确实要落盘，
  // 所以这里钉的是“旧字节仍是新字节的前缀”，而不是逐字节相等 —— 与原用例不同，
  // 那边 s1 自己就是失败的那个，什么都不会重写。）
  const manAfter = zc.loadManifest(scope.manifestPath);
  assert.ok(zc.sessions(manAfter)["s1"], "会话条目没被拿掉");
  const now = blobs(scope.corpusDir);
  for (const n of names) {
    assert.ok(now[n], `旧分片 ${n} 不见了`);
    assert.ok(now[n].length >= blob[n].length, `旧分片 ${n} 变短了`);
    assert.equal(Buffer.compare(now[n].subarray(0, blob[n].length), blob[n]), 0, `旧分片 ${n} 的历史字节被改写`);
  }
  assert.equal(zc.sessions(manAfter)["broken"], undefined, "失败的会话不进 manifest");
});

test("TestM2IndexRefresh.test_corpus_change_during_index_is_not_declared_indexed", () => {
  // 索引**运行期间**别的实例往语料里写了新行：戳只能描述 index 启动时的语料，
  // 否则下一轮会谎报"索引已是最新"，那一行永久搜不到（评审 MED-2）
  const env = setup("ws-race");
  const scope = scopeOf(env);
  prepare(env);
  const shard = path.join(
    scope.corpusDir,
    fs
      .readdirSync(scope.corpusDir)
      .filter((f) => f.endsWith(".txt") && !f.startsWith("."))
      .sort()[0],
  );
  makeMarker(scope.corpusDir);

  // 假 zg：在"索引期间"往语料追加一行（等价于并发 refresh 的 ETL 落在索引窗口内）
  const bindir = path.join(env.root, "bin");
  fs.mkdirSync(bindir, { recursive: true });
  const log = path.join(env.root, "zg-calls.log");
  const zg = path.join(bindir, "zg");
  fs.writeFileSync(
    zg,
    `#!/bin/sh\necho "$@" >> "${log}"\nprintf '99\\tuser\\t1700000000000\\t索引期间被别的实例写进来的行\\n' >> "${shard}"\nexit 0\n`,
  );
  fs.chmodSync(zg, 0o755);

  const p0 = refresh(env, bindir);
  assert.equal(p0.code, 0);
  assert.match(p0.out, /索引已更新/);
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter((l) => l.trim()).length, 1);

  // 关键：戳必须描述"索引启动时"的语料，而不是索引跑完之后被改过的语料
  const stamp = JSON.parse(fs.readFileSync(rf.indexStampPath(scope), "utf8")) as {
    files: number;
    bytes: number;
    newest_mtime: number;
  };
  const diskFiles = fs
    .readdirSync(scope.corpusDir)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("."));
  let diskBytes = 0;
  for (const f of diskFiles) diskBytes += Number(fs.statSync(path.join(scope.corpusDir, f), { bigint: true }).size);
  assert.notEqual(stamp.bytes, diskBytes); // 修前：现场取戳 → 与磁盘完全相等（py: stamp["bytes"] != disk["bytes"]）
  assert.ok(
    stamp.bytes !== diskBytes || stamp.files !== diskFiles.length,
    "戳与磁盘现场指纹至少得有一项不等", // py: stamp != disk
  );

  // 行为面：那次索引没覆盖到新行 → 下一轮绝不能早退，zg 必须再跑
  const p1 = refresh(env, bindir);
  assert.ok(!p1.out.includes("索引已是最新"), "不能谎报已最新"); // 修前：谎报已最新
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter((l) => l.trim()).length, 2); // 修前：一次 zg 都不跑
});

test("TestM2IndexRefresh.test_refresh_sweeps_stale_tmp_without_any_change", () => {
  // 没有任何 session 变化时 ETL 根本不会被调用，但 refresh 也必须清扫硬杀残留
  // （真机冒烟发现的缺口：只在 jsonl2corpus 里扫，残留会永久留着）
  const env = setup("ws-sweep");
  prepare(env);
  const scope = scopeOf(env);
  const { bindir } = fakeZg(env, 0, "indexed 1 files");
  const seg = Object.keys(zc.segments(zc.loadManifest(scope.manifestPath))).sort()[0];

  const stale = path.join(scope.corpusDir, `.${seg}.staging`);
  fs.writeFileSync(stale, "半成品\n");
  fs.utimesSync(stale, 0, 0); // 1970 → 必判过期
  const fresh = path.join(scope.corpusDir, `.${seg}.fresh.staging`);
  fs.writeFileSync(fresh, "另一个进程正在写的\n");

  const p = refresh(env, bindir);
  assert.equal(p.code, 0);
  assert.match(p.out, /清理残留半成品 1 个/);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(fresh));
});
