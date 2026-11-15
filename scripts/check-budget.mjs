#!/usr/bin/env node
/**
 * 体积门禁 / Size budget gate（V6 T-12，FR-14 / C-4）。
 *
 * 对 `dist/` 下所有 `.js` / `.css` 求 **gzip 之和**，超过 120 KB 即以非零码退出，
 * 并列出 top-5 贡献文件与「相对上次基线的增量」。
 *
 * 三个刻意的取舍：
 *   1. 用 gzip 而不是原始字节——CDN 与浏览器协商的就是压缩后传输量，
 *      结构重复的文件（词表 JSON）压完很小，看原值会误判；
 *   2. 增量需要基线，基线写在 `.budget-baseline.json`（不进仓库）；
 *      没有基线时只报占比，不编造「增量」；
 *   3. **LCP 不进 CI**（C-4）：CI 机器没有真实网络与真实相册，数字没有意义。
 *      体积是唯一能在离线环境稳定复现的那条线。
 *
 * gzip total for every js/css under dist/. Over budget fails and names the
 * top-5 contributors; LCP is deliberately not measured in CI (C-4).
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { BUDGET_BYTES, formatBytes, summarize, deltas } from './lib/budget.mjs';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const BASELINE = path.join(ROOT, '.budget-baseline.json');
const EXT = new Set(['.js', '.css']);

/**
 * 目录根的 `sw.js` 不计入：Service Worker 是浏览器**后台**取的，不参与首屏渲染，
 * 也不会阻塞 LCP；不支持 SW 的浏览器一个字节都不会下载它。把它算进来等于让
 * 「离线能力」和「首屏体积」互相挤占，而这两件事优化的方向根本不同。
 * 其余 `.js` / `.css` 一律照算，没有别的例外。
 *
 * The root `sw.js` is excluded: a service worker is fetched in the background,
 * never blocks first paint, and is not downloaded at all by browsers without SW
 * support. Everything else is still counted — this is the only exception.
 */
function measured(full) {
  return !(path.dirname(full) === DIST && path.basename(full) === 'sw.js');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (EXT.has(path.extname(entry.name)) && measured(full)) out.push(full);
  }
  return out;
}

async function main() {
  let files;
  try {
    files = await walk(DIST);
  } catch {
    console.error(`没有找到构建产物目录：${path.relative(ROOT, DIST)}`);
    console.error('先跑 `npm run build:web` 再量体积。');
    process.exit(1);
  }
  if (!files.length) {
    console.error('构建产物里没有 .js / .css——这通常说明构建根本没成功');
    process.exit(1);
  }

  const measured = [];
  for (const file of files) {
    measured.push({
      file: path.relative(DIST, file).split(path.sep).join('/'),
      size: gzipSync(await readFile(file), { level: 9 }).length,
    });
  }

  let baseline = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  } catch {
    baseline = null;
  }
  const delta = deltas(measured, baseline);
  const result = summarize(measured, BUDGET_BYTES);

  console.log('--- 前端体积（gzip）/ Front-end budget ---');
  console.log(`${files.length} 个文件 · 合计 ${formatBytes(result.total)} / 预算 ${formatBytes(BUDGET_BYTES)}`);
  console.log('最大的 5 个：');
  for (const item of result.top) {
    const d = delta[item.file];
    const suffix = typeof d === 'number' ? `  ${d >= 0 ? '+' : ''}${d} B` : '';
    console.log(`  ${item.file.padEnd(36)} ${formatBytes(item.size).padStart(9)}  ${(item.share * 100).toFixed(1).padStart(5)}%${suffix}`);
  }

  if (result.over) {
    console.error('');
    console.error(`体积超预算：${formatBytes(result.total)} > ${formatBytes(BUDGET_BYTES)}，超出 ${formatBytes(result.overflow)}`);
    console.error('先看 top-5 里最大的一项：通常是新引入的依赖，而不是自己的代码。');
    process.exit(1);
  }

  await writeFile(BASELINE, JSON.stringify({
    total: result.total,
    files: Object.fromEntries(measured.map((item) => [item.file, item.size])),
  }, null, 2)).catch(() => { /* 写不了基线不影响判定 */ });

  console.log(`通过：还剩 ${formatBytes(result.remaining)} 余量`);
}

await main();
