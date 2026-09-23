/**
 * 模块 D（`lib/refresh.ts`）的差分对拍 —— **仅迁移期使用**，需要 Python 当裁判；模块 G 随 Python 一起删。
 *
 * 比的是 zgmem 的**写入**路径一条命令的全部行为：
 *   扫 sessions 目录 → 删已消失会话的分片 → prune manifest → 扫残留半成品 → 逐 session ETL
 *   → `zg index` 增量索引 → 索引状态戳 / lease / 失败三态 → 退出码。
 *
 * 为什么必须建**两棵并列的树**：refresh 会改状态（manifest / 分片 / 状态戳）。想逐字节比对
 * 产物，就得让两侧各自演化、互不干扰。于是每个场景建
 *   `<root>/<场景>/{py,ts}/{zgmem/<ws>/{manifest.json,corpus/}, sessions/}`
 * 两侧跑**完全同序**的命令，每步都比：
 *   stdout 文本（绝对根路径归一化成 `<ROOT>`）/ 退出码 / stderr /
 *   分片名单 + 逐字节 / manifest.json 字节 / index-stamp.json 字节 / 语料目录里的残留 .tmp/.staging
 *
 * **假 zg**：PATH 前置一个脚本，行为由 `ZG_FAKE_MODE` 决定（ok / lease / lease-stdout / fail /
 * fail-both / silent）。真 `zg` 又慢又要下嵌入模型、还不是我们的代码 —— 假 zg 只负责"建出
 * `.zvec-grep/index.zvec` + 按模式返回"，好让两侧拿到完全相同的判决。**因此本差分不覆盖 zg
 * 自身的索引逻辑**，只覆盖"我们怎么调它、怎么解释它的结果"（成功 / DAEMON_LEASE_ACTIVE / 失败）。
 * `ZG_FAKE_MODE=fail-both` 是专门喂 `((stderr or "") + (stdout or "")).strip()` 的：拼错顺序
 * 或漏掉 strip 都会被它抓出来。
 *
 * 已知不比对的东西（登记在 docs/plan-ts-migration.md 的模块 D 记录里）：
 *   - `.zvec-grep/index.zvec` 的内容（假 zg 造的，不是我们的代码）；
 *   - segment 的 mtime：`write_segment` 把 mtime 钉在首条消息的语义时间上，本来就是确定的，
 *     这正是指纹里的 `newest_mtime` 能逐字节比的原因；
 *   - manifest.json 里的**绝对路径**（`jsonl_path` 必然指向各自的树）—— 把两侧的根路径都归一化成
 *     `<ROOT>` 后再逐字节比（路径形态的差异仍然会被抳住）；
 *   - ETL 失败时那坨**原生异常文本**：Python 是 traceback，Node 是 Error+栈，两者本来就不可能一样
 *     （掩成 `<MASKED>`，改由 `expectContains` 断言”两侧都确实报了失败“）。
 *
 * 用法: node tests/differential/refresh_differential.ts
 *   SKIP_REAL=1        跳过真实语料场景（默认跑）
 *   REAL_FILES=N       每个真实 workspace 最多取 N 个 jsonl（默认 25；0=不限）
 *   DIFF_KEEP=1        保留临时目录
 * 退出码: 0 一致 / 1 有差异
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const EXT = path.join(REPO, "extensions", "zg-memory");
const PY_CLI = path.join(EXT, "zgmem.py");
const TS_CLI = path.join(HERE, "refresh_entry.ts");
const WS = "testws";
const EMBEDDING = "local/potion-multilingual-128m";
const ZGMEM_DIR = process.env.ZGMEM_DIR || path.join(os.homedir(), ".pi", "agent", "zgmem");

/**
 * ETL 失败时那坨原生异常文本：Python 是 traceback（帧数/格式不同），Node 是 Error+栈。
 * 从 `Traceback (...)`/`Error: ` 起整块吃掉，到下一个**我们自己写的顶格行**为止（用显式停靠词，
 * 因为 traceback 的最后一行 `XxxError: ...` 本身也是顶格的）。
 * 掩掉不等于放过：场景里用 expectContains 另外断言两侧都真的报了异常、且失败计数行一致。
 */
const ETL_FAIL_MASK =
  /(?:Traceback \(most recent call last\):|\bError: )[\s\S]*?(?=\n(?:变更 |索引缺失|语料目录为空|上轮索引|无变化, |另一个 zg|zg index失败|索引已更新|注意:|sessions 目录|跳过无法 stat))/g;

let checks = 0;
const diffs: string[] = [];

function check(label: string, a: Buffer | string, b: Buffer | string): void {
  checks += 1;
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a, "utf8");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  if (ab.equals(bb)) return;
  const first = (() => {
    for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
      if (ab[i] !== bb[i]) return i;
    }
    return -1;
  })();
  diffs.push(
    `${label}: 不一致 (${ab.length}B vs ${bb.length}B, 首个差异 byte ${first})` +
      (first >= 0
        ? `\n    py: ${JSON.stringify(ab.subarray(Math.max(0, first - 40), first + 60).toString("utf8"))}` +
          `\n    ts: ${JSON.stringify(bb.subarray(Math.max(0, first - 40), first + 60).toString("utf8"))}`
        : ""),
  );
}

const FAKE_ZG = `#!/bin/sh
# 假 zg：只为让两侧拿到相同判决。本差分不覆盖 zg 自身的索引逻辑。
case "$ZG_FAKE_MODE" in
  ok) mkdir -p .zvec-grep/index.zvec; echo "fake-zg: indexed" ;;
  lease) echo "DAEMON_LEASE_ACTIVE: another daemon" >&2; exit 1 ;;
  lease-stdout) echo "DAEMON_LEASE_ACTIVE: another daemon"; exit 1 ;;
  fail) echo "fake-zg: boom" >&2; exit 1 ;;
  fail-both) echo "OUT-half"; echo "ERR-half" >&2; exit 1 ;;
  silent) exit 2 ;;
  *) echo "unknown ZG_FAKE_MODE=$ZG_FAKE_MODE" >&2; exit 9 ;;
esac
`;

let ROOT = "";
let BIN = "";

class Tree {
  // 只用可擦除语法：参数属性（constructor(readonly x)）会被 node 的 strip-only 拒掉
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  get side(): string {
    return path.basename(this.root);
  }
  get home(): string {
    return path.join(this.root, "zgmem");
  }
  get sessions(): string {
    return path.join(this.root, "sessions");
  }
  get wsDir(): string {
    return path.join(this.home, WS);
  }
  get manifest(): string {
    return path.join(this.wsDir, "manifest.json");
  }
  get corpus(): string {
    return path.join(this.wsDir, "corpus");
  }
  get stamp(): string {
    return path.join(this.wsDir, "index-stamp.json");
  }
}

function initTree(t: Tree): void {
  fs.mkdirSync(path.join(t.wsDir, "corpus"), { recursive: true });
  fs.mkdirSync(t.sessions, { recursive: true });
  // 起始 manifest：真正的 v2 空 manifest（`{}` 会让 _prune_manifest 拒绝写回，那是另一条分支）
  fs.writeFileSync(t.manifest, `{"version": 2, "sessions": {}, "segments": {}}`);
}

interface Ctx {
  name: string;
  py: Tree;
  ts: Tree;
}

function scenario(name: string): Ctx {
  const base = path.join(ROOT, name);
  const py = new Tree(path.join(base, "py"));
  const ts = new Tree(path.join(base, "ts"));
  for (const t of [py, ts]) initTree(t);
  return { name, py, ts };
}

/** 同时给两棵树写同一份会话（内容逐字节相同；mtime 各树独立，manifest 也各树独立，不影响对拍）。 */
function seedBoth(ctx: Ctx, files: Record<string, string>): void {
  for (const t of [ctx.py, ctx.ts]) {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(t.sessions, name), content);
    }
  }
}

/** 两侧同步施加同一个"外部世界的变化"（改文件/删文件/删索引），两步之间不做任何推断。 */
function both(ctx: Ctx, fn: (t: Tree) => void): void {
  for (const t of [ctx.py, ctx.ts]) fn(t);
}

interface Run {
  out: string;
  err: string;
  code: number;
}

function runSide(t: Tree, opts: { sessionsDir?: string | null; mode?: string }): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZGMEM_DIR: t.home,
    ZGMEM_SCOPE: WS,
    ZGMEM_EMBEDDING: EMBEDDING,
    ZG_FAKE_MODE: opts.mode ?? "ok",
    PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env["PI_SESSION_FILE"];
  const sd = opts.sessionsDir === undefined ? t.sessions : opts.sessionsDir;
  const args =
    t.side === "py"
      ? [PY_CLI, "refresh", "--sessions-dir", sd as string, "--workspace", WS]
      : [TS_CLI, "--sessions-dir", sd as string, "--workspace", WS];
  const r = spawnSync(t.side === "py" ? "python3" : "node", args, { encoding: "utf8", env, cwd: REPO });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
}

/** 报错文本里带各自的绝对路径 —— 不归一化就没法比。 */
function norm(s: string, t: Tree): string {
  return s.split(t.root).join("<ROOT>");
}

function readMaybe(p: string): Buffer {
  try {
    return fs.readFileSync(p);
  } catch {
    return Buffer.from("<缺文件>");
  }
}

/**
 * manifest.json 里的 `jsonl_mtime` 是**各树文件自己的** mtime（绝对毫秒），跨树比字节没意义。
 * 这里把该字段抹平成 `<MTIME>` —— 但同一并断言它等于按文件实际 mtime 算出来的值，
 * 而且用**另一套**公式算（ns 整除 1e6，而不是代码里的 float 乘 1000），专抓舍入类型的 off-by-one。
 */
function normManifest(t: Tree): string {
  const raw = readMaybe(t.manifest).toString("utf8");
  const fromManifest: number[] = [];
  for (const m of raw.matchAll(/"jsonl_mtime": (\d+)/g)) fromManifest.push(Number(m[1]));
  const expected: number[] = [];
  try {
    const man = JSON.parse(raw) as { sessions?: Record<string, unknown> };
    for (const sid of Object.keys(man.sessions ?? {})) {
      expected.push(Number(fs.statSync(path.join(t.sessions, `${sid}.jsonl`), { bigint: true }).mtimeNs / 1_000_000n));
    }
  } catch {
    /* 解析不了/manifest 不存在：交给下面的字节比对报错 */
  }
  if (fromManifest.length === expected.length && fromManifest.join(",") !== expected.join(",")) {
    checks += 1;
    diffs.push(
      `${t.side}: manifest 的 jsonl_mtime 与实际文件 mtime 不符\n    manifest: ${fromManifest.join(",")}\n    实际(整除): ${expected.join(",")}`,
    );
  }
  return raw.split(t.root).join("<ROOT>").replace(/"jsonl_mtime": \d+/g, '"jsonl_mtime": <MTIME>');
}

/** 断言某段文本里确实包含某个标记（用掩码时会顺手用上，避免掩码把”真报错“一起掩掉）。 */
function expectContains(label: string, text: string, needle: string): void {
  checks += 1;
  if (!text.includes(needle)) diffs.push(`${label}: 预期包含 ${JSON.stringify(needle)}，实际没有`);
}

function corpusTxt(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".txt"))
      .sort();
  } catch {
    return [];
  }
}

function dotFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** 比对两侧此刻的全部产物（分片 / manifest / 状态戳 / 残留半成品）。 */
function compareState(ctx: Ctx, tag: string): void {
  const pf = corpusTxt(ctx.py.corpus);
  const tf = corpusTxt(ctx.ts.corpus);
  check(`${tag}: 分片名单`, pf.join(","), tf.join(","));
  for (const f of pf) {
    if (tf.includes(f)) {
      check(`${tag}: corpus/${f}`, fs.readFileSync(path.join(ctx.py.corpus, f)), fs.readFileSync(path.join(ctx.ts.corpus, f)));
    }
  }
  check(`${tag}: manifest.json`, normManifest(ctx.py), normManifest(ctx.ts));
  check(`${tag}: index-stamp.json`, readMaybe(ctx.py.stamp), readMaybe(ctx.ts.stamp));
  check(`${tag}: 语料目录残留(隐藏文件)`, dotFiles(ctx.py.corpus).join(","), dotFiles(ctx.ts.corpus).join(","));
}

/** 跑一步：两侧同序执行 → 比 stdout（归一化 + 可选掩码）/ 退出码 / stderr / 产物。 */
function step(ctx: Ctx, tag: string, opts: { sessionsDir?: string | null; mode?: string; mask?: RegExp } = {}): { py: Run; ts: Run } {
  const py = runSide(ctx.py, opts);
  const ts = runSide(ctx.ts, opts);
  const mask = (s: string): string => (opts.mask ? s.replace(opts.mask, "<MASKED>") : s);
  check(`${tag}: stdout`, mask(norm(py.out, ctx.py)), mask(norm(ts.out, ctx.ts)));
  check(`${tag}: 退出码`, String(py.code), String(ts.code));
  check(`${tag}: stderr`, norm(py.err, ctx.py), norm(ts.err, ctx.ts));
  if (py.code < 0 || ts.code < 0) {
    diffs.push(`${tag}: 进程未正常退出 py=${py.code} ts=${ts.code}\n    ${py.err.trim()}\n    ${ts.err.trim()}`);
  }
  compareState(ctx, tag);
  process.stderr.write(`  ${tag}\n    py: ${brief(py)}\n    ts: ${brief(ts)}\n`);
  return { py, ts };
}

/** 供日志用：把 stdout 压成一行，方便看每步到底走了哪条分支。 */
function brief(r: Run): string {
  const lines = r.out.split("\n").filter((l) => l !== "");
  return `rc=${r.code} | ${lines.join(" ⏎ ")}`;
}

// ---------- 场景 ----------

/** 完整的一条生命周期阶梯：首次构建 → 无变化早退 → 增量 → 索引缺失 → 部分删除 → 拒绝清理 → 无目录。 */
function scenarioLifecycle(): void {
  const ctx = scenario("lifecycle");
  seedBoth(ctx, {
    "sess-a.jsonl": JSON.stringify({ role: "user", content: "你好，第一条" }) + "\n",
    "sess-b.jsonl": JSON.stringify({ role: "assistant", content: "hello #2" }) + "\n",
  });

  const s1 = step(ctx, "首次(全量构建)");
  step(ctx, "无变化(索引已是最新早退)");

  both(ctx, (t) => fs.appendFileSync(path.join(t.sessions, "sess-a.jsonl"), JSON.stringify({ role: "user", content: "追加一行" }) + "\n"));
  step(ctx, "追加一行(增量 ETL)");

  // 索引标记被删（只删 zg 的标记目录；戳还在 → 必须补跑索引而不是早退）
  both(ctx, (t) => fs.rmSync(path.join(t.corpus, ".zvec-grep"), { recursive: true, force: true }));
  step(ctx, "索引缺失+无变化(补跑索引)");

  // 部分删除：sess-b 消失 → 删它的分片 + prune manifest
  both(ctx, (t) => fs.rmSync(path.join(t.sessions, "sess-b.jsonl")));
  step(ctx, "部分删除(prune manifest)");

  // 全部删除：sessions 目录空但 manifest 里还有条目 → 拒绝清理
  both(ctx, (t) => fs.rmSync(path.join(t.sessions, "sess-a.jsonl")));
  step(ctx, "全删(拒绝清理)");

  step(ctx, "sessions 目录不存在", { sessionsDir: path.join(ROOT, "nonexistent-dir") });
  // 空串：Python 走 `args.sessions_dir or dirname(PI_SESSION_FILE)` → "" → no sessions dir
  step(ctx, "sessions-dir 为空串", { sessionsDir: "" });
}

/** 残留半成品：只扫掉超过 1 小时的（fresh .tmp 必须留着，那是别的进程正在写的）。 */
function scenarioStaleTmp(): void {
  const ctx = scenario("stale-tmp");
  seedBoth(ctx, { "sess-a.jsonl": JSON.stringify({ role: "user", content: "x" }) + "\n" });
  both(ctx, (t) => {
    const old = path.join(t.corpus, ".stale.txt.staging");
    const fresh = path.join(t.corpus, ".busy.txt.tmp");
    fs.writeFileSync(old, "半截");
    fs.writeFileSync(fresh, "半截");
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  });
  step(ctx, "扫残留半成品(旧删/新留)");
}

/** zg 三态：成功 / lease(在 stderr) / lease(在 stdout) / 失败 / 失败(两流拼接) / 静默失败。 */
function scenarioZgModes(): void {
  const ctx = scenario("zg-modes");
  seedBoth(ctx, { "sess-a.jsonl": JSON.stringify({ role: "user", content: "zg 各态" }) + "\n" });
  step(ctx, "ok(首次构建)");

  // 每次先制造"有变化 + 无戳"，逼它真去调 zg（否则会走"无变化,索引已是最新"早退）
  const force = (mode: string): void => {
    both(ctx, (t) => {
      fs.appendFileSync(path.join(t.sessions, "sess-a.jsonl"), JSON.stringify({ role: "user", content: mode }) + "\n");
      fs.rmSync(t.stamp, { force: true });
    });
    step(ctx, `zg ${mode}`, { mode });
  };
  force("lease");
  force("lease-stdout");
  force("fail");
  force("fail-both");
  force("silent");
  // 失败后必须能自愈：戳已被清 → 下一轮补跑索引并恢复
  force("ok");
}

/** ETL 失败：把目录伪装成 `<sid>.jsonl`（两侧都必然失败，但失败后的分支要一致）。 */
function scenarioEtlFail(): void {
  const ctx = scenario("etl-fail");
  seedBoth(ctx, { "good.jsonl": JSON.stringify({ role: "user", content: "正常" }) + "\n" });
  both(ctx, (t) => fs.mkdirSync(path.join(t.sessions, "broken.jsonl"), { recursive: true }));
  const a = step(ctx, "ETL 失败(1 好 1 坏)", { mask: ETL_FAIL_MASK });
  expectContains("ETL失败(1好1坏): py 侧报了异常", a.py.out, "Traceback");
  expectContains("ETL失败(1好1坏): ts 侧报了异常", a.ts.out, "Error:");
  expectContains("ETL失败(1好1坏): 失败计数行", a.py.out, "注意: 1/2 个 session ETL 失败");
  expectContains("ETL失败(1好1坏): 失败计数行(ts)", a.ts.out, "注意: 1/2 个 session ETL 失败");

  // 只有坏文件 + 语料为空 + 索引未建过 → 跳过索引（LOW-3 的另一半）
  const ctx2 = scenario("etl-fail-empty");
  both(ctx2, (t) => fs.mkdirSync(path.join(t.sessions, "broken.jsonl"), { recursive: true }));
  const b = step(ctx2, "ETL 失败(语料为空跳过索引)", { mask: ETL_FAIL_MASK });
  expectContains("ETL失败(空): py 侧报了异常", b.py.out, "Traceback");
  expectContains("ETL失败(空): ts 侧报了异常", b.ts.out, "Error:");
  expectContains("ETL失败(空): 失败计数行", b.ts.out, "注意: 1/1 个 session ETL 失败");
}

/** 断链的 jsonl：`os.stat` 失败 → 只跳过它，整轮不崩（报错文本要跟 Python 的 OSError 一字不差）。 */
function scenarioDangling(): void {
  const ctx = scenario("dangling");
  seedBoth(ctx, { "good.jsonl": JSON.stringify({ role: "user", content: "正常" }) + "\n" });
  both(ctx, (t) => fs.symlinkSync(path.join(t.root, "nope", "gone.jsonl"), path.join(t.sessions, "gone.jsonl")));
  step(ctx, "断链 jsonl(跳过但继续)");
}

/** 真实语料：内容是真的（多分行/多行文本/CJK），控制流与产物字节都要一致。 */
function scenarioReal(): void {
  const limit = Number(process.env.REAL_FILES ?? 25);
  const groups = realSessionDirs();
  if (!groups.length) {
    diffs.push("真实语料: 一个 workspace 都没找到（ZGMEM_DIR 下没有 manifest.json？）");
    return;
  }
  for (const { ws, dir } of groups) {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    const take = limit > 0 ? names.slice(0, limit) : names;
    if (!take.length) continue;
    const ctx = scenario(`real-${ws.replace(/[^A-Za-z0-9._-]/g, "_")}`);
    let bytes = 0;
    for (const n of take) {
      const buf = fs.readFileSync(path.join(dir, n));
      bytes += buf.length;
      for (const t of [ctx.py, ctx.ts]) fs.writeFileSync(path.join(t.sessions, n), buf);
    }
    process.stderr.write(`[真实 ${ws}] ${take.length} 个 session / ${(bytes / 1e6).toFixed(1)}MB\n`);
    step(ctx, "真实语料/首次(全量构建)");
    step(ctx, "真实语料/无变化(早退)");
    const victim = take[0];
    both(ctx, (t) => fs.rmSync(path.join(t.sessions, victim)));
    step(ctx, "真实语料/删一个 session(prune)");
  }
}

/** 从既有语料的 manifest 反推真实 session 目录（每 workspace 一个）。 */
function realSessionDirs(): { ws: string; dir: string }[] {
  const out: { ws: string; dir: string }[] = [];
  if (!fs.existsSync(ZGMEM_DIR)) return out;
  for (const ws of fs.readdirSync(ZGMEM_DIR).sort()) {
    const mp = path.join(ZGMEM_DIR, ws, "manifest.json");
    if (!fs.existsSync(mp)) continue;
    let man: { sessions?: Record<string, { jsonl_path?: string }> };
    try {
      man = JSON.parse(fs.readFileSync(mp, "utf8"));
    } catch {
      continue;
    }
    const dirs = new Set<string>();
    for (const v of Object.values(man.sessions ?? {})) {
      const p = v?.jsonl_path;
      if (typeof p === "string" && fs.existsSync(p)) dirs.add(path.dirname(p));
    }
    for (const dir of dirs) out.push({ ws, dir });
  }
  return out;
}

function main(): void {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-refresh-diff-"));
  BIN = path.join(ROOT, "bin");
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, "zg"), FAKE_ZG);
  fs.chmodSync(path.join(BIN, "zg"), 0o755);
  try {
    scenarioLifecycle();
    scenarioStaleTmp();
    scenarioZgModes();
    scenarioEtlFail();
    scenarioDangling();
    if (process.env.SKIP_REAL !== "1") scenarioReal();
  } finally {
    if (process.env.DIFF_KEEP === "1") {
      process.stderr.write(`  (DIFF_KEEP=1，临时目录保留在 ${ROOT})\n`);
    } else {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }

  console.log(`refresh 差分对拍：比对项 ${checks}，差异 ${diffs.length}`);
  if (diffs.length) {
    console.log("\n差异明细:");
    for (const d of diffs.slice(0, 25)) console.log("  - " + d);
    process.exitCode = 1;
  } else {
    console.log("  ✓ Python 与 TS 的 stdout/退出码/分片/manifest/状态戳逐字节一致");
  }
}

main();
