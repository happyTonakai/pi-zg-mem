/**
 * zgmem_corpus — 分片语料布局 + manifest v2 的共享读写层
 * =====================================================
 * 本文件是 extensions/zg-memory/zgmem_corpus.py 的 TypeScript 移植版，
 * 行为必须与 Python 版**逐字节一致**。每个函数上方标注 Python 出处，便于逐条比对。
 *
 * 移植期的约定（见 docs/plan-ts-migration.md）：
 *  - 只用"可擦除语法"（无 enum / namespace / 装饰器 / 构造函数参数属性），
 *    这样 `node x.ts` 与 `node --test t.test.ts` 都能直接跑，不需要构建。
 *  - 相对导入必须带 .ts 扩展名（Node 原生类型剥离不做无扩展名解析）。
 *  - I/O 暂时全部用同步 API —— 忠于 Python 版的同步语义，先保证逐字节可对拍；
 *    异步化留到模块 B（ETL 扫描大文件时才是真瓶颈），届时单独提交、单独验证。
 *  - 库层不 print（Python 版在 sweep_stale_tmp / migrate_cleanup 里直接打印），
 *    改为返回值，由 lib/cli.ts 负责格式化，格式必须与 Python 输出逐字节一致。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// py: zgmem_corpus.py:31-34
export const MANIFEST_VERSION = 2;
export const MAX_SEG_ROWS = intEnv("ZGMEM_SEG_ROWS", 200);
export const MAX_SEG_BYTES = intEnv("ZGMEM_SEG_BYTES", 64 * 1024);

/**
 * py: int(os.environ.get(name, str(def))) —— Python 在导入期解析环境变量，
 * 非法值会让进程直接崩掉（ValueError）。这里保持同样的行为：非法即抛。
 */
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = parsePythonInt(raw);
  if (n === null) throw new Error(`invalid literal for int() with base 10: '${raw}'`);
  return n;
}

/** seq 位数不设上界（4 位起，超过 9999 片自然涨到 5 位）：长会话可以无限分片。 */
// py: _SEG_RE = re.compile(r"^(?P<sid>.+)\.p(?P<seq>\d{4,})\.txt$")
const SEG_RE = /^(.+)\.p(\d{4,})\.txt$/;

// ---------- 行类型 ----------
/** 语料行（对应 Python 的 4 元组 (jsonl_line, role, ts, text)）。 */
export interface Row {
  jsonlLine: number;
  role: string;
  ts: number;
  text: string;
}

/** 带全局行号的语料行（对应 Python 的 5 元组 (line, jsonl_line, role, ts, text)）。 */
export interface CorpusRow extends Row {
  /** 该 session 内跨分片的全局行号（1-based），即 ref 里的 corpus_line。 */
  line: number;
}

export interface SegmentMeta {
  session_id: string;
  seq: number;
  rows: number;
  start_jsonl_line: number;
  start_corpus_line: number;
  start_ts: number | null;
  frozen: boolean;
}

/** manifest 的 session 条目（Python 侧是裸 dict，字段见 jsonl2corpus.py 末尾）。 */
export interface SessionMeta {
  jsonl_path?: string;
  start_ts?: number | null;
  jsonl_mtime?: number;
  jsonl_size?: number;
  last_jsonl_line?: number;
  last_row_jsonl_line?: number;
  last_offset?: number;
  prefix_sha?: string;
  rows?: number;
  segments?: number;
}

export interface Manifest {
  version: number;
  sessions: Record<string, SessionMeta>;
  segments: Record<string, SegmentMeta>;
}

/** 分片元数据 + 文件名（对应 Python 的 {"fname": fn, **m}）。 */
export type SegWithName = SegmentMeta & { fname: string };

/**
 * Python int(s) 的严格等价物。
 *
 * 为什么不能直接用 Number()：`int("12.0")` 抛异常 → read_segment 会跳过该行；
 * 而 `Number("12.0") === 12` 会静默接受，把坏行吃进语料。这是行为差异，必须严格。
 *
 * 已知的、可接受的差异：Python 的 int() 还接受 Unicode 数字（如阿拉伯-印度数字），
 * 这里只认 ASCII 数字；Python 整数无上界，这里受 Number 精度限制（>2^53 会失真）。
 * 这两种输入在真实语料里不会出现（我们自己写的是 ASCII 十进制）。
 */
export function parsePythonInt(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  const m = /^([+-]?)(\d(?:_?\d)*)$/.exec(t);
  if (!m) return null;
  const digits = m[2].replace(/_/g, "");
  const n = Number(m[1] + digits);
  return Number.isFinite(n) ? n : null;
}

// ---------- 命名 ----------
// py: seg_name(sid, seq) -> f"{sid}.p{seq:04d}.txt"
export function segName(sid: string, seq: number): string {
  // Python 的 f"{seq:04d}" 把负号算进宽度（-1 -> "-001"），padStart 做不到，要分开处理。
  // 实际运行中 seq 恒 >=1，这里只是不让一个不会发生的输入成为已知差异。
  const sign = seq < 0 ? "-" : "";
  return `${sid}.p${sign}${String(Math.abs(seq)).padStart(4 - sign.length, "0")}.txt`;
}

/**
 * 分片文件名 -> {sid, seq}；非分片名返回 null。
 * 注意正则用贪婪 `.+`（Python 侧同为贪婪），所以 "a.p0001.p0002.txt" 的 sid 是
 * "a.p0001"，与 Python 一致。
 */
// py: parse_seg(fname)
export function parseSeg(fname: string): { sid: string; seq: number } | null {
  // Python 的 `$`（非 multiline）除字串末尾外，还匹配**尾随换行之前**的位置，
  // 所以 "sess.p0001.txt\n" 在 Python 侧是合法分片名（sid 不含 \n）。JS 的 `$` 不吃这个，
  // 必须显式去一个尾随 \n 才能与 Python 完全一致。差分对拍发现，见 tests/differential/。
  const m = SEG_RE.exec((fname || "").replace(/\n$/, ""));
  if (!m) return null;
  const seq = parseInt(m[2], 10);
  return { sid: m[1], seq };
}

/** v1 时代的单文件语料名 <sid>.txt（非分片、非隐藏 tmp）。 */
// py: is_legacy_name(fname)
export function isLegacyName(fname: string): boolean {
  return Boolean(fname) && fname.endsWith(".txt") && !fname.startsWith(".") && !parseSeg(fname);
}

/** Python 的 glob.escape：把 * ? [ ] 转义成字符类。 */
// py: glob_escape(s)
export function globEscape(s: string): string {
  return (s || "").replace(/([*?[\]])/g, "[$1]");
}

// ---------- manifest ----------
// py: empty_manifest() —— 键顺序必须保持一致（version, sessions, segments），否则 JSON 字节不等
export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, sessions: {}, segments: {} };
}

// py: manifest_path_for(corpus_dir) —— manifest 放在语料目录的**父目录**
export function manifestPathFor(corpusDir: string): string {
  return path.join(path.dirname(path.resolve(corpusDir)), "manifest.json");
}

/** Python 语义的 "是 dict"：排除 null 与数组。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读 v2 manifest；缺失/损坏/旧版本 -> 空 manifest（调用方按"全量重建"处理）。
 * 与 Python 一致：**不抛异常**，任何异常都退化为空 manifest。
 */
// py: load_manifest(path)
export function loadManifest(mpath: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(mpath, "utf8"));
  } catch {
    return emptyManifest();
  }
  if (!isPlainObject(raw)) return emptyManifest();
  const obj = raw as Record<string, unknown>;
  if (obj.version !== MANIFEST_VERSION || !isPlainObject(obj.sessions) || !isPlainObject(obj.segments)) {
    return emptyManifest();
  }
  return obj as unknown as Manifest;
}

/** 原样读磁盘 manifest（不判断版本）；不存在/损坏返回 null。 */
// py: load_manifest_raw(path)
export function loadManifestRaw(mpath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(mpath, "utf8"));
  } catch {
    return null;
  }
}

/** 锁的租约：超过这个时长没被刷新，视为崩溃残留可接管（见 docs/plan-ts-migration.md 待决项 1）。 */
export const LOCK_LEASE_MS = intEnv("ZGMEM_LOCK_LEASE_MS", 10 * 60 * 1000);

/** 同步 sleep —— Python 的 flock 是**阻塞**等锁，这里用轮询等价实现。 */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * 跨进程互斥。
 *
 * ⚠️ 与 Python 版（fcntl.flock）的**已知语义差异**：Node 没有原生 flock，
 * macOS 也没有 flock(1) 命令。这里用"原子创建 + 租约接管"实现：
 *   - `open(lock, 'wx')` 原子创建并写入 {pid, ts}；
 *   - 已存在时，若 age > LOCK_LEASE_MS 视为崩溃残留，删除后重试；否则轮询等待（阻塞语义）。
 * 弱于 flock 之处：租约过期后理论上可双持锁。之所以可接受——真正的抗损坏靠
 * 原子写 + staging + manifest 快照回滚，锁只负责"别让两个刷新同时干活"。
 *
 * 迁移期兼容：Python 版持有 flock 的同时，磁盘上那个 `.lock` 文件**一直是空的**
 * （flock 释放但文件不删）。因此解析不出 {ts} 时退回用文件的 mtime 判断年龄，
 * 避免误偷 Python 进程正持有的锁。差分测试时也不要让两种实现同时操作同一语料目录。
 */
// py: class ManifestLock (fcntl.flock LOCK_EX)
export class ManifestLock {
  readonly lockPath: string;
  private fd: number | null = null;

  constructor(manifestPath: string) {
    this.lockPath = manifestPath + ".lock";
  }

  /** py: __enter__ —— 阻塞直到拿到锁；拿不到（权限/IO 错）时与 Python 一样降级为"无锁继续"。 */
  enter(): this {
    const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
    for (;;) {
      try {
        this.fd = fs.openSync(this.lockPath, "wx");
        fs.writeSync(this.fd, payload);
        return this;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== "EEXIST") {
          this.fd = null; // py: except OSError -> fh = None（不阻塞、不报错）
          return this;
        }
      }
      if (this.stale() && this.unlinkLock()) continue;
      sleepSync(50);
    }
  }

  private stale(): boolean {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.lockPath).mtimeMs;
    } catch {
      return true; // 已经消失：立刻重试创建
    }
    let ts = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as { ts?: unknown };
      if (typeof raw?.ts === "number") ts = raw.ts;
    } catch {
      /* 空文件/非本实现写的：退回 mtime */
    }
    const base = ts > 0 ? ts : mtimeMs;
    return Date.now() - base > LOCK_LEASE_MS;
  }

  private unlinkLock(): boolean {
    try {
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /** py: __exit__ —— 释放锁并删掉锁文件（flock 只释放，这里顺手清理，语义等价且更干净）。 */
  exit(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* py: except OSError: pass */
      }
      this.fd = null;
    }
    this.unlinkLock();
  }
}

/** `with zc.ManifestLock(mpath):` 的等价写法。 */
export function withManifestLock<T>(manifestPath: string, fn: () => T): T {
  const lock = new ManifestLock(manifestPath).enter();
  try {
    return fn();
  } finally {
    lock.exit();
  }
}

/**
 * 原子写（调用方负责持锁）：先 tmp（dot 前缀避免被 zg 索引）再 replace。
 * 字节细节：Python `json.dump(..., ensure_ascii=False, indent=2)` **不写结尾换行**，
 * 这里用 JSON.stringify(man, null, 2) 同样不带换行，键顺序沿用对象插入顺序。
 */
// py: save_manifest(path, man)
export function saveManifest(mpath: string, man: Manifest): void {
  const d = path.dirname(path.resolve(mpath)) || ".";
  fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, `.manifest.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(man, null, 2), "utf8");
  fs.renameSync(tmp, mpath);
}

// ---------- 行 ----------
/** (jsonl_line, role, ts, text) -> 语料行（含结尾 \n）。 */
// py: row_line(row)
export function rowLine(row: Row): string {
  return `${row.jsonlLine}\t${row.role}\t${row.ts}\t${row.text}\n`;
}

// py: row_bytes(row)
export function rowBytes(row: Row): number {
  return Buffer.byteLength(rowLine(row), "utf8");
}

/** py: _split_row(line) —— rstrip("\n") 后按 \t 切最多 4 段；不是 4 段返回 null。 */
function splitRow(line: string): string[] | null {
  let s = line;
  while (s.endsWith("\n")) s = s.slice(0, -1); // py: rstrip("\n") 只去 \n（不去 \r）
  const parts = s.split("\t");
  if (parts.length < 4) return null;
  // maxsplit=3：第 4 段保留剩余全部内容（text 里可能有 \t）
  return [parts[0], parts[1], parts[2], parts.slice(3).join("\t")];
}

/**
 * Python 文本模式的"通用换行"迭代：\r\n、\r、\n 都算行界，
 * 且末尾有换行时不产生额外的空行。
 */
function textLines(content: string): string[] {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 读一个分片 -> CorpusRow[]；文件缺失/不可读返回 []。 */
// py: read_segment(corpus_dir, fname, start_corpus_line)
export function readSegment(corpusDir: string, fname: string, startCorpusLine: number): CorpusRow[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(corpusDir, fname), "utf8");
  } catch {
    return [];
  }
  const rows: CorpusRow[] = [];
  const lines = textLines(content);
  for (let i = 0; i < lines.length; i++) {
    const parts = splitRow(lines[i]);
    if (!parts) continue;
    const jl = parsePythonInt(parts[0]);
    const ts = parsePythonInt(parts[2]);
    if (jl === null || ts === null) continue; // py: except ValueError: continue
    rows.push({ line: startCorpusLine + i, jsonlLine: jl, role: parts[1], ts, text: parts[3] });
  }
  return rows;
}

// ---------- 分片索引 ----------
/** 返回 man.sessions 本体（可写）；缺失则就地创建（Python 靠副作用，这里保持同样语义）。 */
// py: sessions(man)
export function sessions(man: Manifest): Record<string, SessionMeta> {
  if (!isPlainObject(man)) return {};
  if (!isPlainObject(man.sessions)) man.sessions = {};
  return man.sessions;
}

// py: segments(man)
export function segments(man: Manifest): Record<string, SegmentMeta> {
  if (!isPlainObject(man)) return {};
  if (!isPlainObject(man.segments)) man.segments = {};
  return man.segments;
}

/** 某 session 的分片元数据，按 seq 升序。 */
// py: segs_for(man, sid)
export function segsFor(man: Manifest, sid: string): SegWithName[] {
  const out: SegWithName[] = [];
  for (const [fname, m] of Object.entries(segments(man))) {
    if (isPlainObject(m) && (m as SegmentMeta).session_id === sid) {
      out.push({ fname, ...(m as SegmentMeta) });
    }
  }
  // Python 的 sort 稳定；seq 缺失按 0
  out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return out;
}

/** 该 session 的开放尾片（frozen=false）；取 seq 序里最后一个未冻结片，没有返回 null。 */
// py: open_tail(man, sid)
export function openTail(man: Manifest, sid: string): SegWithName | null {
  let tail: SegWithName | null = null;
  for (const s of segsFor(man, sid)) {
    if (!s.frozen) tail = s;
  }
  return tail;
}

/** 全局行号 -> 分片元数据；找不到返回 null。 */
// py: find_segment(man, sid, global_line)
export function findSegment(man: Manifest, sid: string, globalLine: number): SegWithName | null {
  for (const s of segsFor(man, sid)) {
    const start = s.start_corpus_line || 1;
    if (start <= globalLine && globalLine < start + (s.rows || 0)) return s;
  }
  return null;
}

/** 全局行号 -> (fname, local_line, meta)；找不到返回 (null, null, null)。 */
// py: local_line_of(sid, man, global_line)
export function localLineOf(
  sid: string,
  man: Manifest,
  globalLine: number,
): { fname: string; localLine: number; meta: SegWithName } | null {
  const s = findSegment(man, sid, globalLine);
  if (!s) return null;
  return { fname: s.fname, localLine: globalLine - (s.start_corpus_line || 1) + 1, meta: s };
}

/** 整会话全部行的拼接（全局行号升序）。 */
// py: session_rows_full(corpus_dir, man, sid)
export function sessionRowsFull(corpusDir: string, man: Manifest, sid: string): CorpusRow[] {
  const rows: CorpusRow[] = [];
  for (const s of segsFor(man, sid)) {
    rows.push(...readSegment(corpusDir, s.fname, s.start_corpus_line || 1));
  }
  return rows;
}

/**
 * 读命中行 + 必要时向左右邻接分片扩展，直到能凑齐配对。
 * 返回 {rows, idx}；目标行无法定位时 idx 为 null。
 */
// py: read_window(corpus_dir, man, sid, target_global)
export function readWindow(
  corpusDir: string,
  man: Manifest,
  sid: string,
  targetGlobal: number,
): { rows: CorpusRow[]; idx: number | null } {
  const segs = segsFor(man, sid);
  if (segs.length === 0) return { rows: [], idx: null };
  let i = 0;
  for (let k = 0; k < segs.length; k++) {
    const start = segs[k].start_corpus_line || 1;
    if (start <= targetGlobal) i = k;
  }
  let lo = i;
  let hi = i;
  let rows = readSegment(corpusDir, segs[lo].fname, segs[lo].start_corpus_line || 1);
  for (;;) {
    const idx = rows.findIndex((r) => r.line === targetGlobal);
    if (idx === -1) {
      // 目标行不在该分片（分片被重建/行号过期）：若还能扩就继续找
      if (lo > 0) {
        lo -= 1;
        rows = [...readSegment(corpusDir, segs[lo].fname, segs[lo].start_corpus_line || 1), ...rows];
        continue;
      }
      if (hi + 1 < segs.length) {
        hi += 1;
        rows = [...rows, ...readSegment(corpusDir, segs[hi].fname, segs[hi].start_corpus_line || 1)];
        continue;
      }
      return { rows, idx: null };
    }
    const needPrev = rows[idx].role !== "user" && !findPrev(rows, idx, "user");
    const needNext = rows[idx].role !== "assistant" && !findNext(rows, idx, "assistant");
    if (needPrev && lo > 0) {
      lo -= 1;
      rows = [...readSegment(corpusDir, segs[lo].fname, segs[lo].start_corpus_line || 1), ...rows];
      continue;
    }
    if (needNext && hi + 1 < segs.length) {
      hi += 1;
      rows = [...rows, ...readSegment(corpusDir, segs[hi].fname, segs[hi].start_corpus_line || 1)];
      continue;
    }
    return { rows, idx };
  }
}

// ---------- 配对 ----------
// py: find_prev(rows, idx, role) -> 文本或 ""
export function findPrev(rows: CorpusRow[], idx: number, role: string): string {
  for (let j = idx - 1; j >= 0; j--) {
    if (rows[j].role === role) return rows[j].text;
  }
  return "";
}

// py: find_next(rows, idx, role)
export function findNext(rows: CorpusRow[], idx: number, role: string): string {
  for (let j = idx + 1; j < rows.length; j++) {
    if (rows[j].role === role) return rows[j].text;
  }
  return "";
}

export interface Pair {
  ref: { session: string; jsonl_line: number; corpus_line: number };
  role: string;
  ts: number;
  user: string;
  assistant: string;
}

/** 命中 idx -> 对话对（hit 行 + 其 user/assistant 伙伴）。 */
// py: build_pair(rows, idx)
export function buildPair(rows: CorpusRow[], idx: number): Pair {
  const r = rows[idx];
  const userTxt = r.role === "user" ? r.text : findPrev(rows, idx, "user");
  const asstTxt = r.role === "assistant" ? r.text : findNext(rows, idx, "assistant");
  return {
    ref: { session: "", jsonl_line: r.jsonlLine, corpus_line: r.line },
    role: r.role,
    ts: r.ts,
    user: userTxt,
    assistant: asstTxt,
  };
}

/** 全局行号 -> pair（跨分片配对）；无法定位返回 null。 */
// py: pair_for_global(corpus_dir, man, sid, target_global)
export function pairForGlobal(
  corpusDir: string,
  man: Manifest,
  sid: string,
  targetGlobal: number,
): Pair | null {
  const { rows, idx } = readWindow(corpusDir, man, sid, targetGlobal);
  if (idx === null) return null;
  const p = buildPair(rows, idx);
  p.ref.session = sid;
  return p;
}

// ---------- 命中行定位 ----------
// zg 命中只给"命中块起始行"(file.txt:<块首行>)，块内真正被命中的那一行要自己找，
// 否则 ref 会指到块首行：agent 深钻时看到的是别的消息（见评审 H2）。
export const CJK_RE = /[\u3400-\u9fff]+/g; // 含扩展 A 的汉字连续段
export const WORD_RE = /[A-Za-z0-9_]{2,}/g;
export const HIT_REFINE_SPAN = intEnv("ZGMEM_HIT_SPAN", 40);

/**
 * query -> 打分词元：英数 token(>=2 字符) + 中文 2-gram（无分词器时的近似）。
 * 按长度降序（仅影响遍历顺序；打分用各词元自身长度加权，长词辨识度更高）。
 *
 * 与 Python 的差异（不影响结果）：Python 用 set 且 sorted 对等长词元的相对顺序是
 * 哈希序、每个进程还随机化；这里保持插入顺序。因为 row_score 是求和、pick_hit_row
 * 只比较分数，所以对任何可观测输出都等价。
 */
// py: query_terms(q)
export function queryTerms(q: string): string[] {
  const src = q || "";
  const terms = new Set<string>();
  for (const m of src.toLowerCase().matchAll(WORD_RE)) terms.add(m[0]);
  for (const m of src.matchAll(CJK_RE)) {
    const run = m[0];
    if (run.length <= 2) {
      terms.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
    }
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

/** 覆盖分：命中的不同词元按其长度求和（长词权重高）。 */
// py: row_score(text, terms)
export function rowScore(text: string, terms: string[]): number {
  const low = (text || "").toLowerCase();
  let sum = 0;
  for (const t of terms) {
    if (low.includes(t)) sum += t.length;
  }
  return sum;
}

/**
 * 在 [start_global, start_global+span] 内取覆盖分最高的行（并列取最早）。
 *
 * 没有任何词元覆盖（纯向量命中/词元跨行断开）时退回 start_global，即 zg 给的块首行 ——
 * 比乱指一行更诚实。
 */
// py: pick_hit_row(rows, start_global, terms, span=None)
export function pickHitRow(
  rows: CorpusRow[],
  startGlobal: number,
  terms: string[],
  span: number | null = null,
): number {
  if (!rows || rows.length === 0 || !terms || terms.length === 0) return startGlobal;
  const useSpan = span === null ? HIT_REFINE_SPAN : span;
  let best = startGlobal;
  let bestScore = 0;
  for (const r of rows) {
    if (r.line < startGlobal || r.line > startGlobal + useSpan) continue;
    const s = rowScore(r.text, terms);
    if (s > bestScore) {
      best = r.line;
      bestScore = s;
    }
  }
  return best;
}

// ---------- 切分 ----------
export interface SegLimits {
  rows: number;
  bytes: number;
}

/**
 * rows=[Row]: 不需要切分返回 null，否则返回切点(1..len(rows))。
 *
 * 配对边界：切点若正好落在 user 行之后，就继续往后吃，别把 user 问句留在上一片
 * 而它的 assistant 回答落到下一片。
 */
// py: split_point(rows)
export function splitPoint(rows: Row[], limits: SegLimits | null = null): number | null {
  const maxRows = limits ? limits.rows : MAX_SEG_ROWS;
  const maxBytes = limits ? limits.bytes : MAX_SEG_BYTES;
  let total = 0;
  for (const r of rows) total += rowBytes(r);
  if (rows.length < maxRows && total <= maxBytes) return null;

  let cut = 0;
  let nbytes = 0;
  let n = 0;
  for (const r of rows) {
    const rb = rowBytes(r);
    if (cut > 0 && (n >= maxRows || nbytes + rb > maxBytes)) break;
    nbytes += rb;
    n += 1;
    cut += 1;
  }
  if (cut <= 0) cut = 1; // 单行就超限：独占一片
  cut = Math.min(cut, rows.length);
  while (cut < rows.length && rows[cut - 1].role === "user") cut += 1;
  return cut;
}

/**
 * 原子写一个分片，并把 mtime 钉在该片首条消息时间（语义时间，且稳定不变）。
 * 注意 Python `if start_ts:` —— 0 / None 都跳过 utime，这里保持一致。
 */
// py: write_segment(corpus_dir, fname, rows, start_ts=None)
export function writeSegment(corpusDir: string, fname: string, rows: Row[], startTs: number | null = null): void {
  fs.mkdirSync(corpusDir, { recursive: true });
  const tmp = path.join(corpusDir, `.${fname}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, rows.map((r) => rowLine(r)).join(""), "utf8");
  const final = path.join(corpusDir, fname);
  fs.renameSync(tmp, final);
  if (startTs) {
    const sec = startTs / 1000;
    try {
      fs.utimesSync(final, sec, sec);
    } catch {
      /* py: except OSError: pass */
    }
  }
}

/** 文件前 nbytes 字节的 sha256；文件短于 nbytes 返回 null。 */
// py: sha256_prefix(path, nbytes)
export function sha256Prefix(p: string, nbytes: number): string | null {
  const h = crypto.createHash("sha256");
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(1 << 20, Math.max(nbytes, 1)));
    let left = nbytes;
    while (left > 0) {
      const want = Math.min(buf.length, left);
      const read = fs.readSync(fd, buf, 0, want, null);
      if (read <= 0) return null;
      h.update(buf.subarray(0, read));
      left -= read;
    }
    return h.digest("hex");
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// py: new_hasher()
export function newHasher(): crypto.Hash {
  return crypto.createHash("sha256");
}

/**
 * 分片 seq 分配：尾片沿用原 seq（文件名稳定），其后编号从 max(已有 seq, 尾片 seq)+1
 * **无上界**递增。
 *
 * 历史上这里写死 256 个号，单会话超过 257 片时 next() 抛 StopIteration，
 * 半程已写的分片留下、会话入不了 manifest。用无限生成器后不再有上限。
 */
// py: seq_allocator(segs, tail_seq) -> itertools.chain([tail_seq], itertools.count(...))
export function* seqAllocator(segs: SegWithName[], tailSeq: number): Generator<number> {
  const maxSeq = Math.max(0, ...segs.map((s) => s.seq || 0));
  yield tailSeq;
  let n = Math.max(maxSeq, tailSeq) + 1;
  for (;;) yield n++;
}

/**
 * 该 session 在磁盘上的所有语料文件（分片 + v1 单文件）。
 * Python 用 glob("<escaped sid>*") 再过滤；这里直接列目录按前缀筛，并在最后排序
 * （Python 的 glob 顺序不保证，排序只为确定性；调用方只用它删除文件，顺序无关）。
 */
// py: corpus_files_of(corpus_dir, sid)
export function corpusFilesOf(corpusDir: string, sid: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(corpusDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const b of names) {
    if (!b.startsWith(sid)) continue;
    if (b.startsWith(".")) continue;
    const seg = parseSeg(b);
    if ((seg && seg.sid === sid) || (isLegacyName(b) && b === `${sid}.txt`)) {
      out.push(path.join(corpusDir, b));
    }
  }
  return out.sort();
}

/** 超过 1 小时的半成品视为硬杀/断电残留（评审 LOW-5）。 */
// py: STALE_TMP_AGE = 3600
export const STALE_TMP_AGE = 3600;

/**
 * 清掉硬杀/断电留在语料目录里的半成品片（.staging / .<pid>.tmp）。
 *
 * 只碰"隐藏 + 我们自己的后缀"，并且只删 mtime 超过 maxAge 的，免得误删另一个进程
 * 此刻正在写的 tmp。调用方应已持有 manifest 锁。返回被删的文件名列表
 * （Python 版会顺便 print，这里只返回，由 CLI 层负责同样的输出格式）。
 */
// py: sweep_stale_tmp(corpus_dir, max_age=STALE_TMP_AGE)
export function sweepStaleTmp(corpusDir: string, maxAge: number = STALE_TMP_AGE): string[] {
  const now = Date.now() / 1000;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(corpusDir);
  } catch {
    return removed;
  }
  for (const b of names.sort()) {
    if (!b.startsWith(".")) continue;
    if (!(b.endsWith(".staging") || b.endsWith(".tmp"))) continue;
    const p = path.join(corpusDir, b);
    try {
      if (now - fs.statSync(p).mtimeMs / 1000 < maxAge) continue; // 可能是别的进程正在写的半成品
      fs.unlinkSync(p);
      removed.push(b);
    } catch {
      /* py: except OSError: pass */
    }
  }
  return removed;
}
