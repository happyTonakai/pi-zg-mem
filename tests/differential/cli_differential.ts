/**
 * CLI 边界的差分对拍（模块 E：lib/cli.ts ← zgmem.py 入口）。
 *
 * 为什么要有这一层：Python 侧 25 个用例只覆盖库函数，**覆盖不到** argparse 那一层
 * （子命令表、选项校验、usage/--help 文本、退出码、workspace 'all' 的拒绝路径）。
 * 而 cli.ts 是用户直接看的一层，所以这里把两个入口摆在同一张桌子上：
 *
 *   python3 extensions/zg-memory/zgmem.py <argv>   vs   node lib/cli.ts <argv>
 *
 * 比 **stdout 字节 + stderr 字节 + 退出码**（`-h`/usage 的换行与缩进也在内）。
 *
 * ## 环境口径
 * 两侧必须在同一份输入上跑：语料/manifest 各一份（refresh 会写，必须隔离），
 * 会话目录**共用**（只读，且报错文本里会出现它的绝对路径 → 不共用就会有假差异）。
 * 假 zg 挂 PATH（真 zg 要模型与索引，对拍不该依赖它）。COLUMNS/LINES 一律清掉，
 * 让两边都退回 argparse 的 80-2=78 列。
 *
 * ## 场景范围（有意不覆盖的部分）
 * query 的 zg 路径（hybrid/fts 的 argv 与命中解析）在 query_differential.ts 已逐字节对拍，
 * 这里只跑 `--mode rg`（纯 JS 路径）与"zg 不在 PATH"的报错路径 —— 避免同一件事验两遍。
 *
 * 用法: node --experimental-strip-types tests/differential/cli_differential.ts [--list]
 *      SKIP_REAL=1 跳过真实 ~/.pi/agent/zgmem 语料上的场景
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as etl from "../../extensions/zg-memory/lib/etl.ts";
import * as zc from "../../extensions/zg-memory/lib/corpus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const EXT = path.join(REPO, "extensions", "zg-memory");
const PY = path.join(EXT, "zgmem.py");
const TS = path.join(EXT, "lib", "cli.ts");
const SKIP_REAL = process.env["SKIP_REAL"] === "1";

let checks = 0;
const diffs: string[] = [];

function check(label: string, kind: string, a: string, b: string): void {
  checks += 1;
  if (a === b) return;
  const n = Math.max(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  diffs.push(
    `${label} [${kind}]: 不一致 (${a.length}B vs ${b.length}B, 首差 @${i})\n` +
      `    py: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}\n` +
      `    ts: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`,
  );
}

// ---------- 造语料 ----------

const TS0 = 1_700_000_000_000;
const MARKER = "图书直播选题 的唯一标记行";
const LONG = Array.from({ length: 900 }, (_, k) => (k % 10 === 9 ? "\n" : k % 2 === 0 ? "x" : "あ")).join("");

function msgLine(role: string, text: string, ts: number): string {
  return JSON.stringify({ type: "message", message: { role, timestamp: ts, content: [{ type: "text", text }] } });
}

/** sessA 100 条（标记@80、长文本@95）+ sessB 50 条（标记@30），写成 Python 侧同格式的 jsonl。 */
function writeSessions(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const a: string[] = [];
  for (let i = 1; i <= 100; i++) {
    if (i === 42) {
      a.push(JSON.stringify({ type: "message", message: { role: "tool", timestamp: TS0 + i, content: [{ type: "text", text: "工具输出占位" }] } }));
    }
    const text = i === 80 ? MARKER : i === 95 ? LONG : `sessA 第 ${i} 条 普通内容 filler`;
    a.push(msgLine(i % 2 === 1 ? "user" : "assistant", text, TS0 + i * 1000));
  }
  fs.writeFileSync(path.join(dir, "sessA.jsonl"), `${a.join("\n")}\n`);
  const b: string[] = [];
  for (let i = 1; i <= 50; i++) {
    b.push(msgLine(i % 2 === 1 ? "user" : "assistant", i === 30 ? MARKER : `sessB 第 ${i} 条 filler`, TS0 - 100_000_000 + i * 1000));
  }
  fs.writeFileSync(path.join(dir, "sessB.jsonl"), `${b.join("\n")}\n`);
}

/** 一个已初始化的 workspace：home/<ws>/{manifest.json,corpus/}，来源是 sessions 目录。 */
function makeWs(home: string, ws: string, globIn: string): void {
  const corpus = path.join(home, ws, "corpus");
  fs.mkdirSync(corpus, { recursive: true });
  const mpath = path.join(home, ws, "manifest.json");
  const man = zc.emptyManifest();
  for (const f of fs.readdirSync(globIn).sort()) {
    if (f.endsWith(".jsonl")) etl.processSession(path.join(globIn, f), corpus, man);
  }
  zc.saveManifest(mpath, man);
}

interface Template {
  root: string;
  /** 模板 home（每个场景拷一份，互不干扰） */
  home: string;
  /** 会话目录：两侧**共用**（只读；报错文本里会出现它的绝对路径） */
  sessions: string;
  /** 假 zg 所在的 bin 目录；AGENT_PATH 是不带假 zg 的 PATH */
  bin: string;
  realPath: string;
  /** 源 workspace（可读写的原样拷贝） */
  marker: { session: string; corpusLine: number };
}

function buildTemplate(): Template {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-cli-"));
  const sessions = path.join(root, "sessions");
  writeSessions(sessions);
  const sessionsB = path.join(root, "sessions-b");
  fs.mkdirSync(sessionsB, { recursive: true });
  fs.copyFileSync(path.join(sessions, "sessA.jsonl"), path.join(sessionsB, "sessA.jsonl"));

  const home = path.join(root, "home");
  makeWs(home, "ws-a", sessions);
  makeWs(home, "ws-b", sessionsB);

  // 标记行所在的 corpus_line：从 manifest 定位（不写死，改语料也不会假红）
  const man = zc.loadManifest(path.join(home, "ws-a", "manifest.json"));
  const marker = { session: "sessA", corpusLine: 1 };

  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const zg = path.join(bin, "zg");
  fs.writeFileSync(zg, '#!/bin/sh\necho "indexed 2 files"\nexit 0\n');
  fs.chmodSync(zg, 0o755);

  return { root, home, sessions, bin, realPath: process.env["PATH"] as string, marker };
}

function dirOf(t: Template, name: string, side: string): string {
  const dir = path.join(t.root, "case", `${name.replace(/[^\w.-]+/g, "_")}.${side}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(t.home, path.join(dir, "home"), { recursive: true });
  return dir;
}

function envFor(
  t: Template,
  dir: string,
  opts: { withZg?: boolean; scope?: string | null; extra?: Record<string, string> } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["COLUMNS"];
  delete env["LINES"];
  env["ZGMEM_DIR"] = path.join(dir, "home");
  env["PI_SESSION_FILE"] = path.join(t.sessions, "sessA.jsonl");
  env["ZGMEM_EMBEDDING"] = "local/potion-multilingual-128m";
  env["ZGMEM_HIT_REFINE"] = "1";
  if (opts.scope !== null) env["ZGMEM_SCOPE"] = opts.scope ?? "ws-a";
  else delete env["ZGMEM_SCOPE"];
  const bins = opts.withZg === false ? [] : [t.bin];
  env["PATH"] = [...bins, t.realPath].join(path.delimiter);
  Object.assign(env, opts.extra ?? {});
  return env;
}

// ---------- 跑两侧 ----------

interface Case {
  name: string;
  argv: string[];
  /** 用 ZGMEM_SCOPE 指定 workspace（null = 不设，走 derive） */
  scope?: string | null;
  /** false = PATH 里不带假 zg */
  withZg?: boolean;
  /** 真实语料场景（SKIP_REAL=1 时跳过） */
  real?: boolean;
  /**
   * 两侧共用同一个家目录（默认false：py/ts 各一份拷贝）。
   * 只有“互操作”场景才该这么做 —— 见 docs/plan-ts-migration.md“写对拍器时踩的坑”：
   * manifest 与锁都在 corpus 上一级，共用父目录会让 TS 去等 Python 留下的锁。
   */
  shareTree?: boolean;
  /** 额外的环境变量（如 ZGMEM_LOCK_LEASE_MS） */
  extraEnv?: Record<string, string>;
  /**
   * 单文件内 rg 的命中序是相关性序（可复现），但**跳文件**的先后是 ripgrep 多线程的
   * 调度产物（同一份输入两次跑都可能不同）—— 这类场景只比内容集合，不比顺序。
   * 跟 query_differential.ts 的 unorderedScenarios 同一口径。
   */
  unordered?: boolean;
}

function runPy(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync("python3", [PY, ...argv], { encoding: "utf8", env, cwd, timeout: 120_000 });
}

function runTs(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", TS, ...argv], { encoding: "utf8", env, cwd, timeout: 120_000 });
}

const LOCK_STALL_MS = 3000;
const latencyNotes: string[] = [];

function applyCase(t: Template, c: Case): void {
  if (c.real) {
    // 真实语料：home 不动、scope 由场景给，只比 stdout/stderr/退出码
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["COLUMNS"];
    delete env["LINES"];
    delete env["PI_SESSION_FILE"];
    if (c.scope !== null) env["ZGMEM_SCOPE"] = c.scope ?? undefined;
    const py = runPy(c.argv, env, REPO);
    const ts = runTs(c.argv, env, REPO);
    check(c.name, "rc", String(py.status), String(ts.status));
    check(c.name, "stdout", py.stdout ?? "", ts.stdout ?? "");
    check(c.name, "stderr", py.stderr ?? "", ts.stderr ?? "");
    return;
  }

  const pyDir = dirOf(t, c.name, "py");
  // 默认两侧各一份拷贝；interop 场景故意共用（用来看“Python 留下的空锁”怎么处理）
  const tsDir = c.shareTree ? pyDir : dirOf(t, c.name, "ts");
  const time = <T,>(fn: () => T): [T, number] => {
    const t0 = Date.now();
    const res = fn();
    return [res, Date.now() - t0];
  };
  const [py, pyMs] = time(() => runPy(c.argv, envFor(t, pyDir, { withZg: c.withZg, scope: c.scope, extra: c.extraEnv }), REPO));
  const [ts, tsMs] = time(() => runTs(c.argv, envFor(t, tsDir, { withZg: c.withZg, scope: c.scope, extra: c.extraEnv }), REPO));

  const note = (r: typeof py): string => (r.error ? `err=${r.error.message}` : r.signal ? `signal=${r.signal}` : "");
  const rcLabel = note(py) || note(ts) ? `${c.name} (${note(py)}|${note(ts)})` : c.name;
  check(rcLabel, "rc", String(py.status), String(ts.status));
  const norm = (s: string): string =>
    c.unordered
      ? // 序无关：把排名标记 `--- [N]` 抹平后按行排序。rg 跨文件的先后是多线程调度产物，
        // 但“命中了哪些行 / 预览文本”仍逐字节比（少一条、预览变了都会红）。
        s
          .split("\n")
          .map((l) => l.replace(/^--- \[\d+\]/, "--- [#]"))
          .sort()
          .join("\n")
      : s;
  // 两侧的家目录不同（故意的），但有些输出会把它的绝对路径打出来（如“已初始化”提示、
  // zg 缺失时的 corpus 路径）—— 比较前各自抹平，否则全是假差异。
  const depath = (s: string, dir: string): string => s.split(dir).join("<TREE>");
  check(
    c.name,
    c.unordered ? "stdout(序无关:rank抹平)" : "stdout",
    norm(depath(py.stdout ?? "", pyDir)),
    norm(depath(ts.stdout ?? "", tsDir)),
  );
  check(c.name, "stderr", depath(py.stderr ?? "", pyDir), depath(ts.stderr ?? "", tsDir));

  if (tsMs > LOCK_STALL_MS) latencyNotes.push(`${c.name}: ts 耗时 ${tsMs}ms(可能卡在锁租约上)`);
  if (c.shareTree) {
    // 互操作：Python 跑完会留下一个空锁文件（flock 残留）；TS 必须能最终拿到锁并产出同字节
    latencyNotes.push(
      `${c.name}: py ${pyMs}ms / ts ${tsMs}ms（Python 留下的空锁 → TS 等租约）`,
    );
    check(`${c.name} [ts 未被锁卡死]`, "耗时上限", String(tsMs < 30_000), "true");
  }
}

// ---------- 场景表 ----------

const M = "sessA"; // 标记所在 session
const L = 1; // 语料必存在的行号（首行）

const CASES: Case[] = [
  // --- usage / --help（含换行与缩进的字节一致性）---
  { name: "help/top -h", argv: ["-h"] },
  { name: "help/top --help", argv: ["--help"] },
  // 顶层也是走 argparse 的（`cmd` 是 nargs='PARSER'）：allow_abbrev 的前缀缩写、短选项拼 explicit arg
  { name: "help/top --hel (缩写)", argv: ["--hel"] },
  { name: "help/top --he (缩写)", argv: ["--he"] },
  { name: "help/top -hx (短选项拼接)", argv: ["-hx"] },
  { name: "help/top --help query (help 当场退出)", argv: ["--help", "query"] },
  { name: "help/query -h", argv: ["query", "-h"] },
  { name: "help/query --help", argv: ["query", "--help"] },
  { name: "help/refresh -h", argv: ["refresh", "-h"] },
  { name: "help/show -h", argv: ["show", "-h"] },
  { name: "help/ctx -h", argv: ["ctx", "-h"] },
  { name: "help/sessions -h", argv: ["sessions", "-h"] },
  // --- 顶层报错（argparse 把没消费的参数交给父解析器 → 顶层 usage）---
  { name: "err/no-args", argv: [] },
  { name: "err/bad-cmd", argv: ["badcmd"] },
  // `cmd` 的 choices 报错（不是 unrecognized）：`-` 是位置参数、`--top3` 是认不出的选项
  { name: "err/top-dash-cmd", argv: ["-"] },
  { name: "err/top-unknown-only", argv: ["--bogus"] },
  { name: "err/top-unknown-long", argv: ["--version"] },
  { name: "err/top-unknown-top3", argv: ["--top3"] },
  // 认不出的顶层选项 + 合法子命令：**子命令**的 required 报错先出（子 usage）
  { name: "err/top-unknown-then-cmd", argv: ["--bogus", "query"] },
  { name: "err/top-unknown-eq-then-cmd", argv: ["--session=5", "query"] },
  // 子解析器没报错时，顶层才报 extras（**顶层** usage）
  { name: "err/top-unknown-with-cmd-argv", argv: ["--bogus", "query", "x"] },
  { name: "err/top-dashdash-cmd-extras", argv: ["--", "query", "x", "-z"] },
  // `--hel=x`：help action 不吃 explicit arg → ignored explicit argument（顶层）
  { name: "err/top-help-eq", argv: ["--hel=x"] },
  { name: "err/unknown-opt", argv: ["query", "x", "--bogus"] },
  { name: "err/extra-positional", argv: ["query", "x", "extra"] },
  { name: "err/refresh-unknown-opt", argv: ["refresh", "--bogus"] },
  // --- 子命令报错（子命令 usage + `zgmem <cmd>: error:`）---
  { name: "err/query-missing", argv: ["query"] },
  { name: "err/query-int", argv: ["query", "x", "--top", "abc"] },
  { name: "err/query-who", argv: ["query", "x", "--who", "bogus"] },
  { name: "err/query-mode", argv: ["query", "x", "--mode", "bogus"] },
  { name: "err/query-opt-no-value", argv: ["query", "x", "--top"] },
  { name: "err/query-eq", argv: ["query", "x", "--top=abc"] },
  { name: "err/show-missing", argv: ["show"] },
  { name: "err/show-missing-2", argv: ["show", "s"] },
  { name: "err/show-int", argv: ["show", "s", "abc"] },
  { name: "err/ctx-int", argv: ["ctx", "s", "abc"] },
  // --- argparse 选项解析的细节（parseCmd 是手工仿真，以下是它的已知边界）---
  // 选项值以 '-' 开头：argparse 不把它当值 → expected one argument。
  // 「像选项」的判定是 `_parse_optional()`：以 '-' 开头且**不是**负数字面量
  // （CPython 的 `_negative_number_matcher = re.compile(r'-\.?\d')`；本实现对应
  //  `lib/cli.ts` 的 `NEGATIVE_NUMBER_RE = /^-\.?\p{Nd}/u`，比它多认 unicode 数字）
  // 且不是单个 '-'（单个 '-' 是位置参数）→ 算 'O'(option)，于是 --session 拿到 0 个参数。
  { name: "arg/opt-val-dash", argv: ["query", "x", "--session", "-x"] },
  { name: "arg/opt-val-opt", argv: ["query", "x", "--top", "--who", "user"] },
  { name: "arg/opt-val-neg-underscore", argv: ["query", "x", "--top", "-1_0"] },
  { name: "arg/opt-val-unknown-short", argv: ["query", "x", "--session", "-z"] },
  // 单个 '-' 不是选项 → 可以作为选项的值
  { name: "arg/opt-val-single-dash", argv: ["query", "x", "--session", "-"] },
  // `--` 分隔符：顶层被 argparse 吃掉一个，剩下的原样交给子解析器
  { name: "arg/top-dashdash-only", argv: ["--"] },
  { name: "arg/top-dashdash-cmd", argv: ["--", "query"] },
  { name: "arg/top-dashdash-cmd-argv", argv: ["--", "query", "x"] },
  { name: "arg/top-cmd-dashdash", argv: ["query", "--", "x"] },
  { name: "arg/top-cmd-dashdash-opt", argv: ["query", "--", "--top", "3", "x"] },
  // PARSER 的 '--' 只在**本段首位**才剥：`-- query -- x` 剥（子命令收到 ['--','x']），
  // 而 `query -- --top 3 x` 不剥（'--' 在段中，子命令收到 ['--','--top','3','x']）
  { name: "arg/top-dashdash-cmd-dashdash", argv: ["--", "query", "--", "x"] },
  { name: "arg/top-cmd-dashdash-unknown", argv: ["query", "--", "--bogus"] },
  { name: "arg/top-cmd-dashdash-extra", argv: ["query", "--", "x", "y"] },
  { name: "err/top-cmd-dashdash-opt-mixed", argv: ["query", "--", "--top", "3", "x", "--who", "user"] },
  { name: "err/top-dashdash-cmd-dashdash-opt", argv: ["--", "query", "--", "--top", "3", "x"] },
  // `--opt=value` 里的值**不**重新分类：'-x' 原样收
  { name: "arg/inline-dash-value", argv: ["query", "x", "--session=-x"] },
  { name: "arg/inline-empty-value", argv: ["query", "x", "--top="] },
  // 负数字面量是合法位置参数 → 交给 type=int
  { name: "arg/neg-corpus-line", argv: ["show", "s", "-1"] },
  { name: "arg/neg-underscore-positional", argv: ["show", "s", "-1_0"] },
  { name: "arg/neg-span", argv: ["ctx", "s", "1", "--span", "-2"] },
  { name: "arg/neg-float-span", argv: ["ctx", "s", "1", "--span", "-1.5"] },
  // 短选项拼接：-h 带 explicit arg 'x'
  { name: "arg/concat-hx", argv: ["query", "-hx"] },
  { name: "arg/concat-xh", argv: ["query", "-xh"] },
  // `type=int` 走 Python 的 int()：下划线分隔、正号、前后空白都收
  { name: "arg/int-underscore", argv: ["query", "x", "--top", "1_0"] },
  { name: "arg/int-plus", argv: ["query", "x", "--top", "+5"] },
  // 非 ASCII 数字：CPython 的 int() 按 Nd 属性收（`５` 全角、`٣` 阿拉伯-印度、`𝟎` 数学粗体）
  { name: "arg/int-fullwidth", argv: ["query", "x", "--top", "\uff15"] },
  { name: "arg/int-arabic", argv: ["query", "x", "--top", "\u0663"] },
  { name: "arg/int-arabic-pair", argv: ["query", "x", "--top", "\u0663\u0664"] },
  { name: "arg/int-math-bold", argv: ["query", "x", "--top", "\U0001D7CE\U0001D7CF"] },
  { name: "arg/int-arabic-underscore", argv: ["query", "x", "--top", "\u0663_\u0664"] },
  { name: "arg/int-fullwidth-underscore", argv: ["query", "x", "--top", "\uff11_\uff10"] },
  { name: "arg/int-arabic-neg", argv: ["query", "x", "--top", "-\u0663"] },
  { name: "arg/int-mixed-digits", argv: ["query", "x", "--top", "1\u0662\u0663"] },
  { name: "arg/int-arabic-positional", argv: ["ctx", "sessA", "\u0663"] },
  { name: "arg/int-arabic-span", argv: ["ctx", "sessA", "1", "--span", "\u0663"] },
  // 拒绝侧：非 Nd 的“像数字”字符，以及 Nd 段边界外的码点
  { name: "arg/int-non-nd-sup", argv: ["query", "x", "--top", "\u00b2"] },
  { name: "arg/int-non-nd-circ", argv: ["query", "x", "--top", "\u2460"] },
  { name: "arg/int-non-nd-ideo", argv: ["query", "x", "--top", "\u3007"] },
  // 边界上的“假 Nd”：U+116CF、U+116D9、U+116DA 在 Python 16 与 Node 17 里都是同一状态
  // （4803 个“16 里 Cn、17 里已分配”的码点才是不可对拍的，如 U+088F，见 docs/plan-ts-migration.md）。
  { name: "arg/int-adjacent-run-tail", argv: ["query", "x", "--top", "\ud805\uded9"] },
  { name: "arg/int-run-first", argv: ["query", "x", "--top", "\ud805\udeda"] },
  { name: "arg/int-trailing-underscore", argv: ["query", "x", "--top", "\u0663_"] },
  { name: "arg/int-leading-underscore", argv: ["query", "x", "--top", "_\u0663"] },
  { name: "arg/int-double-underscore", argv: ["query", "x", "--top", "\u0663__\u0664"] },
  { name: "arg/int-unicode-space", argv: ["query", "x", "--top", "\u3000\u0663\u3000"] },
  // int() 自己的空白表不含 \x1c-\x1f（而 str.strip() 含）——这条专门钉住两套表不能混用
  { name: "arg/int-file-separator", argv: ["query", "x", "--top", "\u001c5"] },
  // 错误信息里的 %(value)r：不可打印字符必须按 repr() 转义（NBSP/DEL/LS 在 16/17 两边都是不可打印）
  { name: "arg/int-nbsp", argv: ["query", "x", "--top", "\u00a0x"] },
  { name: "arg/int-del", argv: ["query", "x", "--top", "\u007fx"] },
  { name: "arg/int-line-sep", argv: ["query", "x", "--top", "\u2028x"] },
  // 长选项唯一前缀缩写 / 歧义
  // 注：query 用 "sessA 第"（与 run/query-secs 同一颗子弹）而不是 "x"：
  //  1) "x" 会命中**每一行**（JSONL 里就带 `"type":"text"`），一旦命中跨 sessA/sessB 两个 target，
  //     rg 的先后就是多线程调度产物，而 `--top N` 会在那条乱序流上截断 → 连命中的**集合**都变（不只是乱序，
  //     rank 抹平治不了）；
  //  2) `--session sessA` **治不了这个问题**：rg 的 `--glob` 对显式列出的文件路径不过滤
  //     （正是 rgCandidates.session_glob_is_a_noop_parity_with_upstream_bug 钉住的上游 bug）；
  //  3) "sessA 第" 只出现在 sessA.jsonl 里 → 单文件命中，rg 按行号输出，top 截断也确定。
  { name: "arg/prefix-unique", argv: ["query", "sessA 第", "--mod", "rg"] },
  { name: "arg/prefix-ambiguous", argv: ["query", "x", "--w", "user"] },
  { name: "arg/prefix-ambiguous-2", argv: ["sessions", "--w", "all"] },
  // 重复选项：后者覆盖前者（--top 7 必须赢：只有 7 行 = 后者生效，5 行就是前者赢了。
  // query 选 "sessA 第" 的理由同 arg/prefix-unique：命中数要 >7 才看得出 top，又不能跨文件乱序）
  { name: "arg/repeat-opt", argv: ["query", "sessA 第", "--top", "5", "--top", "7", "--mode", "rg"] },
  // 未知短选项
  { name: "arg/unknown-short", argv: ["query", "x", "-z"] },
  // --- workspace 维度 ---
  { name: "ws/unknown-sessions", argv: ["sessions", "--workspace", "nope"] },
  { name: "ws/unknown-show", argv: ["show", "s", "1", "--workspace", "nope"] },
  { name: "ws/all-show", argv: ["show", "s", "1", "--workspace", "all"] },
  { name: "ws/all-ctx", argv: ["ctx", "s", "1", "--workspace", "all"] },
  { name: "ws/dash-bad", argv: ["sessions", "--workspace", "../evil"] },
  // 两层职责之一：**显式** --workspace 在 `main()` 里**分发前**就校验（use_workspace），
  // 非法名 / 未初始化 → 未捕获的 SystemExit → **stderr + rc1**。
  // 少了这一步，query 会退化成「cmd_query 内层 try 捕获 → stdout + rc0」。
  { name: "ws/unknown-query", argv: ["query", "图书直播选题", "--mode", "rg", "--workspace", "nope"] },
  { name: "ws/unknown-refresh", argv: ["refresh", "--workspace", "nope"] },
  { name: "ws/dash-bad-query", argv: ["query", "x", "--mode", "rg", "--workspace", "../evil"] },
  // 两层职责之二：**缺省** scope（env ZGMEM_SCOPE）未初始化时 `main()` 不校验，
  // cmd_* 用的是 import 期那份**宽容**的全局（空 manifest）→ stdout + rc0。
  // ws-uninit 不在模板 home 里（只有 ws-a / ws-b）。
  { name: "ws/uninit-default-query", argv: ["query", "图书直播选题", "--mode", "rg"], scope: "ws-uninit" },
  { name: "ws/uninit-default-show", argv: ["show", "sessA", "1"], scope: "ws-uninit" },
  { name: "ws/uninit-default-ctx", argv: ["ctx", "sessA", "1"], scope: "ws-uninit" },
  { name: "ws/uninit-default-sessions", argv: ["sessions"], scope: "ws-uninit" },
  // refresh 曾经**漏在**这条规律之外（cli.ts 的 refresh 分支对缺省 scope 也走了严格 loadScope）：
  // 上面四条都盖着，只有 refresh 没有未初始化的对照用例，而模板 home 里 ws-a 是已初始化的
  // —— 严格/宽容在这一格看不出差别，于是这个 bug 一直绿。三条就是它的常驻守卫。
  { name: "ws/uninit-default-refresh", argv: ["refresh"], scope: "ws-uninit" },
  { name: "ws/uninit-default-refresh-all", argv: ["refresh", "--workspace", "all"], scope: "ws-uninit" },
  { name: "ws/uninit-default-refresh-empty-name", argv: ["refresh", "--workspace", ""], scope: "ws-uninit" },
  // `--workspace all` 跳过前置校验：refresh 忽略 args.workspace → 刷的是**缺省** scope；
  // 而 `--workspace <名>` 因为 main() 改的是全局，刷的就是那个 ws（见 run/refresh-ws-b）。
  { name: "ws/refresh-all", argv: ["refresh", "--workspace", "all"] },
  // 空串在 Python 里是**假值**：`if ws and ws != "all"` 不成立 → 回落缺省 scope（不是报非法名）
  { name: "ws/empty-name-sessions", argv: ["sessions", "--workspace", ""] },
  { name: "ws/empty-name-refresh", argv: ["refresh", "--workspace", ""] },
  // 派生路径：**不设** ZGMEM_SCOPE（真实用户就是这个状态）→ 名字从 PI_SESSION_FILE 的目录名
  // slug 出来；而模板里那个目录不属于任何已初始化 workspace → 又回到“缺省 scope 必须宽容”。
  // scope:null 是 envFor 里唯一会 delete ZGMEM_SCOPE 的取值（非 real 用例不会被改写成 realWs），
  // 两侧共用同一个 t.sessions（只有 home 各一份），所以派生名两边一致、可比。
  { name: "derive/refresh", argv: ["refresh"], scope: null },
  { name: "derive/refresh-all", argv: ["refresh", "--workspace", "all"], scope: null },
  { name: "derive/sessions", argv: ["sessions"], scope: null },
  { name: "derive/query-rg", argv: ["query", "sessA 第", "--mode", "rg", "--top", "2"], scope: null },
  // --- 真跑（产出体本身来自已验收的库）---
  { name: "run/sessions", argv: ["sessions"] },
  { name: "run/sessions-all", argv: ["sessions", "--workspace", "all"] },
  { name: "run/sessions-ws", argv: ["sessions", "--workspace", "ws-b"] },
  { name: "run/query-rg", argv: ["query", "图书直播选题", "--mode", "rg"], unordered: true },
  { name: "run/query-rg-json", argv: ["query", "图书直播选题", "--mode", "rg", "--json"], unordered: true },
  // 单文件多次命中：命中序可复现 → 仍逐字节比。
  // 注意：**跨文件**且带截断的 rg 场景不可能稳定 —— rg 跳文件的先后是多线程调度产物，
  // 而 pool / top 的截断发生在排序之前，所以连命中**集合**都会变（本用例曾经跨文件，
  // 用 "filler" 命中 ~145 行，3 次跑里 1 次红：py 取到 sessB 的前几条 / ts 取到 sessA 的）。
  // 要测「先取池再截断」就必须把命中收在**一个文件**里。
  { name: "run/query-rg-who", argv: ["query", "sessA 第", "--mode", "rg", "--who", "user", "--top", "2"] },
  { name: "run/query-rg-pool", argv: ["query", "sessA 第", "--mode", "rg", "--pool", "5", "--top", "2"] },
  // 跨文件的 rg：只比**内容集合**（命中少到不会截断，所以集合稳定，只有先后不稳）。
  // 已实测：“第 2 条”在全库只有 2 行命中（sessA/sessB 各 1，就是 i=2 那条；i=12/20/21… 因空格
  // 而不匹配），而 pool 缺省 0 → limit = max(0, top) = 5，2 < 5 → 截断不可能发生。
  // 换言之：本用例的“集合稳定”不是碰运气，是被这两行串钉住的；加语料/改查询词要重算这个数。
  { name: "run/query-rg-cross-file", argv: ["query", "第 2 条", "--mode", "rg", "--top", "5"], unordered: true },
  { name: "run/query-rg-session", argv: ["query", "sessA 第", "--mode", "rg", "--session", "sessA"] },
  {
    name: "run/query-rg-session-mismatch",
    argv: ["query", "图书直播选题", "--mode", "rg", "--session", "sessB"],
    unordered: true,
  },
  { name: "run/query-fts-no-zg", argv: ["query", "filler", "--mode", "fts"], withZg: false },
  { name: "run/query-secs", argv: ["query", "sessA 第", "--mode", "rg", "--since", "1"] },
  { name: "run/query-no-hit", argv: ["query", "不存在的词zzz", "--mode", "rg"] },
  { name: "run/show", argv: ["show", M, String(L)] },
  { name: "run/show-full", argv: ["show", M, String(L), "--full"] },
  { name: "run/show-bad-line", argv: ["show", M, "99999"] },
  { name: "run/show-unknown-session", argv: ["show", "nope", "1"] },
  { name: "run/ctx", argv: ["ctx", M, String(L)] },
  { name: "run/ctx-span1", argv: ["ctx", M, String(L), "--span", "1"] },
  { name: "run/refresh", argv: ["refresh", "--workspace", "ws-a"] },
  { name: "run/refresh-ws-b", argv: ["refresh", "--workspace", "ws-b"] },
  { name: "run/refresh-nosessions", argv: ["refresh", "--workspace", "ws-a", "--sessions-dir", "/nonexistent-dir-zzz"] },
  // 互操作：Python 先跑 refresh（flock 残留一个**空**锁文件），TS 必须在同一个家目录上接着跑完
  // 并且产出同样的字节。租约用 env 压到 3s（默认 10min），否则这条用例要等 10 分钟。
  {
    name: "interop/py-leftover-lock",
    argv: ["refresh", "--workspace", "ws-a"],
    shareTree: true,
    extraEnv: { ZGMEM_LOCK_LEASE_MS: "3000" },
  },
  // --- 真实语料（SKIP_REAL=1 跳过）---
  { name: "real/sessions", argv: ["sessions"], real: true, scope: null },
  { name: "real/show", argv: ["show", "nope", "1"], real: true, scope: null },
];

/** 序无关场景（比较口径见 Case.unordered）：数量与名称都列出来，不当成静默差异。 */
const UNORDERED = CASES.filter((c) => c.unordered).map((c) => c.name);

function main(): void {
  if (process.argv.includes("--list")) {
    for (const c of CASES) console.log(`${c.real ? "[real] " : ""}${c.name}\t${JSON.stringify(c.argv)}`);
    return;
  }
  const t = buildTemplate();
  const realWs = process.env["ZGMEM_SCOPE_REAL"];
  for (const c of CASES) {
    if (c.real && SKIP_REAL) continue;
    if (c.real && !realWs) continue; // 没指定真实 workspace 就跳过（避免猜错把真实索引搅了）
    applyCase(t, c.real ? { ...c, scope: realWs } : c);
  }
  fs.rmSync(t.root, { recursive: true, force: true });

  if (UNORDERED.length > 0) console.log(`序无关比较(rank抹平): ${UNORDERED.join(", ")}`);
  for (const n of latencyNotes) console.log(`[note] ${n}`);
  if (diffs.length === 0) {
    console.log(`CLI 差分对拍: ${checks} 项检查全部一致`);
    return;
  }
  console.log(`CLI 差分对拍: ${checks} 项检查，${diffs.length} 不一致\n`);
  for (const d of diffs) console.log(d);
  process.exitCode = 1;
}

main();
