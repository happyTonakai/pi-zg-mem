/**
 * 模块 C（lib/query.ts ← zgmem.py 查询侧）的回归。
 *
 * 迁移自 Python 的用例（名字保持原样，便于逐条对照）：
 *   TestH2HitRefinement.test_refine_hit_line_end_to_end
 * 其余用例是**差分/变异证据转成的常驻断言**：差分脚本（`tests/differential/query_differential.ts`）
 * 与变异脚本（`tests/differential/mutate_query.sh`）是迁移期一次性证据、已随模块 G 删除，
 * 它们当时“改坏了必须红”的点留在这里常驻：
 *   - rg 的 since 单位（`now_ms - since*86400*1000`，写错差 1000 倍）
 *   - rg who 过滤 / --session glob / pairFromJsonl 兜底
 *   - 跨 workspace 去重键必须含 session（否则不同 session 的同号行被合并）
 *   - show 截断 800 / ctx 截断 200 + 换行→空格 / ctx 窗口
 *   - limit = pool>top ? pool : top、精修开关键、非法 session id
 * 这些断言不依赖 Python（rg 用真的，zg 用假脚本）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import * as zc from "../extensions/zg-memory/lib/corpus.ts";
import * as etl from "../extensions/zg-memory/lib/etl.ts";
import * as q from "../extensions/zg-memory/lib/query.ts";

const BASE_TS = 1_700_000_000_000;
const MARKER = "图书直播选题 的唯一标记行";
/** 长文本：show 的 800 截断与 ctx 的 200 截断 + 换行→空格 替换一起被钉住。 */
const LONG = Array.from({ length: 900 }, (_, k) => (k % 10 === 9 ? "\n" : k % 2 === 0 ? "x" : "あ")).join("");

function msgLine(role: string, text: string, ts: number): string {
  return JSON.stringify({ type: "message", message: { role, timestamp: ts, content: [{ type: "text", text }] } });
}

/** 给 msg 加一个顶层 `toolResult` 键（show 的 toolResult 标记分支）。 */
function msgLineWithToolResult(text: string, ts: number): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      timestamp: ts,
      toolResult: { ok: true },
      content: [{ type: "text", text }],
    },
  });
}

/** 非 user/assistant 文本：不进语料，但占 jsonl 行号（corpus_line ≠ jsonl_line 的成因）。 */
function toolResultLine(ts: number): string {
  return JSON.stringify({
    type: "toolResult",
    message: { role: "tool", timestamp: ts, content: [{ type: "toolResult", text: "TOOLONLY_MARKER 工具输出" }] },
  });
}

interface Fixture {
  root: string;
  home: string;
  /** sessP 的 jsonl 路径（ctx 用例要直接读源文本，证明“含换行”这条分支是活的）。 */
  jsonlP: string;
  /** ws-a = {sessP(标记@80, 长文本@95, 跨 ws 共享标记@31), sessR(近期标记)} */
  scopeA: q.Scope;
  /** ws-b 只有 sessP 的一份**拷贝**（路径不同、session/jsonl_line 相同）→ 跨 ws 去重键的测试点 */
  scopeB: q.Scope;
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-c-"));
  const home = path.join(root, "zgmem");
  const dirA = path.join(root, "sessions-a");
  const dirB = path.join(root, "sessions-b");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const p: string[] = [];
  for (let i = 1; i <= 100; i++) {
    if (i === 42) {
      p.push(toolResultLine(BASE_TS + i));
      p.push(msgLine("tool", "工具输出占位", BASE_TS + i));
    }
    const text =
      i === 80 ? `${MARKER}` : i === 95 ? LONG : i === 31 ? "SHARED_MARKER sessP" : `sessP 第 ${i} 条 普通内容 filler`;
    p.push(msgLine(i % 2 === 1 ? "user" : "assistant", text, BASE_TS + i * 1000));
  }
  fs.writeFileSync(path.join(dirA, "sessP.jsonl"), `${p.concat([msgLineWithToolResult("带 toolResult 键的 assistant 行", BASE_TS + 200_000)]).join("\n")}\n`);
  fs.writeFileSync(path.join(dirB, "sessP.jsonl"), `${p.join("\n")}\n`); // 同一 session 的另一份拷贝

  const r: string[] = [];
  const recent = Date.now() - 3600_000; // 1 小时前
  for (let i = 1; i <= 50; i++) {
    const text = i === 31 ? "SHARED_MARKER sessR" : i === 40 ? "RECENT_ONLY_MARKER" : `sessR 第 ${i} 条 普通内容 filler`;
    r.push(msgLine(i % 2 === 1 ? "user" : "assistant", text, i === 40 ? recent : BASE_TS + i * 1000));
  }
  fs.writeFileSync(path.join(dirA, "sessR.jsonl"), `${r.join("\n")}\n`);

  // 语料用 TS 的 ETL 建（模块 B 已逐字节对齐 Python，不是本模块的被测对象）
  for (const [ws, dir] of [
    ["ws-a", dirA],
    ["ws-b", dirB],
  ] as const) {
    const res = etl.runEtl(path.join(dir, "*.jsonl"), path.join(home, ws, "corpus"));
    assert.equal(res.code, 0, `ETL 建语料失败 ${ws}: ${res.lines.join("\n")}`);
  }
  return { root, home, jsonlP: path.join(dirA, "sessP.jsonl"), scopeA: q.loadScope("ws-a", home, true), scopeB: q.loadScope("ws-b", home, true) };
}

/** 临时把 process.env.PATH 指到含假 zg 的目录（lib 里 spawnSync 继承 process.env）。 */
function withFakeZg(script: string, fn: (log: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-c-bin-"));
  const log = path.join(dir, "zg.log");
  fs.writeFileSync(path.join(dir, "zg"), script, { mode: 0o755 });
  const oldPath = process.env["PATH"];
  const oldLog = process.env["FAKE_ZG_LOG"];
  process.env["PATH"] = `${dir}:${oldPath ?? ""}`;
  process.env["FAKE_ZG_LOG"] = log;
  try {
    fn(log);
  } finally {
    process.env["PATH"] = oldPath;
    if (oldLog === undefined) delete process.env["FAKE_ZG_LOG"];
    else process.env["FAKE_ZG_LOG"] = oldLog;
  }
}

const FAKE_ZG = `#!/bin/sh
for a in "$@"; do printf 'ARG %s\\n' "$a"; done >> "$FAKE_ZG_LOG"
printf 'CWD %s\\n' "$PWD" >> "$FAKE_ZG_LOG"
cat <<'EOF'
#1 matchedBy=fts+vector 2026-09-23 10:00 sessP.p0001.txt:64
#2 matchedBy=fts+vector 2026-09-23 10:00 sessP.p0001.txt:64
#3 matchedBy=vector 2026-09-23 10:00 ghost.p0001.txt:5
#4 matchedBy=fts 2026-09-23 10:00 sessP.p0001.txt:20
#5 matchedBy=fts+vector 2026-09-23 10:00 sessP.p0001.txt:30
EOF
exit 0
`;

// ---------- H2: 精修（Python 原用例） ----------

test("TestH2HitRefinement.test_refine_hit_line_end_to_end", () => {
  const { scopeA } = buildFixture();
  const cname = Object.keys(zc.segments(scopeA.manifest))[0];
  const meta = zc.segments(scopeA.manifest)[cname] as unknown as zc.SegmentMeta;
  const blockStart = 64; // zg 只给分片内行号（块首行）
  assert.equal(q.refineHitLine(scopeA, cname, meta, blockStart, "图书直播选题"), 80);
  const noRefine: q.Scope = { ...scopeA, refineHits: false };
  assert.equal(q.refineHitLine(noRefine, cname, meta, blockStart, "图书直播选题"), blockStart);
});

// ---------- rg 召回 ----------

test("rgCandidates.pair_is_built_from_corpus_with_correct_line_numbers", () => {
  const { scopeA } = buildFixture();
  const hits = q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ref.session, "sessP");
  assert.equal(hits[0].ref.corpus_line, 80);
  assert.equal(hits[0].ref.jsonl_line, 82, "corpus_line 80 前面插了两行 tool 行 → jsonl_line 82");
  assert.equal(hits[0].ref.workspace, "ws-a");
});

test("rgCandidates.who_filter_keeps_only_that_role", () => {
  const { scopeA } = buildFixture();
  for (const role of ["user", "assistant"]) {
    const hits = q.rgCandidates(scopeA, { query: "普通内容 filler", who: role }, 5, "ws-a");
    assert.ok(hits.length > 0, `${role} 应有命中`);
    assert.deepEqual([...new Set(hits.map((h) => h.role))], [role]);
  }
});

test("rgCandidates.since_cutoff_is_ms_not_seconds", () => {
  const { scopeA } = buildFixture();
  // 1 小时前的消息：--since 1（1 天）必须保留；单位写错（差 1000 倍）会把所有东西滤掉
  assert.equal(q.rgCandidates(scopeA, { query: "RECENT_ONLY_MARKER", since: 1 }, 5, "ws-a").length, 1);
  assert.equal(q.rgCandidates(scopeA, { query: "RECENT_ONLY_MARKER", since: 30 }, 5, "ws-a").length, 1);
  // 2023 年时间戳的旧命中：--since 1 必须被滤掉（反向错会被这条抓住）
  assert.equal(q.rgCandidates(scopeA, { query: MARKER, since: 1 }, 5, "ws-a").length, 0);
});

test("rgCandidates.session_glob_is_a_noop_parity_with_upstream_bug", () => {
  const { scopeA } = buildFixture();
  assert.equal(q.rgCandidates(scopeA, { query: "SHARED_MARKER" }, 5, "ws-a").length, 2);
  // ⚠️ 上游 bug（Python 同样）：rgCandidates 把 `--glob sessP.jsonl` 传给 rg，但目标是**显式文件**，
  // rg 对显式文件参数完全忽略 -g/--glob（只有传目录时才生效；实测 `rg -g '!sessR.jsonl' f1 f2` 仍搜两个）。
  // 所以 rg 模式下 `--session` 不起作用 —— 别的 session 的命中照样吐出来。
  // 裸 rg 复现：`mkdir -p t/a && echo hello > t/a/sessP.jsonl && echo hello > t/a/sessR.jsonl &&
  //   rg -n --no-heading -H -e hello --glob 'sessP.jsonl' t/a/sessP.jsonl t/a/sessR.jsonl` → 2 条
  // 迁移期保持与 Python 逐字节一致，**不**单方面修 TS；这条断言钉住的就是“过滤不存在”。
  const hits = q.rgCandidates(scopeA, { query: "SHARED_MARKER", session: "sessP" }, 5, "ws-a");
  assert.deepEqual([...new Set(hits.map((h) => h.ref.session))].sort(), ["sessP", "sessR"]);
});

test("rgCandidates_falls_back_to_pairFromJsonl_for_rows_outside_corpus", () => {
  const { scopeA } = buildFixture();
  const hits = q.rgCandidates(scopeA, { query: "TOOLONLY_MARKER" }, 5, "ws-a");
  assert.equal(hits.length, 1, "toolResult 行不在语料里，必须走 pairFromJsonl 兜底");
  assert.equal(hits[0].role, "tool");
  assert.equal(hits[0].ref.jsonl_line, 42);
  assert.match(hits[0].text ?? "", /TOOLONLY_MARKER/);
  assert.equal(hits[0].ref.corpus_line, 0, "兜底 pair 的 corpus_line 是 0（zgmem.py:414 就是 corpus_line:0）");
});

// ---------- runQuery：rg 路径 + workspace 扇出 ----------

function queryEnv(home: string, ws: string): q.QueryEnv {
  return q.queryEnv({ ZGMEM_DIR: home, ZGMEM_SCOPE: ws } as NodeJS.ProcessEnv);
}

// ---------- 子进程输出上限（Node maxBuffer 回归） ----------

/**
 * Node 的 spawnSync 默认 maxBuffer 只有 1 MiB（Python 的 subprocess.run 没上限）。
 * 超限时 spawnSync 给 error.code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER + status=null；
 * 若不显式 check，rg 召回会被当成“没命中”而返回空数组，**静默给出错答案**
 * （真机全量 rg 命中早就过 1 MiB）。这里把上限压到 1 字节，钉住“必须抛”而不是“返回空”。
 */
test("rgCandidates.raises_on_maxbuffer_instead_of_silently_returning_nothing", () => {
  const { scopeA } = buildFixture();
  // 先钉住默认值本身：环境变量没设时必须远大于 Node 的 1 MiB 默认，
  // 否则“把默认改回 1 MiB”这个测试仍会绿（下面只验证“超限要抛”）。
  assert.ok(zc.subprocessMaxBuffer() > 1024 * 1024, `默认上限 ${zc.subprocessMaxBuffer()} 应 > 1 MiB`);
  const baseline = q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a");
  assert.ok(baseline.length > 0, "前置：这个 fixture 本来能命中，否则“返回空”也能骗过断言");

  const key = "ZGMEM_SUBPROCESS_MAX_BUFFER";
  const old = process.env[key];
  process.env[key] = "1";
  try {
    assert.throws(
      () => q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a"),
      (e: unknown) => /ENOBUFS/.test(String((e as { code?: string })?.code ?? "") + String((e as Error)?.message ?? "")),
      "超限必须是显式异常，不能静默返回 []",
    );
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
  // 恢复后又能正常命中（证明上面压小上限就是唯一变量）
  assert.equal(q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a").length, baseline.length);
});

/**
 * A1（第三轮评审：Module G 删掉 Python 后零守卫的静默错答案）：“rg 非零退出 → 丢掉整个
 * workspace 的候选”，输出仍是“(无命中)”。真实触发路径 = manifest 里还留着 jsonl_path、文件已被删。
 *
 * 因为 zgmem.py:350 也是同一行为（忠于 Python），这里钉的是**现状**而不是“应该抛”：想改就得连
 * docs/plan-ts-migration.md「已知残余差异 · rg 子进程非零退出时会丢掉全部候选」一起改。
 * 与上面的 maxBuffer 用例的分工：那条只守 `proc.error`（真正的启动失败/ENOBUFS），这条守 `status!==0`。
 */
test("rgCandidates.nonzero_rg_exit_returns_empty_not_throw (A1)", () => {
  const { home, scopeA } = buildFixture();
  const env = queryEnv(home, "ws-a");
  assert.ok(q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a").length > 0, "前置：文件还在时必须能命中");

  // 把 manifest 里登记的所有 jsonl 全删掉 → rg 找不到任何 target，退 2（不是“没命中”的 1）
  for (const m of Object.values(zc.sessions(scopeA.manifest))) {
    if (typeof m.jsonl_path === "string") fs.unlinkSync(m.jsonl_path);
  }
  assert.deepEqual(q.rgCandidates(scopeA, { query: MARKER }, 5, "ws-a"), [], "非零退出不能抛，只丢候选");
  const res = q.runQuery({ query: MARKER, mode: "rg", workspace: "ws-a" }, env);
  assert.equal(res.code, 0);
  assert.equal(res.out, "(无命中)\n", "坏掉的 workspace 与“真的没命中”在输出上仍不可分（已知残余，不是 bug 修复点）");
});

test("runQuery.workspace_all_dedupes_by_session_not_by_jsonl_line", () => {
  const { home } = buildFixture();
  // ws-a 与 ws-b 各有一份 sessP 拷贝（jsonl 路径不同、session/jsonl_line 相同）→ 只能出一条；
  // 而 sessP@sessR 的 SHARED_MARKER 落在**同一 jsonl 行号 31** 上 → 去重键不能只含行号，否则这两条被并成一条
  const res = q.runQuery({ query: "SHARED_MARKER", mode: "rg", workspace: "all", json: true }, queryEnv(home, "ws-a"));
  assert.equal(res.code, 0);
  const pairs = JSON.parse(res.out) as q.QueryPair[];
  assert.deepEqual(pairs.map((p) => p.ref.session).sort(), ["sessP", "sessR"]);
  assert.deepEqual(pairs.map((p) => p.ref.workspace).sort(), ["ws-a", "ws-a"]);
});

test("runQuery.rg_no_hit_and_json_empty_array", () => {
  const { home } = buildFixture();
  const env = queryEnv(home, "ws-a");
  assert.equal(q.runQuery({ query: "绝对不存在的字符串 zzz", mode: "rg" }, env).out, "(无命中)\n");
  assert.equal(q.runQuery({ query: "绝对不存在的字符串 zzz", mode: "rg", json: true }, env).out, "[]\n");
});

test("runQuery.rejects_glob_metacharacters_in_session_id", () => {
  const { home } = buildFixture();
  assert.equal(q.runQuery({ query: "x", session: "sess*" }, queryEnv(home, "ws-a")).out, "非法 session id\n");
});

test("runQuery.unknown_workspace_returns_message_not_throw", () => {
  const { home } = buildFixture();
  // 单 workspace 时 loadScope 的 ScopeExit 被 runQuery 吞成输出行（Python: except SystemExit 分支）
  const res = q.runQuery({ query: "x", workspace: "nope" }, queryEnv(home, "ws-a"));
  assert.equal(res.code, 0);
  assert.match(res.out, /^workspace 'nope' 未初始化 \(缺 .*manifest\.json\); 已有:/);
});

// ---------- runQuery：zg 路径（假 zg） ----------

test("runQuery.zg_limit_uses_pool_when_pool_exceeds_top", () => {
  const { home } = buildFixture();
  withFakeZg(FAKE_ZG, (log) => {
    q.runQuery({ query: "图书直播选题", pool: 5, top: 2 }, queryEnv(home, "ws-a"));
    const argv = fs.readFileSync(log, "utf8");
    assert.match(argv, /ARG --limit\nARG 5\n/, "pool>top 时 limit 取 pool");
    fs.writeFileSync(log, "");
    q.runQuery({ query: "图书直播选题", top: 4 }, queryEnv(home, "ws-a"));
    assert.match(fs.readFileSync(log, "utf8"), /ARG --limit\nARG 4\n/, "没给 pool 时 limit 取 top");
  });
});

test("runQuery.zg_ranks_by_1_over_order_and_dedupes_repeated_hits", () => {
  const { home } = buildFixture();
  withFakeZg(FAKE_ZG, () => {
    // 假 zg 的第 1、2 条是同一分片的同一行（精修后同一行）→ 去重后占一个名次；
    // ghost.p0001.txt 不在 manifest 里 → 丢弃。最终 5 条里只剩 sessP 的几条。
    const res = q.runQuery({ query: "图书直播选题", workspace: "ws-a", top: 5 }, queryEnv(home, "ws-a"));
    const lines = res.out.split("\n").filter((l) => l.startsWith("--- ["));
    assert.deepEqual(
      lines.map((l) => l.slice(0, 7)),
      ["--- [1]", "--- [2]", "--- [3]"],
      "命中头行保持 zg 名次顺序（1/(order+1) 单调）",
    );
  });
});

test("runQuery.zg_hit_refine_can_be_disabled", () => {
  const { home } = buildFixture();
  withFakeZg(FAKE_ZG, () => {
    const on = q.runQuery({ query: "图书直播选题", workspace: "ws-a", top: 1 }, queryEnv(home, "ws-a"));
    const off = q.runQuery(
      { query: "图书直播选题", workspace: "ws-a", top: 1 },
      q.queryEnv({ ZGMEM_DIR: home, ZGMEM_SCOPE: "ws-a", ZGMEM_HIT_REFINE: "0" } as NodeJS.ProcessEnv),
    );
    assert.notEqual(on.out, off.out, "关掉精修后落到的行不同（块首行 vs 真命中行）");
  });
});

test("runQuery.zg_failure_keeps_single_workspace_semantics", () => {
  const { home } = buildFixture();
  withFakeZg("#!/bin/sh\nexit 1\n", () => {
    // 单 workspace：把错误吞进 stdout 且 exit 0（Python 的 cmd_query 行为）
    const res = q.runQuery({ query: "x", workspace: "ws-a" }, queryEnv(home, "ws-a"));
    assert.equal(res.code, 0);
    // 扇出：单个 workspace 失败被跳过，不报错
    const all = q.runQuery({ query: "x", workspace: "all" }, queryEnv(home, "ws-a"));
    assert.equal(all.code, 0);
  });
});

/**
 * A2（同 A1）：`--workspace all` 扇出时，某个 workspace 的 zg 非零退出被 `continue` 静默跳过 ——
 * 它的 stderr 不进结果，于是“某个 workspace 坏了”与“它没命中”在输出上不可分。同样忠于 Python，
 * 所以钉现状（见 docs/plan-ts-migration.md「已知残余差异 · `--workspace all` 扇出时静默丢失败 workspace」）。
 * 与上一条的分工：上一条所有 workspace 都坏（退出码），这条只有 ws-b 坏（**好 workspace 的结果必须还在**）。
 */
test("runQuery.workspace_all_silently_drops_failed_workspace (A2)", () => {
  const { home } = buildFixture();
  // 假 zg 按 cwd 分叉：ws-b 的语料目录 exit 1 + 一句 stderr，ws-a 照常返回命中。
  // （lib 里 spawnSync 的 cwd 就是 scope.corpusDir，所以 $PWD 能区分 workspace。）
  const script = `#!/bin/sh
case "$PWD" in
  */ws-b/*) echo "BOOM_WS_B: embedding daemon down" >&2; exit 1 ;;
esac
${FAKE_ZG}`;
  withFakeZg(script, () => {
    const all = q.runQuery({ query: "图书直播选题", workspace: "all", top: 5 }, queryEnv(home, "ws-a"));
    assert.equal(all.code, 0);
    const heads = all.out.split("\n").filter((l) => l.startsWith("--- ["));
    assert.deepEqual(heads.map((l) => l.slice(0, 7)), ["--- [1]", "--- [2]", "--- [3]"], "ws-a 的命中必须还在（一个坏 workspace 不能拖垮整轮扇出）");
    assert.equal(all.out.includes("BOOM_WS_B"), false, "坏 workspace 的 stderr 不进结果（已知残余）");
  });
});

// ---------- show / ctx ----------

test("runShow.slices_text_and_thinking_at_800", () => {
  const { home } = buildFixture();
  const env = queryEnv(home, "ws-a");
  const res = q.runShow("sessP", 95, false, "ws-a", env);
  assert.equal(res.code, 0);
  assert.ok(res.out.includes(`\n[text]\n${q.pySlice(LONG, 800)}\n`), "show 截断 800");
  assert.equal(res.out.includes(LONG), false, "整段长文本不该出现");
});

test("runShow.marks_tool_result_and_jsonl_line", () => {
  const { home } = buildFixture();
  const env = queryEnv(home, "ws-a");
  const res = q.runShow("sessP", 80, false, "ws-a", env);
  assert.match(res.out, /^session=sessP jsonl_line=82 role=assistant ts=1700000080000\n/);
  // 真实 pi 的 toolResult 消息 role=tool，进不了语料（etl.ts:180 只收 user/assistant），
  // 所以这条分支实际只在 user/assistant 消息带顶层 toolResult 键时可达 —— Python/TS 一致。
  // 语料末行（第 101 条）就是那条 assistant 消息。
  const tool = q.runShow("sessP", 101, false, "ws-a", env);
  assert.match(tool.out, /\[toolResult field present\]/);
});

test("runShow.unknown_session_and_bad_corpus_line", () => {
  const { home } = buildFixture();
  const env = queryEnv(home, "ws-a");
  assert.equal(q.runShow("nope", 1, false, "ws-a", env).out, "unknown session nope\n");
  assert.equal(q.runShow("sessP", 999999, false, "ws-a", env).out, "bad corpus line\n");
});

test("runCtx.window_span_and_truncation_and_newline_replacement", () => {
  const { home, jsonlP } = buildFixture();
  const env = queryEnv(home, "ws-a");
  const res = q.runCtx("sessP", 95, 1, "ws-a", env);
  // 窗口 = 目标 ±1 共 3 条；corpus_line 95 的前面有两行 tool → jsonl_line 97
  assert.ok(res.out.endsWith("\n(共 3 条, 目标在 jsonl_line=97)\n"), `尾部标记: ${JSON.stringify(res.out.slice(-40))}`);
  const body = res.out.split("\n").filter((l) => l.startsWith("["));
  assert.equal(body.length, 3);
  // ctx 读的是**原始 jsonl**（不是语料），所以长文本里真的有换行 —— `replaceAll("\n", " ")` 是活代码：
  // 拿掉它，单条记录会断成好几行，下面的行数/条数断言就会红。
  const src = JSON.parse(fs.readFileSync(jsonlP, "utf8").split("\n")[96]) as { message: { content: Array<{ text: string }> } };
  assert.ok(src.message.content[0].text.includes("\n"), "源文本确实含换行（否则这条断言是死的）");
  assert.equal(res.out.split("\n").filter((l) => l !== "").length, 4, "3 条记录 + 1 行总数标记：记录内部不能再有换行");
  const long = body.find((l) => l.includes("x")) as string;
  assert.ok(long.length <= 1 + 16 + 2 + 200, `ctx 单行截断 200: ${long.length}`);
  assert.equal(long.includes("\r"), false);
  assert.equal(/\[\]\s+\w+/.test(long), false);
});

test("runCtx.unknown_session_and_bad_corpus_line", () => {
  const { home } = buildFixture();
  const env = queryEnv(home, "ws-a");
  assert.equal(q.runCtx("nope", 1, 3, "ws-a", env).out, "unknown session nope\n");
  assert.equal(q.runCtx("sessP", 999999, 3, "ws-a", env).out, "bad corpus line\n");
});

// ---------- pyInt：Python `int()` 的十进制解析 ----------
// 迁移期的证据是 `tests/differential/query_differential.ts` + /tmp 的 Nd 全量对拍（1122 例：全部 760 个 Nd
// 码点 + 76 个 Nd 段边界 + 对抗样例，与 CPython 逐条一致）；那些脚本已随模块 G 删除，这里留常驻断言。
// 为什么不是“不可达”：q.pyInt 是 argparse 的 `type=`（cli.ts:517），用户 argv 直接可控。

test("pyInt.accepts_unicode_nd_digits_like_cpython", () => {
  // CPython 的 int() 经 _PyUnicode_TransformDecimalAndSpaceToASCII 按 Nd 属性映射数字
  assert.equal(q.pyInt("٣"), 3);
  assert.equal(q.pyInt("٣٤"), 34);
  assert.equal(q.pyInt("１２"), 12); // 全角
  assert.equal(q.pyInt("５"), 5);
  assert.equal(q.pyInt("𝟎𝟏"), 1); // U+1D7CE.. 数学粗体
  assert.equal(q.pyInt("०१"), 1); // 天城文
});

test("pyInt.rejects_non_nd_and_bad_shapes", () => {
  const bad = [
    "²", "①", "〇", "零", "Ⅰ", "５٠²", // No/Nl/Lo —— “像数字”但不是 Nd
    "\u{116cf}", "\u{116e4}", // Nd 段边界外（0x116D0..0x116D9 与 0x116DA..0x116E3 是两段）
    "٣_", "_٣", "1__0", "٣.٥", "٣e2", "٣ ٤", "\u3000", "", "-", "+",
    "\u001c5", "\u001d5", "\u001e5", "\u001f5", // int() 不认这些（str.strip() 认）
    "\ufeff5", // JS 认空白、Python 不认
  ];
  for (const t of bad) {
    assert.throws(() => q.pyInt(t), /invalid literal for int\(\) with base 10/, `${JSON.stringify(t)} 应被拒`);
  }
});

test("pyInt.unicode_digits_full_rule_set", () => {
  assert.equal(q.pyInt("-٣"), -3);
  assert.equal(q.pyInt("+٣"), 3);
  assert.equal(q.pyInt("٣_٤"), 34);
  assert.equal(q.pyInt("１２_٣٤"), 1234);
  assert.equal(q.pyInt("1٣"), 13);
  assert.equal(q.pyInt("\u3000٣\u3000"), 3); // U+3000 在 int() 的空白表里
  assert.equal(q.pyInt("\u{116da}"), 0); // 段首（Nandinagari 第二段）
  assert.equal(q.pyInt("\u{116d9}"), 9); // 相邻前一段的段尾，不能因为“往回走 9 步”算法而误读
  assert.equal(q.pyInt("\u{116e3}"), 9); // 段尾
  assert.equal(q.pyInt("\u{1d7f6}"), 0);
  assert.equal(q.pyInt("\u{1d7ff}"), 9);
  // `int("-0")` 就是 0，不能留 JS 的 -0
  assert.equal(Object.is(q.pyInt("-0"), 0), true);
  assert.equal(Object.is(q.pyInt("-𝟎"), 0), true);
  // pyStrip 的两套空白表不能被合并：str.strip() 剥 \x1c-\x1f，int() 不剥
  assert.equal(q.pyStrip("\u001c5"), "5");
  assert.throws(() => q.pyInt("\u001c5"), /invalid literal/);
});

test("pyRepr.matches_python_str_repr", () => {
  // Python3 的 str repr 保留可打印非 ASCII，只转义不可打印字符（str.isprintable() 为假）
  assert.equal(q.pyRepr("abc"), "'abc'");
  assert.equal(q.pyRepr("٣"), "'٣'");
  assert.equal(q.pyRepr("a'b"), `"a'b"`); // 含单引号用双引号包，不转义
  assert.equal(q.pyRepr('a"b'), `'a"b'`);
  assert.equal(q.pyRepr(`a'"b`), `'a\\'"b'`); // 两种引号都有 → 用单引号包、转义单引号
  assert.equal(q.pyRepr("a\\b"), "'a\\\\b'");
  assert.equal(q.pyRepr("a\nb\tc\rd"), "'a\\nb\\tc\\rd'");
  assert.equal(q.pyRepr("\x00"), "'\\x00'");
  assert.equal(q.pyRepr("\x1c5"), "'\\x1c5'");
  assert.equal(q.pyRepr("\x7f"), "'\\x7f'");
  assert.equal(q.pyRepr("\xa0x"), "'\\xa0x'"); // NBSP（Zs）
  assert.equal(q.pyRepr("\u2028x"), "'\\u2028x'"); // LS（Zl）
  assert.equal(q.pyRepr("\u3000x"), "'\\u3000x'"); // 全角空格（Zs）
  assert.equal(q.pyRepr(" "), "' '"); // ASCII 空格是 Zs 但可打印
  assert.equal(q.pyRepr("😀"), "'😀'"); // So 可打印
  assert.equal(q.pyRepr(`\u{1f600}`), "'😀'");
  assert.equal(q.pyRepr("\u{116cf}"), "'\\U000116cf'"); // Python 16 与 Node 17 都是 Cn → 两边都转义
  // Unicode 版本表差异（已记录不修）：U+088F 在 Python 16 是 Cn（转义）、在 Node 的 17 里已分配（原样）
  assert.equal(q.pyRepr("\u{88f}"), "'\u{88f}'");
  // 选逸分支的阈值/宽度各由一个变异杀死：\x 上界 0xff、\u 上界 0xffff（U+FFFF 会变 \U）、
  // \u 的 padStart(4) 只要不补零就被 U+061C 杀掉（不补零会得到 \u61c）
  assert.equal(q.pyRepr("\u00ad"), "'\\xad'"); // Cf：\x 分支
  assert.equal(q.pyRepr("\u061c"), "'\\u061c'"); // Cf：\u 分支需补零到 4 位
  assert.equal(q.pyRepr("\uffff"), "'\\uffff'"); // Cn：\u 分支上界
  assert.equal(q.pyRepr("\u{e0001}"), "'\\U000e0001'"); // Cf：\U 分支
  assert.equal(q.pyRepr("\u{10000}"), "'\u{10000}'"); // >0xFFFF 但可打印 → 原样
  assert.equal(q.pyRepr(null), "None");
});

// ---------- workspace 派生 ----------

test("deriveWorkspace.env_wins_then_session_file_slug_then_single_then_github", () => {
  const { home } = buildFixture();
  const base = { ZGMEM_DIR: home } as NodeJS.ProcessEnv;
  assert.equal(q.deriveWorkspace(home, { ...base, ZGMEM_SCOPE: "ws-b" }), "ws-b");
  // pi 的会话目录形如 .../--<slug>--/：两端的 `-` 都要剥掉
  assert.equal(q.deriveWorkspace(home, { ...base, PI_SESSION_FILE: "/x/--proj-slug--/s.jsonl" }), "proj-slug");
  const single = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-c-one-"));
  fs.mkdirSync(path.join(single, "only-ws"), { recursive: true });
  fs.writeFileSync(path.join(single, "only-ws", "manifest.json"), "{}");
  assert.equal(q.deriveWorkspace(single, {} as NodeJS.ProcessEnv), "only-ws");
  assert.equal(q.deriveWorkspace(single, { ...base, PI_SESSION_FILE: "" } as NodeJS.ProcessEnv), "only-ws");
  assert.equal(q.deriveWorkspace(home, { ...base, PI_SESSION_FILE: "" } as NodeJS.ProcessEnv), "github");
});
