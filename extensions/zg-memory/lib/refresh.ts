/**
 * lib/refresh.ts — zgmem 的**写入**路径（v2 分片语料），`extensions/zg-memory/zgmem.py` 的 TS 移植
 * =====================================================================================
 * 覆盖：`refresh` 一条命令的全部逻辑 —— 扫描 sessions 目录、删已消失会话的分片、
 * prune manifest、扫残留半成品、逐 session 跑 ETL、跑 `zg index` 增量索引、索引状态戳。
 * 只读路径（query/show/ctx/sessions）在 `lib/query.ts`（模块 C）；本文件不碰它。
 *
 * 每个函数上方标注 Python 出处，便于逐条比对。移植期的约定（见 docs/plan-ts-migration.md，
 * 与 lib/corpus.ts、lib/etl.ts、lib/query.ts 同一套）：
 *  - 只用"可擦除语法"，`node lib/refresh.ts` 能被剥离类型后直接跑（不能用 enum/namespace/装饰器）；
 *  - 相对导入必须带 .ts 扩展名；
 *  - I/O 全部同步（zg 用 spawnSync，忠于 Python 的 subprocess.run 阻塞语义）；
 *  - 库层**不 print**：`runRefresh` 返回 `{out, code}`，`out` 是要写 stdout 的**完整文本**，
 *    由模块 E（lib/cli.ts）负责落地。格式与 Python 逐字节一致（CLI 回归靠它）。
 *
 * 与 Python 的结构差异（有意，逐条登记）：
 *  1. **ETL 走进程内调用**（`etl.runEtl`），不再是 `subprocess.run([python3, jsonl2corpus.py, ...])`。
 *     这正是本次迁移的目的（去掉 subprocess 边界）。**调用粒度保持一致：仍然一个 changed
 *     文件调一次**（不是一把 glob 全跑完）—— 因为每次 ETL 都会重新 load manifest 并在结束时
 *     原子写回，粒度变了 manifest 的键序/中间态就可能不同。子进程的 stdout 在 Python 里被
 *     `capture_output` 吞掉，所以进程内同样**丢弃** ETL 的成功输出，只在一处保留（见下）。
 *     唯一**不可**复刻的是 Python 的 `timeout=300`：进程内没法掐自己的表，超时语义（子进程被
 *     杀 → 半截状态 → rc=2）退化为"跑完为止"。真实语料下 ETL 是秒级，300s 只在病态输入上才到。
 *  2. Python 的 `print` 序列 → 本文件收集成 `out` 文本（每条 print 补一个 `\n`）。
 *     需要保真的几处：`print(out.stderr or out.stdout)` 是**原样 + 一个换行**（不 strip），
 *     而 `_run_index` 里那句 `((stderr or "") + (stdout or "")).strip()` 是**先拼后 strip**，
 *     顺序与 strip 都不能省（拼反了 lease 检测在 stdout/stderr 分布不同时会漏）。
 *  3. `_prune_manifest` / `_mark_indexed` 在 Python 里直接 print，这里改为**返回值**
 *     （`string[]` / `string | null`），由 `runRefresh` 按原顺序插入 `out` —— 与模块 B 处理
 *     `sweep_stale_tmp` 的口径一致。
 *  4. Python 的 `sweep_stale_tmp` **自己 print**（`  清理残留半成品 N 个: a, b ...`，只列前 5 个），
 *     `zgmem_corpus.py` 里那句 print 在 TS 侧被拆成"返回值 + 这里按同格式渲染"。模块 A 的
 *     `corpus.ts` 有意不动（已验收代码，改了就要重跑它的差分），格式在本文件补齐。
 *  5. Python 结尾的 `MANIFEST.clear(); MANIFEST.update(load_manifest(...))` **不做**：
 *     那是模块级全局的防御性重载，`cmd_refresh` 是最后一步，之后进程就 exit 了，没有任何读取方
 *     （`if rc: sys.exit(rc)` 紧跟其后）。TS 里 Scope 是值对象，更没有"跨命令残留状态"。
 *  6. `os.stat` 失败的报错文本（`跳过无法 stat 的会话文件 <name>: <OSError>`）用
 *     `pyOsErrorText` 复刻常见 errno（ENOENT/EACCES/ENOTDIR/ELOOP），其余退回 Node 的 message。
 *     Python 的 OSError 文本形如 `[Errno 2] No such file or directory: '<path>'`。
 *  8. `os.path.dirname` 的差异：Node 在无目录分量时给 `.`，Python 给空串 —— 见 `pyDirname`。
 *  9. `_mark_indexed` 的落盘字节：Python `json.dump(dict)` 用**默认分隔符**（`, ` 与 `: `），
 *     `JSON.stringify` 不是（`,` 与 `:`）。这里显式拼成 Python 的形态，好让差分对拍能比戳文件字节。
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as zc from "./corpus.ts";
import * as etl from "./etl.ts";
import * as q from "./query.ts";

/** 入口返回值：out = 要写 stdout 的完整文本（Python 的 print 逐次追加）。 */
export interface RefreshResult {
  out: string;
  code: number;
}

/** py: 可注入的边界（默认走真实实现），只为让失败分支可测。 */
export interface RefreshDeps {
  /** 一个 session 一份 ETL（对应 Python 起一个 `jsonl2corpus.py` 子进程）。 */
  etlRun?: (globIn: string, corpusDir: string, stderr: (s: string) => void) => etl.EtlResult;
  /** `zg index`（返回 null=成功 / "lease-active" / 错误文本）。 */
  zgIndex?: (corpusDir: string, embedding: string) => string | null;
}

const defaultEtlRun: NonNullable<RefreshDeps["etlRun"]> = (globIn, corpusDir, stderr) =>
  etl.runEtl(globIn, corpusDir, { stderr });

/** 与 lib/corpus.ts、lib/etl.ts、lib/query.ts 同款局部助手（有意不扩大已验收模块的公开面）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** py: os.path.isdir —— 出错（不存在/权限）一律 False，不抛。 */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Python 的 `str(OSError)`：`[Errno <errno>] <strerror>: '<path>'`。
 * 只覆盖 refresh 真会遇到的四种；其它退回 Node 的 message（已登记为残余差异）。
 */
function pyOsErrorText(e: unknown, p: string): string {
  const code = (e as { code?: string }).code;
  const table: Record<string, [number, string]> = {
    ENOENT: [2, "No such file or directory"],
    EACCES: [13, "Permission denied"],
    ENOTDIR: [20, "Not a directory"],
    ELOOP: [40, "Too many levels of symbolic links"],
  };
  const hit = code ? table[code] : undefined;
  if (hit) return `[Errno ${hit[0]}] ${hit[1]}: '${p}'`;
  return e instanceof Error ? e.message : String(e);
}

// ---------- manifest 修剪 / 索引状态戳 ----------

/**
 * py: _prune_manifest(session_ids) —— 删除已消失 session 的 manifest 条目（v2: sessions + 其 segments）
 * 跨进程锁 + 原子写；manifest 损坏/非 v2 时放弃写回而非清空。
 * 返回：要 print 的警告行（0 或 1 条）。
 */
export function pruneManifest(scope: q.Scope, sessionIds: Iterable<string>): string[] {
  const mpath = scope.manifestPath;
  const dead = new Set(sessionIds);
  const warn: string[] = [];
  zc.withManifestLock(mpath, () => {
    const disk = zc.loadManifestRaw(mpath);
    if (!isPlainObject(disk) || disk["version"] !== zc.MANIFEST_VERSION) {
      // py: print("警告: manifest 非 v2 或不可读, 跳过 prune 写回(绝不清空)")
      warn.push("警告: manifest 非 v2 或不可读, 跳过 prune 写回(绝不清空)");
      return;
    }
    // py: disk.setdefault("sessions", {}) —— 键存在但不是 dict 时 Python 会在 .pop 上炸
    // （AttributeError/TypeError），这里同样抛，别把损坏的 manifest 悄悄"修好"。
    if (disk["sessions"] === undefined) disk["sessions"] = {};
    if (disk["segments"] === undefined) disk["segments"] = {};
    const sessions = disk["sessions"];
    const segments = disk["segments"];
    if (!isPlainObject(sessions) || !isPlainObject(segments)) {
      throw new TypeError("py: manifest 的 sessions/segments 不是对象, 无法 prune");
    }
    for (const sid of dead) delete sessions[sid];
    for (const fn of Object.keys(segments)) {
      const m = segments[fn];
      // py: isinstance(m, dict) and m.get("session_id") in dead
      if (isPlainObject(m) && dead.has(m["session_id"] as string)) delete segments[fn];
    }
    zc.saveManifest(mpath, disk as unknown as zc.Manifest);
  });
  return warn;
}

/** py: _index_marker() */
export function indexMarker(scope: q.Scope): string {
  return path.join(scope.corpusDir, q.INDEX_MARKER_REL);
}

/** py: _index_stamp_path() —— "语料已成功索引"的状态戳（我们自己的目录，不动 zg 的 .zvec-grep） */
export function indexStampPath(scope: q.Scope): string {
  return path.join(scope.home, scope.name, "index-stamp.json");
}

/** py: _corpus_files() —— 语料目录里的分片文件（非隐藏） */
export function corpusFiles(corpusDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(corpusDir);
  } catch {
    return []; // py: glob.glob 在目录不存在时返回空列表
  }
  // glob 的通配符不吃以 . 开头的名字；Python 侧那行 startswith(".") 过滤因此是冗余的
  return names
    .filter((n) => !n.startsWith(".") && etl.fnmatch("*.txt", n))
    .map((n) => path.join(corpusDir, n))
    .sort(q.pyStrCmp); // Python 的 glob 顺序不定，这里定死，便于差分比对
}

/** 语料指纹（片段数 / 总字节 / 最新 mtime，毫秒）。 */
export interface CorpusFingerprint {
  files: number;
  bytes: number;
  newest_mtime: number;
}

/**
 * py: _corpus_fingerprint() —— 只看"语料变没变"。
 *
 * 总字节数是可靠的那一项：新增消息一定让它变大。不能拿"语料 mtime > 索引 mtime"当陈旧判据 ——
 * `write_segment` 把 mtime 钉在首条消息的语义时间上（可能比索引时间早得多），那样判会漏掉新追加的尾片。
 */
export function corpusFingerprint(corpusDir: string): CorpusFingerprint {
  const files = corpusFiles(corpusDir);
  let newest = 0.0;
  let total = 0;
  for (const p of files) {
    // 字节细节：int(newest * 1000)，其中 newest 是 Python 的 st_mtime = tv_sec + tv_nsec/1e9。
    // 必须先取"秒（double）"再在最后一次性 *1000，不能先算毫秒再 max —— 舍入边界会差 1。
    let sec: number;
    let size: number;
    try {
      const st = fs.statSync(p, { bigint: true });
      const NS = 1_000_000_000n;
      sec = Number(st.mtimeNs / NS) + Number(st.mtimeNs % NS) / 1e9;
      size = Number(st.size);
    } catch {
      continue; // py: except OSError: continue
    }
    newest = Math.max(newest, sec);
    total += size;
  }
  return { files: files.length, bytes: total, newest_mtime: Math.trunc(newest * 1000) };
}

/** Python 的 dict == 语义（键序无关；只按自家写出的三个键比）。 */
function fingerprintEq(a: unknown, b: CorpusFingerprint): boolean {
  if (!isPlainObject(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== 3) return false;
  // 已知残余差异：Python 的 1 == True / 1 == 1.0，JS 用 === 更严。只有手改过的戳文件才碰得到。
  return (
    a["files"] === b.files && a["bytes"] === b.bytes && a["newest_mtime"] === b.newest_mtime
  );
}

/** py: _index_stamp_ok() —— 语料是否与"上一次成功索引"时完全一致（没戳=上轮没成功过） */
export function indexStampOk(scope: q.Scope): boolean {
  let stamp: unknown;
  try {
    stamp = JSON.parse(fs.readFileSync(indexStampPath(scope), "utf8"));
  } catch {
    return false; // py: except (OSError, ValueError)
  }
  return fingerprintEq(stamp, corpusFingerprint(scope.corpusDir));
}

/** Python `json.dump(dict)` 的默认分隔符形态（`, ` / `: `，键序=插入序，无结尾换行）。 */
function pyJsonDumpBody(fp: CorpusFingerprint): string {
  return `{"files": ${fp.files}, "bytes": ${fp.bytes}, "newest_mtime": ${fp.newest_mtime}}`;
}

/**
 * py: _mark_indexed(fp=None) —— 记下"成功索引过的语料状态"。
 *
 * `fp` 必须由调用方在 `runIndex()` **之前**取好：否则会把"索引期间别的实例写进来的语料"
 * 一并声明成已索引 → 下一轮早退，那些行就永久搜不到了（评审 MED-2）。
 * 返回：写入失败的警告行（无则 null）。
 */
export function markIndexed(scope: q.Scope, fp?: CorpusFingerprint): string | null {
  try {
    const p = indexStampPath(scope);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, pyJsonDumpBody(fp ?? corpusFingerprint(scope.corpusDir)));
    fs.renameSync(tmp, p); // py: os.replace(tmp, p)
    return null;
  } catch (e) {
    // py: print("警告: 索引状态戳写入失败(下轮会白跑一次 zg index):", e)
    return `警告: 索引状态戳写入失败(下轮会白跑一次 zg index): ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** py: sweep_stale_tmp 的那句 print（只列前 5 个 + " ..."），sweepLine([]) 时无输出。 */
export function sweepLine(removed: string[]): string[] {
  if (!removed.length) return [];
  const head = removed.slice(0, 5).join(", ") + (removed.length > 5 ? " ..." : "");
  return [`  清理残留半成品 ${removed.length} 个: ${head}`];
}

/** py: _clear_index_stamp() */
export function clearIndexStamp(scope: q.Scope): void {
  try {
    fs.unlinkSync(indexStampPath(scope));
  } catch {
    /* py: except OSError: pass */
  }
}

// ---------- zg 索引 ----------

/**
 * py: _run_index() —— 跑 zg 增量索引。
 * 返回 None=成功；"lease-active"=另一个 zg 进程在写本 root；其它=错误文本。
 */
export function runIndex(corpusDir: string, embedding: string): string | null {
  const proc = childProcess.spawnSync("zg", ["index", ".", "--embedding", embedding], {
    cwd: corpusDir,
    encoding: "utf8",
    timeout: 300_000, // py: timeout=300
    maxBuffer: zc.subprocessMaxBuffer(), // 默认才 1 MiB，zg index 的输出会超
  });
  // py 对 FileNotFoundError / TimeoutExpired 都不捕获（_run_index 里没有 try）→ 直接崩。
  // 这里同样不吞，交给模块 E 按"意外异常"渲染。
  if (proc.error) throw proc.error;
  // 被信号杀死时 Python 给 -signum，这里退化为 -1（zg 是普通 CLI，我们从不主动发信号）
  const rc = proc.status ?? -1;
  if (rc === 0) return null;
  // 顺序要紧：stderr 在前、stdout 在后，最后整体 strip（py 的 `((stderr or "") + (stdout or "")).strip()`）
  const out = q.pyStrip(`${proc.stderr ?? ""}${proc.stdout ?? ""}`);
  if (out.includes("DAEMON_LEASE_ACTIVE")) return "lease-active";
  return out || `zg index 退出码 ${rc}`;
}

// ---------- refresh ----------

export interface RefreshOptions {
  /** py: args.sessions_dir（None 时退回 PI_SESSION_FILE 所在目录，见 sessionsDirFor）。 */
  sessionsDir?: string | null;
  /** py: EMBEDDING（ZGMEM_EMBEDDING），由调用方从 queryEnv 取。 */
  embedding: string;
}

/** py: os.path.dirname(p) —— Node 的 `path.dirname` 在"没有目录分量"时给 `"."`，Python 给 `""`。
 * 差在 `os.path.dirname("") == ""`（→ `no sessions dir`）与 `os.path.dirname("a.jsonl") == ""`
 * 而 Node 分别给 `"."`/`"."`：若照抄，PI_SESSION_FILE 是相对名时就会把 **cwd** 当会话目录扫。
 * 已知残余差异：POSIX 的 `//x` 前缀（Python 给 `"//"`，这里给 `""`）—— 真实值是绝对路径，碰不到。 */
export function pyDirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  const head = p.slice(0, i + 1).replace(/\/+$/, "");
  if (head !== "") return head;
  return i === 0 ? "/" : "";
}

/** py: `args.sessions_dir or os.path.dirname(os.environ.get("PI_SESSION_FILE", ""))` */
export function sessionsDirFor(sessionsDir: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (q.pyTruthy(sessionsDir)) return sessionsDir as string;
  return pyDirname(env["PI_SESSION_FILE"] ?? "");
}

/**
 * py: cmd_refresh(args) —— 扫描 sessions 目录，只重跑 mtime/size 变化的 jsonl
 * （ETL 内部再前缀校验 + 增量续读），然后 zg 增量索引。
 *
 * 退出码：0 成功 / 2 有 session 的 ETL 失败（Python 的 `if rc == 0: rc = 2`）/
 * 3 zg index 失败。`no sessions dir` 与"拒绝清理"都是 0（Python 直接 return）。
 *
 * 已知残余差异：`sweepStaleTmp` 内部的排序用的是 JS 默认 `.sort()`（UTF-16 码元序），
 * Python 是码点序 —— 只影响 >5 个残留半成品时那句日志里前 5 个的先后，且需要非 BMP 文件名，
 * 而分片名来自 session id（真实值都是 ASCII）。登记在案，不改模块 A 的已验收代码。
 */
export function runRefresh(
  scope: q.Scope,
  opts: RefreshOptions,
  deps: RefreshDeps = {},
): RefreshResult {
  const etlRun = deps.etlRun ?? defaultEtlRun;
  const zgIndex = deps.zgIndex ?? runIndex;
  let out = "";
  const say = (line: string): void => {
    out += `${line}\n`;
  };

  const sessionsDir = sessionsDirFor(opts.sessionsDir);
  if (!sessionsDir || !isDir(sessionsDir)) {
    say("no sessions dir");
    return { out, code: 0 };
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  const nowM = new Map<string, { mtimeMs: number; size: number }>();
  const sessMap = zc.sessions(scope.manifest);
  const skipped: string[] = [];
  for (const p of etl.globPaths(path.join(sessionsDir, "*.jsonl")).sort(q.pyStrCmp)) {
    const sid = path.basename(p).slice(0, -".jsonl".length);
    let mtimeMs: number;
    let size: number;
    try {
      const st = fs.statSync(p, { bigint: true });
      // 字节细节：int(st.st_mtime * 1000)。与 lib/etl.ts 的 jsonl_mtime 必须同一套运算顺序，
      // 否则"上一轮 Python/TS 写的 manifest"会一直被判成 changed（舍入边界差 1，评审 HIGH-1）。
      const NS = 1_000_000_000n;
      mtimeMs = Math.trunc((Number(st.mtimeNs / NS) + Number(st.mtimeNs % NS) / 1e9) * 1000);
      size = Number(st.size);
    } catch (e) {
      // py: 断链/竞态删除: 不因它整轮崩掉
      skipped.push(`${path.basename(p)}: ${pyOsErrorText(e, p)}`);
      continue;
    }
    nowM.set(sid, { mtimeMs, size });
    const prev = sessMap[sid];
    if (!prev || mtimeMs !== prev["jsonl_mtime"] || size !== prev["jsonl_size"]) changed.push(p);
  }
  for (const s of skipped) say(`跳过无法 stat 的会话文件 ${s}`);
  // sessions 目录有效但为空：拒绝清理，防止误删全部语料
  if (nowM.size === 0 && Object.keys(sessMap).length > 0) {
    say(`sessions 目录无 jsonl, 拒绝清理 ${Object.keys(sessMap).length} 条 manifest (安全起见不 prune)`);
    return { out, code: 0 };
  }
  // 已从 manifest 消失的 jsonl（被删除/归档）：同步删该 session 的全部分片与 manifest 条目
  for (const sid of Object.keys(sessMap)) {
    if (nowM.has(sid)) continue;
    deleted.push(sid);
    for (const p of zc.corpusFilesOf(scope.corpusDir, sid)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* py: except OSError: pass */
      }
    }
  }
  if (changed.length || deleted.length) {
    say(`变更 ${changed.length} 个, 删除 ${deleted.length} 个`);
  }
  // prune 先落盘（在任何 early-return 之前，避免"文件已删但键永留"）；
  // ETL 的 merge 在其后读到已 prune 的 manifest
  if (deleted.length) for (const w of pruneManifest(scope, deleted)) say(w);
  // 硬杀残留的半成品片：没有任何 session 变化时 ETL 根本不会被调用，所以这里也扫一次（LOW-5）。
  // 只拿一小段锁（ETL 会抢同一把锁，不能在持锁时起它）
  for (const line of sweepLine(zc.withManifestLock(scope.manifestPath, () => zc.sweepStaleTmp(scope.corpusDir)))) {
    say(line);
  }
  const etlFail: string[] = [];
  for (const p of changed) {
    const errChunks: string[] = [];
    try {
      const res = etlRun(p, scope.corpusDir, (s) => errChunks.push(s));
      if (res.code !== 0) {
        etlFail.push(p);
        // py: print(out.stderr or out.stdout) —— 原样 + 一个换行（不 strip）
        const stderrText = errChunks.join("");
        const stdoutText = res.lines.map((l) => `${l}\n`).join("");
        say(`${stderrText || stdoutText}`);
      }
    } catch (e) {
      etlFail.push(p);
      say(`ETL 失败 ${p} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const marker = indexMarker(scope);
  // 无变化 + 索引在 + 上轮索引确实成功过：真没事情做
  // （索引不存在，或上轮 zg index 失败/lease-active → 绝不能早退，否则新语料永远搜不到）
  // zg 建出来的 .zvec-grep/index.zvec 是**目录**（与 index.ts 的 existsSync 同口径），不能用 isFile
  if (!changed.length && !deleted.length && fs.existsSync(marker) && indexStampOk(scope)) {
    say("无变化, 索引已是最新");
    return { out, code: 0 };
  }
  if (!fs.existsSync(marker)) {
    say("索引缺失, 重建索引");
  } else if (!changed.length && !deleted.length) {
    say("上轮索引未成功(或语料已变), 补跑索引");
  }
  let rc = 0;
  if (!corpusFiles(scope.corpusDir).length && !fs.existsSync(marker)) {
    say("语料目录为空且索引未建过, 跳过索引");
  } else {
    // zg 增量索引（冻结分片 size+mtime 不变 → 只重嵌开放尾片）
    // 语料被清空时也要跑：让 zg 把已删文件的向量一起清掉（LOW-3）
    // 戳必须在跑索引**之前**取：它只能描述 zg index 启动时就已经存在的语料
    const fpBefore = corpusFingerprint(scope.corpusDir);
    const indexErr = zgIndex(scope.corpusDir, opts.embedding);
    if (indexErr === null) {
      const warn = markIndexed(scope, fpBefore);
      if (warn) say(warn);
      say(`索引已更新 (${changed.length} changed, ${deleted.length} deleted)`);
    } else if (indexErr === "lease-active") {
      // 另一个窗口/仓库的 zg 正在写本 root：不是错误，但绝不能报"索引已更新"
      // 清掉状态戳 → 下一轮必然会重试（D2/评审 HIGH-1）
      clearIndexStamp(scope);
      say("另一个 zg 进程正在写本 workspace 的索引(lease active), 本次未更新索引; 下一轮会重试");
    } else {
      clearIndexStamp(scope);
      say(`zg index 失败: ${indexErr}`);
      rc = 3;
    }
  }
  if (etlFail.length) {
    say(`注意: ${etlFail.length}/${changed.length} 个 session ETL 失败, 这些会话本轮未入语料(修掉原因后重跑即可)`);
    if (rc === 0) rc = 2;
  }
  // py: `if rc: sys.exit(rc)` —— rc=0 时正常退出；这里统一由调用方按 code 落地
  return { out, code: rc };
}
