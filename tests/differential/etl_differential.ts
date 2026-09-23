/**
 * 模块 B 的差分对拍（**仅迁移期使用**，需要 Python 当裁判；模块 G 随 Python 一起删）。
 *
 * 拿真实语料跑两条路径：
 *   阶段 1（全量重建）：同一份 sessions 目录，Python 与 TS 各建一份语料，逐字节比对。
 *   阶段 2（增量续读）：把每个 jsonl 截到 60% 字节处（大概率切在**半行**上）先建一次，
 *                       再把文件恢复成完整内容 —— 两侧都必须只重写开放尾片、且结果一致。
 *                       （半行不消费、last_offset 停在半行前、prefix_sha 续读：全是易错点）
 *   阶段 3（全量重建）：--rebuild 重建一份，两侧逐字节比对；并且**语义上**必须等于阶段 2 的增量结果。
 *
 * 为什么阶段 3 对阶段 2 只能比语义（JSON 深比较）而不能比字节：manifest 里 `segments` 是普通
 * 对象，键的插入顺序在“重建”与“增量”下确实不同（重建会删除后按处理先后重新登记，增量会让旧
 * 条目留在原位）。集合与每个条目的内容完全一致，只是顺序不同 —— Python 自己重建也存在同样的
 * 顺序差异（实测两边对称：大小相同、集合相同、payload 相同）。键序对下游无意义：openTail 与
 * 查询都按 seq 字段、manifest 成员关系走，zgmem 列 session 时还显式 sort。
 *
 * 用法: node tests/differential/etl_differential.ts
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
const PY_ETL = path.join(EXT, "jsonl2corpus.py");
const TS_ETL = path.join(EXT, "lib", "etl.ts");
const ZGMEM_DIR = process.env.ZGMEM_DIR || path.join(os.homedir(), ".pi", "agent", "zgmem");

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
      (first >= 0 ? `\n    py: ${JSON.stringify(ab.subarray(Math.max(0, first - 20), first + 40).toString("utf8"))}` : "") +
      (first >= 0 ? `\n    ts: ${JSON.stringify(bb.subarray(Math.max(0, first - 20), first + 40).toString("utf8"))}` : ""),
  );
}

/** 从既有语料的 manifest 反推真实 session 目录（每 workspace 一个 `--<ws>--/`）。 */
function realSessionDirs(): string[] {
  const out = new Set<string>();
  if (!fs.existsSync(ZGMEM_DIR)) return [];
  for (const ws of fs.readdirSync(ZGMEM_DIR).sort()) {
    const mp = path.join(ZGMEM_DIR, ws, "manifest.json");
    if (!fs.existsSync(mp)) continue;
    let man: { sessions?: Record<string, { jsonl_path?: string }> };
    try {
      man = JSON.parse(fs.readFileSync(mp, "utf8"));
    } catch {
      continue;
    }
    for (const v of Object.values(man.sessions ?? {})) {
      const p = v?.jsonl_path;
      if (typeof p === "string" && fs.existsSync(p)) out.add(path.dirname(p));
    }
  }
  return [...out].sort();
}

const FORCE = ["--rebuild"];

let lastOut = "";

function runPy(sessionsDir: string, corpusDir: string, tag: string, force = false): number {
  const r = spawnSync("python3", [PY_ETL, path.join(sessionsDir, "*.jsonl"), corpusDir, ...(force ? FORCE : [])], { encoding: "utf8" });
  lastOut = r.stdout ?? "";
  report(tag, "python", r);
  return r.status ?? -1;
}

function runTs(sessionsDir: string, corpusDir: string, tag: string, force = false): number {
  const r = spawnSync("node", [TS_ETL, path.join(sessionsDir, "*.jsonl"), corpusDir, ...(force ? FORCE : [])], { encoding: "utf8" });
  lastOut = r.stdout ?? "";
  report(tag, "ts", r);
  return r.status ?? -1;
}

/**
 * 证明「续读阶段真的走了增量分支」。只看产物相等是不够的：
 * 如果某个实现偷偷做了全量重建，产物也可能一模一样（评审 H1）。
 * 两侧的状态行形如 `  sid  12 msgs / 2 segs  (+3 inc)` / `(+3 rebuild)`。
 */
function assertSawInc(tag: string): void {
  const modes = lastOut.match(/\(\+\d+ (?:inc|rebuild)\)/g) ?? [];
  if (!modes.length) {
    diffs.push(`${tag}: 没看到任何增量/重建状态行（stdout 空了或格式变了，增量语义无从证明）`);
    return;
  }
  const inc = modes.filter((m) => m.endsWith("inc)")).length;
  // 阶段 2 的前缀与阶段 1 逐字节相同，理应 100% 走增量；只要有任何一个 session 退化成重建，
  // 就说明“续读”这条路径没被完整验证（重建会得到相同产物，从而掩盖续读缺陷）。
  if (inc !== modes.length) diffs.push(`${tag}: 增量覆盖不全 inc ${inc}/${modes.length}（应为 100%）`);
  else process.stderr.write(`    ${tag}: inc ${inc}/${modes.length}\n`);
}

/** 子进程异常一律报出来（0 通过 / 1 无匹配 / 2 有 session 失败都算差异）。 */
function report(tag: string, who: string, r: { status: number | null; stderr?: string | null; error?: Error }): void {
  if (r.error) diffs.push(`${tag}: ${who} 启动失败 ${r.error.message}`);
  if (r.status !== 0) {
    diffs.push(`${tag}: ${who} 退出码 ${r.status}\n    ${(r.stderr || "").trim().split("\n").slice(-6).join("\n    ")}`);
  }
}

/** 递归按键名排序后序列化：用于“语义相等”比对（忽略对象键的插入顺序）。 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/**
 * 比对一份语料（分片逐字节 + manifest）。
 * manifest 在 corpusDir 的上一级（zc.manifestPathFor），所以**每个 run 必须有独立父目录**，
 * 否则两侧共用一个 manifest.json 与锁文件（锁租约 10 分钟，会直接卡死对拍）。
 * semanticManifest=true 时 manifest 只比语义（忽略键序），用于“重建 vs 增量”这类断言。
 */
function compareCorpus(
  ws: string,
  phase: string,
  pyCorpus: string,
  tsCorpus: string,
  semanticManifest = false,
): void {
  if (!fs.existsSync(pyCorpus) || !fs.existsSync(tsCorpus)) {
    diffs.push(`${ws}/${phase}: 语料目录缺失 (py=${fs.existsSync(pyCorpus)} ts=${fs.existsSync(tsCorpus)})`);
    return;
  }
  const py = fs.readdirSync(pyCorpus).sort();
  const ts = fs.readdirSync(tsCorpus).sort();
  check(`${ws}/${phase}: 分片名单`, py.join(","), ts.join(","));
  for (const f of py) {
    if (!ts.includes(f)) continue;
    check(`${ws}/${phase}: ${f}`, fs.readFileSync(path.join(pyCorpus, f)), fs.readFileSync(path.join(tsCorpus, f)));
  }
  const pyMan = path.join(path.dirname(pyCorpus), "manifest.json");
  const tsMan = path.join(path.dirname(tsCorpus), "manifest.json");
  if (semanticManifest) {
    check(
      `${ws}/${phase}: manifest.json(语义)`,
      stableStringify(JSON.parse(fs.readFileSync(pyMan, "utf8"))),
      stableStringify(JSON.parse(fs.readFileSync(tsMan, "utf8"))),
    );
  } else {
    check(`${ws}/${phase}: manifest.json`, fs.readFileSync(pyMan), fs.readFileSync(tsMan));
  }
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zgmem-etl-diff-"));
  const limit = Number(process.env.ETL_DIFF_LIMIT || 0);
  const all = realSessionDirs();
  const dirs = limit > 0 ? all.slice(0, limit) : all;
  let fileCount = 0;
  let rowBytes = 0;
  try {
    for (const sd of dirs) {
      const ws = path.basename(sd).replace(/^--|--$/g, "");
      process.stderr.write(`[${ws}] ...\n`);
      const pristine = path.join(root, ws, "pristine");
      const work = path.join(root, ws, "sessions");
      // 每个 run 一个独立父目录: <root>/<ws>/<run>/corpus + <root>/<ws>/<run>/manifest.json
      const c = (run: string): string => path.join(root, ws, run, "corpus");
      fs.mkdirSync(pristine, { recursive: true });
      fs.mkdirSync(work, { recursive: true });

      const names = fs.readdirSync(sd).filter((f) => f.endsWith(".jsonl")).sort();
      const cut = new Map<string, number>();
      for (const f of names) {
        const buf = fs.readFileSync(path.join(sd, f));
        fs.writeFileSync(path.join(pristine, f), buf);
        const k = Math.floor(buf.length * 0.6);
        cut.set(f, k);
        fs.writeFileSync(path.join(work, f), buf.subarray(0, k)); // 大概率切在半行上
        fileCount += 1;
        rowBytes += buf.length;
      }

      // 阶段 1：半行输入（两侧都从零建）
      runPy(work, c("py1"), `${ws}/py1`);
      runTs(work, c("ts1"), `${ws}/ts1`);
      compareCorpus(ws, "阶段1(截断)", c("py1"), c("ts1"));

      // 阶段 2：把文件恢复成完整内容后，在**同一个 corpus 目录**上再跑一次。
      // 关键：必须复用 c("py1")/c("ts1")，那里已经有一轮截断状态的 manifest，
      // 才会真的走「半行补齐 + 追加」的增量分支。另开新目录只是又一遍全量重建，
      // 什么都证不了（评审 H1）。
      for (const f of names) {
        fs.copyFileSync(path.join(pristine, f), path.join(work, f));
      }
      runPy(work, c("py1"), `${ws}/py1(续读)`);
      assertSawInc(`${ws}/py1(续读)`);
      runTs(work, c("ts1"), `${ws}/ts1(续读)`);
      assertSawInc(`${ws}/ts1(续读)`);
      compareCorpus(ws, "阶段2(增量续读)", c("py1"), c("ts1"));

      // 阶段 3：强制全量重建（--rebuild）——两侧必须逐字节一致。
      runPy(work, c("pyfull"), `${ws}/pyfull`, true);
      runTs(work, c("tsfull"), `${ws}/tsfull`, true);
      compareCorpus(ws, "阶段3(重建) py-vs-ts", c("pyfull"), c("tsfull"));
      // 「重建 == 增量」只要求语义相等（分片键序合法地不同，见文件头注释）；
      // 两侧都查一遍：否则某个实现“重建结果 != 自己的增量结果”到底算不算差异就说不清。
      compareCorpus(ws, "阶段3(重建) vs 阶段2(增量) py", c("pyfull"), c("py1"), true);
      compareCorpus(ws, "阶段3(重建) vs 阶段2(增量)", c("tsfull"), c("ts1"), true);
    }
  } finally {
    if (process.env.ETL_DIFF_KEEP) {
      process.stderr.write(`  (ETL_DIFF_KEEP=1，临时目录保留在 ${root})\n`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`ETL 差分对拍：${dirs.length}${limit > 0 ? `/${all.length}` : ""} 个真实 workspace / ${fileCount} 个 session 文件 / ${(rowBytes / 1e6).toFixed(1)}MB`);
  console.log(`  比对项 ${checks}，差异 ${diffs.length}`);
  if (diffs.length) {
    console.log("\n差异明细:");
    for (const d of diffs.slice(0, 20)) console.log("  - " + d);
    process.exitCode = 1;
  } else {
    console.log("  ✓ Python 与 TS 产物逐字节一致（含截断/续读/半行）");
  }
}

main();
