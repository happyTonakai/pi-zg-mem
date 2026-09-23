/**
 * lib/etl.ts — pi session JSONL → zg 分片语料（v2，增量续读）
 * =========================================================
 * 本文件是 extensions/zg-memory/jsonl2corpus.py 的 TypeScript 移植版，
 * 产物（分片字节 + manifest.json）必须与 Python 版**逐字节一致**。
 * 每个函数上方标注 Python 出处，便于逐条比对。
 *
 * 一个 session → 多个分片 `<sid>.pNNNN.txt`，每片 <= ZGMEM_SEG_ROWS/SEG_BYTES；
 * 只有最后一个"开放尾片"会被重写，冻结片字节永不改动 → zg 增量索引只重嵌尾片。
 *
 * 增量续读：manifest 记 last_jsonl_line / last_offset / prefix_sha（已处理前缀的 sha256）。
 *  - 校验前缀 sha 未变 + 尾片末行与 manifest 记的"尾片末条语料行"一致 → 只解析新行
 *  - 任一校验失败（JSONL 被改写/压缩/resume）→ 该 session 全量重建
 *
 * 移植期的约定（见 docs/plan-ts-migration.md，与 lib/corpus.ts 同一套）：
 *  - 只用"可擦除语法"，`node lib/etl.ts <glob> <corpus_dir> [--rebuild]` 可直接跑；
 *  - 相对导入必须带 .ts 扩展名；
 *  - I/O 全部同步（忠于 Python 的同步语义，先保证逐字节可对拍）；
 *  - 库层不 print：格式化输出集中在 etlMain()，格式与 Python 逐字节一致。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as zc from "./corpus.ts";

export const USAGE = `Usage: node lib/etl.ts <sessions_glob> <corpus_dir> [--rebuild]
  --rebuild  忽略既有状态, 强制全量重建所有匹配 session
`;

// ---------- 小工具 ----------

/** 与 lib/corpus.ts 内部同名助手保持一致的判定（不导出，避免扩大模块 A 的公开面）。 */
function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Python `int()` 的**错误语义**：`int(5)` 正常，`int(None)` 抛 TypeError，
 * `int("x")` 抛 ValueError，`int(float("inf"))` 抛 OverflowError。
 *
 * 为什么需要区分：jsonl2corpus.row_of 用 `except (TypeError, ValueError)` 兜住 ts
 * 解析失败（→ 0），但 OverflowError 会往上抛、让整个 session 失败。照抄这套语义，
 * 才不会把 Python 侧"会失败"的输入在 TS 侧悄悄吞掉。
 */
class PyIntError extends Error {
  kind: "TypeError" | "ValueError" | "OverflowError";
  constructor(kind: "TypeError" | "ValueError" | "OverflowError", message: string) {
    super(message);
    this.name = kind;
    this.kind = kind;
  }
}

/**
 * Python `int(str)`：允许首尾空白、可选正负号、数字之间单个下划线。
 * 已知可接受差异（同 lib/corpus.ts:parsePythonInt）：只认 ASCII 数字，且受 Number 精度限制。
 */
function pyIntOfString(s: string): number | null {
  const t = s.replace(new RegExp(`^[${PY_WS_CLASS}]+|[${PY_WS_CLASS}]+$`, "gu"), "");
  if (!/^[+-]?\d(?:_?\d)*$/.test(t)) return null;
  const n = Number(t.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** py: int(v) —— 只接受 bool / int|float / str，其余抛 TypeError（见 PyIntError）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new PyIntError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new PyIntError("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const n = pyIntOfString(v);
    if (n === null) throw new PyIntError("ValueError", `invalid literal for int() with base 10: '${v}'`);
    return n;
  }
  throw new PyIntError("TypeError", `int() argument must be a string or a number, not '${typeof v}'`);
}

/** py: type(e).__name__ */
function errName(e: unknown): string {
  if (e instanceof Error) return e.constructor.name || "Error";
  return typeof e;
}

/** py: str(e) */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * py: bool(v) —— Python 的真值语义。**不能直接用 JS 的真值**：
 * `[]` / `{}` 在 Python 是假值、在 JS 是真值，错用会把「跳过这一行」变成「整个 session 失败」。
 * 这正是评审 CRIT-2（`{"message": []}` 导致整会话丢失、退出码 2）的根因。
 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

/** py: `a or b` —— 只在 a 为 Python 假值时取 b。 */
function pyOr<T>(a: T, b: T): T | T {
  return pyTruthy(a) ? a : b;
}

// ---------- 文本清洗 ----------

/**
 * Python `str.isspace()` 为真的码点集合。**不能直接用 JS 的 `\s`**：
 * 少 \x1c-\x1f 与 \x85（Python 算空白），多 \ufeff（JS 算空白、Python 不算）。
 */
const PY_WS: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  ...Array.from({ length: 0x200b - 0x2000 }, (_, i) => 0x2000 + i),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const PY_WS_CLASS = Array.from(PY_WS, (c) => `\\u{${c.toString(16)}}`).join("");

/**
 * py: clean_text(text) —— `" ".join(text.split())`，只压缩空白。
 * 不做二次反转义：JSON 已解码，字面反斜杠 n / 反斜杠引号 是代码内容本身。
 *
 * 非字符串在这里抛异常是**故意的**：Python `(5).split()` 抛 AttributeError，
 * 让它冒到 per-session 的 try/except 里，失败可见（评审 H1 的同一精神）。
 */
export function cleanText(text: unknown): string {
  if (typeof text !== "string") {
    throw new TypeError(`'${typeof text}' object has no attribute 'split'`);
  }
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    // 按码点迭代：代理对不会被拆成两半
    if (PY_WS.has(ch.codePointAt(0) as number)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join(" ");
}

// ---------- 一行 JSONL -> 一条语料行 ----------

const utf8 = new TextDecoder("utf-8"); // 非 fatal：非法字节 -> U+FFFD，等价 py: decode("utf-8","replace")

/**
 * py: row_of(raw, line_no) —— 一行 JSONL → Row；非 user/assistant text 消息返回 null。
 *
 * 结构上的 `or {}` / 属性访问都照抄 Python 的失败模式：
 *  - message 不是对象（如 `"message": "oops"`）→ Python AttributeError → 这里抛 TypeError；
 *  - content 是数字 → Python `for c in 5` TypeError → pyIterate 抛 TypeError；
 *  - content 是 dict → Python 迭代的是**键**（全被 isinstance(c, dict) 挡掉）→ 这里迭代键；
 *  - text 不是字符串 → Python AttributeError → cleanText 抛 TypeError。
 * 这些都是 pi 不会产出的畸形 JSONL，但保持"失败可见"比静默跳过安全。
 */
// py: row_of(raw, line_no)
export function rowOf(raw: Buffer, lineNo: number): zc.Row | null {
  let d: unknown;
  try {
    d = JSON.parse(utf8.decode(raw));
  } catch {
    return null; // py: except Exception: return None
  }
  if (!isPlainObject(d) || d["type"] !== "message") return null;
  // py: msg = d.get("message") or {} —— 用 pyOr 才能对齐 `[]`（Python 假值 / JS 真值）
  const msg = pyOr(d["message"], {});
  if (!isPlainObject(msg)) throw new TypeError(`'${typeof msg}' object has no attribute 'get'`);
  const role = msg["role"];
  if (role !== "user" && role !== "assistant") return null;

  let ts = pyOr(pyOr(msg["timestamp"], d["timestamp"]), 0);
  const texts: string[] = [];
  for (const c of pyIterate(pyOr(msg["content"], []))) {
    if (!isPlainObject(c)) continue;
    if (c["type"] !== "text") continue;
    const t = c["text"];
    if (pyTruthy(t)) texts.push(cleanText(t));
  }
  if (!texts.length) return null;
  try {
    ts = pyInt(ts);
  } catch (e) {
    // py: except (TypeError, ValueError): ts = 0 —— OverflowError 不在其中，会往上抛
    if (e instanceof PyIntError && e.kind !== "OverflowError") ts = 0;
    else throw e;
  }
  return { jsonlLine: lineNo, role, ts, text: texts.join(" ") };
}

/** py 的 `for x in v`：list/str（按码点）/dict（按键）可迭代，其余抛 TypeError。 */
function* pyIterate(v: unknown): Generator<unknown> {
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
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

// ---------- 逐行扫描 ----------

export interface ScannedLine {
  jsonlLine: number;
  row: zc.Row | null;
  /** 该行末字节在文件里的绝对偏移（下一行的起点）。 */
  end: number;
}

/**
 * py: scan(path, start_offset, first_line_no, hasher)
 *
 * 从 start_offset（必须是行边界）起顺序解析**完整**行，已消费字节实时喂给 hasher；
 * 末尾无 \n 的半行不消费（下次再说），也**不喂 hasher**。
 *
 * 读不了（权限/IO 错）就抛出去：早先这里静默 return，结果是"会话读不到"被当成空会话
 * 写进 manifest（0 条），全链路还报成功（评审 H1）。
 */
export function* scan(
  p: string,
  startOffset: number,
  firstLineNo: number,
  hasher: crypto.Hash,
): Generator<ScannedLine> {
  const CHUNK = 1 << 20;
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    // 尚未凑成整行的尾巴。用「块列表」而不是单个 carry 缓冲区：
    // 每读到一个不含 \n 的 1MiB 块就 Buffer.concat 一次是 O(L²)，一行 L 字节会被拖死；
    // 这里只在真正找到换行时才拼一次，且正常行（<64KiB）根本不会拼。
    let pending: Buffer[] = [];
    let base = startOffset; // pending[0] 首字节的绝对偏移
    let no = firstLineNo;
    for (;;) {
      const pendingLen = pending.reduce((s, b) => s + b.length, 0);
      const n = fs.readSync(fd, buf, 0, CHUNK, base + pendingLen);
      if (n <= 0) return;
      pending.push(Buffer.from(buf.subarray(0, n)));
      for (;;) {
        let idx = -1;
        let nl = -1;
        for (let i = 0; i < pending.length; i++) {
          const at = pending[i].indexOf(0x0a);
          if (at !== -1) {
            idx = i;
            nl = at;
            break;
          }
        }
        if (idx === -1) break; // 还没有整行
        const head = pending.slice(0, idx);
        const lineLen = head.reduce((s, b) => s + b.length, 0) + nl + 1;
        const raw = head.length
          ? Buffer.concat([...head, pending[idx].subarray(0, nl + 1)])
          : pending[idx].subarray(0, nl + 1);
        hasher.update(raw);
        yield { jsonlLine: no, row: rowOf(raw, no), end: base + lineLen };
        no += 1;
        const rest = pending[idx].subarray(nl + 1);
        base += lineLen;
        pending = rest.length ? [rest] : [];
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// ---------- 增量续读的前置校验 ----------

/**
 * py: _prefix_hasher(path, st, sess) —— 返回已喂入 [0:last_offset) 的 hasher；不可增量返回 null。
 *
 * 与 Python 的 h.hexdigest() 不同，Node 的 digest() 会把 hasher 终结掉，
 * 所以先 copy() 出一份做比较，仍在用的那份继续接收新行。
 */
function prefixHasher(p: string, st: fs.BigIntStats, sess: zc.SessionMeta): crypto.Hash | null {
  const lo = Math.trunc(sess.last_offset || 0);
  const ps = sess.prefix_sha;
  if (lo <= 0 || !ps || Number(st.size) < lo) return null;
  const h = zc.newHasher();
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(lo, 1)));
    let left = lo;
    while (left > 0) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, left), null);
      if (read <= 0) return null;
      h.update(buf.subarray(0, read));
      left -= read;
    }
  } catch {
    return null; // py: except OSError: return None
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  return h.copy().digest("hex") === ps ? h : null;
}

/**
 * py: _tail_consistent(corpus_dir, man, sid, sess)
 *
 * 尾片末行必须与 manifest 记的"尾片末条语料行的 jsonl_line"一致（防半程写坏后重复追加）。
 *
 * 不能拿 last_jsonl_line 比：它是"扫描到的最后一行 JSONL"，而语料只收 user/assistant
 * 文本消息 —— 会话末尾总是 toolResult/toolCall（agent 干活时的常态），两者天然不等，
 * 会导致每轮刷新都整会话重建（评审 M1）。
 */
function tailConsistent(corpusDir: string, man: zc.Manifest, sid: string, sess: zc.SessionMeta): boolean {
  const tail = zc.openTail(man, sid);
  if (!tail) return true; // 没有尾片（例如上次刚好整片冻结/空会话）
  const rows = zc.readSegment(corpusDir, tail.fname, tail.start_corpus_line || 1);
  if (!rows.length) return false; // 尾片文件缺失/损坏
  let want = sess.last_row_jsonl_line;
  if (want === undefined || want === null) want = sess.last_jsonl_line || 0;
  return rows[rows.length - 1].jsonlLine === want;
}

/** py: can_continue(...) —— 返回可继续使用的 hasher，不能续读返回 null。 */
function canContinue(
  p: string,
  st: fs.BigIntStats,
  corpusDir: string,
  man: zc.Manifest,
  sid: string,
  sess: zc.SessionMeta | undefined,
): crypto.Hash | null {
  if (!sess) return null;
  if (path.resolve(p) !== sess.jsonl_path) return null;
  if (!tailConsistent(corpusDir, man, sid, sess)) return null;
  return prefixHasher(p, st, sess);
}

// ---------- 分片登记 ----------

/** py: _register_segment(...) —— 调用方保证文件已经写成功。键顺序必须与 Python 一致。 */
function registerSegment(
  man: zc.Manifest,
  sid: string,
  fname: string,
  rows: zc.Row[],
  seq: number,
  startGlobal: number,
  frozen: boolean,
): void {
  zc.segments(man)[fname] = {
    session_id: sid,
    seq,
    rows: rows.length,
    start_jsonl_line: rows.length ? rows[0].jsonlLine : 0,
    start_corpus_line: startGlobal,
    start_ts: rows.length ? rows[0].ts : null,
    frozen: Boolean(frozen),
  };
}

/** py: next(zc.seq_allocator(...)) —— 取尽即抛（模块 A 已去掉 257 上限，正常取不尽）。 */
function nextSeq(g: Generator<number>): number {
  const r = g.next();
  if (r.done) throw new Error("StopIteration");
  return r.value;
}

// ---------- 主流程 ----------

export interface ProcessOptions {
  /** 忽略既有状态，强制全量重建（py: force=True）。 */
  force?: boolean;
  /** 覆盖分片上限（Python 侧靠 monkeypatch 模块常量 MAX_SEG_ROWS；TS 侧显式传参）。 */
  limits?: zc.SegLimits | null;
}

export interface ProcessResult {
  status: string;
  nNew: number;
}

/**
 * py: process_session(path, corpus_dir, man, force=False) -> (status, n_new)
 *
 * 写序刻意分成"算 → 写 staging → 换入 → 登记"：新片全部落盘成功后才丢旧分片/登记 manifest。
 * 重建时若写片阶段出错（ENOSPC/os.replace 失败/被 kill），旧语料与 manifest 条目原样保留（评审 MED-1）。
 */
export function processSession(
  p: string,
  corpusDir: string,
  man: zc.Manifest,
  opts: ProcessOptions = {},
): ProcessResult {
  const sid = path.basename(p, path.extname(p));
  // py: os.stat(path) —— 读不到就抛（不静默当空会话）。
  // bigint: true 是为了拿到精确纳秒：Python 的 st_mtime 是 double 秒（tv_sec + tv_nsec/1e9），
  // 而非 bigint 的 st.mtimeMs 已经丢过一次精度，截断后会在舍入边界差 1（评审 HIGH-1）。
  const st = fs.statSync(p, { bigint: true });
  const sess: zc.SessionMeta | undefined = zc.sessions(man)[sid];

  const hasher = opts.force ? null : canContinue(p, st, corpusDir, man, sid, sess);
  const incremental = hasher !== null;
  let firstLine: number;
  let startOffset: number;
  let h: crypto.Hash;
  if (incremental) {
    firstLine = (sess?.last_jsonl_line || 0) + 1;
    startOffset = Math.trunc(sess?.last_offset || 0);
    h = hasher as crypto.Hash;
  } else {
    firstLine = 1;
    startOffset = 0;
    h = zc.newHasher();
  }

  const newRows: zc.Row[] = [];
  let lastNo = incremental ? sess?.last_jsonl_line || 0 : 0;
  let lastOff = startOffset;
  for (const { jsonlLine, row, end } of scan(p, startOffset, firstLine, h)) {
    lastNo = jsonlLine;
    lastOff = end;
    if (row) newRows.push(row);
  }

  let segs = zc.segsFor(man, sid);
  let tail = zc.openTail(man, sid);
  let tailRows: zc.Row[];
  let tailSeq: number;
  let startGlobal: number;
  if (!incremental) {
    // 重建：分片号/全局行号从 1 重排（删旧分片推迟到新片写成功之后，见下）
    segs = [];
    tail = null;
    tailRows = [];
    tailSeq = 1;
    startGlobal = 1;
  } else if (tail) {
    tailRows = zc
      .readSegment(corpusDir, tail.fname, tail.start_corpus_line || 1)
      .map((r) => ({ jsonlLine: r.jsonlLine, role: r.role, ts: r.ts, text: r.text }));
    tailSeq = tail.seq || 1;
    startGlobal = tail.start_corpus_line || 1;
  } else {
    tailRows = [];
    tailSeq = Math.max(0, ...segs.map((s) => s.seq || 0)) + 1;
    startGlobal = Math.max(1, ...segs.map((s) => (s.start_corpus_line || 1) + (s.rows || 0)));
  }

  const allRows = tailRows.concat(newRows);
  const nNew = newRows.length;

  const planned: { fname: string; rows: zc.Row[]; seq: number; startGlobal: number; frozen: boolean }[] = [];
  if (nNew === 0 && tailRows.length) {
    // jsonl 变了但没产出新消息（例如只改了 toolResult 行）：尾片无需重写
  } else {
    const seqs = zc.seqAllocator(segs, tailSeq);
    let rest = allRows;
    for (;;) {
      const cut = zc.splitPoint(rest, opts.limits ?? null);
      if (cut === null) break;
      const chunk = rest.slice(0, cut);
      const seq = nextSeq(seqs);
      planned.push({ fname: zc.segName(sid, seq), rows: chunk, seq, startGlobal, frozen: true });
      startGlobal += chunk.length;
      rest = rest.slice(cut);
    }
    if (rest.length) {
      const seq = nextSeq(seqs);
      planned.push({ fname: zc.segName(sid, seq), rows: rest, seq, startGlobal, frozen: false });
    } else if (tail) {
      // 尾片被整体吃进冻结片（或本次无剩余）：旧尾片文件已由首个冻结片覆盖；
      // 若无冻结片且无剩余（空会话）则删除旧尾片，避免残留
      if (!planned.length) {
        try {
          fs.unlinkSync(path.join(corpusDir, zc.segName(sid, tailSeq)));
        } catch {
          /* py: except OSError: pass */
        }
        delete zc.segments(man)[zc.segName(sid, tailSeq)]; // 别留指向已删文件的条目
      }
    }
  }

  // 重建：先记下"旧状态"，但删除推迟到新片写成功之后
  const oldFiles = !incremental ? zc.corpusFilesOf(corpusDir, sid) : [];
  const oldFnames = !incremental
    ? Object.entries(zc.segments(man))
        .filter(([, m]) => isPlainObject(m) && m["session_id"] === sid)
        .map(([fn]) => fn)
    : [];

  // 先把新片写成隐藏的 staging 文件（不碰现有语料），全部写成功后再一次性换入。
  // 任何一片写失败（ENOSPC/os.replace 失败/被 kill）都只会留下可清理的 staging，
  // 旧分片与 manifest 条目原样不动（评审 MED-1）
  const staged: { staging: string; final: string }[] = [];
  try {
    for (const pl of planned) {
      const staging = `.${pl.fname}.staging`;
      zc.writeSegment(corpusDir, staging, pl.rows, pl.rows.length ? pl.rows[0].ts : null);
      staged.push({ staging: path.join(corpusDir, staging), final: path.join(corpusDir, pl.fname) });
    }
    for (const s of staged) fs.renameSync(s.staging, s.final);
  } catch (e) {
    for (const s of staged) {
      try {
        fs.unlinkSync(s.staging);
      } catch {
        /* py: except OSError: pass */
      }
    }
    throw e;
  }

  if (!incremental) {
    const newNames = new Set(planned.map((x) => x.fname));
    for (const pth of oldFiles) {
      if (newNames.has(path.basename(pth))) continue; // 本次重写过的片留着（内容已是新的）
      try {
        fs.unlinkSync(pth);
      } catch {
        /* py: except OSError: pass */
      }
    }
    for (const fn of oldFnames) delete zc.segments(man)[fn];
    delete zc.sessions(man)[sid];
  }

  for (const pl of planned) registerSegment(man, sid, pl.fname, pl.rows, pl.seq, pl.startGlobal, pl.frozen);

  let totalRows = 0;
  for (const m of Object.values(zc.segments(man))) {
    if (m && m.session_id === sid) totalRows += m.rows || 0;
  }
  const nSegs = Object.values(zc.segments(man)).filter((m) => m && m.session_id === sid).length;

  // py: prev_start_ts = (sess or {}).get("start_ts"); if prev_start_ts is None and all_rows: ...
  // 注意 Python 的判空是 `is None` 而不是“键不存在”：增量续读时 sess 里可能就是一个**显式的 null**
  // （上一轮文件被截到 0 行），此时也必须回退到 all_rows[0].ts，否则 start_ts 会永久僵在 null。
  // 用 `=== undefined` 判断会漏掉这种情况（差分对拍实测：4 个 workspace 的续读 manifest 少 9n 字节）。
  let prevStartTs: number | null = incremental && sess ? (sess.start_ts ?? null) : null;
  if (prevStartTs === null && allRows.length) prevStartTs = allRows[0].ts || null;

  // 字节细节：int(st.st_mtime * 1000)。Python 的 st_mtime = float(tv_sec) + float(tv_nsec) / 1e9
  // （CPython 自己就是这么算的），所以必须拆开秒/纳秒再相加，运算顺序也要一致：
  // 任何“先除后乘”的写法都会在舍入边界上差 1（评审 HIGH-1）。
  const MTIME_NS_PER_SEC = 1_000_000_000n;
  const mtimeMs = Math.trunc(
    (Number(st.mtimeNs / MTIME_NS_PER_SEC) + Number(st.mtimeNs % MTIME_NS_PER_SEC) / 1e9) * 1000,
  );

  zc.sessions(man)[sid] = {
    jsonl_path: path.resolve(p),
    start_ts: prevStartTs,
    jsonl_mtime: mtimeMs,
    jsonl_size: Number(st.size),
    last_jsonl_line: lastNo,
    last_row_jsonl_line: allRows.length ? allRows[allRows.length - 1].jsonlLine : 0,
    last_offset: lastOff,
    prefix_sha: h.digest("hex"),
    rows: totalRows,
    segments: nSegs,
  };
  const mode = incremental ? "inc" : "rebuild";
  return { status: `  ${sid}  ${totalRows} msgs / ${nSegs} segs  (+${nNew} ${mode})`, nNew };
}

// ---------- 迁移清理 ----------

/** py: glob.glob(join(dir, "*.txt")) —— Python 的 glob 不匹配隐藏文件。 */
function listTxt(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((b) => !b.startsWith(".") && b.endsWith(".txt"))
    .map((b) => path.join(dir, b))
    .sort();
}

export interface CleanupResult {
  removed: string[];
  failed: { name: string; error: unknown }[];
}

/**
 * py: migrate_cleanup(corpus_dir, man, prev_sids=())
 *
 * v1→v2 / manifest 损坏迁移后：清掉不再被引用的遗留语料文件。只删"确属本工具产物"的文件，
 * 名字对不上的一概不碰：
 *   - v1 单文件 `<sid>.txt`：仅当 sid 是已知 session（旧 manifest 或新 manifest 里有）；
 *   - 分片 `<sid>.pNNNN.txt`：仅当 sid 已不存在（孤儿片）；已知 session 的片保留。
 * 历史上这里删任何非隐藏 .txt -> 用户放在语料目录里的 notes.txt 会在迁移时被删掉（评审 H3）。
 *
 * Python 版会直接 print；这里只返回，格式化交给调用方（评审：库层不 print）。
 */
export function migrateCleanup(
  corpusDir: string,
  man: zc.Manifest,
  prevSids: Iterable<string> = [],
): CleanupResult {
  const keep = new Set(Object.keys(zc.segments(man)));
  const known = new Set([...Object.keys(zc.sessions(man)), ...prevSids]);
  const removed: string[] = [];
  const failed: { name: string; error: unknown }[] = [];
  for (const p of listTxt(corpusDir)) {
    const b = path.basename(p);
    if (b.startsWith(".") || keep.has(b)) continue;
    const seg = zc.parseSeg(b);
    if (seg && known.has(seg.sid)) continue; // 已知 session 的分片：不动
    if (!seg && !(zc.isLegacyName(b) && known.has(path.basename(b, ".txt")))) continue; // 不是我们的产物
    try {
      fs.unlinkSync(p);
      removed.push(b);
    } catch (e) {
      failed.push({ name: b, error: e });
    }
  }
  return { removed, failed };
}

/** py: `head = ", ".join(removed[:5]) + (" ..." if len(removed) > 5 else "")` */
function removedHead(removed: string[]): string {
  return removed.slice(0, 5).join(", ") + (removed.length > 5 ? " ..." : "");
}

// ---------- glob ----------

/** py: fnmatch.fnmatch(name, pat) 的单段实现（支持 * ? [seq] [!seq]，大小写敏感）。 */
export function fnmatch(pat: string, name: string): boolean {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      let j = i + 1;
      if (j < pat.length && (pat[j] === "!" || pat[j] === "^")) j += 1;
      if (j < pat.length && pat[j] === "]") j += 1;
      while (j < pat.length && pat[j] !== "]") j += 1;
      if (j >= pat.length) {
        re += "\\["; // 未闭合的 [ 当字面量（fnmatch 的行为）
      } else {
        let stuff = pat.slice(i + 1, j);
        if (stuff.startsWith("!")) {
          stuff = `^${stuff.slice(1)}`;
        } else if (stuff.startsWith("^")) {
          // fnmatch.translate 对首字符 ^ 做转义：`[^a]` 在 Python 里是**字面 ^ 或 a**，不是取反
          stuff = `\\^${stuff.slice(1)}`;
        }
        re += `[${stuff.replace(/\\/g, "\\\\")}]`;
        i = j;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * py: glob.glob(pattern) 的最小等价物。
 *
 * 真实调用只有 `<sessions_dir>/*.jsonl` 一种形态，所以这里只实现单段通配：
 * `*` / `?` / `[...]`，并遵守 glob 的隐藏文件规则（通配符不吃以 . 开头的名字）；
 * `**` 不特殊（Python 需 recursive=True 才特殊，否则等价于 `*`）。
 */
export function globPaths(pattern: string): string[] {
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter((s, i) => !(i === 0 && s === ""));
  let out = [abs ? "/" : "."];
  for (const seg of segs) {
    const next: string[] = [];
    if (!/[*?[]/.test(seg)) {
      for (const base of out) {
        const p = path.join(base, seg);
        if (fs.existsSync(p)) next.push(p);
      }
    } else {
      for (const base of out) {
        for (const name of listDirNames(base)) {
          if (name.startsWith(".") && !seg.startsWith(".")) continue;
          if (fnmatch(seg, name)) next.push(path.join(base, name));
        }
      }
    }
    out = next;
  }
  return out.sort();
}

// ---------- CLI ----------

export interface EtlResult {
  /** 按顺序的 stdout 行（不含换行；"" 表示空行），与 Python print 序列逐行对应。 */
  lines: string[];
  code: number;
}

export interface EtlOptions {
  force?: boolean;
  limits?: zc.SegLimits | null;
  /** Python 版用 traceback.print_exc() 走 stderr；这里可注入，便于测试捕获。 */
  stderr?: (s: string) => void;
}

/**
 * py: main() 的主体（去掉 sys.argv 解析与 print，改为返回值）。
 *
 * 失败处理是重点（评审 H1）：单个 session 抛异常时**回滚该 session 的 manifest 改动**、
 * 记录失败、最后 exit 2 —— 修前是吞掉异常 + exit 0，让"整个 session 没进语料"看起来和成功一样。
 */
export function runEtl(globIn: string, corpusDir: string, opts: EtlOptions = {}): EtlResult {
  const lines: string[] = [];
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const force = Boolean(opts.force);
  fs.mkdirSync(corpusDir, { recursive: true });
  const mpath = zc.manifestPathFor(corpusDir);

  let paths = globPaths(globIn);
  return zc.withManifestLock(mpath, () => {
    const raw = zc.loadManifestRaw(mpath);
    const legacy = raw !== null && (!isPlainObject(raw) || raw["version"] !== zc.MANIFEST_VERSION);
    // 迁移前旧 manifest 的 session 名单：migrate_cleanup 只按它判断"哪些遗留文件是我们的"。
    // v1 是扁平 {<sid>.txt: {...}} 而不是 {"sessions": {...}} —— 早先这里只认后者，
    // 于是 prev_sids 恒为空集，jsonl 已消失的 legacy 文件永远不会被清理（评审 LOW-1）
    let prevSids: Set<string>;
    const rawSessions = isPlainObject(raw) ? raw["sessions"] : undefined;
    if (isPlainObject(rawSessions)) {
      prevSids = new Set(Object.keys(rawSessions));
    } else if (isPlainObject(raw)) {
      prevSids = new Set(
        Object.keys(raw)
          .filter((k) => k.endsWith(".txt"))
          .map((k) => k.slice(0, -".txt".length)),
      );
    } else {
      prevSids = new Set();
    }

    const man = zc.loadManifest(mpath);
    if (!paths.length) {
      lines.push(`no sessions matched: ${globIn}`);
      return { lines, code: 1 };
    }
    // 老用户升级路径：manifest 整个不在（换目录/先删了），但语料目录里还塞着 .txt。
    // 若不管，已知 session 的 v1 单文件会"被 zg 索引、却在查询侧被过滤掉" -> 隐形重复（评审 L2）。
    // 不设 legacy=True：那是"非 v2 -> 全量重建本目录所有 jsonl"的语义，比 L2 要的重。
    const cleanup = legacy || (raw === null && listTxt(corpusDir).length > 0);
    const swept = zc.sweepStaleTmp(corpusDir); // LOW-5（共享实现；zgmem refresh 里也调一次）
    if (swept.length) lines.push(`  清理残留半成品 ${swept.length} 个: ${removedHead(swept)}`);
    if (legacy) {
      // 迁移：处理该 sessions 目录下所有 jsonl，避免旧语料变成查不到的孤儿
      const sdir = path.dirname(path.resolve(globIn));
      paths = [...new Set([...paths, ...globPaths(path.join(sdir, "*.jsonl"))])].sort();
      lines.push(`manifest 非 v${zc.MANIFEST_VERSION}(迁移/损坏), 全量重建 ${paths.length} 个 session`);
    }

    let totalNew = 0;
    const etlFail: { p: string; error: unknown }[] = [];
    for (const p of paths) {
      const snapshot = structuredClone(man); // 失败回滚：绝不把半截状态落盘（评审 MED-1）
      try {
        const { status, nNew } = processSession(p, corpusDir, man, { force, limits: opts.limits ?? null });
        totalNew += nNew;
        lines.push(status);
      } catch (e) {
        // 不能只打一行就 continue：历史上这里吞掉异常 + 结尾 exit 0，
        // 让"整个 session 没进语料"看起来和成功一模一样（评审 H1）。
        err(`${e instanceof Error ? e.stack ?? String(e) : String(e)}\n`);
        etlFail.push({ p, error: e });
        man.version = snapshot.version;
        man.sessions = snapshot.sessions;
        man.segments = snapshot.segments;
        continue;
      }
    }
    zc.saveManifest(mpath, man);
    if (cleanup) {
      const { removed, failed } = migrateCleanup(corpusDir, man, prevSids);
      // py 的打印顺序：循环里逐条 print 清理失败，循环结束才 print 汇总（jsonl2corpus.py:311,314）
      for (const f of failed) lines.push(`  清理失败 ${f.name}: ${errMsg(f.error)}`);
      if (removed.length) lines.push(`  清理遗留语料 ${removed.length} 个: ${removedHead(removed)}`);
    }

    lines.push("");
    lines.push(`${paths.length} 个 session, 本次新增 ${totalNew} 条`);
    lines.push(
      `manifest v${man.version}: ${Object.keys(zc.sessions(man)).length} sessions / ` +
        `${Object.keys(zc.segments(man)).length} segments -> ${mpath}`,
    );
    if (etlFail.length) {
      lines.push("");
      lines.push(`失败 ${etlFail.length}/${paths.length} 个 session(未入语料, 语料不完整):`);
      for (const f of etlFail) lines.push(`  - ${path.basename(f.p)}: ${errName(f.error)}: ${errMsg(f.error)}`);
      lines.push("  修掉原因后重跑本命令即可: 失败的 session 已回滚(旧分片与 manifest 条目保持原样), 语料里没有半截会话");
      return { lines, code: 2 };
    }
    return { lines, code: 0 };
  });
}

export interface EtlIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: EtlIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * `node lib/etl.ts <sessions_glob> <corpus_dir> [--rebuild]`
 *
 * 与 Python 的 sys.exit 对齐：0 成功 / 1 没有匹配到 session / 2 有 session 失败。
 * 差异（有意）：参数不对时打印的用法文本是 TS 版的自述，不是 Python 的 __doc__。
 */
export function etlMain(argv: string[], io: EtlIO = defaultIO): number {
  const args = argv.filter((a) => !a.startsWith("--"));
  const force = argv.includes("--rebuild");
  if (args.length !== 2) {
    io.out(USAGE);
    return 2;
  }
  const res = runEtl(args[0], args[1], { force, stderr: io.err });
  for (const l of res.lines) io.out(`${l}\n`);
  return res.code;
}

if (import.meta.main) process.exitCode = etlMain(process.argv.slice(2));
