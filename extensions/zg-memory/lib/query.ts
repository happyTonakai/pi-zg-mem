/**
 * lib/query.ts — zgmem 的**只读**路径（v2 分片语料），`extensions/zg-memory/zgmem.py` 的 TS 移植
 * =====================================================================================
 * 覆盖：query（zg 语义召回 + 命中精修 / rg 字面召回）、show、ctx、sessions。
 * **不含** refresh 的写入路径（ETL + zg index + 索引戳），那是模块 D（`lib/refresh.ts`）。
 *
 * 每个函数上方标注 Python 出处，便于逐条比对。移植期的约定（见 docs/plan-ts-migration.md，
 * 与 lib/corpus.ts、lib/etl.ts 同一套）：
 *  - 只用"可擦除语法"，`node lib/query.ts` 能被剥离类型后直接跑（不能用 enum/namespace/装饰器）；
 *  - 相对导入必须带 .ts 扩展名；
 *  - I/O 全部同步（zg / rg 用 spawnSync，忠于 Python 的 subprocess.run 阻塞语义）；
 *  - 库层**不 print**：每个入口返回 `{out, code}`，`out` 是要写 stdout 的**完整文本**，
 *    由模块 E（lib/cli.ts）负责落地。格式与 Python 逐字节一致（CLI 回归靠它）。
 *
 * 与 Python 的结构差异（有意，且已登记）：
 *  1. Python 靠模块级全局 `SCOPE_DIR/CORPUS_DIR/MANIFEST` + `use_workspace()` 就地改写；
 *     这里改为显式 `Scope` 值对象：`loadScope(ws, home)` 返回一份快照，不再有跨命令的隐式状态。
 *     于是"workspace 维度"（`--workspace all` 扇出）就是循环里换一个 Scope，行为等价。
 *  2. `SystemExit(msg)` → `ScopeExit`。语义差别只在**谁**处理：Python 在 fan-out 里
 *     `except SystemExit` 吞掉继续下一个 workspace；顶层不捕获 → stderr + 退出码 1。
 *     这里同样把 ScopeExit 抛给调用方，由模块 E 决定落地到 stderr / exit 1。
 *  3. Python 在 import 时读环境变量（ZGMEM_DIR / ZGMEM_SCOPE / ZGMEM_HIT_REFINE …），
 *     这里收进 `queryEnv(env)` 显式传参，测试可注入而不必重启进程（语义不变：默认仍取 process.env）。
 *
 * 未导出 / 与 lib/etl.ts 重复的小助手（`pyTruthy` / `pyOr` / `pyIterate` / `pyInt` / PY_WS）：
 *  模块 A、B 有意不导出内部助手（不扩大已验收模块的公开面），本模块内联同一套实现，
 *  逐字对齐 Python 的假值/可迭代/整数语义。**模块 G 清理时**可抽成 `lib/py.ts` 共用。
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as zc from "./corpus.ts";

/** 入口返回值：out = 要写 stdout 的完整文本（Python 的 print 逐次追加）。 */
export interface RunResult {
  out: string;
  code: number;
}

/** Python 的全局配置（等价于 zgmem.py 顶部那批模块级常量）。 */
export interface QueryEnv {
  /** ZGMEM_HOME：~/.pi/agent/zgmem 或 ZGMEM_DIR。 */
  home: string;
  /** 缺省 workspace（ZGMEM_SCOPE > PI_SESSION_FILE 目录 slug > 唯一已初始化 > "github"）。 */
  scopeName: string;
  /** 传给 `zg index --embedding` 的模型（模块 D 用；这里只做同口径解析）。 */
  embedding: string;
  /** ZGMEM_HIT_REFINE：命中行精修开关（等价 Python 的 _REFINE_HITS）。 */
  hitRefine: boolean;
}

export const DEFAULT_EMBEDDING = "local/potion-multilingual-128m";
/** zg 索引是否已建成（与 index.ts 的 indexMarker 同口径）；随 workspace 切换，故只存相对路径。 */
export const INDEX_MARKER_REL = path.join(".zvec-grep", "index.zvec");

/**
 * workspace 未初始化 / 名字非法 —— 对应 Python 的 `raise SystemExit(msg)`。
 * 顶层调用方（模块 E）应把 message 原样写 stderr 并 exit 1；fan-out 里则跳过该 workspace。
 */
export class ScopeExit extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeExit";
  }
}

// ---------- 小工具（Python 语义，与 lib/etl.ts 内联实现一致）----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** py: str(v) —— 只覆盖真实数据里出现的标量（None/bool/str/int/float）。 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v); // list/dict 的 repr 不在此复刻：真实输入里 role/ts/line 不会是容器
}

/** py: repr(v) —— 仅用于错误信息（`{ws!r}`）。非可打印字符按 \xXX 转义的那套没复刻。 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return pyStr(v);
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  let body = "";
  for (const ch of v) {
    if (ch === "\\") body += "\\\\";
    else if (ch === "\n") body += "\\n";
    else if (ch === "\r") body += "\\r";
    else if (ch === "\t") body += "\\t";
    else if (ch === q) body += `\\${ch}`;
    else body += ch;
  }
  return `${q}${body}${q}`;
}

/** py: bool(v) —— `[]`/`{}` 在 Python 是假值、在 JS 是真值，不能直接用 JS 真值。 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

/** py: `a or b` —— 只在 a 为 Python 假值时取 b。 */
export function pyOr<T>(a: T, b: T): T | T {
  return pyTruthy(a) ? a : b;
}

/** py: s[:n] —— Python 按**码点**切片；JS slice 按 UTF-16 码元（emoji 会切坏）。 */
export function pySlice(s: string, n: number): string {
  const arr = Array.from(s);
  return arr.length <= n ? s : arr.slice(0, n).join("");
}

/** Python 的 str 比较（按码点）；JS 默认比较按 UTF-16 码元，遇到星平面字符会不同。 */
export function pyStrCmp(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i].codePointAt(0) ?? 0;
    const cb = B[i].codePointAt(0) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length - B.length;
}

/** py: dict.get(key, default) —— 非 dict 时抛 AttributeError 等价错误（Python 会直接崩）。 */
export function pyGet(obj: unknown, key: string, def: unknown): unknown {
  if (!isPlainObject(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : def;
}

export function hasOwn(obj: unknown, key: string): boolean {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (isPlainObject(v)) return "dict";
  return typeof v;
}

/** py 的 `for x in v`：list/str（按码点）/dict（按键）可迭代，其余抛 TypeError。 */
export function* pyIterate(v: unknown): Generator<unknown> {
  if (typeof v === "string") {
    for (const ch of v) yield ch;
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) yield x;
    return;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) yield k;
    return;
  }
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/**
 * Python 文本模式的**行迭代**（universal newlines + 结尾换行不多产生一行）。
 * 返回的行不含行尾换行符 —— `json.loads` 对有无尾换行等价，所以不必回填。
 */
export function pyFileLines(raw: string): string[] {
  const lines = raw.replace(/\r\n|\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** py: s.splitlines() —— 用于子进程 stdout（text=True 已把 \r\n 归一成 \n）。 */
export function pySplitLines(raw: string): string[] {
  return pyFileLines(raw);
}

/**
 * Python `str.isspace()` 为真的码点集合。**不能直接用 JS 的 `\s`**：
 * 少 \x1c-\x1f 与 \x85（Python 算空白），多 \ufeff（JS 算空白、Python 不算）。
 */
const PY_WS: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  ...Array.from({ length: 0x200b - 0x2000 }, (_, i) => 0x2000 + i),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** py: s.strip() —— 只剥 Python 认的那批空白码点。 */
export function pyStrip(s: string): string {
  const arr = Array.from(s);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi && PY_WS.has(arr[lo].codePointAt(0) ?? 0)) lo += 1;
  while (hi > lo && PY_WS.has(arr[hi - 1].codePointAt(0) ?? 0)) hi -= 1;
  return arr.slice(lo, hi).join("");
}

/**
 * Python `int()` 的**错误语义**（与 lib/etl.ts 一致）：`int(None)` 抛 TypeError、
 * `int("x")` 抛 ValueError、`int(float("inf"))` 抛 OverflowError。
 * `_pair_from_jsonl` 用 `except (TypeError, ValueError)` 兜住失败 → ts=0。
 */
class PyIntError extends Error {
  kind: "TypeError" | "ValueError" | "OverflowError";
  constructor(kind: "TypeError" | "ValueError" | "OverflowError", message: string) {
    super(message);
    this.name = kind;
    this.kind = kind;
  }
}

/** py: int(v) —— 只接受 bool / int|float / str；ASCII 数字、可用下划线分隔。 */
export function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new PyIntError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new PyIntError("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    if (!/^[+-]?\d(?:_?\d)*$/.test(pyStrip(v))) {
      throw new PyIntError("ValueError", `invalid literal for int() with base 10: '${v}'`);
    }
    return Number(pyStrip(v).replace(/_/g, ""));
  }
  throw new PyIntError("TypeError", `int() argument must be a string or a number, not '${pyTypeName(v)}'`);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------- 本地时间（Python `datetime.fromtimestamp(...).strftime(...)`）----------
// 都是**本地时区**格式化；只复刻用到的三种格式串。

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtStamp(ms: number, mode: "datetime" | "date" | "time"): string {
  const d = new Date(ms);
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (mode === "date") return ymd;
  if (mode === "time") return hm;
  return `${ymd} ${hm}`;
}

// ---------- workspace / Scope ----------

// py: ZGMEM_HOME（含 ZGMEM_DIR 覆盖）
export function zgmemHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["ZGMEM_DIR"] ?? path.join(os.homedir(), ".pi", "agent", "zgmem");
}

/** py: _REFINE_HITS —— ZGMEM_HIT_REFINE=0/false/no 时关闭（大小写敏感，与 Python 一致）。 */
export function hitRefineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["ZGMEM_HIT_REFINE"] ?? "1";
  return !["0", "false", "no"].includes(raw);
}

export function queryEnv(env: NodeJS.ProcessEnv = process.env): QueryEnv {
  const home = zgmemHome(env);
  return {
    home,
    scopeName: deriveWorkspace(home, env),
    embedding: env["ZGMEM_EMBEDDING"] ?? DEFAULT_EMBEDDING,
    hitRefine: hitRefineEnabled(env),
  };
}

/** py: _derive_workspace —— env > PI_SESSION_FILE 会话目录 slug > 唯一已初始化 workspace > github */
export function deriveWorkspace(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const ws = env["ZGMEM_SCOPE"];
  if (pyTruthy(ws)) return ws as string;
  const psf = env["PI_SESSION_FILE"];
  if (pyTruthy(psf)) {
    // pi 的会话目录形如 .../--<slug>--/ ；Python 用 .strip("-") 剥两端所有 '-'
    const slug = path.basename(path.dirname(psf as string)).replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  const avail = listWorkspaces(home);
  if (avail.length === 1) return avail[0];
  return "github";
}

/** py: list_workspaces —— 已初始化（存在 manifest.json）的 workspace 名，已排序。 */
export function listWorkspaces(home: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names.filter((n) => isFile(path.join(home, n, "manifest.json"))).sort(pyStrCmp);
}

/** 一个 workspace 的只读快照（Python 里是 SCOPE_DIR/CORPUS_DIR/MANIFEST 三个全局）。 */
export interface Scope {
  name: string;
  home: string;
  corpusDir: string;
  manifestPath: string;
  manifest: zc.Manifest;
  refineHits: boolean;
}

/**
 * py: use_workspace(ws) —— 校验名字与 manifest，返回该 workspace 的快照。
 * 非法名字 / 未初始化时抛 ScopeExit（Python 是 SystemExit），message 逐字对齐。
 */
export function loadScope(ws: string, home: string, refineHits: boolean = hitRefineEnabled()): Scope {
  const s = ws ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s.includes("..")) {
    throw new ScopeExit(`非法 workspace 名: ${pyRepr(ws)}`);
  }
  const mpath = path.join(home, ws, "manifest.json");
  if (!isFile(mpath)) {
    const avail = listWorkspaces(home).join(", ") || "无";
    throw new ScopeExit(`workspace '${ws}' 未初始化 (缺 ${mpath}); 已有: ${avail}`);
  }
  return {
    name: ws,
    home,
    corpusDir: path.join(home, ws, "corpus"),
    manifestPath: mpath,
    manifest: zc.loadManifest(mpath),
    refineHits,
  };
}

// ---------- 只读访问 ----------

/** py: corpus_meta(session_id) */
export function corpusMeta(scope: Scope, sessionId: string): zc.SessionMeta | undefined {
  return zc.sessions(scope.manifest)[sessionId];
}

/**
 * py: corpus_row(session_id, corpus_line) —— 全局 corpus 行号 -> (jsonl_line, role, ts, text)；
 * 定位失败返回 null。
 */
export function corpusRow(scope: Scope, sessionId: string, corpusLine: number): zc.CorpusRow | null {
  const seg = zc.findSegment(scope.manifest, sessionId, corpusLine);
  if (!seg) return null;
  const rows = zc.readSegment(scope.corpusDir, seg.fname, seg.start_corpus_line || 1);
  return rows.find((r) => r.line === corpusLine) ?? null;
}

/** py: jsonl_path_for(session_id) */
export function jsonlPathFor(scope: Scope, sessionId: string): string | null {
  const m = corpusMeta(scope, sessionId);
  return m && typeof m.jsonl_path === "string" ? m.jsonl_path : null;
}

// ---------- 对话对构建 ----------

export interface QueryRef {
  session: string;
  jsonl_line: number;
  corpus_line: number;
  workspace?: string;
}

/** Python 里的 pair 是裸 dict，键的**插入顺序**会进 --json 输出，故字段顺序即协议。 */
export interface QueryPair {
  ref: QueryRef;
  role: string;
  ts: number;
  user: string;
  assistant: string;
  /** 只出现在 `_pair_from_jsonl` 的兜底结果里。 */
  text?: string;
}

/** py: fmt_pair(p, i) —— 返回值**不含** print 追加的那个换行（调用方补）。 */
export function fmtPair(p: QueryPair, i: number): string {
  const ref = p.ref as unknown as Record<string, unknown>;
  const ts = p.ts ? fmtStamp(p.ts, "datetime") : "?";
  const u = pySlice(p.user || "", 200);
  const a = pySlice(p.assistant || "", 300);
  const header =
    `--- [${i}] ${ts} [${pyStr(ref["workspace"] ?? "")}] ` +
    `session=${pySlice(pyStr(ref["session"]), 20)} line=${pyStr(ref["jsonl_line"])} (role=${pyStr(p.role)})\n`;
  if (!u && !a) {
    const raw = pySlice(pyStr(pyOr(p.text ?? null, "")), 300);
    return `${header}  RAW     : ${raw}\n`;
  }
  return `${header}  USER     : ${u}\n  ASSISTANT: ${a}\n`;
}

/** pair 的跨 workspace 去重键（Python 是 `(session, jsonl_line)` 元组）。 */
function globalKey(p: QueryPair): string {
  return JSON.stringify([p.ref.session ?? null, p.ref.jsonl_line ?? null]);
}

// ---------- 精确 token 路由 ----------

/** py: _looks_exact(q) —— 启发式判断 query 是"精确 token"型还是语义型。 */
export function looksExact(q: string): "rg" | "fts" | "hybrid" {
  // 错误码/key:value/路径行号: 冒号分隔的强 token
  if (/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+/.test(q)) return "rg";
  // 路径样式
  if (/[A-Za-z0-9_.~-]+\/[A-Za-z0-9_.~-]+/.test(q)) return "rg";
  // 长难 token / hash
  if (/[A-Za-z0-9]{16,}/.test(q)) return "rg";
  // camelCase 符号
  if (/[a-z][A-Z][A-Za-z]*/.test(q) || /[A-Z]{2,}/.test(q)) return "fts";
  return "hybrid";
}

// ---------- rg 召回 ----------

export interface QueryOpts {
  query: string;
  top?: number;
  who?: string;
  since?: number;
  pool?: number;
  session?: string | null;
  workspace?: string | null;
  json?: boolean;
  mode?: string;
}

/**
 * py: _rg_candidates(args, limit, ws_name) —— 在该 workspace 已索引的会话 JSONL 上字面匹配。
 * rg 序即相关性序（1/(order+1)），命中行不在语料里时用 `_pair_from_jsonl` 兜底。
 */
export function rgCandidates(
  scope: Scope,
  opts: QueryOpts,
  limit: number,
  wsName: string,
): QueryPair[] {
  const man = scope.manifest;
  const targets = [...new Set(
    Object.values(zc.sessions(man))
      .map((m) => m.jsonl_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  )].sort(pyStrCmp);
  if (targets.length === 0) return [];

  // -H: 单文件 target 也打文件名(否则解析全挂); -e: query 以 '-' 开头时与 rg 选项隔离
  const args = ["-n", "-F", "--no-heading", "-H", "-e", opts.query];
  if (opts.session) args.push("--glob", `${path.basename(opts.session)}.jsonl`);
  const proc = childProcess.spawnSync("rg", [...args, ...targets], {
    encoding: "utf8",
    maxBuffer: zc.subprocessMaxBuffer(),
  });
  // 为什么不先 return []：rg 输出超限时 spawnSync 给的是 error=…MAXBUFFER（message 里带 ENOBUFS）
  // + status=null，当成“没命中”就变成了静默错答案（真机全量 rg 早就过 1 MiB 了）。
  // 包一层只为可读：裸抛 proc.error 在 CLI 侧就是一句 `spawnSync rg ENOBUFS`；cause 保留原始 error。
  if (proc.error) {
    throw new Error(`rg 子进程失败（输出超过 maxBuffer？）: ${proc.error.message}`, { cause: proc.error });
  }
  if ((proc.status ?? -1) !== 0) return [];

  const j2s = new Map<string, string>();
  for (const [sid, m] of Object.entries(zc.sessions(man))) {
    if (typeof m.jsonl_path === "string") j2s.set(m.jsonl_path, sid);
  }
  const rowsCache = new Map<string, zc.CorpusRow[]>();
  const pairs: QueryPair[] = [];
  const seen = new Set<string>();
  for (const l of pySplitLines(proc.stdout ?? "")) {
    const m = /^(.+?):(\d+):/.exec(l);
    if (!m) continue;
    const p = m[1];
    const jl = Number(m[2]);
    const key = `${jl}\u0000${p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // role 过滤在拿到 pair 后做（Python 这里是个空 if，语义上只是注释）
    const sid = j2s.get(p);
    let pair: QueryPair | null = null;
    if (sid) {
      let rows = rowsCache.get(sid);
      if (!rows) {
        rows = zc.sessionRowsFull(scope.corpusDir, man, sid);
        rowsCache.set(sid, rows);
      }
      const idx = rows.findIndex((r) => r.jsonlLine === jl);
      if (idx !== -1) {
        pair = zc.buildPair(rows, idx);
        pair.ref.session = sid;
      }
    }
    if (pair === null) pair = pairFromJsonl(p, jl); // toolResult 等不在语料里的命中兜底
    if (pair === null) continue;
    pair.ref.workspace = wsName;
    if ((opts.who ?? "all") !== "all" && pair.role !== opts.who) continue;
    if ((opts.since ?? 0) !== 0) {
      // py: cutoff = (time.time() - since*86400) * 1000 —— time.time() 是**秒**，Date.now() 是毫秒，
      // 所以毫秒域里只能是 now_ms - since*86400*1000（写 `(Date.now()-since*86400)*1000` 会差 1000 倍，
      // 且在“全旧语料”上完全看不出来：差分用例必须带一条**近期时间戳**的消息）。
      const cutoff = Date.now() - (opts.since as number) * 86400 * 1000;
      if ((pair.ts || 0) < cutoff) continue;
    }
    pairs.push(pair);
    if (pairs.length >= limit) break;
  }
  return pairs;
}

/**
 * py: _pair_from_jsonl(path, jl) —— 兜底：corpus 没有该行(toolResult/thinking)，
 * 直接从 JSONL 合成 pair。Python 整个函数被 `except Exception: return None` 包着。
 */
export function pairFromJsonl(jsonlPath: string, jl: number): QueryPair | null {
  try {
    const lines = pyFileLines(fs.readFileSync(jsonlPath, "utf8"));
    for (let i = 1; i <= lines.length; i++) {
      if (i !== jl) continue;
      const d = JSON.parse(lines[i - 1]);
      const msg = pyGet(d, "message", {});
      const role = pyStr(pyGet(msg, "role", "?"));
      let ts = 0;
      try {
        ts = pyInt(pyOr(pyOr(pyGet(msg, "timestamp", null), pyGet(d, "timestamp", null)), 0));
      } catch (e) {
        // py: except (TypeError, ValueError) -> ts = 0（OverflowError 会往上抛，被外层吞成 None）
        if (e instanceof PyIntError && e.kind !== "OverflowError") ts = 0;
        else throw e;
      }
      const parts: string[] = [];
      for (const c of pyIterate(pyOr(pyGet(msg, "content", null), []))) {
        if (!isPlainObject(c)) continue;
        const t = pyOr(pyOr(pyGet(c, "text", null), pyGet(c, "thinking", null)), "");
        if (pyTruthy(t)) {
          // py: " ".join(parts) 遇非 str 会抛 TypeError（被外层吞成 None）——别静默转字符串
          if (typeof t !== "string") throw new TypeError(`sequence item 0: expected str instance, ${pyTypeName(t)} found`);
          parts.push(t);
        }
      }
      const txt = parts.join(" ").replaceAll("\n", " "); // py: str.replace 是**全部**替换
      return {
        ref: { session: path.basename(jsonlPath).slice(0, -6), corpus_line: 0, jsonl_line: jl },
        role,
        ts,
        text: txt,
        user: role === "user" ? txt : "",
        assistant: role === "assistant" ? txt : "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------- 命中行精修（H2）----------

/**
 * py: _refine_hit_line(cname, meta, cstart, query, span=None)
 *
 * zg 给的行号是命中块的**首行**（实测可以比真正命中的行早 16 行），块内哪一行被命中只能自己找：
 * 同片内从块首行往后限窗，取 query 词元覆盖分最高的一行；纯向量命中（无词元覆盖）时退回块首行。
 * ZGMEM_HIT_REFINE=0 可关闭精修。
 */
export function refineHitLine(
  scope: Scope,
  cname: string,
  meta: zc.SegmentMeta,
  cstart: number,
  query: string,
  span: number | null = null,
): number {
  const start = (meta.start_corpus_line || 1) + Math.trunc(cstart) - 1;
  if (!scope.refineHits) return start;
  const rows = zc.readSegment(scope.corpusDir, cname, meta.start_corpus_line || 1);
  return zc.pickHitRow(rows, start, zc.queryTerms(query), span);
}

// ---------- query ----------

/** py: cmd_query(args) */
export function runQuery(opts: QueryOpts, env: QueryEnv = queryEnv()): RunResult {
  // session id 会进 rg/zg 的 glob 模式, 先拒绝元字符(防模式放宽)
  const session = opts.session ?? null;
  if (session && !/^[A-Za-z0-9._-]+$/.test(session)) {
    return { out: "非法 session id\n", code: 0 };
  }
  let mode = opts.mode || "auto";
  if (mode === "auto") mode = looksExact(opts.query);
  // zg query 位置参数以 '-' 开头会被 zg 解析成选项; fts 走 --fts 带值参数天然安全
  if (mode === "hybrid" && opts.query.startsWith("-")) mode = "fts";

  const top = opts.top ?? 3;
  const who = opts.who ?? "all";
  const since = opts.since ?? 0;
  const pool = opts.pool ?? 0;
  const limit = pool > top ? pool : top;

  // workspace 维度: 名字=单 workspace; all=所有已初始化 workspace 扇出合并
  const ws = opts.workspace || env.scopeName;
  const workspaces = ws === "all" ? listWorkspaces(env.home) : [ws];

  const candidates: Array<[number, QueryPair]> = [];
  const seenGlobal = new Set<string>(); // 跨 workspace 扇出去重: (session, jsonl_line)
  let out = "";

  for (const w of workspaces) {
    let scope: Scope;
    try {
      scope = loadScope(w, env.home, env.hitRefine);
    } catch (e) {
      if (e instanceof ScopeExit) {
        // py: except SystemExit —— 单 workspace 时报错返回, 扇出时跳过这一个
        if (workspaces.length === 1) return { out: `${out}${e.message}\n`, code: 0 };
        continue;
      }
      throw e;
    }

    if (mode === "rg") {
      const list = rgCandidates(scope, { ...opts, who, since, session }, limit, w);
      // 注意: Python 是 `for order, pair in enumerate(...)` —— order 按**列表下标**走,
      // 被 seen_global 跳过的项照样占一个名次。这里保持同一口径。
      for (let order = 0; order < list.length; order++) {
        const pair = list[order];
        const gkey = globalKey(pair);
        if (seenGlobal.has(gkey)) continue;
        seenGlobal.add(gkey);
        candidates.push([1.0 / (order + 1), pair]);
      }
      continue;
    }

    const cmd = ["zg", "query"];
    if (mode === "fts") cmd.push("--fts", opts.query);
    else cmd.push(opts.query);
    cmd.push("--limit", String(limit), "--preview", "none");
    if (session) cmd.push("-g", `${session}*`);
    if (since) {
      // py: int((datetime.now() - timedelta(days=since)).timestamp() * 1000)
      cmd.push("--modified-after", String(Date.now() - since * 86400 * 1000));
    }

    const proc = childProcess.spawnSync(cmd[0], cmd.slice(1), {
      cwd: scope.corpusDir,
      encoding: "utf8",
      maxBuffer: zc.subprocessMaxBuffer(),
    });
    if (proc.error) throw proc.error; // py: 找不到 zg -> FileNotFoundError 直接崩(不吞)
    if ((proc.status ?? -1) !== 0) {
      const err = pyOr(pyTruthy(proc.stderr) ? proc.stderr : null, proc.stdout);
      if (workspaces.length === 1) return { out: `${out}${err ?? ""}\n`, code: 0 };
      continue;
    }

    // 解析 zg 输出: 每行像 "#1 matchedBy=fts+vector 2026-....txt:32" 或 "...p0003.txt:73-94", 保序去重。
    // 只认 `#N matchedBy=... file.txt:line[-end]` 命中头行; 语料正文回显可能含 xxx.txt:123 字样。
    // zg 给了块内窗口时记下末尾: 精修就在这个窗口内找命中行, 不用再猜它的块大小。
    const hits: Array<[string, number, number | null]> = [];
    const seen = new Set<string>();
    for (const ln of pySplitLines(proc.stdout ?? "")) {
      const s = pyStrip(ln);
      if (!s.startsWith("#")) continue;
      const m = /([0-9A-Za-z_.-]+\.txt):(\d+)(?:-(\d+))?/.exec(s);
      if (m && hasOwn(zc.segments(scope.manifest), m[1])) {
        const key = `${m[1]}\u0000${m[2]}\u0000${m[3] ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push([m[1], Number(m[2]), m[3] ? Number(m[3]) : null]);
        }
      }
    }

    for (let order = 0; order < hits.length; order++) {
      const [cname, cstart, cend] = hits[order];
      const meta = zc.segments(scope.manifest)[cname];
      if (!isPlainObject(meta)) continue;
      const sid = pyStr((meta as unknown as zc.SegmentMeta).session_id);
      const wspan = cend ? Math.max(0, cend - cstart) : null;
      const gline = refineHitLine(scope, cname, meta as unknown as zc.SegmentMeta, cstart, opts.query, wspan);
      const found = zc.pairForGlobal(scope.corpusDir, scope.manifest, sid, gline);
      if (found === null) continue;
      // 注: zc.Pair.ref 没有 workspace 字段(那是查询层概念); 这里起 alias 后再挂上
      const pair: QueryPair = found;
      pair.ref.workspace = w;
      if (who !== "all" && pair.role !== who) continue;
      const gkey = globalKey(pair);
      if (seenGlobal.has(gkey)) continue;
      seenGlobal.add(gkey);
      candidates.push([1.0 / (order + 1), pair]); // zg 相关性名次 -> 基础相关
    }
  }

  if (candidates.length === 0) {
    return { out: `${out}${opts.json ? "[]" : "(无命中)"}\n`, code: 0 };
  }

  // 纯相关性排序; 不做时间衰减(检索系统不做遗忘, 时间戳随结果返回由 agent 自行裁决新旧)
  candidates.sort((a, b) => b[0] - a[0]);
  const pairs = candidates.slice(0, top).map((c) => c[1]);

  if (opts.json) return { out: `${out}${JSON.stringify(pairs, null, 2)}\n`, code: 0 };
  for (let i = 1; i <= pairs.length; i++) out += `${fmtPair(pairs[i - 1], i)}\n`;
  return { out, code: 0 };
}

// ---------- show ----------

/** py: cmd_show(session_id, corpus_line, full) */
export function runShow(
  sessionId: string,
  corpusLine: number,
  full: boolean,
  ws?: string | null,
  env: QueryEnv = queryEnv(),
): RunResult {
  const scope = loadScope(ws || env.scopeName, env.home, env.hitRefine);
  const jpath = jsonlPathFor(scope, sessionId);
  if (!jpath) return { out: `unknown session ${sessionId}\n`, code: 0 };
  // 从分片语料定位 jsonl 行号
  const rec = corpusRow(scope, sessionId, corpusLine);
  if (!rec) return { out: "bad corpus line\n", code: 0 };
  const jl = rec.jsonlLine;

  const lines = pyFileLines(fs.readFileSync(jpath, "utf8"));
  for (let i = 1; i <= lines.length; i++) {
    if (i !== jl) continue;
    const d = JSON.parse(lines[i - 1]);
    const msg = pyGet(d, "message", {});
    let out = `session=${sessionId} jsonl_line=${jl} role=${pyStr(pyGet(msg, "role", null))} ` +
      `ts=${pyStr(pyGet(msg, "timestamp", null))}\n`;
    for (const c of pyIterate(pyGet(msg, "content", []))) {
      if (!isPlainObject(c)) continue;
      const t = pyStr(pyGet(c, "type", null));
      const valRaw = pyOr(pyOr(pyGet(c, "text", null), pyGet(c, "thinking", null)), "");
      // py: val[:800] —— val 不是 str 时 Python 抛 TypeError, 这里同样不静默转换
      if (typeof valRaw !== "string") throw new TypeError(`'${pyTypeName(valRaw)}' object is not subscriptable`);
      if (["text", "thinking", "ToolCall", "toolCall"].includes(t) || full) {
        out += `\n[${t}]\n${pySlice(valRaw, 800)}\n`;
      }
    }
    // toolResult
    if (hasOwn(msg, "toolResult") || pyGet(msg, "role", null) === "tool") {
      out += "\n[toolResult field present]\n";
    }
    return { out, code: 0 };
  }
  return { out: "jsonl line not found\n", code: 0 };
}

// ---------- ctx ----------

/** py: cmd_ctx(session_id, corpus_line, span) */
export function runCtx(
  sessionId: string,
  corpusLine: number,
  span: number,
  ws?: string | null,
  env: QueryEnv = queryEnv(),
): RunResult {
  const scope = loadScope(ws || env.scopeName, env.home, env.hitRefine);
  const jpath = jsonlPathFor(scope, sessionId);
  if (!jpath) return { out: `unknown session ${sessionId}\n`, code: 0 };
  const rec = corpusRow(scope, sessionId, corpusLine);
  if (!rec) return { out: "bad corpus line\n", code: 0 };
  const target = rec.jsonlLine;

  const rows: Array<[number, unknown]> = [];
  const lines = pyFileLines(fs.readFileSync(jpath, "utf8"));
  for (let i = 1; i <= lines.length; i++) {
    let d: unknown;
    try {
      d = JSON.parse(lines[i - 1]);
    } catch {
      continue;
    }
    if (pyGet(d, "type", null) !== "message") continue;
    rows.push([i, pyGet(d, "message", {})]);
  }
  const tidx = rows.findIndex((r) => r[0] === target);
  if (tidx === -1) return { out: "line not found\n", code: 0 };

  const lo = Math.max(0, tidx - span);
  const hi = Math.min(rows.length, tidx + span + 1);
  let out = "";
  for (let i = lo; i < hi; i++) {
    const msg = rows[i][1];
    const role = pyStr(pyGet(msg, "role", null));
    const tsRaw = pyGet(msg, "timestamp", null);
    let ts = "?";
    if (pyTruthy(tsRaw)) {
      // py: (timestamp or 0) / 1000 —— 非数字会 TypeError, 不静默转换
      if (typeof tsRaw !== "number") throw new TypeError(`unsupported operand type(s) for /: '${pyTypeName(tsRaw)}' and 'int'`);
      ts = fmtStamp(tsRaw, "time"); // fmtStamp 收毫秒（= py 的 fromtimestamp(ts/1000)）
    }
    for (const c of pyIterate(pyGet(msg, "content", []))) {
      if (isPlainObject(c) && pyGet(c, "type", null) === "text" && pyTruthy(pyGet(c, "text", null))) {
        const txt = pyGet(c, "text", null);
        if (typeof txt !== "string") throw new TypeError(`'${pyTypeName(txt)}' object is not subscriptable`);
        out += `[${ts} ${role}] ${pySlice(txt, 200)}`.replaceAll("\n", " ") + "\n";
      }
    }
    if (pyGet(msg, "role", null) === "tool") out += `[${ts} toolResult] (工具输出)\n`;
  }
  out += `\n(共 ${hi - lo} 条, 目标在 jsonl_line=${target})\n`;
  return { out, code: 0 };
}

// ---------- sessions ----------

/** py: cmd_sessions(ws=None) */
export function runSessions(ws?: string | null, env: QueryEnv = queryEnv()): RunResult {
  const dump = (scope: Scope): string => {
    let out = "";
    // py: sorted(..., key=start_ts or 0, reverse=True) —— 稳定排序, 并列时保持 manifest 里的顺序
    const items = Object.entries(zc.sessions(scope.manifest)).map(([sid, m]) => {
      const raw = pyGet(m, "start_ts", null);
      const k = pyTruthy(raw) ? raw : 0;
      if (typeof k !== "number") throw new TypeError(`'<' not supported between instances of '${pyTypeName(k)}' and 'int'`);
      return { sid, m, k };
    });
    items.sort((a, b) => b.k - a.k);
    for (const it of items) {
      const ts = it.k ? fmtStamp(it.k, "date") : "?";
      out += `${ts}  ${it.sid}  (${pyStr(pyGet(it.m, "rows", 0))} msgs / ${pyStr(pyGet(it.m, "segments", 0))} segs)\n`;
    }
    return out;
  };

  if (ws === "all") {
    let out = "";
    // py 在这里不捕获 SystemExit: list_workspaces 只返回有 manifest 的目录, 正常不会抛
    for (const w of listWorkspaces(env.home)) {
      const scope = loadScope(w, env.home, env.hitRefine);
      out += `## ${w}\n`;
      out += dump(scope);
    }
    return { out, code: 0 };
  }
  return { out: dump(loadScope(ws || env.scopeName, env.home, env.hitRefine)), code: 0 };
}
