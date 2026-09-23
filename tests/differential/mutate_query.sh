#!/usr/bin/env bash
# 变异测试（migration-time one-shot evidence）：故意改坏 `lib/query.ts`，确认差分对拍会红。
# “对拍零差异”只有在对拍**确实有敏感性**的前提下才算证据 —— 否则它只是两个实现一起静默出错。
#
# 用法：bash tests/differential/mutate_query.sh
# 退出码 0 表示每个变异都被捕获；非 0 表示有存活变异（盲区）或 pattern 没命中（假变异）。
# 注意：本脚本会临时改写 extensions/zg-memory/lib/query.ts，结束时（含 Ctrl-C）自动还原。
set -uo pipefail
cd "$(dirname "$0")/../.."

SRC=extensions/zg-memory/lib/query.ts
BAK="$(mktemp -t query.ts.bak)"
OUT="$(mktemp -t mut.out)"
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK" "$OUT"' EXIT

passed=0
survived=0
noop=0

try() {
  local label="$1" expr="$2"
  cp "$BAK" "$SRC"
  MUT_LABEL="$label" MUT_EXPR="$expr" perl -0pi -e "$expr" "$SRC"
  if cmp -s "$BAK" "$SRC"; then
    echo "⚠️  变异未生效(pattern 没命中，等于没测): $label"
    noop=$((noop + 1))
    return
  fi
  if node --experimental-strip-types tests/differential/query_differential.ts >"$OUT" 2>&1; then
    echo "❌ 存活(对拍没抓到): $label"
    survived=$((survived + 1))
  else
    echo "✅ 被捕获: $label  [$({ grep -m1 '比对项' "$OUT" || true; })]"
    passed=$((passed + 1))
  fi
}

# ---- runQuery 入口参数 ----
try "limit 用 top 而非 pool(pool>top 时漏检)" \
  's/const limit = pool > top \? pool : top;/const limit = top;/'
try "zg --modified-after 单位错(毫秒当秒)" \
  's/String\(Date\.now\(\) - since \* 86400 \* 1000\)/String(Date.now() - since * 86400)/'
try "最终排序反向(相关性名次失效)" \
  's/candidates\.sort\(\(a, b\) => b\[0\] - a\[0\]\);/candidates.sort((a, b) => a[0] - b[0]);/'

# ---- rg 召回 ----
try "跨 ws 去重键丢掉 session" \
  's/return JSON\.stringify\(\[p\.ref\.session \?\? null, p\.ref\.jsonl_line \?\? null\]\);/return JSON.stringify([p.ref.jsonl_line ?? null]);/'
try "rg cutoff 单位错(差 1000 倍)" \
  's/const cutoff = Date\.now\(\) - \(opts\.since as number\) \* 86400 \* 1000;/const cutoff = (Date.now() - (opts.since as number) * 86400) * 1000;/'
try "rg cutoff 比较反向" \
  's/if \(\(pair\.ts \|\| 0\) < cutoff\) continue;/if ((pair.ts || 0) >= cutoff) continue;/'
try "去掉 pairFromJsonl 兜底(语料外命中全丢)" \
  's/if \(pair === null\) pair = pairFromJsonl\(p, jl\);/if (pair === null) continue;/'
try "rg who 过滤失效" \
  's/if \(\(opts\.who \?\? "all"\) !== "all" && pair\.role !== opts\.who\) continue;//'
try "rg 去掉 -H(单文件 target 解析全挂)" \
  's/"-n", "-F", "--no-heading", "-H", "-e"/"-n", "-F", "--no-heading", "-e"/'
try "rg --session 不加 --glob(注定捕获在 argv：见下一条注释)" \
  's/if \(opts\.session\) args\.push\("--glob"/if (false) args.push("--glob"/'
# ⚠ 上面这条只靠 **argv 比对** 捕获，stdout 不会变 —— 因为 rg 对**显式文件参数**完全忽略 -g：
#   实测 `rg -e hello --glob 'sessP.jsonl' a/sessP.jsonl a/sessR.jsonl` 仍会搜两个文件，
# 所以上游 `--session` 在 rg 模式下是 no-op（Python 同样，见 plan-ts-migration.md 的“候选上游修复”）。
try "rg 命中解析丢掉行号锚定(行号错位)" \
  's/const key = `\$\{jl\}\\u0000\$\{p\}`;/const key = `${jl + 1}\\u0000${p}`;/'

# ---- 精修 ----
try "精修起算行 off-by-one" \
  's/const start = \(meta\.start_corpus_line \|\| 1\) \+ Math\.trunc\(cstart\) - 1;/const start = (meta.start_corpus_line || 1) + Math.trunc(cstart);/'

# ---- show / ctx ----
try "show 截断 800→799" \
  's/pySlice\(valRaw, 800\)/pySlice(valRaw, 799)/'
try "ctx 截断 200→199" \
  's/pySlice\(txt, 200\)/pySlice(txt, 199)/'
try "ctx 换行不替换成空格(pySlice 那一处)" \
  's/(pySlice\(txt, 200\)\}\`)\.replaceAll\("\\n", " "\)/$1/'
try "pairFromJsonl 兜底不把换行换成空格" \
  's/const txt = parts\.join\(" "\)\.replaceAll\("\\n", " "\);/const txt = parts.join(" ");/'
try "ctx 窗口右边界少含一条" \
  's/const hi = Math\.min\(rows\.length, tidx \+ span \+ 1\);/const hi = Math.min(rows.length, tidx + span);/'
try "show/ctx 的 corpus_line off-by-one" \
  's/const rec = corpusRow\(scope, sessionId, corpusLine\);/const rec = corpusRow(scope, sessionId, corpusLine + 1);/'

# ---- sessions / workspace 派生 ----
try "sessions 排序反向" \
  's/items\.sort\(\(a, b\) => b\.k - a\.k\);/items.sort((a, b) => a.k - b.k);/'
try "deriveWorkspace 不剥 --slug--(PI_SESSION_FILE 分支)" \
  's/\.replace\(\/\^-\+\|-\+\$\/g, ""\)//'

echo
echo "变异测试汇总：被捕获 ${passed}，存活 ${survived}，pattern 未命中 ${noop}"
if [ "$survived" -ne 0 ] || [ "$noop" -ne 0 ]; then
  echo "→ 对拍证据不成立：先补用例/修 harness，再重跑"
  exit 1
fi
echo "→ 全部变异被捕获：差分对拍对这 ${passed} 类改动是敏感的"
