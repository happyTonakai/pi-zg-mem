/**
 * 模块 F：`index.ts` 的子进程边界（Python → TypeScript）的常驻回归。
 *
 * 为什么需要这一层：`index.ts` 是 pi 扩展入口，CI 里没有 pi runtime（plan「明确不做的项」），
 * 它的**功能**没法直接测。但模块 F 之后，它与 lib 之间只剩一件事 —— 把 argv 交给
 * `node --experimental-strip-types lib/xxx.ts` 这个子进程。本文件就把这件事当真跑一遍：
 * 用**与 index.ts 逐字相同**的 argv 形状驱动真实 TS 入口（假 zg 挂 PATH），于是
 * 「index.ts 拼的 argv 是否仍被 cli.ts / etl.ts 接受」由这里守着，不必等哪天在 pi 里才发现。
 *
 * 覆盖三层：
 *  1. 静态边界：index.ts 里不能再有指向 python3 / *.py 的执行目标，且 spawn 目标必须是
 *     `process.execPath` + lib/*.ts，并且那些文件真的在；
 *  2. 真进程冒烟：两个入口都能被 node 直接执行（`-h` 与用法分支的退出码）；
 *  3. 端到端：ETL → refresh(建索引) → refresh(无变化,no-op) → refresh(增量) → sessions
 *     → query(rg) → show / ctx，全部走子进程；假 zg 的调用次数用来确认"无变化"真的没重嵌，
 *     增量真的只重嵌了尾片。
 *
 * 与 `tests/differential/*` 的关系：那些是迁移期一次性证据（要 Python 当裁判，模块 G 删），
 * 本文件不依赖 Python，**与 python3 的去留无关，永久保留**。
 *
 * 已知不覆盖：index.ts 的 pi 事件接线（session_start / agent_settled / enqueue / epoch）、
 * 工具 schema —— 那些要假 pi runtime，成本大于收益；这里只钉"命令能否照旧送达 lib"。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EXT = path.join(REPO, "extensions", "zg-memory");
const INDEX_TS = path.join(EXT, "index.ts");

/** 与 index.ts 里的 `STRIP_TYPES` 同一个 flag：node 22 要靠它，24 默认开启但接受它。 */
const STRIP_TYPES = "--experimental-strip-types";
const T0 = 1_700_000_000_000;

/** 真的起子进程跑 TS 入口（同 index.ts 的 execFile 口径：只取 stdout）。 */
function runTs(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [STRIP_TYPES, script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// ---------- 1. 静态边界：执行目标不能再是 Python ----------

test("module F: index.ts 不再把 python3 / *.py 作为执行目标", () => {
  const src = fs.readFileSync(INDEX_TS, "utf8");

  // 查的是**字符串字面量**（spawn 目标只能这么写）；注释里叙述历史不算。
  assert.equal(/["'`]python3["'`]/.test(src), false, "index.ts 里仍有 python3 执行目标");
  assert.equal(/["'][^"'\n]*\.py["']/.test(src), false, "index.ts 里仍有 .py 执行目标");

  // 边界本身：进程内直调不行(lib 是同步的, 会占住 event loop), 必须是 node + 可擦除语法 flag。
  assert.match(
    src,
    /execFileAsync\(process\.execPath, \[STRIP_TYPES, script, \.\.\.args\]/,
    "index.ts 的 spawn 不再是 `process.execPath` + STRIP_TYPES",
  );
  assert.match(src, /const STRIP_TYPES = "--experimental-strip-types"/, "STRIP_TYPES 常量被改名/删掉");
});

test("module F: spawn 目标的 lib/*.ts 都在，且路径由 EXT_DIR 推出", () => {
  const src = fs.readFileSync(INDEX_TS, "utf8");
  const targets = [...src.matchAll(/const (LIB_[A-Z]+) = path\.join\(EXT_DIR, "lib", "([A-Za-z0-9_.-]+)"\);/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  assert.deepEqual(
    targets.map((t) => t[0]).sort(),
    ["LIB_CLI", "LIB_ETL"],
    "index.ts 的 lib 入口常量少了/多了",
  );
  for (const [name, file] of targets) {
    assert.ok(file.endsWith(".ts"), `${name} 指向的不是 .ts: ${file}`);
    assert.ok(fs.existsSync(path.join(EXT, "lib", file)), `${name} 指向的 ${file} 不存在`);
  }
  // 常量确实被用上了(别删了调用点只留常量)
  assert.match(src, /runLib\(LIB_CLI,/, "LIB_CLI 没有被使用");
  assert.match(src, /runLib\(LIB_ETL,/, "LIB_ETL 没有被使用");
});

// ---------- 2. 真进程冒烟：两个入口都能被 node 直接跑 ----------

test("module F: cli.ts 作为真进程可执行(-h → 0, usage 在 stdout)", () => {
  const r = runTs(path.join(EXT, "lib", "cli.ts"), ["-h"], process.env);
  assert.equal(r.code, 0, `rc=${r.code} stderr=${r.err}`);
  assert.match(r.out, /^usage: zgmem \[-h\] \{query,refresh,show,ctx,sessions\}/);
});

test("module F: etl.ts 作为真进程可执行(裸跑走用法分支, rc=2)", () => {
  // 裸跑没有 glob/输出目录 → 用法分支 exit 2；这正是 CI「erasable syntax」检查不能直接跑
  // 该模块的原因（见 ci.yml），也是这里要钉住的行为。
  const r = runTs(path.join(EXT, "lib", "etl.ts"), [], process.env);
  assert.equal(r.code, 2, `rc=${r.code} stdout=${r.out}`);
  assert.match(r.err + r.out, /用法|usage/i);
});

// ---------- 3. 端到端：与 index.ts 逐字相同的 argv 形状 ----------

interface Env {
  root: string;
  sessions: string;
  zgmem: string;
  corpus: string;
  env: NodeJS.ProcessEnv;
  zgCalls: () => number;
}

/** 造一个 workspace（1 个 session / 2 条消息）+ 假 zg + 隔离的 ZGMEM_DIR。 */
function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-f-"));
  const sessions = path.join(root, "sessions", "--Users-f-demo--");
  const zgmem = path.join(root, "zgmem");
  const corpus = path.join(zgmem, "e2e", "corpus");
  const bindir = path.join(root, "bin");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(bindir, { recursive: true });

  const log = path.join(root, "zg-calls.log");
  // 假 zg：记调用 + 造出索引目录（zg 建的 index.zvec 是**目录**，refresh 按目录判存在）。
  const zg = path.join(bindir, "zg");
  fs.writeFileSync(zg, `#!/bin/sh\necho "$@" >> "${log}"\nmkdir -p "$PWD/.zvec-grep/index.zvec"\necho indexed 1 files\n`);
  fs.chmodSync(zg, 0o755);

  const lines = [
    { type: "session", id: "s-e2e", timestamp: new Date(T0).toISOString() },
    { type: "message", id: "m1", timestamp: new Date(T0 + 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: "how do we shard the corpus?" }] } },
    { type: "message", id: "m2", timestamp: new Date(T0 + 2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "we shard it per session." }] } },
  ];
  fs.writeFileSync(path.join(sessions, "s-e2e.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const env = { ...process.env, ZGMEM_DIR: zgmem, PATH: `${bindir}${path.delimiter}${process.env.PATH ?? ""}` };
  const zgCalls = (): number =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.trim()).length : 0;
  return { root, sessions, zgmem, corpus, env, zgCalls };
}

function append(env: Env, id: string, role: string, text: string, at: number): void {
  const rec = { type: "message", id, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: "text", text }] } };
  fs.appendFileSync(path.join(env.sessions, "s-e2e.jsonl"), JSON.stringify(rec) + "\n");
}

test("module F: ETL → refresh(建) → refresh(no-op) → refresh(增量) → sessions", () => {
  const env = setup();
  const cli = path.join(EXT, "lib", "cli.ts");
  const etl = path.join(EXT, "lib", "etl.ts");

  // index.ts:152 的形状：buildFullIndex 先跑 ETL 再 `zg index`(后者由 refresh/本文件外的真实 zg 承担)
  const e = runTs(etl, [path.join(env.sessions, "*.jsonl"), env.corpus], env.env);
  assert.equal(e.code, 0, `ETL rc=${e.code} stderr=${e.err}`);
  assert.ok(fs.existsSync(path.join(env.corpus, "s-e2e.p0001.txt")), "分片没落盘");
  assert.ok(fs.existsSync(path.join(env.zgmem, "e2e", "manifest.json")), "manifest 应在 corpus 的上一级");

  // index.ts:175 的形状（scheduleRefresh / buildFullIndex 的 refresh 一律这两条 flag）
  const r1 = runTs(cli, ["refresh", "--sessions-dir", env.sessions, "--workspace", "e2e"], env.env);
  assert.equal(r1.code, 0, `refresh rc=${r1.code} stderr=${r1.err}`);
  assert.match(r1.out, /索引已更新/);
  const after1 = env.zgCalls();
  assert.ok(after1 >= 1, "首轮 refresh 应该跑过一次 zg");

  // 无变化：一次 zg 都不该再跑（M2 的历史 bug：早退把"修索引"也跳过；这里守反面）
  const r2 = runTs(cli, ["refresh", "--sessions-dir", env.sessions, "--workspace", "e2e"], env.env);
  assert.equal(r2.code, 0);
  assert.match(r2.out, /无变化/);
  assert.equal(env.zgCalls(), after1, "无变化的 refresh 不该再调 zg");

  // 追加一条 → 增量（manifest 的 prefix_sha 变更检测）
  append(env, "m3", "user", "and the tail shard?", T0 + 3000);
  const r3 = runTs(cli, ["refresh", "--sessions-dir", env.sessions, "--workspace", "e2e"], env.env);
  assert.equal(r3.code, 0, `refresh rc=${r3.code} stderr=${r3.err}`);
  assert.match(r3.out, /变更 1 个, 删除 0 个/);
  assert.equal(env.zgCalls(), after1 + 1, "增量 refresh 应该正好跑一次 zg");

  // index.ts:338 的形状
  const s = runTs(cli, ["sessions", "--workspace", "e2e"], env.env);
  assert.equal(s.code, 0);
  assert.match(s.out, /s-e2e\s+\(3 msgs \/ 1 segs\)/);
});

test("module F: query(--mode rg --json) → show / ctx 全部走子进程", () => {
  const env = setup();
  const cli = path.join(EXT, "lib", "cli.ts");
  runTs(path.join(EXT, "lib", "etl.ts"), [path.join(env.sessions, "*.jsonl"), env.corpus], env.env);
  runTs(cli, ["refresh", "--sessions-dir", env.sessions, "--workspace", "e2e"], env.env);
  append(env, "m3", "user", "and the tail shard?", T0 + 3000);
  runTs(cli, ["refresh", "--sessions-dir", env.sessions, "--workspace", "e2e"], env.env);

  // index.ts:263 的形状（`--` 隔离 + 末尾 query）
  const q = runTs(cli, ["query", "--top", "3", "--mode", "rg", "--json", "--workspace", "e2e", "--", "tail shard"], env.env);
  assert.equal(q.code, 0, `query rc=${q.code} stderr=${q.err}`);
  const pairs = JSON.parse(q.out) as { ref: { session: string; corpus_line: number }; user: string }[];
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].ref.session, "s-e2e");
  assert.match(pairs[0].user, /tail shard/);

  // index.ts:311-312 的形状
  const ref = pairs[0].ref;
  const show = runTs(cli, ["show", ref.session, String(ref.corpus_line), "--full", "--workspace", "e2e"], env.env);
  assert.equal(show.code, 0);
  assert.match(show.out, /and the tail shard\?/);
  const ctx = runTs(cli, ["ctx", ref.session, String(ref.corpus_line), "--span", "2", "--workspace", "e2e"], env.env);
  assert.equal(ctx.code, 0);
  assert.match(ctx.out, /how do we shard the corpus\?/);
  assert.match(ctx.out, /we shard it per session\./);
});
