#!/usr/bin/env node
/**
 * T-03 · term 覆盖率审计 / Term coverage audit.
 *
 * 目的：词表要扩到 ≈380 个词，扩哪些不能靠猜。本脚本读**生产索引**，
 * 统计每个被识别出来的 term 出现了多少张照片、当前有没有中文名。
 * 输出只含 term 与计数，**不打印任何照片 id、路径或相册名**——
 * 这份报告可以安全地贴进聊天或提交入库。
 *
 * 关键：C-3 之后 `zh` 是**建索引期**才解析的，所以索引里存的 `zh` 会滞后。
 * 报告分两栏——「索引现状」看已经发布的那份，**「重建后」才是真正还缺多少**，
 * 因为重建只需几秒而重跑识别要几小时。
 *
 * Reads the production index and reports, per recognised term, how many photos
 * carry it and whether a Chinese name exists. Output contains terms and counts
 * only — never photo ids, paths or album names — so the report itself is safe
 * to share or commit.
 *
 * Since C-3 `zh` is resolved at index-build time, so the `zh` stored in the
 * published index lags behind the vocabulary. The report therefore has two
 * columns: what the published index says, and — the one that matters — what
 * would remain missing after a rebuild (seconds) versus a full re-recognition
 * (hours).
 *
 * 用法 / Usage:
 *   node scripts/audit-terms.mjs                       # 自动在 data/ 里找索引
 *   node scripts/audit-terms.mjs data/search-index.json
 *   node scripts/audit-terms.mjs --out spec/v6/term-audit.md
 *   node scripts/audit-terms.mjs --missing-only        # 只看缺中文名的
 *   node scripts/audit-terms.mjs --min-photos 3        # 过滤长尾
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
// 用当前词表重算中文名：这才是「重建索引后会怎样」。
// Resolve Chinese names through the current vocabulary — that is what a
// rebuild would actually produce.
import { TERM_ZH } from '../src/server/search/lexicon.generated.mjs';

const DATA_DIR = 'data';

/* ---------- 参数 / Args ---------- */

const argv = process.argv.slice(2);
const opt = {
  input: '',
  out: '',
  missingOnly: false,
  minPhotos: 1,
};

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--out') { opt.out = argv[i += 1] || ''; }
  else if (a === '--missing-only') { opt.missingOnly = true; }
  else if (a === '--min-photos') { opt.minPhotos = Math.max(1, Number(argv[i += 1]) || 1); }
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else if (!a.startsWith('-')) { opt.input = a; }
}

function printHelp() {
  process.stdout.write([
    'node scripts/audit-terms.mjs [索引路径] [选项]',
    '',
    '  --out <file>        把 Markdown 报告写到文件（默认输出到终端）',
    '  --missing-only      只列出缺中文名的 term',
    '  --min-photos <n>    只统计至少出现在 n 张照片上的 term（默认 1）',
    '',
    '索引来源优先级：命令行参数 > data/search-index.json > data/ 下最新的 rev 版索引',
    '',
  ].join('\n'));
}

/* ---------- 定位索引 / Locate the index ---------- */

function findIndex() {
  if (opt.input) {
    const p = resolve(opt.input);
    if (!existsSync(p)) fail(`找不到指定的索引文件 / index not found: ${opt.input}`);
    return p;
  }
  const fixed = join(DATA_DIR, 'search-index.json');
  if (existsSync(fixed)) return resolve(fixed);

  if (existsSync(DATA_DIR)) {
    const revs = readdirSync(DATA_DIR)
      .filter((f) => /^search-index\.[0-9a-f]{8,64}\.json$/i.test(f))
      .map((f) => ({ path: join(DATA_DIR, f), mtime: statSync(join(DATA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (revs.length) return resolve(revs[0].path);
  }
  return '';
}

function fail(msg) {
  process.stderr.write(`\n${msg}\n\n`);
  process.stderr.write([
    '索引只在 S3 站点桶里，本仓库不含 data/。先从桶里取一份：',
    '',
    '  # 桶名 = Lambda album-processor 的环境变量 SITE_BUCKET',
    '  aws s3 cp s3://$SITE_BUCKET/data/search-index.json data/',
    '',
    '或直接打开 https://<站点域名>/data/search-index.json 另存为 data/search-index.json。',
    'data/ 已在 .gitignore 中，不会被提交。',
    '',
  ].join('\n'));
  process.exit(1);
}

const indexPath = findIndex();
if (!indexPath) fail('没有找到索引文件 / no index file found');

/* ---------- 读索引 / Load ---------- */

let index;
try {
  index = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch (err) {
  fail(`索引不是合法 JSON / index is not valid JSON：${err.message}`);
}

const items = Array.isArray(index?.items) ? index.items : null;
if (!items) fail('索引缺少 items 数组 / index has no items array');

/**
 * 中文名是否**真的**是中文。
 *
 * `zhForTerm()` 的兜底是 `TERM_ZH[term] || term`——查不到就直接把英文 term
 * 回填进 zh。所以 `zh === term` 或 zh 不含任何汉字，都等于**没有中文名**，
 * 这样的标签只能用英文检索，而用户不会去敲英文。
 *
 * A Chinese name is only real if it contains a CJK ideograph. `zhForTerm()`
 * falls back to the English term itself, so `zh === term` means "no Chinese
 * name at all" — such labels are effectively unsearchable in Chinese.
 */
const CJK = /[\u4e00-\u9fff]/;
function zhStatus(zhValues, term) {
  for (const zh of zhValues) {
    if (CJK.test(zh) && zh !== term) return 'cn';
  }
  return zhValues.size ? 'placeholder' : 'empty';
}

/* ---------- 统计 / Aggregate ---------- */

const stats = new Map(); // term -> { photos:Set, zh:Set, kinds:Set, maxConf }
let photosWithLabels = 0;

for (const item of items) {
  const labels = Array.isArray(item?.labels) ? item.labels : [];
  if (labels.length) photosWithLabels += 1;
  const seenInPhoto = new Set(); // 同一张里重复 term 只算一次
  for (const label of labels) {
    const term = typeof label?.term === 'string' ? label.term : '';
    if (!term || seenInPhoto.has(term)) continue;
    seenInPhoto.add(term);

    if (!stats.has(term)) {
      stats.set(term, {
        photos: new Set(), zh: new Set(), kinds: new Set(), maxConf: 0,
      });
    }
    const row = stats.get(term);
    row.photos.add(item.id);
    if (typeof label.zh === 'string' && label.zh) row.zh.add(label.zh);
    if (typeof label.kind === 'string' && label.kind) row.kinds.add(label.kind);
    const conf = Number(label.confidence);
    if (Number.isFinite(conf)) row.maxConf = Math.max(row.maxConf, conf);
  }
}

/**
 * 用当前词表解析中文名，复刻 `zhForTerm()` 的兜底语义。
 * Resolve a Chinese name the way `zhForTerm()` would, after a rebuild.
 */
function zhAfterRebuild(term) {
  const zh = TERM_ZH[term] || term;
  return { zh, isReal: CJK.test(zh) && zh !== term };
}

const rows = [...stats.entries()]
  .map(([term, v]) => {
    const after = zhAfterRebuild(term);
    return {
      term,
      photos: v.photos.size,
      zh: [...v.zh].filter((z) => CJK.test(z) && z !== term).join(' / '),
      status: zhStatus(v.zh, term),
      zhAfter: after.zh,
      statusAfter: after.isReal ? 'cn' : 'missing',
      kind: [...v.kinds].join(', '),
      maxConf: v.maxConf,
    };
  })
  .filter((r) => r.photos >= opt.minPhotos)
  .filter((r) => (opt.missingOnly ? r.statusAfter !== 'cn' : true))
  .sort((a, b) => b.photos - a.photos || a.term.localeCompare(b.term));

const withZh = rows.filter((r) => r.status === 'cn').length;
const missing = rows.filter((r) => r.status !== 'cn');
const placeholder = missing.filter((r) => r.status === 'placeholder').length;
const emptyZh = missing.filter((r) => r.status === 'empty').length;

// 重建后的真实缺口——T-04 的判定依据
const stillMissing = rows.filter((r) => r.statusAfter !== 'cn');
const coveredPhotos = rows.filter((r) => r.statusAfter === 'cn').reduce((n, r) => n + r.photos, 0);

/* ---------- 输出 / Render ---------- */

const pct = (n) => `${((n / Math.max(1, photosWithLabels)) * 100).toFixed(1)}%`;

const lines = [];
lines.push('# V6 词表覆盖率审计 / Term coverage audit');
lines.push('');
lines.push('> 由 `scripts/audit-terms.mjs` 生成。**只含识别词与计数，不含任何照片 id、路径或相册名。**');
lines.push('');
lines.push(`- 索引文件 / index：\`${indexPath.split(/[\\/]/).slice(-2).join('/')}\``);
lines.push(`- 索引版本 / version：\`${index.version ?? '(未标注)'}\``);
lines.push(`- 照片总数 / items：${items.length}`);
lines.push(`- 有标签的照片：${photosWithLabels}（${pct(photosWithLabels)}）`);
lines.push(`- distinct term：${rows.length}`);
lines.push(`- 已发布索引：有真中文名 ${withZh}；缺 ${missing.length}（其中占位=英文 ${placeholder}，空值 ${emptyZh}）`);
lines.push(`- **用当前词表重建后仍缺：${stillMissing.length}**（已覆盖 ${coveredPhotos} 条标签出现）`);
if (placeholder) {
  lines.push('');
  lines.push(`> ⚠️ 「占位=英文」指 \`zh\` 被 \`zhForTerm()\` 兜底填成了 term 本身，**该标签只能用英文检索**，对中文用户等于不可搜。`);
}
lines.push('');
lines.push('> 索引里的 `zh` 是**上一次建索引时**解析的，会滞后于词表。判 T-04 进度看下面第二节。');
if (opt.minPhotos > 1) lines.push(`- 过滤：只统计出现在 ≥${opt.minPhotos} 张照片上的 term`);
lines.push('');
lines.push('## 重建索引后仍缺中文名 / Still missing after a rebuild');
lines.push('');
if (!stillMissing.length) {
  lines.push('无。当前词表已覆盖全部已识别 term，重建索引即可生效。');
} else {
  lines.push('| term | 出现张数 | 覆盖率 | kind | 最高置信度 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of stillMissing) {
    lines.push(`| \`${r.term}\` | ${r.photos} | ${pct(r.photos)} | ${r.kind || '-'} | ${r.maxConf.toFixed(1)} |`);
  }
}
lines.push('');
lines.push('## 已发布索引的缺口（历史对照）/ Gaps in the published index');
lines.push('');
if (!missing.length) {
  lines.push('无。');
} else {
  lines.push('| term | 出现张数 | 覆盖率 | 状态 | kind | 最高置信度 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of missing) {
    const flag = r.status === 'placeholder' ? '占位=英文' : '空';
    lines.push(`| \`${r.term}\` | ${r.photos} | ${pct(r.photos)} | ${flag} | ${r.kind || '-'} | ${r.maxConf.toFixed(1)} |`);
  }
}
if (!opt.missingOnly) {
  lines.push('');
  lines.push('## 全部 term / All terms');
  lines.push('');
  lines.push('| term | 出现张数 | 覆盖率 | 中文名（重建后） | kind |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const name = r.statusAfter === 'cn' ? r.zhAfter : '**缺**';
    lines.push(`| \`${r.term}\` | ${r.photos} | ${pct(r.photos)} | ${name} | ${r.kind || '-'} |`);
  }
}
lines.push('');

const report = lines.join('\n');

if (opt.out) {
  writeFileSync(opt.out, report, 'utf8');
  process.stdout.write(`已写入 ${opt.out}\n`);
  process.stdout.write(
    `distinct term ${rows.length} · 索引现状：有中文名 ${withZh} / 缺 ${missing.length}`
    + ` · **重建后仍缺 ${stillMissing.length}**\n`,
  );
} else {
  process.stdout.write(report);
}
