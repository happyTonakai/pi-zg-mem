#!/usr/bin/env node
/**
 * zgmem CLI（模块 E）—— `zgmem.py` 入口的迁移对等物。
 *
 * 只做 argparse 那一层（子命令/选项/校验/退出码/usage 与 --help 文本）+ 分发；
 * 真正的活都在已验收的库里：query/show/ctx/sessions → lib/query.ts，refresh → lib/refresh.ts。
 *
 * ## 为什么要逐字节复刻 argparse
 * 这是**用户直接看的**一层（`node lib/cli.ts query ...`，以及 index.ts 迁移期按命令切换时
 * 的替身），Python 侧的 25 个用例只覆盖库函数、覆盖不到这里。所以对拍摆在 CLI 边界：
 * tests/differential/cli_differential.ts 把 `python3 zgmem.py <argv>` 与
 * `node lib/cli.ts <argv>` 摆在同一张桌子上，比 **stdout 字节 + stderr 字节 + 退出码**。
 * 因此 usage/help/报错文本是按 argparse 的算法**算出来的**（不是手抄的常量），
 * 改选项只改下面的 spec 表。
 *
 * 已知（有意保留的）差异都在 cli_differential.ts 顶部登记，当前只有两条：
 *   1. argparse 的 `--hel` 这类**长选项前缀缩写**：这里同样支持（唯一前缀才认，歧义报错）。
 *   2. Python 的 `%` 格式化/`!r` 风格报错文本按字面复刻；`--who bogus` 的 choose from 顺序
 *      跟 spec 表一致（argparse 按 choices 原序）。
 */
import * as fs from "node:fs";

import * as q from "./query.ts";
import * as r from "./refresh.ts";

// ---------- 选项/位置参数模型 ----------

interface OptSpec {
  /** 长选项名（含 `--`） */
  name: string;
  kind: "flag" | "str" | "int";
  choices?: string[];
  default?: string | number | boolean | null;
  help?: string;
}

interface PosSpec {
  name: string;
  kind: "str" | "int";
}

interface CmdSpec {
  name: string;
  opts: OptSpec[];
  pos: PosSpec[];
}

const WHO = ["user", "assistant", "all"];
const MODE = ["auto", "hybrid", "fts", "rg"];

/** py: argparse 的那张表（顺序即 usage 顺序，别乱动）。 */
const CMDS: CmdSpec[] = [
  {
    name: "query",
    opts: [
      { name: "--top", kind: "int", default: 3 },
      { name: "--who", kind: "str", choices: WHO, default: "all" },
      { name: "--since", kind: "int", default: 0 },
      { name: "--pool", kind: "int", default: 0, help: "候选池大小(> top 时先取池再截断)" },
      { name: "--session", kind: "str", default: null },
      {
        name: "--workspace",
        kind: "str",
        default: null,
        help: "workspace 名或 'all'(仅 query: 扇出所有已初始化 workspace); 缺省=ZGMEM_SCOPE",
      },
      { name: "--json", kind: "flag", default: false },
      {
        name: "--mode",
        kind: "str",
        choices: MODE,
        default: "auto",
        help: "auto=启发式路由; hybrid=fts+向量; fts=BM25词法; rg=JSONL字面精确匹配",
      },
    ],
    pos: [{ name: "query", kind: "str" }],
  },
  {
    name: "refresh",
    opts: [
      { name: "--sessions-dir", kind: "str", default: null, help: "会话目录; 缺省用当前 session 所在目录" },
      { name: "--workspace", kind: "str", default: null, help: "目标 workspace; 缺省=ZGMEM_SCOPE" },
    ],
    pos: [],
  },
  {
    name: "show",
    opts: [
      { name: "--full", kind: "flag", default: false },
      { name: "--workspace", kind: "str", default: null, help: "目标 workspace; 缺省=ZGMEM_SCOPE" },
    ],
    pos: [
      { name: "session_id", kind: "str" },
      { name: "corpus_line", kind: "int" },
    ],
  },
  {
    name: "ctx",
    opts: [
      { name: "--span", kind: "int", default: 3 },
      { name: "--workspace", kind: "str", default: null, help: "目标 workspace; 缺省=ZGMEM_SCOPE" },
    ],
    pos: [
      { name: "session_id", kind: "str" },
      { name: "corpus_line", kind: "int" },
    ],
  },
  {
    name: "sessions",
    opts: [{ name: "--workspace", kind: "str", default: null, help: "目标 workspace 或 'all'; 缺省=ZGMEM_SCOPE" }],
    pos: [],
  },
];

const CMD_NAMES = CMDS.map((c) => c.name);

function cmdOf(name: string): CmdSpec {
  const spec = CMDS.find((c) => c.name === name);
  if (!spec) throw new Error(`unknown cmd ${name}`);
  return spec;
}

// ---------- argparse 的文本算法 ----------

/**
 * py: argparse.HelpFormatter 的宽度 —— `width = shutil.get_terminal_size().columns - 2`。
 * shutil 的口径：COLUMNS/LINES **都**得是正数才认（少一个就当没设），否则问 stdout 的 tty，
 * 拿不到（管道/重定向）就退回 (80, 24)。
 */
export function textWidth(env: NodeJS.ProcessEnv = process.env): number {
  const cols = env["COLUMNS"];
  const lines = env["LINES"];
  if (cols !== undefined && lines !== undefined) {
    const c = Number(cols);
    const l = Number(lines);
    if (Number.isInteger(c) && Number.isInteger(l) && c > 0 && l > 0) return c - 2;
  }
  if (process.stdout.isTTY && typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
    return process.stdout.columns - 2;
  }
  return 80 - 2;
}

/** py: HelpFormatter._max_help_position */
const MAX_HELP_POSITION = 24;
const INDENT_INCREMENT = 2;
const PREFIX = "usage: ";

function indentOf(n: number): string {
  return " ".repeat(n);
}

/** 选项的 invocation 文本（含前导缩进），如 `  --who {user,assistant,all}`。 */
function optInvocation(o: OptSpec, indent: number): string {
  const pad = indentOf(indent);
  if (o.kind === "flag") return `${pad}${o.name}`;
  if (o.choices) return `${pad}${o.name} {${o.choices.join(",")}}`;
  return `${pad}${o.name} ${o.name.replace(/^--/, "").replace(/-/g, "_").toUpperCase()}`;
}

/** usage 段里的部分（不含缩进）：`[--top TOP]`、`[--who {user,assistant,all}]`、`query`。 */
function optUsagePart(o: OptSpec): string {
  if (o.kind === "flag") return `[${o.name}]`;
  if (o.choices) return `[${o.name} {${o.choices.join(",")}}]`;
  return `[${o.name} ${o.name.replace(/^--/, "").replace(/-/g, "_").toUpperCase()}]`;
}

function optParts(spec: CmdSpec): string[] {
  return ["[-h]", ...spec.opts.map(optUsagePart)];
}

function posParts(spec: CmdSpec): string[] {
  return spec.pos.map((p) => p.name);
}

/**
 * py: HelpFormatter._format_usage 的 `get_lines` 内层函数（逐字照抄它的行宽判定，
 * 否则换行位置会差一两个字符）。
 */
function getLines(parts: string[], indent: string, prefix: string | null, textWidth: number): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let lineLen: number;
  if (prefix !== null) lineLen = prefix.length - 1;
  else lineLen = indent.length - 1;
  for (const part of parts) {
    if (lineLen + 1 + part.length > textWidth && line.length > 0) {
      lines.push(indent + line.join(" "));
      line = [];
      lineLen = indent.length - 1;
    }
    line.push(part);
    lineLen += 1 + part.length;
  }
  if (line.length > 0) lines.push(indent + line.join(" "));
  if (prefix !== null && lines.length > 0) lines[0] = lines[0].slice(indent.length);
  return lines;
}

/** `usage: ...` 之后的正文（可能多行），不带结尾换行。 */
function usageBody(prog: string, spec: CmdSpec | null, width: number): string {
  const opts = spec ? optParts(spec) : ["[-h]"];
  const pos = spec ? posParts(spec) : ["{query,refresh,show,ctx,sessions}", "..."];
  const usage = [prog, ...opts, ...pos].join(" ");
  if (PREFIX.length + usage.length <= width) return usage;

  // py: if len(prefix)+len(prog) <= 0.75 * text_width: 续行缩进到 prog 之后，否则 prog 独占一行
  if (PREFIX.length + prog.length <= 0.75 * width) {
    const indent = indentOf(PREFIX.length + prog.length + 1);
    if (opts.length > 0) {
      const lines = getLines([prog, ...opts], indent, PREFIX, width);
      lines.push(...getLines(pos, indent, null, width));
      return lines.join("\n");
    }
    return getLines([prog, ...pos], indent, PREFIX, width).join("\n");
  }
  const indent = indentOf(PREFIX.length);
  const lines = getLines([...opts, ...pos], indent, null, width);
  return [prog, ...lines].join("\n");
}

function usageText(prog: string, spec: CmdSpec | null, width: number): string {
  return `${PREFIX}${usageBody(prog, spec, width)}\n`;
}

/** py: textwrap.wrap(text, width) 里我们真正用到的部分（按空白切词、贪心回填、单空格连接）。 */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line === "") line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** help 段：py: HelpFormatter._format_actions_usage + _format_action，列宽 24、组间空行。 */
function helpText(prog: string, spec: CmdSpec | null, width: number): string {
  const invocations: string[] = ["  -h, --help"];
  for (const o of spec ? spec.opts : []) invocations.push(optInvocation(o, INDENT_INCREMENT));
  // 位置参数的 invocation 也参与列宽（argparse 的 _action_max_length 不区分可选/位置）
  const posInvocations: string[] = spec
    ? spec.pos.map((p) => `  ${p.name}`)
    : [`  {${CMD_NAMES.join(",")}}`];
  const maxLen = Math.max(...invocations.map((s) => s.length), ...posInvocations.map((s) => s.length));
  const helpPos = Math.min(maxLen + 2, MAX_HELP_POSITION);
  // py: help_width = max(self._width - help_position, 11)
  const helpWidth = Math.max(width - helpPos, 11);
  // py: action_width = help_position - current_indent - 2（current_indent=2）
  const actionWidth = helpPos - INDENT_INCREMENT - 2;

  let out = usageText(prog, spec, width);
  out += "\n";

  const groups: string[] = [];
  // positional arguments（没有位置参数时 argparse 整个组都不打）
  if (posInvocations.length > 0) groups.push(`positional arguments:\n${posInvocations.map((s) => `${s}\n`).join("")}`);

  // options
  const optRows: string[] = [];
  const allOpts: (OptSpec | { name: string; kind: "flag"; help?: string })[] = [
    { name: "-h, --help", kind: "flag", help: "show this help message and exit" },
    ...(spec ? spec.opts : []),
  ];
  for (const o of allOpts) {
    const invocation = o.name === "-h, --help" ? "  -h, --help" : optInvocation(o as OptSpec, INDENT_INCREMENT);
    const bare = invocation.slice(INDENT_INCREMENT); // 不带缩进的 invocation
    const help = o.help;
    if (!help) {
      optRows.push(`${invocation}\n`);
      continue;
    }
    const lines = wrapText(help, helpWidth);
    // py: 长 invocation（> action_width）把 help 挤到下一行并缩进到 help_position
    if (bare.length > actionWidth) optRows.push(`${invocation}\n${indentOf(helpPos)}${lines[0]}\n`);
    else optRows.push(`${invocation}${indentOf(actionWidth - bare.length + 2)}${lines[0]}\n`);
    for (const l of lines.slice(1)) optRows.push(`${indentOf(helpPos)}${l}\n`);
  }
  groups.push(`options:\n${optRows.join("")}`);

  out += groups.join("\n");
  return out;
}

// ---------- 解析 ----------

/** argparse 的报错：`zgmem query: error: ...`（或顶层的 `zgmem: error: ...`）。 */
export class UsageError extends Error {
  cmd: string | null;
  constructor(cmd: string | null, message: string) {
    super(message);
    this.cmd = cmd;
  }
}

interface Parsed {
  values: Record<string, string | number | boolean | null>;
  positionals: (string | number)[];
  help: boolean;
}

function isLongOpt(tok: string): boolean {
  return tok.startsWith("--") && tok.length > 2;
}

/** py: argparse 的 `--opt` 唯一前缀缩写（`--hel` → `--help`；歧义则报错）。 */
function resolvePrefix(spec: CmdSpec, name: string): string | null {
  const all = ["--help", ...spec.opts.map((o) => o.name)];
  if (all.includes(name)) return name;
  const hits = all.filter((n) => n.startsWith(name));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new UsageError(
      spec.name,
      `ambiguous option: ${name} could match ${hits.join(", ")}`,
    );
  }
  return null;
}

function parseIntArg(cmd: string, label: string, raw: string): number {
  // py: argparse 的 `type=int` → 失败报 invalid int value（Python 的 int() 接受前后空白与正负号）
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new UsageError(cmd, `argument ${label}: invalid int value: '${raw}'`);
  }
  return Number.parseInt(t, 10);
}

/**
 * 逐 token 解析。注意 argparse 的两个"反直觉"行为（都照抄）：
 *   - 认不出的选项/多余的参数 → **顶层** usage + `zgmem: error: unrecognized arguments: ...`
 *     （子解析器把没消费的交给父解析器，父解析器统一报错）；
 *   - 缺位置参数/取值非法 → **子命令** usage + `zgmem <cmd>: error: ...`。
 */
export function parseCmd(spec: CmdSpec, argv: string[]): Parsed {
  const values: Record<string, string | number | boolean | null> = { workspace: null };
  for (const o of spec.opts) values[o.name.replace(/^--/, "").replace(/-/g, "_")] = o.default ?? null;
  const positionals: (string | number)[] = [];
  const extra: string[] = [];
  let help = false;
  let noMoreOpts = false;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (noMoreOpts || tok === "-" || !tok.startsWith("-")) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--") {
      noMoreOpts = true;
      continue;
    }
    let name = tok;
    let inline: string | null = null;
    if (isLongOpt(tok)) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        name = tok.slice(0, eq);
        inline = tok.slice(eq + 1);
      }
      const resolved = resolvePrefix(spec, name);
      if (resolved === "--help") {
        // argparse 的 -h/--help 是**当场**生效（add_help 的 action 直接 raise SystemExit）
        return { values, positionals, help: true };
      }
      if (resolved === null) {
        extra.push(tok);
        continue;
      }
      name = resolved;
    } else if (tok === "-h") {
      return { values, positionals, help: true };
    } else {
      extra.push(tok);
      continue;
    }

    const opt = spec.opts.find((o) => o.name === name);
    if (!opt) {
      extra.push(tok);
      continue;
    }
    const key = opt.name.replace(/^--/, "").replace(/-/g, "_");
    if (opt.kind === "flag") {
      if (inline !== null) {
        throw new UsageError(spec.name, `argument ${opt.name}: ignored explicit argument '${inline}'`);
      }
      values[key] = true;
      continue;
    }
    let raw: string;
    if (inline !== null) raw = inline;
    else {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(spec.name, `argument ${opt.name}: expected one argument`);
      raw = next;
      i += 1;
    }
    if (opt.choices && !opt.choices.includes(raw)) {
      const list = opt.choices.map((c) => `'${c}'`).join(", ");
      throw new UsageError(spec.name, `argument ${opt.name}: invalid choice: '${raw}' (choose from ${list})`);
    }
    values[key] = opt.kind === "int" ? parseIntArg(spec.name, opt.name, raw) : raw;
  }

  if (extra.length > 0) {
    throw new UsageError(null, `unrecognized arguments: ${extra.join(" ")}`);
  }
  if (positionals.length > spec.pos.length) {
    throw new UsageError(null, `unrecognized arguments: ${positionals.slice(spec.pos.length).join(" ")}`);
  }
  // 缺位置参数：按 spec 顺序逐个填，缺的报 required
  const missing = spec.pos.filter((_, idx) => idx >= positionals.length).map((p) => p.name);
  if (missing.length > 0) {
    throw new UsageError(spec.name, `the following arguments are required: ${missing.join(", ")}`);
  }
  const typed: (string | number)[] = positionals.map((v, idx) => {
    const p = spec.pos[idx];
    return p.kind === "int" ? parseIntArg(spec.name, p.name, String(v)) : v;
  });
  return { values, positionals: typed, help };
}

// ---------- 入口 ----------

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdIo: CliIO = {
  out: (s) => void fs.writeSync(1, s),
  err: (s) => void fs.writeSync(2, s),
};

/** py: zgmem.py 的 main()。返回进程退出码（Python 侧是 SystemExit / return）。 */
export function main(argv: string[], io: CliIO = stdIo, env: q.QueryEnv = q.queryEnv()): number {
  const width = textWidth();
  const topUsage = usageText("zgmem", null, width);

  if (argv.length === 0) {
    return fail(io, topUsage, null, "the following arguments are required: cmd");
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    io.out(helpText("zgmem", null, width));
    return 0;
  }
  if (argv[0].startsWith("-")) {
    return fail(io, topUsage, null, `unrecognized arguments: ${argv[0]}`);
  }
  const cmdName = argv[0];
  if (!CMD_NAMES.includes(cmdName)) {
    const list = CMD_NAMES.map((c) => `'${c}'`).join(", ");
    return fail(io, topUsage, null, `argument cmd: invalid choice: '${cmdName}' (choose from ${list})`);
  }
  const spec = cmdOf(cmdName);
  const prog = `zgmem ${cmdName}`;

  let parsed: Parsed;
  try {
    parsed = parseCmd(spec, argv.slice(1));
  } catch (e) {
    if (e instanceof UsageError) {
      const usage = e.cmd === null ? topUsage : usageText(prog, spec, width);
      return fail(io, usage, e.cmd === null ? null : prog, e.message);
    }
    throw e;
  }
  if (parsed.help) {
    io.out(helpText(prog, spec, width));
    return 0;
  }

  const v = parsed.values;
  const ws = (v["workspace"] as string | null) ?? null;
  const pos = parsed.positionals;

  // workspace 维度: query/sessions 支持 'all'(内部扇出), show/ctx 必须具体 workspace
  if (ws === "all" && (cmdName === "show" || cmdName === "ctx")) {
    io.out(`${cmdName} 需要具体 workspace, 不能用 all\n`);
    return 0;
  }

  // py: use_workspace(ws) —— 非法/未初始化时 SystemExit(msg) → stderr + exit 1
  const loadScope = (name: string): q.Scope => q.loadScope(name, env.home, env.hitRefine);

  let res: { out: string; code: number };
  try {
    switch (cmdName) {
      case "query":
        res = q.runQuery(
          {
            query: String(pos[0]),
            top: v["top"] as number,
            who: v["who"] as string,
            since: v["since"] as number,
            pool: v["pool"] as number,
            session: v["session"] as string | null,
            workspace: ws,
            json: v["json"] as boolean,
            mode: v["mode"] as string,
          },
          env,
        );
        break;
      case "refresh":
        res = r.runRefresh(loadScope(ws || env.scopeName), {
          sessionsDir: v["sessions_dir"] as string | null,
          embedding: env.embedding,
        });
        break;
      case "show":
        res = q.runShow(String(pos[0]), pos[1] as number, v["full"] as boolean, ws, env);
        break;
      case "ctx":
        res = q.runCtx(String(pos[0]), pos[1] as number, v["span"] as number, ws, env);
        break;
      default:
        res = q.runSessions(ws, env);
    }
  } catch (e) {
    if (e instanceof q.ScopeExit) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
  io.out(res.out);
  return res.code;
}

function fail(io: CliIO, usage: string, cmd: string | null, message: string): number {
  io.err(usage);
  io.err(`${cmd === null ? "zgmem" : cmd}: error: ${message}\n`);
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
