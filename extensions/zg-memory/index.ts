import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------- 配置 ----------
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../.pi/extensions/zg-memory
const ZGMEM_ROOT = process.env.ZGMEM_DIR
  ? path.resolve(process.env.ZGMEM_DIR)
  : path.join(os.homedir(), ".pi", "agent", "zgmem");
const SESSIONS_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

/** 临时/子代理会话文件(非项目会话): 不可用于派生 workspace(防垃圾索引) */
function isTempSessionFile(sf: string): boolean {
  const norm = sf.replace(/\\/g, "/");
  if (path.basename(path.dirname(sf)) === "pi-subagent-sessions") return true;
  if (norm.includes("/var/folders/") || norm.startsWith("/tmp/") || norm.includes("/private/tmp/")) return true;
  return false;
}

function isTempPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return norm.includes("/var/folders/") || norm.startsWith("/tmp/") || norm.includes("/private/tmp/");
}

function slugOfSessionsDir(dir: string): string {
  return path.basename(dir).replace(/^-+|-+$/g, "");
}

function cwdSlug(cwd?: string): string {
  const c = (cwd || process.cwd()).replace(/\\/g, "/");
  return c.split("/").filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9._-]/g, "-")).join("-");
}

/** workspace: 项目会话目录 slug > cwd slug > ZGMEM_SCOPE/github(兜底, 不建索引) */
function deriveWorkspace(sessionFile: string | undefined, cwd?: string): string {
  if (sessionFile && !isTempSessionFile(sessionFile)) {
    const slug = slugOfSessionsDir(path.dirname(sessionFile));
    if (slug) return slug;
  }
  if (!isTempPath(cwd || process.cwd())) {
    const slug = cwdSlug(cwd);
    if (slug) return slug;
  }
  return process.env.ZGMEM_SCOPE || "github";
}

function corpusDirOf(ws: string): string {
  return path.join(ZGMEM_ROOT, ws, "corpus");
}

/** sessions 目录里是否已有 *.jsonl (新会话 session_start 时自己的 jsonl 可能尚未落盘) */
function hasSessionFiles(sessionsDir: string): boolean {
  try {
    return fs.readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl"));
  } catch { return false; }
}

/** workspace 对应的会话目录: 项目会话直取; 否则按 slug 在 sessions 根下找规范目录 */
function sessionsDirFor(ws: string, sessFile?: string): string | undefined {
  if (sessFile && !isTempSessionFile(sessFile) && slugOfSessionsDir(path.dirname(sessFile)) === ws) {
    return path.dirname(sessFile);
  }
  try {
    for (const e of fs.readdirSync(SESSIONS_ROOT)) {
      if (e.replace(/^-+|-+$/g, "") === ws) return path.join(SESSIONS_ROOT, e);
    }
  } catch { /* ignore */ }
  return undefined;
}

/** 优先从 extension ctx 拿会话文件(运行期可靠), 再回落 env */
function workspaceFromCtx(ctx?: any): string {
  let sf: string | undefined;
  try { sf = ctx?.sessionManager?.getSessionFile?.(); } catch { /* ignore */ }
  return deriveWorkspace(sf || currentSessionFile(), typeof ctx?.cwd === "string" ? ctx.cwd : undefined);
}

function sessionFileFromCtx(ctx?: any): string | undefined {
  try { return ctx?.sessionManager?.getSessionFile?.() || undefined; } catch { return undefined; }
}
const PY_MEM = path.join(EXT_DIR, "zgmem.py");
const PY_ETL = path.join(EXT_DIR, "jsonl2corpus.py");
const EMBEDDING = process.env.ZGMEM_EMBEDDING || "local/potion-multilingual-128m";

/** 会话关闭时中止在跑的 python/zg 子进程(防超时半写/孤儿 zg) */
let _abort = new AbortController();

/**
 * pi 在 /new /resume /fork 时复用已加载模块(不重执行模块体), 但 session_shutdown 已把 _abort 打死 —
 * 必须换新, 否则本进程所有子进程永久 AbortError。顺带清按 ws 的 memo(会话换了, 给一次重试机会)。
 */
function liveAbort(): AbortController {
  if (_abort.signal.aborted) {
    _abort = new AbortController();
    _readyByWs.clear();
    _refreshQueued = false;
  }
  return _abort;
}

function runPy(script: string, args: string[], timeoutMs = 120_000, extraSignal?: AbortSignal): Promise<string> {
  const signal = extraSignal ? AbortSignal.any([liveAbort().signal, extraSignal]) : liveAbort().signal;
  return execFileAsync("python3", [script, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    signal,
  }).then((r) => r.stdout);
}

async function zgIndex(cwd: string, rebuild = false): Promise<void> {
  const args = ["index", "."];
  if (rebuild) args.push("--rebuild");
  args.push("--embedding", EMBEDDING);
  await execFileAsync("zg", args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, signal: liveAbort().signal });
}

function currentSessionFile(): string | undefined {
  return process.env.PI_SESSION_FILE || undefined;
}

// ---------- 索引变更串行队列(全量构建/增量刷新互斥, 防 manifest/index 并发写坏) ----------
let _queueTail: Promise<unknown> = Promise.resolve();
let _epoch = 0;   // session 轮换(/new /resume /fork)时 +1, 队列里排队未起跑的旧任务作废
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = _queueTail.then(fn, fn);          // 前序失败也继续执行
  _queueTail = run.then(() => {}, () => {});    // 失败不毒化链
  return run;
}

/** 全量构建索引(首次或手动): ETL 该 workdir 下全部 session + zg index (走串行队列) */
function buildFullIndex(sessionsDir: string, corpusDir: string): Promise<string> {
  const epoch = _epoch;
  return enqueue(async () => {
    if (epoch !== _epoch) throw new Error("session 已切换, 排队中的全量构建作废");
    if (!hasSessionFiles(sessionsDir)) return `skip: no jsonl in ${sessionsDir}`;
    await runPy(PY_ETL, [path.join(sessionsDir, "*.jsonl"), corpusDir]);
    await zgIndex(corpusDir, true);
    return `indexed all sessions in ${sessionsDir}`;
  });
}

// ---------- 每轮结束后的增量刷新: 冷却 + 合并 + 串行 ----------
let _refreshQueued = false;
let _lastRefreshAt = 0;
function scheduleRefresh(sessionsDir: string, ws: string): void {
  if (!fs.existsSync(path.join(ZGMEM_ROOT, ws, "manifest.json"))) return;  // workspace 未初始化: 无可刷新, 等 ensure 建好
  if (_refreshQueued) return;                                  // 已排队/进行中, 合并掉
  if (Date.now() - _lastRefreshAt < 15_000) return;            // 15s 冷却
  _refreshQueued = true;
  const epoch = _epoch;
  enqueue(async () => {
    if (epoch !== _epoch) return;            // session 已轮换: 排队中的旧刷新作废, 不再往旧会话外 spawn
    try {
      await runPy(PY_MEM, ["refresh", "--sessions-dir", sessionsDir, "--workspace", ws], 600_000);
    } finally {
      if (epoch === _epoch) {
        _lastRefreshAt = Date.now();   // 失败也计冷却, 防持续失败每回合狂刷
        _refreshQueued = false;
      }
    }
  }).catch((e) => {
    console.error("[zg-memory] refresh failed:", e?.message || e);
  });
}

// ---------- 按 workspace 单飞: 每个 ws 独立 promise(失败保留=本进程不重试) ----------
const _readyByWs = new Map<string, Promise<void>>();

/** 返回 true=已就绪(可记忆); false=本次没建成(不记忆, 目录出现后再试) */
async function doEnsureIndexReady(ws: string, ctx?: any): Promise<boolean> {
  const corpusDir = corpusDirOf(ws);
  const indexMarker = path.join(corpusDir, ".zvec-grep", "index.zvec");
  if (fs.existsSync(indexMarker)) return true;
  const sessFile = sessionFileFromCtx(ctx) || currentSessionFile();
  const sessionsDir = sessionsDirFor(ws, sessFile);
  // 无会话目录/目录还没有 jsonl(新会话文件未落盘): 不建不记忆, 首次查询时再试
  if (!sessionsDir || !fs.existsSync(sessionsDir) || !hasSessionFiles(sessionsDir)) return false;
  await buildFullIndex(sessionsDir, corpusDir);
  return true;
}

/** 查询前确保目标 workspace 索引就绪(按 ws 单飞; 失败/未建成都不记忆, 可重试) */
function ensureIndexReady(ctx?: any, wsOverride?: string): Promise<void> {
  const ws = wsOverride || workspaceFromCtx(ctx);
  let p = _readyByWs.get(ws);
  if (!p) {
    p = doEnsureIndexReady(ws, ctx)
      .then((done) => { if (!done && _readyByWs.get(ws) === p) _readyByWs.delete(ws); })
      .catch((e) => { if (_readyByWs.get(ws) === p) _readyByWs.delete(ws); throw e; });
    _readyByWs.set(ws, p);
  }
  return p;
}

function truncateStr(s: string, n = 6000): string {
  return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
}

function toolResult(text: string, details: Record<string, unknown> = {}): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], details };
}

export default function (pi: ExtensionAPI) {
  // ---------- 工具 1: 查询 ----------
  pi.registerTool({
    name: "zg_memory_query",
    label: "ZG Memory Query",
    description:
      "语义/关键字检索 pi 历史会话记忆(主动召回)。返回 Top-N 条 '对话对'(命中消息+其问答伙伴), 每条带 ref(session+行号) 供 zg_memory_open 深钻。" +
      "用于: 想不起以前说过/做过什么、跨 session 上下文、'上周说过X'这类问题。" +
      "mode=auto 按 query 形态自动路由: 中文/描述性→hybrid(fts+向量), 错误码/驼峰标识/长token→fts 或 rg(JSONL字面精确)。" +
      "范围默认当前工作区全部 session; scope=current 只搜当前会话; workspace 可跨工作区。",
    parameters: Type.Object({
      query: Type.String({ description: "要召回的问题/关键词; 精确 token(错误码/路径/标识符)也能搜" }),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3, description: "返回条数" })),
      scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("current")], { default: "all", description: "all=整个索引; current=只搜当前这个会话" })),
      who: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("user"), Type.Literal("assistant")], { default: "all", description: "限定命中消息是谁说的" })),
      since_days: Type.Optional(Type.Integer({ minimum: 1, description: "只搜过去 N 天内的会话(按会话开始时间)" })),
      workspace: Type.Optional(Type.String({ pattern: "^(?!\\.+$)[A-Za-z0-9._-]+$", description: "workspace 名或 'all'(跨全部已初始化 workspace 合并); 缺省=当前" })),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("hybrid"), Type.Literal("fts"), Type.Literal("rg")], { default: "auto", description: "auto=按query形态自动路由; hybrid=fts+向量; fts=BM25词法; rg=JSONL字面精确" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const ws = params.workspace ?? workspaceFromCtx(ctx);
        await ensureIndexReady(ctx, ws);
        const args = ["query", "--top", String(params.top_k ?? 3), "--json"];
        if (params.scope === "current") {
          const sf = sessionFileFromCtx(ctx) || currentSessionFile();
          if (!sf) {
            return toolResult("scope=current 失败: 当前会话文件不可用, 请去掉 scope 重试。", { error: "no-session-file" });
          }
          args.push("--session", path.basename(sf, ".jsonl"));
        }
        if (params.who && params.who !== "all") args.push("--who", params.who);
        if (params.since_days) args.push("--since", String(params.since_days));
        if (params.mode && params.mode !== "auto") args.push("--mode", params.mode);
        // '--' 隔离: query 以 '-' 开头也不会被 argparse 当成选项
        args.push("--workspace", ws, "--", params.query);
        const out = await runPy(PY_MEM, args, 120_000, _signal);
        let pairs: any[] = [];
        try { pairs = JSON.parse(out); } catch { }
        if (!Array.isArray(pairs)) {
          // python 会把错误文本打到 stdout; 不能再伪装成"没有命中"
          return toolResult("检索引擎输出不是 JSON 数组(可能出错): " + out.slice(0, 300), { error: "non-json", raw: out.slice(0, 300) });
        }
        if (pairs.length === 0) {
          return toolResult("没有命中相关记忆。", { hits: 0 });
        }
        // 可读摘要: 带完整 session id 与 corpus_line, 供 zg_memory_open 直接回指
        const lines = pairs.map((p, i) => {
          const tsNum = Number(p?.ts);
          const t = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum).toISOString().slice(0, 16).replace("T", " ") : "?";
          const ref = p?.ref || {};
          const src = `session=${ref.session ?? "?"} corpus_line=${ref.corpus_line ?? "?"} jsonl_line=${ref.jsonl_line ?? "?"}`;
          return `[${i + 1}] ${t} ${src} [${ref.workspace ?? ""}] (role=${p?.role ?? "?"})\n  USER     : ${String(p?.user || "").slice(0, 180)}\n  ASSISTANT: ${String(p?.assistant || "").slice(0, 240)}`;
        });
        return toolResult("命中 " + pairs.length + " 条记忆:\n\n" + lines.join("\n\n"), {
          hits: pairs.length,
          refs: pairs.map((p) => p?.ref).filter(Boolean),
        });
      } catch (e: any) {
        return toolResult("检索失败: " + (e?.message || String(e)), { error: String(e) });
      }
    },
  });

  // ---------- 工具 2: 深钻 ----------
  pi.registerTool({
    name: "zg_memory_open",
    label: "ZG Memory Open",
    description:
      "对 zg_memory_query 命中的一条记忆做深钻。mode=full 查看该消息原始记录(thinking/工具调用); mode=ctx 查看它前后 span 条上下文对话。" +
      "参数 session, corpus_line 来自 query 返回的 ref。",
    parameters: Type.Object({
      session: Type.String({ pattern: "^(?!\\.+$)[A-Za-z0-9._-]+$", description: "会话 id(ref.session)" }),
      corpus_line: Type.Integer({ description: "corpus 行号(ref.corpus_line)" }),
      mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("ctx")], { default: "full", description: "full=单条原始记录(含thinking/工具); ctx=扩展上下文" })),
      span: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 3, description: "ctx 模式下前后多少条" })),
      workspace: Type.Optional(Type.String({ pattern: "^(?!\\.+$)[A-Za-z0-9._-]+$", description: "目标 workspace(ref.workspace); 缺省=当前" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const mode = params.mode ?? "full";
        const ws = params.workspace ?? workspaceFromCtx(ctx);
        await ensureIndexReady(ctx, ws);   // refs 可能指向其他 workspace(workspace=all 扇出)
        const out = mode === "ctx"
          ? await runPy(PY_MEM, ["ctx", params.session, String(params.corpus_line), "--span", String(params.span ?? 3), "--workspace", ws], 120_000, _signal)
          : await runPy(PY_MEM, ["show", params.session, String(params.corpus_line), "--full", "--workspace", ws], 120_000, _signal);
        return toolResult(truncateStr(out));
      } catch (e: any) {
        return toolResult("深钻失败: " + (e?.message || String(e)), { error: String(e) });
      }
    },
  });

  // ---------- 命令: 手动维护 ----------
  pi.registerCommand("zgmem", {
    description: "维护/查询 zg 记忆索引. 用法: /zgmem refresh | reindex | sessions",
    handler: async (_args, ctx) => {
      const arg = (_args || "").trim();
      const sessFile = sessionFileFromCtx(ctx) || currentSessionFile();
      const ws = workspaceFromCtx(ctx);
      const sessionsDir = sessionsDirFor(ws, sessFile);
      try {
        if (arg === "refresh") {
          if (!sessionsDir) { ctx.ui.notify(`no sessions dir for workspace ${ws}`, "error"); return; }
          const out = await enqueue(() => runPy(PY_MEM, ["refresh", "--sessions-dir", sessionsDir, "--workspace", ws], 600_000));   // 与自动刷新/全量构建互斥
          ctx.ui.notify(out.slice(-500), "info");
        } else if (arg === "reindex" || arg === "") {
          if (!sessionsDir) { ctx.ui.notify(`no sessions dir for workspace ${ws}`, "error"); return; }
          const msg = await buildFullIndex(sessionsDir, corpusDirOf(ws));   // 内部走串行队列
          ctx.ui.notify(msg.startsWith("skip:") ? `跳过: workspace ${ws} 尚无会话文件` : "已全量重建 zg 记忆索引", "info");
        } else if (arg === "sessions") {
          const out = await runPy(PY_MEM, ["sessions", "--workspace", ws]);
          ctx.ui.notify(out.slice(-2000), "info");
        } else {
          ctx.ui.notify(`未知子命令: ${arg}`, "error");
        }
      } catch (e: any) {
        ctx.ui.notify("失败: " + (e?.message || String(e)), "error");
      }
    },
  });

  // ---------- 维护: 每轮结束后扫描 sessions 目录, 增量刷新有变化的会话 ----------
  // 覆盖缺口: 被恢复重写的旧会话也会被扫到, 而不仅当前 session (subagent 临时会话不在此目录, 不参与)
  pi.on("agent_settled", async (_event, ctx) => {
    const sf = sessionFileFromCtx(ctx) || currentSessionFile();
    const ws = workspaceFromCtx(ctx);
    const sessionsDir = sessionsDirFor(ws, sf);
    if (!sessionsDir) return;
    scheduleRefresh(sessionsDir, ws);
  });

  // ---------- 启动时后台建索引(不阻塞会话启动) ----------
  pi.on("session_start", async (_event, ctx) => {
    // 不 await：存量全量构建扔后台跑; 查询若恰好撞上, 会共享同一 promise 等它完成
    ensureIndexReady(ctx).catch((e) => {
      console.error("[zg-memory] background index build failed:", e?.message || e);
    });
  });

  // ---------- 会话关闭: 中止在跑的 python/zg 子进程(幂等, 防半写/孤儿进程) ----------
  pi.on("session_shutdown", async () => {
    _epoch++;                 // 队列里排队未起跑的旧任务作废
    _refreshQueued = false;
    _abort.abort();
  });
}