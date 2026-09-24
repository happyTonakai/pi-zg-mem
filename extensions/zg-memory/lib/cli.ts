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
 * 已知（有意保留的）差异（原登记在 `tests/differential/cli_differential.ts` 顶部，该文件已随模块 G 删除，
 * 记录内联在此；终态差分 403 项全一致）：
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
  /**
   * py: `add_subparsers(required=True)` 生成的 `_SubParsersAction` —— `nargs='PARSER'` 的位置参数，
   * 会**吃掉剩下的全部 token**（含选项），再把除首 token 外的那些交给子解析器。
   * 顶层 `cmd` 走的就是这条（见 `TOP_SPEC`）；子命令的 `parseCmd` 碰不到它。
   */
  sub?: boolean;
  choices?: string[];
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

// 顶层解析器：`cmd` 是 nargs='PARSER' 的位置参数（choices=子命令名），剩余 token 交给子解析器。
export const TOP_SPEC: CmdSpec = {
  name: "zgmem",
  opts: [],
  pos: [{ name: "cmd", kind: "str", sub: true, choices: CMD_NAMES }],
};

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
  /**
   * py: `cmd` 位置参数（`nargs='PARSER'`）交给子解析器的那段 argv —— 仅顶层会出现。
   * 与 argparse 一致：子解析器拿到的是 `cmd` **之后**的原始 token（选项原样传下去）。
   */
  subArgv?: string[];
  /**
   * py: 只在**顶层**用（`subArgv !== undefined` 时）—— 顶层 `parse_args` 的
   * `unrecognized arguments: %s` 检查发生在**子解析器跑完之后**：子解析器自己的
   * required/choice 错误会先出（`--bogus query` → `query` 的 required 错误），
   * 只有子解析器没报错时才会轮到这里。
   */
  extras?: string[];
}

// ---------- argparse 仿真 ----------
//
// 为什么是"照着算法重写"而不是继续逐 token 手写规则：argparse 的解析是**两遍**的 —— 先给每个
// token 分类（`_parse_optional` → 'A' 位置参数 / 'O' 选项 / '-' 分隔符），再拿 nargs 正则在这串
// 分类上做匹配（`match_argument` / `_match_arguments_partial`）。顺序反过来就分叉：
// 「像选项的值」(`--session -x`) 不是"取值时跳过"，而是"分类阶段就记成 'O'，于是 --session 只拿到
// 0 个参数 → expected one argument"；`-hx` 也不是"未知短选项"，而是 `-h` 带一个 explicit arg。
// 下面把 CPython 3.14 `Lib/argparse.py` 的那几个函数按原样搬过来，函数名保留 py 的，便于对读。

/** py: argparse 的 action —— 选项与位置参数统一建模（只保留 zgmem.py 用到的那几种）。 */
interface Action {
  /** py: `action.dest` —— 位置参数的报错名，也是 `values` 的键 */
  dest: string;
  /** py: `action.option_strings` —— 空数组 = 位置参数 */
  optionStrings: string[];
  /** py: `action.nargs` —— 只用到 0(help/store_true) / 1(None) / 'PARSER'(顶层子命令) */
  nargs: 0 | 1 | "PARSER";
  /** py: `action.type` —— 只有 int 与非 int 两种 */
  type: "int" | null;
  choices: readonly string[] | null;
  default: unknown;
  /** py: `add_help=True` 生成的 `_HelpAction`（它直接 raise SystemExit(0)，不往 namespace 写值） */
  help?: boolean;
}

/** py: `argparse._get_action_name(action)` —— 选项用 option_strings、位置参数用 dest。 */
function actionName(action: Action): string {
  if (action.optionStrings.length > 0) return action.optionStrings.join("/");
  return action.dest;
}

/**
 * py: `_negative_number_matcher = re.compile(r'-\.?\d')`（argparse.py:1465）。
 * `re.match` 是**从头**匹配；`\d` 在 Python 里是 Unicode 十进制数字，所以用 `\p{Nd}` 而不是 JS 的 ASCII `\d`。
 */
const NEGATIVE_NUMBER_RE = /^-\.?\p{Nd}/u;

/** py: `ArgumentParser._get_nargs_pattern(action)` —— 只列 zgmem.py 会遇到的三组。 */
function nargsPattern(action: Action): string {
  const opt = action.optionStrings.length > 0;
  if (action.nargs === 0) return opt ? "()" : "(-*)";
  if (action.nargs === 1) return opt ? "([A])" : "(-*A-*)";
  return opt ? "(A[AO]*)" : "(-*A[-AO]*)";
}

/** py: `ArgumentParser._match_argument(action, arg_strings_pattern)` —— 返回吃掉的 pattern 字符数。 */
function matchArgument(cmd: string, action: Action, pattern: string): number {
  const m = new RegExp(`^${nargsPattern(action)}`).exec(pattern);
  if (!m) {
    // py: `nargs_errors` —— 这里只有 nargs=None 那条会走到（nargs=0/1 的 pattern 不会失败）
    throw new UsageError(cmd, `argument ${actionName(action)}: expected one argument`);
  }
  return (m[1] ?? "").length;
}

/**
 * py: `ArgumentParser._match_arguments_partial(actions, arg_strings_pattern)` —— 位置参数的整体匹配。
 * 返回值是每个位置参数各吃掉几个 pattern 字符，**含** `--` 那种 '-' 字符（`consume_positionals`
 * 就是靠这个长度把 '--' 一起前进掉的）。
 */
function matchArgumentsPartial(actions: Action[], pattern: string): number[] {
  for (let i = actions.length; i > 0; i -= 1) {
    const pat = actions.slice(0, i).map(nargsPattern).join("");
    const m = new RegExp(`^${pat}`).exec(pattern);
    if (!m) continue;
    const result = m.slice(1).map((g) => (g ?? "").length);
    // py: 只匹配上前一段、且下一字符是 'O'（紧跟选项）时，抹掉尾部长度为 0 的匹配
    if (m[0].length < pattern.length && pattern[m[0].length] === "O") {
      while (result.length > 0 && result[result.length - 1] === 0) result.pop();
    }
    return result;
  }
  return [];
}

/**
 * py: help action 的两条 `raise SystemExit(0)` 语义 —— 当场停手，后面的参数不再解析。
 */
class HelpExit extends Error {}

/**
 * 逐 token 解析（py: `ArgumentParser.parse_known_args` 在**子解析器**上的那一遍）。
 * 两条"反直觉"的分工都照抄：
 *   - 认不出的选项/多余的参数 → 子解析器只把它们**交出去**（extras），由顶层解析器统一报
 *     **顶层** usage + `zgmem: error: unrecognized arguments: ...`；
 *   - 缺位置参数/取值非法/歧义 → 在这里抛 → **子命令** usage + `zgmem <cmd>: error: ...`。
 */
export function parseCmd(spec: CmdSpec, argv: string[]): Parsed {
  const cmdName = spec.name;
  const argStrings = argv;

  // py: `add_help=True` 的那个 action 排在所有用户选项**之前**（歧义前缀的枚举顺序就是它）
  const actions: Action[] = [
    { dest: "help", optionStrings: ["-h", "--help"], nargs: 0, type: null, choices: null, default: null, help: true },
  ];
  for (const o of spec.opts) {
    actions.push({
      dest: o.name.replace(/^--/, "").replace(/-/g, "_"),
      optionStrings: [o.name],
      nargs: o.kind === "flag" ? 0 : 1,
      type: o.kind === "int" ? "int" : null,
      choices: o.choices ?? null,
      default: o.default ?? null,
    });
  }
  for (const p of spec.pos) {
    actions.push({
      dest: p.name,
      optionStrings: [],
      nargs: p.sub ? "PARSER" : 1,
      type: p.kind === "int" ? "int" : null,
      choices: p.choices ?? null,
      default: null,
    });
  }

  // py: `_option_string_actions` —— 一个按**插入顺序**枚举的 dict（歧义报错列出的顺序就是它）
  const optionMap = new Map<string, Action>();
  for (const a of actions) for (const os of a.optionStrings) optionMap.set(os, a);
  const optionStringList = [...optionMap.keys()];
  // py: `_has_negative_number_optionals` —— 有"像负数"的选项时，负数 token 才不再算位置参数
  const hasNegativeNumberOptionals = optionStringList.some((s) => NEGATIVE_NUMBER_RE.test(s));

  const values: Record<string, string | number | boolean | null> = {};
  for (const a of actions) if (!a.help) values[a.dest] = a.default as string | number | boolean | null;
  const positionalsOut: (string | number)[] = [];
  // py: `_get_positional_actions()` —— 还没被消费掉的位置参数（`consume_positionals` 会切片）
  const positionalsLeft: Action[] = actions.filter((a) => a.optionStrings.length === 0);
  const extras: string[] = [];
  const seen = new Set<Action>();
  /** py: `_SubParsersAction` 写回 namespace 的那部分 —— 子命令名 + 它的 argv（见 `Parsed.subArgv`）*/
  let subArgv: string[] | undefined;

  // ---- py: `_get_option_tuples(option_string)` ----
  type OptTuple = [Action | null, string, string | null, string | null];
  const getOptionTuples = (argString: string): OptTuple[] => {
    const result: OptTuple[] = [];
    const eq = argString.indexOf("=");
    const optionPrefix = eq >= 0 ? argString.slice(0, eq) : argString;
    const sep = eq >= 0 ? "=" : null;
    const explicitArg = eq >= 0 ? argString.slice(eq + 1) : null;
    if (argString[0] === "-" && argString[1] === "-") {
      // 双前缀只按 '=' 切分；`allow_abbrev=True` → 顺带按前缀枚举（`--mod` → `--mode`）
      for (const [os, action] of optionMap) {
        if (os.startsWith(optionPrefix)) result.push([action, os, sep, explicitArg]);
      }
      return result;
    }
    // 单字符选项可以和它的参数**拼**在一起（`-x5` == `-x 5`），长选项必须分开
    const shortOptionPrefix = argString.slice(0, 2);
    const shortExplicitArg = argString.slice(2);
    for (const [os, action] of optionMap) {
      if (os === shortOptionPrefix) result.push([action, os, "", shortExplicitArg]);
      else if (os.startsWith(optionPrefix)) result.push([action, os, sep, explicitArg]);
    }
    return result;
  };

  // ---- py: `_parse_optional(arg_string)` → None(位置参数) 或 tuple 列表 ----
  const parseOptional = (argString: string): OptTuple[] | null => {
    if (argString === "") return null;
    if (argString[0] !== "-") return null; // py: prefix_chars = '-'
    const exact = optionMap.get(argString);
    if (exact) return [[exact, argString, null, null]];
    if (argString.length === 1) return null; // 单个 '-' 是位置参数
    const eq = argString.indexOf("=");
    if (eq >= 0) {
      const named = optionMap.get(argString.slice(0, eq));
      if (named) return [[named, argString.slice(0, eq), "=", argString.slice(eq + 1)]];
    }
    const tuples = getOptionTuples(argString);
    if (tuples.length > 0) return tuples;
    // 像负数的 token 是位置参数（除非有"像负数"的选项）；含空格的也是位置参数
    if (NEGATIVE_NUMBER_RE.test(argString) && !hasNegativeNumberOptionals) return null;
    if (argString.includes(" ")) return null;
    // 认不出但"像选项" → action 记 None，交给上面当 extras
    return [[null, argString, null, null]];
  };

  // ---- py: `take_action` → `_get_values` + `_check_value` ----
  const takeAction = (action: Action, argStringsForAction: string[], _optionString: string | null): void => {
    seen.add(action);
    if (action.help) {
      // py: `_HelpAction.__call__` → print_help() + exit(0)，**当场**生效
      throw new HelpExit();
    }
    if (action.nargs === 0) {
      // py: `_StoreTrueAction` —— 不看参数，写 const=True
      values[action.dest] = true;
      return;
    }
    if (action.nargs === "PARSER") {
      // py: `_SubParsersAction.__call__` —— `values[0]` 是子命令名（先过 `_check_value` 的 choices），
      // 剩下的原样给子解析器。"invalid choice" 是**顶层**的报错（顶层 usage）。
      const name = argStringsForAction[0] ?? "";
      if (action.choices !== null && !action.choices.includes(name)) {
        const list = action.choices.map((c) => q.pyRepr(String(c))).join(", ");
        throw new UsageError(cmdName, `argument ${actionName(action)}: invalid choice: ${q.pyRepr(name)} (choose from ${list})`);
      }
      values[action.dest] = name;
      subArgv = argStringsForAction.slice(1);
      return;
    }
    const raw = argStringsForAction[0] ?? "";
    let value: string | number = raw;
    if (action.type === "int") {
      try {
        value = q.pyInt(raw);
      } catch {
        // py: `_get_value` 的 `except (TypeError, ValueError)` → `invalid int value: %(value)r`
        throw new UsageError(cmdName, `argument ${actionName(action)}: invalid int value: ${q.pyRepr(raw)}`);
      }
    }
    if (action.choices !== null && !action.choices.includes(String(value))) {
      // py: `_check_value` → `invalid choice: %(value)r (choose from %(choices)s)`
      const list = action.choices.map((c) => q.pyRepr(String(c))).join(", ");
      throw new UsageError(
        cmdName,
        `argument ${actionName(action)}: invalid choice: ${q.pyRepr(String(value))} (choose from ${list})`,
      );
    }
    if (action.optionStrings.length > 0) values[action.dest] = value;
    else positionalsOut.push(value);
  };

  // py: `_parse_known_args` 的前半段 —— 先把每个 token 分类成 'A'/'O'/'-'
  const optionStringIndices = new Map<number, OptTuple[]>();
  const patternParts: string[] = [];
  for (let i = 0; i < argStrings.length; i += 1) {
    if (argStrings[i] === "--") {
      // `--` 之后（含它自己）全都不是选项；'-' 之外的部分一律记 'A'
      patternParts.push("-");
      for (let j = i + 1; j < argStrings.length; j += 1) patternParts.push("A");
      break;
    }
    const tuples = parseOptional(argStrings[i]);
    if (tuples === null) patternParts.push("A");
    else {
      optionStringIndices.set(i, tuples);
      patternParts.push("O");
    }
  }
  const pattern = patternParts.join("");

  const consumePositionals = (start: number): number => {
    const argCounts = matchArgumentsPartial(positionalsLeft, pattern.slice(start));
    let idx = start;
    for (let k = 0; k < argCounts.length; k += 1) {
      const action = positionalsLeft[k];
      const args = argStrings.slice(idx, idx + argCounts[k]);
      // py: 位置参数吃掉的那段里若含 '--'（pattern 里的 '-'），把**第一个** '--' 从值里删掉。
      // 但 PARSER（顶层 `cmd`）有**独立**分支（argparse.py:2237-2245）：只有 '--' 在本段**首位**
      // 时剥，否则原样交给子解析器（由子命令行自己再剥一次）。不分开就会把
      // `query -- --top 3 x` 的 `--top` 当选项，而 Python 把它当位置参数。
      if (argCounts[k] > 0) {
        const strip =
          action.nargs === "PARSER" ? pattern[idx] === "-" : pattern.slice(idx, idx + argCounts[k]).includes("-");
        if (strip) {
          const at = args.indexOf("--");
          if (at >= 0) args.splice(at, 1);
        }
      }
      idx += argCounts[k];
      takeAction(action, args, null);
    }
    positionalsLeft.splice(0, argCounts.length);
    return idx;
  };

  const consumeOptional = (start: number): number => {
    const tuples = optionStringIndices.get(start);
    if (!tuples) throw new Error(`argparse 仿真内部错误: ${start} 不在 option_string_indices 里`);
    if (tuples.length > 1) {
      // py: 多个 action 命中同一前缀 → 歧义（注意这条也是**子命令** usage）
      const options = tuples.map((t) => t[1]).join(", ");
      // 注意：py 这里是 `ArgumentError(None, ...)`，但它在**子解析器**的 `_parse_known_args` 里抛，
      // 由子解析器的 `error()` 接住 → 子命令 usage（不是顶层）。
      throw new UsageError(cmdName, `ambiguous option: ${argStrings[start]} could match ${options}`);
    }
    let [action, optionString, sep, explicitArg] = tuples[0];
    let stop = start;
    const taken: [Action, string[], string][] = [];
    for (;;) {
      // py: 认不出的选项 → extras（顶层再报 unrecognized arguments）
      if (action === null) {
        extras.push(argStrings[start]);
        return start + 1;
      }
      if (explicitArg !== null) {
        const argCount = matchArgument(cmdName, action, "A");
        // py: 单字符选项且不吃参数时，可以从选项串尾巴里再切出下一个选项（`-xy` == `-x -y`）
        if (argCount === 0 && optionString[1] !== "-" && explicitArg !== "") {
          if (sep || explicitArg[0] === "-") {
            throw new UsageError(
              cmdName,
              `argument ${actionName(action)}: ignored explicit argument ${q.pyRepr(explicitArg)}`,
            );
          }
          taken.push([action, [], optionString]);
          const ch = optionString[0];
          optionString = ch + explicitArg[0];
          const next = optionMap.get(optionString);
          if (next) {
            action = next;
            explicitArg = explicitArg.slice(1);
            if (explicitArg === "") {
              sep = null;
              explicitArg = null;
            } else if (explicitArg[0] === "=") {
              sep = "=";
              explicitArg = explicitArg.slice(1);
            } else {
              sep = "";
            }
          } else {
            extras.push(ch + explicitArg);
            stop = start + 1;
            break;
          }
        } else if (argCount === 1) {
          stop = start + 1;
          taken.push([action, [explicitArg], optionString]);
          break;
        } else {
          // py: 双横线选项不吃 explicit arg → ignored explicit argument（`--json=1`）
          throw new UsageError(
            cmdName,
            `argument ${actionName(action)}: ignored explicit argument ${q.pyRepr(explicitArg)}`,
          );
        }
      } else {
        // 没带 explicit arg：从**后面**的 token 里按 nargs 正则取（取值时不重新分类，
        // 分类阶段已经决定了下一个 token 是不是选项）
        const from = start + 1;
        const argCount = matchArgument(cmdName, action, pattern.slice(from));
        stop = from + argCount;
        taken.push([action, argStrings.slice(from, stop), optionString]);
        break;
      }
    }
    for (const [a, args, os] of taken) takeAction(a, args, os);
    return stop;
  };

  try {
    let startIndex = 0;
    const maxOptionStringIndex = optionStringIndices.size > 0 ? Math.max(...optionStringIndices.keys()) : -1;
    while (startIndex <= maxOptionStringIndex) {
      // 先吃掉紧邻的下一个选项**之前**的位置参数
      let nextOptionStringIndex = startIndex;
      while (nextOptionStringIndex <= maxOptionStringIndex) {
        if (optionStringIndices.has(nextOptionStringIndex)) break;
        nextOptionStringIndex += 1;
      }
      if (startIndex !== nextOptionStringIndex) {
        const end = consumePositionals(startIndex);
        if (end > startIndex) {
          startIndex = end;
          continue;
        }
        startIndex = end;
      }
      // 位置参数吃不动了、又不在选项下标上 → 这一串都是 extras
      if (!optionStringIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOptionStringIndex));
        startIndex = nextOptionStringIndex;
      }
      startIndex = consumeOptional(startIndex);
    }
    // py: 非 intermixed → 最后一个选项之后还能再吃一轮位置参数，剩下的都算 extras
    const stopIndex = consumePositionals(startIndex);
    extras.push(...argStrings.slice(stopIndex));

    // py: 必填的位置参数（nargs=None 的位置参数 required 默认为真）
    const missing = actions
      .filter((a) => a.optionStrings.length === 0 && !seen.has(a))
      .map(actionName);
    if (missing.length > 0) {
      throw new UsageError(cmdName, `the following arguments are required: ${missing.join(", ")}`);
    }
  } catch (e) {
    if (e instanceof HelpExit) return { values, positionals: positionalsOut, help: true };
    throw e;
  }

  // py: extras 由**顶层**解析器报（`parse_args` 的 `unrecognized arguments: %s`）
  if (extras.length > 0) {
    // 顶层：交给 main 在子解析器跑完（且没报错）之后再报 —— 见 `Parsed.extras` 的说明。
    if (subArgv !== undefined) return { values, positionals: positionalsOut, help: false, subArgv, extras };
    throw new UsageError(null, `unrecognized arguments: ${extras.join(" ")}`);
  }
  return { values, positionals: positionalsOut, help: false, subArgv };
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

  // py:顶层解析器也走这同一套端口（`cmd` 是 nargs='PARSER' 的位置参数）——`--hel`（缩写）、
  // `-hx`（短选项拼 explicit arg）、`--hel=x`（ignored explicit argument）、`--`（分隔符，
  // 被吃掉再把剩余交给子解析器）、`-`（invalid choice）全由此保证，不再手写特判。
  let top: Parsed;
  try {
    top = parseCmd(TOP_SPEC, argv);
  } catch (e) {
    if (e instanceof UsageError) {
      // 顶层报错统一用顶层 usage + `zgmem: error:`（顶层 UsageError 的 cmd 是 `zgmem` 或 null）
      return fail(io, topUsage, null, e.message);
    }
    throw e;
  }
  if (top.help) {
    io.out(helpText("zgmem", null, width));
    return 0;
  }
  // 走到这里说明 cmd 已过 choices 校验（缺 `cmd` / 非法名在 `parseCmd` 里就已经报了）
  const cmdName = String(top.values["cmd"]);
  const subArgv = top.subArgv ?? [];
  const spec = cmdOf(cmdName);
  const prog = `zgmem ${cmdName}`;

  let parsed: Parsed;
  try {
    parsed = parseCmd(spec, subArgv);
  } catch (e) {
    if (e instanceof UsageError) {
      // extras（`unrecognized arguments`）由**顶层** usage 报：py 里子解析器不报它
      const usage = e.cmd === null ? topUsage : usageText(prog, spec, width);
      return fail(io, usage, e.cmd === null ? null : prog, e.message);
    }
    throw e;
  }
  if (parsed.help) {
    io.out(helpText(prog, spec, width));
    return 0;
  }
  // py: 顶层 `parse_args` 的 extras 检查（子解析器没报错才轮到）——用**顶层** usage
  if (top.extras && top.extras.length > 0) {
    return fail(io, topUsage, null, `unrecognized arguments: ${top.extras.join(" ")}`);
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
  // py: main() 里的 `if ws and ws != "all": use_workspace(ws)` —— **分发前**校验显式 workspace：
  // 非法名 / 未初始化 → SystemExit 未被捕获 → stderr + exit 1。
  // 缺省 scope（env ZGMEM_SCOPE / 派生值）与 'all' **不走**这一步 —— 那时各 cmd_* 用宽容 scope
  // 自行降级（query 打报错文本到 stdout、show/ctx 打 unknown session，均 rc0）。
  // 少了这一步，`query foo --workspace nope` 会退化成 stdout + rc0（cmd_query 内层 try 的口径）。
  if (ws && ws !== "all") {
    try {
      loadScope(ws);
    } catch (e) {
      if (e instanceof q.ScopeExit) {
        io.err(`${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

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
      case "refresh": {
        // py: cmd_refresh **忽略** args.workspace，用的是模块全局（main() 刚切过的那个）。
        // 两层职责的后果：`refresh --workspace ws-b` 刷的是 ws-b（main() 改了全局），
        // 而缺省 scope 与 `refresh --workspace all` / `--workspace ""` 都跳过前置校验 → 回落到
        // **缺省** scope，并且是**宽容**的那份（import 期的空 manifest，见 q.defaultScope）。
        // 少了这条，`ZGMEM_SCOPE=<没建过的 ws> refresh` 在 Python 里是 `no sessions dir` + rc0，
        // 在 TS 里会变成 stderr + rc1（差分模糊测试 74/20847 例全砸在这一处）。
        const scope =
          ws && ws !== "all" ? loadScope(ws) : q.defaultScope(env.home, env.scopeName, env.hitRefine);
        res = r.runRefresh(scope, {
          sessionsDir: v["sessions_dir"] as string | null,
          embedding: env.embedding,
        });
        break;
      }
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
