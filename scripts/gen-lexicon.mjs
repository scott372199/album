#!/usr/bin/env node
/**
 * T-01 · 词表生成器 / Lexicon generator.
 *
 * 唯一真相是 `src/shared/lexicon.json`（人改这个）。
 * 本脚本把它展开成前端可 import 的 ESM 模块，服务端也 import 同一个文件——
 * 于是「中文词表只有一份」这件事由**构建物**保证，而不是靠人记得两边都改。
 *
 * The single source of truth is src/shared/lexicon.json. This script expands it
 * into one generated ESM module that both the browser bundle and the server
 * import, so "one vocabulary" is enforced by the artifact rather than by memory.
 *
 * 用法 / Usage:
 *   node scripts/gen-lexicon.mjs          # 重新生成
 *   node scripts/gen-lexicon.mjs --check  # 只校验已生成文件是否最新（CI 用）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCE = 'src/shared/lexicon.json';

/**
 * 生成两份**内容完全相同**的产物：
 *   - `src/web/js/...`     给浏览器 bundle（构建只拷 src/web/js）
 *   - `src/server/search/…` 给 Lambda 镜像（docker/Dockerfile 只 COPY src/server/）
 *
 * 为什么是两份而不是一份：镜像与前端资产各自只带走自己那个目录，
 * 让服务端去 import `src/web/` 会在镜像里断链（已验证 Dockerfile:38）。
 * 「单一来源」由**同一个生成器 + 一致性门禁**保证，而不是靠共享物理路径。
 *
 * Two byte-identical artifacts because the Docker image only copies
 * src/server/ and the web build only copies src/web/js/. Single-source-ness is
 * guaranteed by one generator plus a sync check, not by a shared file path.
 */
const TARGETS = [
  'src/web/js/lexicon.generated.js',
  'src/server/search/lexicon.generated.mjs',
];

const raw = readFileSync(SOURCE, 'utf8');
const data = JSON.parse(raw);
const CHECK = process.argv.includes('--check');

if (!Array.isArray(data.terms) || !data.terms.length) {
  console.error(`词表为空或格式不对 / lexicon is empty or malformed: ${SOURCE}`);
  process.exit(1);
}

/* ---------- 展开 / Expand ---------- */

const lex = new Map();      // 中文词 -> [canonical, kind]
const termZh = new Map();   // canonical -> 中文主名
const termKind = new Map(); // canonical -> kind
const problems = [];

for (const entry of data.terms) {
  const term = entry?.term;
  const zh = entry?.zh;
  if (typeof term !== 'string' || !term) { problems.push('缺少 term'); continue; }
  if (typeof zh !== 'string' || !zh) { problems.push(`${term} 缺少中文名`); continue; }

  termZh.set(term, zh);
  termKind.set(term, entry.kind === 'color' ? 'color' : (entry.kind || 'object'));

  // searchable === false：只提供中文名（供 labels[].zh 回填），不占检索键位
  if (entry.searchable === false) continue;

  const kind = termKind.get(term);
  const isColor = kind === 'color';

  if (lex.has(zh)) problems.push(`中文主名重复：${zh}`);
  else lex.set(zh, [term, isColor ? 'color' : 'term']);

  for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
    const a = String(alias || '').trim();
    if (!a) continue;
    if (a === zh) continue;
    if (lex.has(a)) problems.push(`中文同义词重复：${a}`);
    else lex.set(a, [term, isColor ? 'color' : 'synonym']);
  }
}

if (problems.length) {
  console.error('词表有问题 / lexicon problems:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// 键排序保证生成物可复现（rev 稳定）。
// 不能用 localeCompare / Intl.Collator：中文排序取决于运行时 ICU 版本，
// macOS 生成的产物在 Linux CI 上会被 `--check` 判为漂移（2026-11-14 实际事故）。
// 改按 UTF-16 码元字典序比较——纯 JS 字符串比较，任何平台结果一致。
// Sort by UTF-16 code units, never localeCompare: ICU collation differs between
// macOS and the Linux runner, which made committed artifacts look stale in CI.
const compareCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keys = [...lex.keys()].sort((a, b) => (b.length - a.length) || compareCodePoint(a, b));
const orderedLex = keys.map((k) => [k, lex.get(k)]);
const colors = [...termKind.entries()].filter(([, k]) => k === 'color').map(([t]) => t)
  .sort(compareCodePoint);

const rev = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);

/* ---------- 输出 / Emit ---------- */

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const lines = [];
lines.push('/**');
lines.push(' * 由 `scripts/gen-lexicon.mjs` 从 `src/shared/lexicon.json` 生成。**不要手改。**');
lines.push(' * Generated from src/shared/lexicon.json — do not edit by hand.');
lines.push(' *');
lines.push(' * 前端（src/web/js/search.js）与 Lambda 都在用同一份内容的产物；');
lines.push(' * 唯一真相是 src/shared/lexicon.json，改完跑 `node scripts/gen-lexicon.mjs`。');
lines.push(' * Both artifacts are emitted from one source; regenerate after every edit.');
lines.push(' *');
lines.push(` * 词表 rev：${rev}｜term ${termZh.size} 个｜可搜中文词 ${lex.size} 个`);
lines.push(' */');
lines.push('');
lines.push(`export const LEXICON_REV = '${rev}';`);
lines.push('');
lines.push('/** 中文词 -> [规范词, 类别] / Chinese phrase -> [canonical, kind] */');
lines.push('export const LEXICON = {');
for (const [k, [term, kind]] of orderedLex) lines.push(`  ${q(k)}: [${q(term)}, ${q(kind)}],`);
lines.push('};');
lines.push('');
lines.push('/** 最长优先，保证「蓝天白云」不会被「蓝天」截断；同长按码点序固定 / longest first, code-point tie-break */');
lines.push('export const LEXICON_KEYS = Object.keys(LEXICON).sort(');
lines.push('  (a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));');
lines.push('');
lines.push('/** 规范词 -> 中文展示名 / canonical -> Chinese display name */');
lines.push('export const TERM_ZH = {');
for (const [term, zh] of [...termZh.entries()].sort((a, b) => compareCodePoint(a[0], b[0]))) {
  lines.push(`  ${q(term)}: ${q(zh)},`);
}
lines.push('};');
lines.push('');
lines.push('/** 规范词 -> 索引标签类别（object|scene|color）/ canonical -> label kind */');
lines.push('export const TERM_KIND = {');
for (const [term, kind] of [...termKind.entries()].sort((a, b) => compareCodePoint(a[0], b[0]))) {
  lines.push(`  ${q(term)}: ${q(kind)},`);
}
lines.push('};');
lines.push('');
lines.push('/** 颜色规范词集合 / color canonical terms */');
lines.push(`export const COLOR_TERMS = new Set([${colors.map(q).join(', ')}]);`);
lines.push('');
lines.push('/** 颜色+物体组合，供 explanation 顺序稳定 / explicit colour-object phrases */');
lines.push(`export const COLOR_OBJECT_COMBINATIONS = ${JSON.stringify(data.combinations || [], null, 2)};`);
lines.push('');

const output = lines.join('\n');

if (CHECK) {
  // 比较前统一归一化换行：生成物固定 LF，但 Windows 上 core.autocrlf=true
  // 会把工作区检出成 CRLF，逐字节比较会因此假失败。
  // `.gitattributes` 已把仓库钉成 LF，这里再归一化一次作为纵深防御。
  // Normalise line endings before comparing: we emit LF, but Windows with
  // core.autocrlf=true checks files out as CRLF. .gitattributes pins LF; this is
  // defence in depth so the check holds on any working copy.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const expected = norm(output);
  let stale = 0;
  for (const target of TARGETS) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* 不存在即视为不一致 */ }
    if (norm(current) !== expected) {
      console.error(`${target} 与 ${SOURCE} 不一致`);
      console.error(`${target} is out of sync with ${SOURCE}`);
      stale += 1;
    }
  }
  if (stale) {
    console.error('请运行 node scripts/gen-lexicon.mjs 后提交 / regenerate and commit.');
    process.exit(1);
  }

  // 两份产物必须逐字节相同：这是「前后端只用一份词表」的硬证据。
  // The two artifacts must be byte-identical — that is the proof that the web
  // bundle and the Lambda share exactly one vocabulary.
  const [a, b] = TARGETS.map((t) => norm(readFileSync(t, 'utf8')));
  if (a !== b) {
    console.error('两份产物内容不同，单一来源已破 / artifacts diverged');
    process.exit(1);
  }

  console.log(`词表一致：rev ${rev}｜term ${termZh.size}｜可搜中文词 ${lex.size}｜产物 ${TARGETS.length} 份（逐字节相同）`);
  process.exit(0);
}

for (const target of TARGETS) writeFileSync(target, output, 'utf8');
console.log(`已生成 ${TARGETS.length} 份：${TARGETS.join('、')}`);
console.log(`  rev ${rev}｜term ${termZh.size} 个｜可搜中文词 ${lex.size} 个｜颜色词 ${colors.length} 个`);
