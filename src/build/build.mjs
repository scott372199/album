import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPhotos } from './scan.mjs';
import { readTakenAt } from './exif.mjs';
import { processEntry } from './media.mjs';
import { buildManifest, loadTagOverrides } from './manifest.mjs';
import { loadSite, resolveHero, resolveFeatured } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PHOTOS = path.join(ROOT, 'photos');
const WEB = path.join(ROOT, 'src', 'web');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.build-cache.json');
const SITE_FILE = path.join(ROOT, 'site.json');
const CACHE_VERSION = 3;

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

async function loadCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE, 'utf8'));
    if (parsed.version !== CACHE_VERSION) return {};
    return parsed.items || {};
  } catch {
    return {};
  }
}

/** 缓存可复用的前提：版本一致、产物文件都还在（降级后的类型变化不影响复用） */
async function cacheUsable(entry, cached) {
  if (!cached || cached.v !== CACHE_VERSION) return false;
  const assets = cached.assets || {};
  const required = [];
  if (cached.type === 'image') required.push(assets.thumb, assets.grid, assets.view);
  else if (cached.type === 'video') required.push(assets.poster, assets.src);
  else if (cached.type === 'live') required.push(assets.thumb, assets.grid, assets.view, assets.poster);
  else if (cached.type === 'animation') required.push(assets.poster, assets.src);
  else return false;
  if (required.some((rel) => !rel)) return false;
  for (const rel of required) {
    if (!(await fileExists(path.join(DIST, rel)))) return false;
  }
  return true;
}

async function cleanStalePhotoDirs(validIds) {
  const photosRoot = path.join(DIST, 'photos');
  const dirs = await readdir(photosRoot, { withFileTypes: true });
  let removed = 0;
  for (const entry of dirs) {
    if (entry.isDirectory() && !validIds.has(entry.name)) {
      await rm(path.join(photosRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** v2：站点走 HTTPS，产物中出现 http:// 即为混合内容风险。产物本身应全部使用相对路径。 */
async function assertNoInsecureReferences(files) {
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('http://')) offenders.push(path.relative(DIST, file));
  }
  if (offenders.length) {
    throw new Error(`产物中出现 http:// 引用（HTTPS 站点会触发混合内容）：${offenders.join(', ')}`);
  }
}

async function collectFiles(dir, base = '') {
  const out = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...await collectFiles(path.join(dir, item.name), rel));
    else if (item.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 复制前端资源。
 * - 有 src/web/js/ 时：整目录按内容哈希落盘（目录名即版本号），模块间相对 import 自然解析
 * - 没有时：退回 v2 的单文件 app.js，保证中间状态仍可构建
 */
async function copyWebAssets() {
  const jsDir = path.join(WEB, 'js');
  if (await fileExists(jsDir)) {
    const files = await collectFiles(jsDir);
    const hash = createHash('sha256');
    for (const rel of files) hash.update(rel).update(await readFile(path.join(jsDir, rel)));
    const dirName = `assets/js.${hash.digest('hex').slice(0, 8)}`;
    for (const rel of files) {
      const target = path.join(DIST, dirName, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(jsDir, rel), target);
    }
    return {
      src: `${dirName}/main.js`,
      kind: 'modules',
      files: files.map((rel) => path.join(DIST, dirName, rel)),
    };
  }

  const js = await readFile(path.join(WEB, 'app.js'));
  const name = `assets/app.${hashOf(js)}.js`;
  await writeFile(path.join(DIST, name), js);
  return { src: name, kind: 'legacy', files: [path.join(DIST, name)] };
}

async function main() {
  const SITE = await loadSite(SITE_FILE);

  await rm(path.join(DIST, 'assets'), { recursive: true, force: true });
  await rm(path.join(DIST, 'data'), { recursive: true, force: true });
  await mkdir(path.join(DIST, 'assets'), { recursive: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });
  await mkdir(path.join(DIST, 'photos'), { recursive: true });

  const cache = await loadCache();
  const { photos, duplicates, ignored, scanned, livePairs } = await scanPhotos(PHOTOS);
  const overrides = await loadTagOverrides(path.join(PHOTOS, 'tags.csv'));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'album-build-'));
  const entries = [];
  const report = {
    added: 0,
    skipped: 0,
    failed: [],
    timeFallback: [],
    degraded: [],
    duplicates,
    ignored,
    scanned,
    livePairs,
    invalidation: null,
  };
  const nextCache = {};

  try {
    for (const photo of photos) {
      try {
        const cached = cache[photo.id];
        let time;
        let record;

        if (await cacheUsable(photo, cached)) {
          time = cached.time;
          record = { type: cached.type, assets: cached.assets, meta: cached.meta };
          report.skipped += 1;
        } else {
          record = await processEntry(photo, { distRoot: DIST, tmpDir });
          if (photo.type === 'video' || photo.type === 'live') {
            time = record.createdAt
              ? {
                year: record.createdAt.getFullYear(),
                month: record.createdAt.getMonth() + 1,
                fallback: false,
              }
              : await readTakenAt(photo.videoPath || photo.srcPath, photo.mtime);
          } else {
            time = await readTakenAt(photo.srcPath, photo.mtime);
          }
          report.added += 1;
          if (record.type === 'image' && photo.type === 'video') report.degraded.push(photo.rel);
        }

        // 视频/动图没有 EXIF 时也要标注兜底，便于排查排序异常
        if (!time) time = await readTakenAt(photo.srcPath, photo.mtime);
        if (time.fallback) report.timeFallback.push(photo.rel);

        nextCache[photo.id] = {
          v: CACHE_VERSION,
          type: record.type,
          assets: record.assets,
          meta: record.meta,
          time,
        };

        entries.push({
          ...photo,
          type: record.type,
          assets: record.assets,
          meta: record.meta,
          year: time.year,
          month: time.month,
        });
      } catch (err) {
        report.failed.push({ file: photo.rel, error: err.message });
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const hero = resolveHero(SITE, entries);
  const featured = resolveFeatured(SITE, entries, { hero });
  const manifest = buildManifest({ entries, site: SITE, overrides, hero, featured });
  const manifestJson = JSON.stringify(manifest);
  const manifestName = `manifest.${hashOf(manifestJson)}.json`;
  const manifestFile = path.join(DIST, 'data', manifestName);
  await writeFile(manifestFile, manifestJson);

  const videos = entries.filter((e) => e.type === 'video' || e.type === 'live');
  const versionJson = JSON.stringify({
    rev: hashOf(manifestJson),
    manifest: `data/${manifestName}`,
    counts: {
      photos: entries.filter((e) => e.type !== 'video').length,
      videos: entries.filter((e) => e.type === 'video').length,
    },
  });
  await writeFile(path.join(DIST, 'data', 'version.json'), versionJson);

  const css = await readFile(path.join(WEB, 'style.css'));
  const cssName = `style.${hashOf(css)}.css`;
  await writeFile(path.join(DIST, 'assets', cssName), css);
  const app = await copyWebAssets();

  const template = await readFile(path.join(WEB, 'index.html'), 'utf8');
  const html = template
    .replaceAll('__TITLE__', SITE.title)
    .replaceAll('__STYLE__', `assets/${cssName}`)
    .replaceAll('__APP__', app.src)
    .replaceAll('__MANIFEST__', `data/${manifestName}`);
  await writeFile(path.join(DIST, 'index.html'), html);

  const removedDirs = await cleanStalePhotoDirs(new Set(entries.map((e) => e.id)));

  await writeFile(CACHE, JSON.stringify({ version: CACHE_VERSION, items: nextCache }, null, 2));

  const textFiles = [
    path.join(DIST, 'index.html'),
    path.join(DIST, 'assets', cssName),
    manifestFile,
    path.join(DIST, 'data', 'version.json'),
    ...app.files,
  ];
  await assertNoInsecureReferences(textFiles);

  // 体积统计：照片墙跑完一轮要下载多少
  let galleryBytes = 0;
  for (const entry of entries) {
    const rel = entry.type === 'video' || entry.type === 'animation'
      ? entry.assets.src
      : entry.assets.view || entry.assets.poster;
    if (!rel) continue;
    try {
      galleryBytes += (await stat(path.join(DIST, rel))).size;
    } catch { /* 忽略统计失败 */ }
  }

  const videoBytes = videos.reduce((sum, e) => sum + (e.meta?.bytes || 0), 0);
  const videoSeconds = videos.reduce((sum, e) => sum + (e.meta?.duration || 0), 0);

  await writeFile(
    path.join(DIST, '.build-report.json'),
    JSON.stringify({
      ...report,
      photos: entries.filter((e) => e.type !== 'video').length,
      videos: entries.filter((e) => e.type === 'video').length,
      albums: manifest.albums.length,
      removedStaleDirs: removedDirs,
      videoSeconds: Number(videoSeconds.toFixed(2)),
      videoBytes,
      galleryBytesEstimate: galleryBytes,
      manifestBytes: Buffer.byteLength(manifestJson),
      webAssets: app.kind,
    }, null, 2),
  );

  console.log('--- 构建完成 ---');
  console.log(`扫描 ${scanned} 个文件 / 忽略 ${ignored.length} / 去重 ${duplicates.length} / 产出 ${entries.length} 条`);
  console.log(`新增 ${report.added} / 跳过 ${report.skipped} / 失败 ${report.failed.length} / 降级 ${report.degraded.length}`);
  console.log(`视频 ${videos.length} 条（${videoSeconds.toFixed(1)}s，${(videoBytes / 1024 / 1024).toFixed(1)}MB），Live Photo ${livePairs} 对`);
  console.log(`无 EXIF 走兜底 ${report.timeFallback.length} 条，清理旧目录 ${removedDirs} 个`);
  console.log(`相册 ${manifest.albums.length} 个，manifest ${(Buffer.byteLength(manifestJson) / 1024).toFixed(1)}KB，产物在 dist/`);
  if (report.degraded.length) {
    for (const file of report.degraded) console.warn(`  ! 视频降级为静图：${file}`);
  }
  if (report.failed.length) {
    for (const item of report.failed) console.error(`  ✗ ${item.file}: ${item.error}`);
    process.exitCode = 1;
  }
  if (!entries.length) {
    console.warn('提示：photos/ 中没有素材，已生成空站点。放入照片或视频后重跑 npm run build 即可。');
  }
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exitCode = 1;
});
