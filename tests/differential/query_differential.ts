/**
 * 模块 C 的差分对拍（**仅迁移期使用**，需要 Python 当裁判；模块 G 随 Python 一起删）。
 *
 * 同一份合成语料 + 同一批"输入"，Python `zgmem.py` 与 TS `lib/query.ts` 各跑一遍，
 * 逐字节比对 **stdout**、**退出码**，以及**传给 zg / rg 的 argv**（这才是易错点：
 * `--limit` 用 top 还是 pool、`-g <sid>*`、`--modified-after`、`--fts` 与位置参数的
 * 换位、rg 的 `-H`/`-e`/`--glob`/targets 顺序）。
 *
 * 为什么要假 zg / 假 rg：真 zg 需要模型与索引（对拍不该依赖它），而 argv 只有假二进制能观察到。
 * 真 rg 另有一组"real"场景（PATH 不动），因为 rg 的**输出顺序**本身是相关性序。
 *
 * 覆盖的语义分支：
 *   - hybrid/fts 路径：命中块首行 → 精修到块内真正命中行（H2）、窗口 span、重复命中去重、
 *     未知分片名过滤、非 `#` 开头的回显行不误判、pure-vector 无词元覆盖时退回块首行
 *   - rg 路径：命中行在语料里（build_pair）与不在语料里（pair_from_jsonl 兜底 → RAW 分支）
 *   - 去重与名次：重复命中**照样占一个 order**（1/(order+1) 相关性不能被压缩）
 *   - who/since/pool/top/session 过滤、`hybrid` + `-` 开头 query 退化成 fts
 *   - workspace 扇出（--workspace all）与跨 workspace 去重、`--workspace all` 对 sessions
 *   - show / show --full / ctx(--span) / sessions（按 start_ts 降序）
 *   - 错误路径：非法 session id、unknown session、bad corpus line、未初始化 workspace
 *     （两条不同的路径：main 里 SystemExit→stderr+exit1，vs cmd_query 里被吞→stdout+exit0）
 *   - ZGMEM_HIT_REFINE=0 关闭精修
 *
 * 用法: node extensions/zg-memory/tests/... → node tests/differential/query_differential.ts
 * 退出码: 0 一致 / 1 有差异
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as etl from "../../extensions/zg-memory/lib/etl.ts";
import * as q from "../../extensions/zg-memory/lib/query.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const EXT = path.join(REPO, "extensions", "zg-memory");
const PY_ZGMEM = path.join(EXT, "zgmem.py");

let checks = 0;
const diffs: string[] = [];
/** 因 rg 自身顺序不稳定而降级为序无关比较的场景（会打印出来，不当成静默差异）。 */
const unorderedScenarios: string[] = [];

function check(label: string, a: string, b: string): void {
  checks += 1;
  if (a === b) return;
  const n = Math.max(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  diffs.push(
    `${label}: 不一致 (${a.length}B vs ${b.length}B, 首差 @${i})\n` +
      `    py: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}\n` +
      `    ts: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`,
  );
}

// ---------- 合成语料 ----------

const BASE_TS_A = 1_700_000_000_000;
const BASE_TS_B = 1_600_000_000_000;
const MARKER_A = "sessA 第 80 条 图书直播选题 的唯一标记行";
const MARKER_B = "sessB 第 30 条 图书直播选题 的另一处标记";
/** 长文本：ctx 的 200 截断 / show 的 800 截断 / 换行→空格 替换，三者一起被钉住。 */
const LONG_A = Array.from({ length: 900 }, (_, k) => (k % 10 === 9 ? "\n" : k % 2 === 0 ? "x" : "あ")).join("");
const LONG_LINE = 95;

function msgLine(role: string, text: string, ts: number): string {
  return JSON.stringify({ type: "message", message: { role, timestamp: ts, content: [{ type: "text", text }] } });
}

/** 非 user/assistant：不进语料，但占 jsonl 行号（corpus_line ≠ jsonl_line 的成因）。 */
function toolResultLine(ts: number): string {
  return JSON.stringify({
    type: "toolResult",
    message: { role: "tool", timestamp: ts, content: [{ type: "toolResult", text: "TOOLONLY_MARKER_unique 工具\n输出" }] },
  });
}

/** type=message 且 role=tool：ctx 的 `[ts toolResult] (工具输出)` 分支。 */
function toolMsgLine(ts: number): string {
  return JSON.stringify({
    type: "message",
    message: { role: "tool", timestamp: ts, content: [{ type: "text", text: "工具输出占位" }] },
  });
}

/**
 * sessA(100 条, 标记@corpus_line 80, 长文本@95) + sessB(50 条, 标记@30) 写进 dirA；
 * dirB 只放一份 sessA 拷贝 —— 用来造"同一 session 被两个 workspace 分别索引"的
 * **跨 workspace 真重复**（rg 路径里 jsonl 路径不同、session/jsonl_line 相同的去重键测试点）。
 */
function buildSessions(dirA: string, dirB: string): void {
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const a: string[] = [];
  for (let i = 1; i <= 100; i++) {
    if (i === 42) {
      a.push(toolResultLine(BASE_TS_A + i));
      a.push(toolMsgLine(BASE_TS_A + i));
    }
    const text = i === 80 ? MARKER_A : i === 31 ? "SHARED_MARKER_TEXT sessA" : i === LONG_LINE ? LONG_A : `sessA 第 ${i} 条 普通内容 filler`;
    a.push(msgLine(i % 2 === 1 ? "user" : "assistant", text, BASE_TS_A + i * 1000));
  }
  fs.writeFileSync(path.join(dirA, "sessA.jsonl"), `${a.join("\n")}\n`);
  fs.writeFileSync(path.join(dirB, "sessA.jsonl"), `${a.join("\n")}\n`);
  const b: string[] = [];
  const recent = Date.now() - 3600_000; // 1 小时前：让 rg 分支的 since 过滤**真**发生
  for (let i = 1; i <= 50; i++) {
    const text = i === 30 ? MARKER_B : i === 31 ? "SHARED_MARKER_TEXT sessB" : i === 40 ? "RECENT_ONLY_MARKER" : `sessB 第 ${i} 条 普通内容 filler`;
    b.push(msgLine(i % 2 === 1 ? "user" : "assistant", text, i === 40 ? recent : BASE_TS_B + i * 1000));
  }
  fs.writeFileSync(path.join(dirA, "sessB.jsonl"), `${b.join("\n")}\n`);
}

// ---------- 假 zg / 假 rg ----------

const FAKE_ZG = `#!/bin/sh
# 记录 argv（含 cwd）后再按 workspace(cwd) 吐命中行。
[ -z "$FAKE_ZG_LOG" ] && { echo "FAKE_ZG_LOG 没设" >&2; exit 9; }
for a in "$@"; do printf 'ARG %s\\n' "$a"; done >> "$FAKE_ZG_LOG"
printf 'CWD %s\\n' "$PWD" >> "$FAKE_ZG_LOG"
[ "$FAKE_ZG_FAIL" = "1" ] && { echo "zg: index.zvec is corrupt (fake)" >&2; exit 1; }
[ "$FAKE_ZG_EMPTY" = "1" ] && exit 0
case "$PWD" in
  *ws-alpha*)
    cat <<'EOF'
#1 matchedBy=fts+vector 2026-09-23 10:00 sessA.p0001.txt:64
#2 matchedBy=fts+vector 2026-09-23 10:00 sessA.p0001.txt:64
#3 matchedBy=vector 2026-09-23 10:00 ghost.p0001.txt:5
#4 matchedBy=fts 2026-09-23 10:00 sessA.p0001.txt:80-94
#5 matchedBy=fts+vector 2026-09-23 10:00 sessA.p0001.txt:20
#6 matchedBy=fts+vector 2026-09-23 10:00 sessA.p0001.txt:30
  echo 回显行 sessA.p0001.txt:3
EOF
    ;;
  *ws-beta*)
    cat <<'EOF'
#1 matchedBy=vector 2026-09-23 10:00 sessB.p0001.txt:24
EOF
    ;;
esac
exit 0
`;

const FAKE_RG = `#!/bin/sh
[ -z "$FAKE_RG_LOG" ] && { echo "FAKE_RG_LOG 没设" >&2; exit 9; }
for a in "$@"; do printf 'ARG %s\\n' "$a"; done >> "$FAKE_RG_LOG"
printf 'CWD %s\\n' "$PWD" >> "$FAKE_RG_LOG"
case "$FAKE_RG_NAME" in
  tool) printf '%s:42:%s\\n' "$1" 'TOOLONLY_MARKER_unique 工具输出' ;;
  *) exit 1 ;;   # 无命中：rg 以 1 退出
esac
exit 0
`;

// ---------- 两个 runner ----------

interface TsCall {
  kind: "query" | "show" | "ctx" | "sessions";
  opts?: q.QueryOpts;
  sessionId?: string;
  corpusLine?: number;
  full?: boolean;
  span?: number;
  ws?: string | null;
}

interface Scenario {
  name: string;
  call: TsCall;
  env?: Record<string, string>;
  /** 期望两边都失败（Python SystemExit / TS ScopeExit）。 */
  expectFail?: boolean;
  /** 有 fake 二进制参与时才比 argv。 */
  argvLog?: "zg" | "rg";
  /**
   * 用**真** rg：PATH 不能带 bin/（那里放着假 rg，否则整个场景退化成空输出，
   * 看看着比上了、实际上什么也没测——“rg 去掉 -H / cutoff 单位错 / 兑底被删”
   * 三个变异就是这样活下来的）。
   */
  realRg?: boolean;
}

function pyArgv(call: TsCall): string[] {
  const a: string[] = [call.kind];
  if (call.kind === "query") {
    const o = call.opts ?? { query: "" };
    const flags: string[] = [];
    if (o.top !== undefined) flags.push("--top", String(o.top));
    if (o.who) flags.push("--who", o.who);
    if (o.since) flags.push("--since", String(o.since));
    if (o.pool) flags.push("--pool", String(o.pool));
    if (o.session) flags.push("--session", o.session);
    if (o.workspace) flags.push("--workspace", o.workspace);
    if (o.json) flags.push("--json");
    if (o.mode && o.mode !== "auto") flags.push("--mode", o.mode);
    // `-` 开头的查询会被 argparse 当成选项（Python 侧实测 exit 2），必须用 `--` 终止选项解析
    if (o.query.startsWith("-")) a.push(...flags, "--", o.query);
    else a.push(o.query, ...flags);
  } else if (call.kind === "show") {
    a.push(call.sessionId as string, String(call.corpusLine));
    if (call.full) a.push("--full");
    if (call.ws) a.push("--workspace", call.ws);
  } else if (call.kind === "ctx") {
    a.push(call.sessionId as string, String(call.corpusLine));
    if (call.span !== undefined) a.push("--span", String(call.span));
    if (call.ws) a.push("--workspace", call.ws);
  } else if (call.ws) {
    a.push("--workspace", call.ws);
  }
  return a;
}

/**
 * 镜像 Python `main()` 的前置校验（属于模块 E 的职责，对拍里先替上，否则 --workspace 的
 * 两条失败路径 —— main 里 SystemExit→stderr+exit1 vs cmd 里被吞→stdout+exit0 —— 无从区分）:
 *     ws = a.workspace
 *     if ws == "all" and cmd in ("show","ctx"): print(...需具体 workspace); return
 *     if ws and ws != "all": use_workspace(ws)   # 名字非法/未初始化 → SystemExit
 */
function mainPrologue(call: TsCall, env: q.QueryEnv): q.RunResult | null {
  const ws = call.kind === "query" ? call.opts?.workspace : call.ws;
  if (ws === "all" && (call.kind === "show" || call.kind === "ctx")) {
    return { out: `${call.kind} 需要具体 workspace, 不能用 all\n`, code: 0 };
  }
  if (ws && ws !== "all") q.loadScope(ws, env.home, env.hitRefine); // 可能抛 ScopeExit
  return null;
}

/** 跑 TS 侧（进程内调用 lib/query.ts，避免提前实现模块 E 的 argv 解析）。 */
function runTs(call: TsCall, env: q.QueryEnv): q.RunResult {
  const early = mainPrologue(call, env);
  if (early) return early;
  switch (call.kind) {
    case "query":
      return q.runQuery(call.opts ?? { query: "" }, env);
    case "show":
      return q.runShow(call.sessionId as string, call.corpusLine as number, Boolean(call.full), call.ws ?? null, env);
    case "ctx":
      return q.runCtx(call.sessionId as string, call.corpusLine as number, call.span ?? 3, call.ws ?? null, env);
    default:
      return q.runSessions(call.ws ?? null, env);
  }
}

/** 临时把 process.env 换成场景 env（lib 内部 spawnSync 不带 env，靠继承）。 */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * rg 传多个 target 时，`rg` 的输出顺序由它的线程调度决定，**不稳定**：
 * 实测 6 文件 × 200 行的语料上跑 40 次得到 28 种不同顺序（rg 15.2.0）。
 * 合同上也不承诺稳定 —— Python 侧 docstring 写的就是“返回 pairs(rg 序)”。
 * 所以：≥2 条命中时做序无关比较（记录集合 + 每条内部字节 + 编号连续性 + 条数），
 * 0/1 条命中时仍是逐字节比较（此时顺序不可能有差异）。
 */
function canonOutput(s: string): string {
  const trimmed = s.trim();
  // JSON 模式：顶层是数组，按元素规范化后排序
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return JSON.stringify(arr.map((x) => JSON.stringify(x)).sort());
    } catch {
      /* 不是 JSON，落回文本记录模式 */
    }
  }
  // 文本模式：每条命中以 `--- [N] ` 开头；N 是顺序号，归一后再排序。
  // 记录尾部的空行要 rstrip 掉：记录之间有个空行分隔，而**文件末尾**那条没有，
  // 且“谁在最后”随 rg 顺序变 —— 不归一就会把“末尾换行属于哪条记录”当成差异。
  const push = (lines: string[]): void => {
    if (lines.length) recs.push(lines.join("\n").replace(/^\n+|\n+$/g, ""));
  };
  const recs: string[] = [];
  let cur: string[] = [];
  for (const line of s.split("\n")) {
    if (/^--- \[\d+\]/.test(line)) {
      push(cur);
      cur = [line.replace(/^--- \[\d+\]/, "--- [N]")];
    } else if (cur.length) {
      cur.push(line);
    } else if (line.trim()) {
      recs.push(line); // 记录外的散行，如 `(无命中)`
    }
  }
  push(cur);
  return recs.sort().join("\n");
}

/** 命中记录的条数（JSON 数数组元素，文本数 `--- [` 行），用于在序无关比较下仍卡住漏吐/多吐。 */
function countRecords(s: string): number {
  const trimmed = s.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.length;
    } catch {
      /* 落回文本计数 */
    }
  }
  return s.split("\n").filter((l) => /^--- \[\d+\]/.test(l)).length;
}

/** 编号必须是 1..N 连续（顺序不稳定，但编号本身不能乱）；返回异常描述，正常为空串。 */
function badNumbering(s: string): string {
  const nums = s
    .split("\n")
    .map((l) => /^--- \[(\d+)\]/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) return `第 ${i + 1} 条编号为 ${nums[i]}（应为 ${i + 1}）`;
  }
  return "";
}

/** `--modified-after <now-ms>` 两侧不可能同毫秒，比对前归一（日志里是两行: 选项行 + 毫秒值行）。 */
/** `--modified-after` 的毫秒值：归一掉抖动后还要校验**量级**（否则单位写错也看不出来）。 */
function sinceValueOf(rawLog: string): number | null {
  const lines = rawLog.split("\n");
  const i = lines.findIndex((l) => l === "ARG --modified-after");
  if (i === -1 || i + 1 >= lines.length) return null;
  const m = /^ARG (\d+)$/.exec(lines[i + 1]);
  return m ? Number(m[1]) : null;
}

function normLog(s: string): string {
  const lines = s.split("\n").filter((l) => l !== "");
  return lines
    .map((l, i) => (i > 0 && lines[i - 1] === "ARG --modified-after" && /^ARG \d+$/.test(l) ? "ARG <TS>" : l))
    .join("\n");
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-query-diff-"));
  const home = path.join(root, "zgmem");
  const sessionsA = path.join(root, "sessions-a");
  const sessionsB = path.join(root, "sessions-b");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  buildSessions(sessionsA, sessionsB);
  for (const [name, body] of [["zg", FAKE_ZG], ["rg", FAKE_RG]] as const) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }

  // 两个 workspace 的语料都用 TS 的 ETL 建（模块 B 已逐字节对齐 Python，不是本次的被测对象）。
  // ws-alpha = {sessA, sessB}; ws-beta = {sessA}(同一 session 的另一个拷贝)
  const etlSources: Array<[string, string]> = [
    ["ws-alpha", sessionsA],
    ["ws-beta", sessionsB],
  ];
  for (const [ws, dir] of etlSources) {
    const res = etl.runEtl(path.join(dir, "*.jsonl"), path.join(home, ws, "corpus"));
    if (res.code !== 0) throw new Error(`ETL 建语料失败 ${ws}: ${res.lines.join("\n")}`);
  }
  // 断言一下对拍前提：corpus_line 80 ↔ jsonl_line 82（corpus_line ≠ jsonl_line）
  const scopeA = q.loadScope("ws-alpha", home, true);
  const row80 = q.corpusRow(scopeA, "sessA", 80);
  if (!row80 || row80.text !== MARKER_A) throw new Error(`语料前提不成立: corpus_line 80 = ${JSON.stringify(row80)}`);
  if (row80.jsonlLine !== 82) throw new Error(`语料前提不成立: corpus_line 80 应为 jsonl_line 82, 实为 ${row80.jsonlLine}`);

  // ZGMEM_SCOPE 必须显式给：真实 shell 里 PI_SESSION_FILE 有值，派生会走到会话目录 slug 上
  // FAKE_*_LOG 必须给：假二进制的 argv 日志靠它落盘，不给就整个 argv 维度空转
  const baseEnv = {
    ...process.env,
    ZGMEM_DIR: home,
    ZGMEM_SCOPE: "ws-alpha",
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_ZG_LOG: path.join(root, "zg.log"),
    FAKE_RG_LOG: path.join(root, "rg.log"),
  };
  const zgLog = baseEnv.FAKE_ZG_LOG;
  const rgLog = baseEnv.FAKE_RG_LOG;

  const realPath = baseEnv.PATH;
  // 自检：PATH 里必须真的能看到假 zg/假 rg（否则 argv 维度会静默空转）
  {
    const whichZg = spawnSync("sh", ["-c", "command -v zg"], { env: baseEnv, encoding: "utf8" }).stdout?.trim();
    const whichRg = spawnSync("sh", ["-c", "command -v rg"], { env: baseEnv, encoding: "utf8" }).stdout?.trim();
    if (whichZg !== path.join(bin, "zg") || whichRg !== path.join(bin, "rg")) {
      throw new Error(`假二进制没挂上: zg=${whichZg} rg=${whichRg}`);
    }
  }
  const noFakePath = process.env.PATH as string;

  const query = (o: q.QueryOpts): TsCall => ({ kind: "query", opts: o });

  const scenarios: Scenario[] = [
    // ---- zg 路径（假 zg：argv + 命中解析 + 精修 + 去重 + 名次）----
    { name: "query/hybrid 精修+去重+名次", call: query({ query: "图书直播选题", top: 5 }), argvLog: "zg" },
    { name: "query/hybrid --json（键序也是协议）", call: query({ query: "图书直播选题", top: 5, json: true }), argvLog: "zg" },
    { name: "query/fts 显式", call: query({ query: "图书直播选题", mode: "fts", top: 2 }), argvLog: "zg" },
    { name: "query/auto+- 开头退化成 fts", call: query({ query: "-leading-dash", top: 2 }), argvLog: "zg" },
    { name: "query/pool>top 用 pool 当 limit", call: query({ query: "图书直播选题", pool: 5, top: 2 }), argvLog: "zg" },
    { name: "query/who=assistant 过滤", call: query({ query: "图书直播选题", who: "assistant", top: 5 }), argvLog: "zg" },
    { name: "query/who=user 过滤", call: query({ query: "图书直播选题", who: "user", top: 5 }), argvLog: "zg" },
    { name: "query/since 过滤掉全部", call: query({ query: "图书直播选题", since: 30, top: 5 }), argvLog: "zg" },
    { name: "query/session -g 前缀 + 非法 id 校验", call: query({ query: "图书直播选题", session: "sessA", top: 3 }), argvLog: "zg" },
    { name: "query/session 含元字符被拒", call: query({ query: "x", session: "sess*" }) },
    { name: "query/精修关闭", call: query({ query: "图书直播选题", top: 3 }), env: { ZGMEM_HIT_REFINE: "0" }, argvLog: "zg" },
    { name: "query/zg 无命中", call: query({ query: "图书直播选题", top: 3, json: true }), env: { FAKE_ZG_EMPTY: "1" }, argvLog: "zg" },
    { name: "query/zg 无命中(文本)", call: query({ query: "图书直播选题", top: 3 }), env: { FAKE_ZG_EMPTY: "1" }, argvLog: "zg" },
    { name: "query/zg 失败 exit!=0", call: query({ query: "图书直播选题", top: 3 }), env: { FAKE_ZG_FAIL: "1" }, argvLog: "zg" },
    // ---- workspace 扇出 ----
    { name: "query/--workspace all 扇出合并", call: query({ query: "图书直播选题", workspace: "all", top: 5 }), argvLog: "zg" },
    { name: "sessions/--workspace all", call: { kind: "sessions", ws: "all" } },
    { name: "sessions/单 workspace", call: { kind: "sessions" } },
    { name: "sessions/--workspace ws-beta", call: { kind: "sessions", ws: "ws-beta" } },
    // ---- rg 路径（真 rg 的输出顺序即相关性序）----
    { name: "query/rg 语料内命中(真 rg)", realRg: true, call: query({ query: "sessA 第 4 条 普通内容 filler", mode: "rg", top: 3 }) },
    { name: "query/rg toolResult 兜底(真 rg)", realRg: true, call: query({ query: "TOOLONLY_MARKER_unique", mode: "rg", top: 3 }) },
    { name: "query/rg 无命中(真 rg)", realRg: true, call: query({ query: "绝对不存在的字符串 zzz", mode: "rg", top: 3, json: true }) },
    { name: "query/rg --session glob(上游 no-op: rg 忽略显式文件上的 -g)", realRg: true, call: query({ query: "SHARED_MARKER_TEXT", mode: "rg", session: "sessA", top: 5 }) },
    { name: "query/rg who=assistant", realRg: true, call: query({ query: "图书直播选题", mode: "rg", who: "assistant", top: 5 }) },
    { name: "query/rg who=user(该行 role=assistant,应无命中)", realRg: true, call: query({ query: "图书直播选题", mode: "rg", who: "user", top: 5 }) },
    // since 的**单位**：近期消息(1h 前)在 --since 1 下必须被保留；单位写错会全被滤掉
    { name: "query/rg since=1 保留近期消息", realRg: true, call: query({ query: "RECENT_ONLY_MARKER", mode: "rg", since: 1, top: 3, json: true }) },
    { name: "query/rg since=30 保留近期消息", realRg: true, call: query({ query: "RECENT_ONLY_MARKER", mode: "rg", since: 30, top: 3, json: true }) },
    // 跨 workspace 同一 session 的同一条 jsonl 行 → 去重键必须含 session（否则多吐一条）
    { name: "query/rg --workspace all 跨 ws 真重复", realRg: true, call: query({ query: "SHARED_MARKER_TEXT", mode: "rg", workspace: "all", top: 5, json: true }) },
    // ---- show / ctx：长文本截断（200/800）与换行→空格替换 ----
    { name: "show/长文本 800 截断", call: { kind: "show", sessionId: "sessA", corpusLine: LONG_LINE, full: true } },
    { name: "ctx/长文本 200 截断+换行替换", call: { kind: "ctx", sessionId: "sessA", corpusLine: LONG_LINE } },
    // ---- show / ctx ----
    { name: "show/corpus_line 80 (≠jsonl_line)", call: { kind: "show", sessionId: "sessA", corpusLine: 80 } },
    { name: "show/--full 与 toolResult 标记", call: { kind: "show", sessionId: "sessA", corpusLine: 80, full: true } },
    { name: "show/unknown session", call: { kind: "show", sessionId: "nope", corpusLine: 1 } },
    { name: "show/bad corpus line", call: { kind: "show", sessionId: "sessA", corpusLine: 999999 } },
    { name: "ctx/span=2 跨 tool 行", call: { kind: "ctx", sessionId: "sessA", corpusLine: 80, span: 2 } },
    { name: "ctx/span 默认 3", call: { kind: "ctx", sessionId: "sessA", corpusLine: 43 } },
    { name: "ctx/bad corpus line", call: { kind: "ctx", sessionId: "sessA", corpusLine: 999999 } },
    { name: "ctx/unknown session", call: { kind: "ctx", sessionId: "nope", corpusLine: 1 } },
    // ---- 未初始化 workspace：两条不同路径 ----
    {
      name: "workspace/--workspace 不存在 (main 里 SystemExit→stderr+1)",
      call: query({ query: "x", workspace: "nope" }),
      expectFail: true,
    },
    {
      name: "workspace/ZGMEM_SCOPE 不存在 (cmd 里吞掉→stdout+0)",
      call: query({ query: "x" }),
      env: { ZGMEM_SCOPE: "nope", ZGMEM_DIR: home },
    },
    { name: "workspace/非法名 ../etc", call: query({ query: "x", workspace: "../etc" }), expectFail: true },
    { name: "workspace/show 不能用 all", call: { kind: "show", sessionId: "sessA", corpusLine: 80, ws: "all" } },
    { name: "workspace/ctx 不能用 all", call: { kind: "ctx", sessionId: "sessA", corpusLine: 80, ws: "all" } },
  ];

  for (const sc of scenarios) {
    const env = { ...baseEnv, ...(sc.env ?? {}) };
    // “真 rg”场景把 bin/ 从 PATH 里拿掉（否则跑到假 rg 上，场景静默退化成空输出）
    if (sc.realRg) env.PATH = process.env.PATH as string;
    // 每个场景清空 argv 日志，两侧各写一份
    fs.writeFileSync(zgLog, "");
    fs.writeFileSync(rgLog, "");

    const py = spawnSync("python3", [PY_ZGMEM, ...pyArgv(sc.call)], { env, encoding: "utf8" });
    const pyOut = py.stdout ?? "";
    const pyErr = py.stderr ?? "";
    const pyLog = normLog(fs.readFileSync(sc.argvLog === "rg" ? rgLog : zgLog, "utf8"));
    const pyRawLog = fs.readFileSync(sc.argvLog === "rg" ? rgLog : zgLog, "utf8");
    // --modified-after 必须约等于 now_ms - since*86400*1000（±5s），量级/单位写错在这里拄住
    const expectedCutoff = Date.now() - 30 * 86400 * 1000;
    const pySince = sinceValueOf(pyRawLog);
    if (pySince !== null) {
      checks += 1;
      if (Math.abs(pySince - expectedCutoff) > 5000) diffs.push(`${sc.name}: --modified-after 量级异常 ${pySince}`);
    }

    // 两侧共用同一份日志文件：跑 TS 前必须清空，否则 ts 侧读到的是两份拼接
    fs.writeFileSync(zgLog, "");
    fs.writeFileSync(rgLog, "");

    // rg 场景走真 rg 时不需要 argv 日志；用 fake rg 的场景单独标了 FAKE_RG_NAME
    let tsOut = "";
    let tsCode = -1;
    let tsErr = "";
    let tsThrew: unknown = null;
    withEnv(env, () => {
      try {
        const r = runTs(sc.call, q.queryEnv(env));
        tsOut = r.out;
        tsCode = r.code;
      } catch (e) {
        tsThrew = e;
      }
    });
    const tsLog = normLog(fs.readFileSync(sc.argvLog === "rg" ? rgLog : zgLog, "utf8"));
    {
      const tsSince = sinceValueOf(fs.readFileSync(sc.argvLog === "rg" ? rgLog : zgLog, "utf8"));
      if (tsSince !== null) {
        checks += 1;
        if (Math.abs(tsSince - (Date.now() - 30 * 86400 * 1000)) > 5000) {
          diffs.push(`${sc.name}: TS --modified-after 量级异常 ${tsSince}`);
        }
        checks += 1;
        if (pySince !== null && pySince !== tsSince) {
          // 两侧都在同一量级且相差 <5s 视为一致（抖动）
          if (Math.abs(pySince - tsSince) > 5000) diffs.push(`${sc.name}: --modified-after 相差过大 ${pySince} vs ${tsSince}`);
        }
      }
    }

    if (sc.expectFail) {
      check(`${sc.name}: 退出信息`, pyErr, tsThrew instanceof q.ScopeExit || tsThrew ? String((tsThrew as Error)?.message ?? tsThrew) + "\n" : "");
      check(`${sc.name}: 是否失败`, String(py.status), tsThrew ? "1" : String(tsCode));
      if (py.status === 0 && !tsThrew) diffs.push(`${sc.name}: 期望失败但两侧都成功了`);
    } else {
      // 真 rg 且≥2 条命中：顺序不定（见 canonOutput 注释），序无关比较；否则逐字节
      const unordered = sc.realRg && Math.max(countRecords(pyOut), countRecords(tsOut)) > 1;
      if (unordered) unorderedScenarios.push(sc.name);
      if (unordered) {
        // ⚠ 序无关比较只在**没被 limit 截断**时才成立：输出顺序不定时，“前 N 条”就是个随机子集
        //（实测 py 拿到 3 条 sessA、ts 拿到 3 条 sessB）。所以强制 命中数 < limit，
        // 否则该场景的比对会变成随机红灯 —— 把 top 调大或换更窄的 query。
        const lim = Math.max(sc.call.opts?.pool ?? 0, sc.call.opts?.top ?? 3);
        const n = Math.max(countRecords(pyOut), countRecords(tsOut));
        checks += 1;
        if (n >= lim) diffs.push(`${sc.name}: 命中数 ${n} ≥ limit ${lim} → 序无关比较不成立`);
        // rg 自己的输出顺序不稳定（连 Python 都不可逐字节复现）→ 比记录集合，但仍卡住条数与编号
        check(`${sc.name}: 记录条数`, String(countRecords(pyOut)), String(countRecords(tsOut)));
        check(`${sc.name}: 编号连续`, badNumbering(pyOut), badNumbering(tsOut));
        check(`${sc.name}: stdout(序无关)`, canonOutput(pyOut), canonOutput(tsOut));
      } else {
        check(`${sc.name}: stdout`, pyOut, tsOut);
      }
      check(`${sc.name}: exit code`, String(py.status), String(tsCode));
      if (tsThrew) diffs.push(`${sc.name}: TS 抛异常 ${String(tsThrew)}`);
    }
    if (sc.argvLog === "zg") check(`${sc.name}: zg argv`, pyLog, tsLog);
    if (sc.argvLog === "zg" && tsLog === "") diffs.push(`${sc.name}: 假 zg 的 argv 日志是空的（argv 维度空转）`);
  }

  // ---- 真 rg 的 argv 也钉一遍（用假 rg + FAKE_RG_NAME=tool）----
  const rgScenario: Scenario = {
    name: "query/rg argv",
    call: query({ query: "TOOLONLY_MARKER_unique", mode: "rg", session: "sessA", top: 2 }),
    env: { FAKE_RG_NAME: "tool" },
  };
  {
    const env = { ...baseEnv, ...rgScenario.env };
    fs.writeFileSync(rgLog, "");
    fs.writeFileSync(rgLog, "");
    const py = spawnSync("python3", [PY_ZGMEM, ...pyArgv(rgScenario.call)], { env, encoding: "utf8" });
    const pyLog = normLog(fs.readFileSync(rgLog, "utf8"));
    fs.writeFileSync(rgLog, "");
    let tsOut = "";
    let tsCode = -1;
    withEnv(env, () => {
      const r = runTs(rgScenario.call, q.queryEnv(env));
      tsOut = r.out;
      tsCode = r.code;
    });
    const tsLog = normLog(fs.readFileSync(rgLog, "utf8"));
    check(`${rgScenario.name}: stdout`, py.stdout ?? "", tsOut);
    check(`${rgScenario.name}: exit code`, String(py.status), String(tsCode));
    check(`${rgScenario.name}: rg argv`, pyLog, tsLog);
    if (tsLog === "") diffs.push(`${rgScenario.name}: 假 rg 的 argv 日志是空的（argv 维度空转）`);
    void realPath;
    void noFakePath;
  }

  // ---- workspace 派生（无 ZGMEM_SCOPE）：PI_SESSION_FILE slug / 唯一已初始化 / 兜底 ----
  {
    const envNoScope: Record<string, string | undefined> = { ...baseEnv };
    delete envNoScope["ZGMEM_SCOPE"];
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ["唯一已初始化", { ...envNoScope, ZGMEM_DIR: home } as NodeJS.ProcessEnv],
      ["PI_SESSION_FILE slug", { ...envNoScope, ZGMEM_DIR: home, PI_SESSION_FILE: "/x/--proj-slug--/s.jsonl" } as NodeJS.ProcessEnv],
      ["两个 workspace 时兜底 github", { ...envNoScope, ZGMEM_DIR: home, PI_SESSION_FILE: "" } as NodeJS.ProcessEnv],
    ];
    for (const [label, e] of cases) {
      const py = spawnSync(
        "python3",
        ["-c", "import os,sys; sys.path.insert(0, sys.argv[1]); import zgmem; print(zgmem._derive_workspace())", EXT],
        { env: e as Record<string, string>, encoding: "utf8" },
      );
      check(`derive_workspace/${label}`, (py.stdout ?? "").trim(), q.deriveWorkspace(q.zgmemHome(e), e));
    }
  }

  if (!process.env.QUERY_DIFF_KEEP) fs.rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`  (QUERY_DIFF_KEEP=1，临时目录保留在 ${root})\n`);

  console.log(`query 差分对拍：${scenarios.length} 个场景 + rg argv + workspace 派生`);
  console.log(`  比对项 ${checks}，差异 ${diffs.length}`);
  if (unorderedScenarios.length) {
    console.log(`  序无关比较（真 rg 且 ≥2 条命中，rg 不承诺输出顺序）：`);
    for (const n of unorderedScenarios) console.log(`    · ${n}`);
  }
  if (diffs.length) {
    console.log("\n差异明细:");
    for (const d of diffs.slice(0, 20)) console.log("  - " + d);
    process.exitCode = 1;
  } else {
    console.log("  ✓ Python 与 TS 的 stdout / 退出码 / zg·rg argv 全部一致");
  }
}

main();
