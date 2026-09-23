/**
 * refresh 的 TS 侧最小驱动器 —— 模块 D 差分对拍的入口（**仅迁移期使用**）。
 *
 * 模块 E（`lib/cli.ts`）落地前的临时替身：只做 Python `zgmem.py refresh` 那点参数解析 +
 * `ScopeExit` 渲染，好让差分器能把两侧摆在同一张桌上对比。
 * 注意它**不是**给用户用的 CLI：不做 usage、不认 `--json`、不进 CJS bundle —— 模块 E 会用
 * `index.ts` 里那套直接调用 `runRefresh`。等 E 落地后本文件随 Python 一起删。
 *
 * 用法: node tests/differential/refresh_entry.ts --sessions-dir <dir> --workspace <ws>
 * 环境: ZGMEM_DIR / ZGMEM_SCOPE / ZGMEM_EMBEDDING 与 Python 同口径（queryEnv 负责解析）。
 */
import * as fs from "node:fs";

import * as q from "../../extensions/zg-memory/lib/query.ts";
import * as r from "../../extensions/zg-memory/lib/refresh.ts";

function argOf(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function main(): void {
  const env = q.queryEnv();
  const ws = argOf("--workspace") ?? env.scopeName;
  let scope: q.Scope;
  try {
    scope = q.loadScope(ws, env.home);
  } catch (e) {
    // py: use_workspace 的 raise SystemExit(msg) → argparse 把消息写 stderr 并 exit 1
    if (e instanceof q.ScopeExit) {
      fs.writeSync(2, `${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const res = r.runRefresh(scope, { sessionsDir: argOf("--sessions-dir"), embedding: env.embedding });
  fs.writeSync(1, res.out);
  process.exit(res.code);
}

main();
