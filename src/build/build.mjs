import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPhotos } from './scan.mjs';
import { readTakenAt } from './exif.mjs';
import { processImage } from './image.mjs';
import { buildManifest, loadTagOverrides } from './manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PHOTOS = path.join(ROOT, 'photos');
const WEB = path.join(ROOT, 'src', 'web');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.build-cache.json');
const SITE_FILE = path.join(ROOT, 'site.json');
const DEFAULT_SITE = { title: '个人相册', subtitle: '' };

async function loadSite() {
  try {
    const parsed = JSON.parse(await readFile(SITE_FILE, 'utf8'));
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : DEFAULT_SITE.title,
      subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : DEFAULT_SITE.subtitle,
    };
  } catch {
    return DEFAULT_SITE;
  }
}

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
    return parsed.items || {};
  } catch {
    return {};
  }
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

async function main() {
  const SITE = await loadSite();

  await mkdir(path.join(DIST, 'assets'), { recursive: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });
  await mkdir(path.join(DIST, 'photos'), { recursive: true });
  await rm(path.join(DIST, 'assets'), { recursive: true, force: true });
  await rm(path.join(DIST, 'data'), { recursive: true, force: true });
  await mkdir(path.join(DIST, 'assets'), { recursive: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });

  const cache = await loadCache();
  const { photos, duplicates, ignored, scanned } = await scanPhotos(PHOTOS);
  const overrides = await loadTagOverrides(path.join(PHOTOS, 'tags.csv'));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'album-build-'));
  const entries = [];
  const report = {
    added: 0, skipped: 0, failed: [], timeFallback: [],
    duplicates, ignored, scanned,
    invalidation: null,
  };
  const nextCache = {};

  try {
    for (const photo of photos) {
      try {
        const time = await readTakenAt(photo.srcPath, photo.mtime);
        if (time.fallback) report.timeFallback.push(photo.rel);

        const cached = cache[photo.id];
        const thumbFile = path.join(DIST, 'photos', photo.id, 'thumb.webp');
        const viewFile = path.join(DIST, 'photos', photo.id, 'view.webp');
        const reuse = cached && await fileExists(thumbFile) && await fileExists(viewFile);

        let assets;
        if (reuse) {
          assets = { thumb: cached.thumb, view: cached.view, ratio: cached.ratio };
          report.skipped += 1;
        } else {
          assets = await processImage(photo, DIST, tmpDir);
          report.added += 1;
        }

        nextCache[photo.id] = assets;
        entries.push({ ...photo, ...time, ...assets });
      } catch (err) {
        report.failed.push({ file: photo.rel, error: err.message });
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const manifest = buildManifest(entries, SITE, overrides);
  const manifestJson = JSON.stringify(manifest);
  const manifestName = `manifest.${hashOf(manifestJson)}.json`;
  const manifestFile = path.join(DIST, 'data', manifestName);
  await writeFile(manifestFile, manifestJson);

  const css = await readFile(path.join(WEB, 'style.css'));
  const js = await readFile(path.join(WEB, 'app.js'));
  const cssName = `style.${hashOf(css)}.css`;
  const jsName = `app.${hashOf(js)}.js`;
  await writeFile(path.join(DIST, 'assets', cssName), css);
  await writeFile(path.join(DIST, 'assets', jsName), js);

  const template = await readFile(path.join(WEB, 'index.html'), 'utf8');
  const html = template
    .replaceAll('__TITLE__', SITE.title)
    .replaceAll('__STYLE__', `assets/${cssName}`)
    .replaceAll('__APP__', `assets/${jsName}`)
    .replaceAll('__MANIFEST__', `data/${manifestName}`);
  await writeFile(path.join(DIST, 'index.html'), html);

  const removedDirs = await cleanStalePhotoDirs(new Set(entries.map((e) => e.id)));
  report.removedStaleDirs = removedDirs;

  await writeFile(CACHE, JSON.stringify({ version: 1, items: nextCache }, null, 2));

  await assertNoInsecureReferences([
    path.join(DIST, 'index.html'),
    path.join(DIST, 'assets', cssName),
    path.join(DIST, 'assets', jsName),
    manifestFile,
  ]);

  await writeFile(
    path.join(DIST, '.build-report.json'),
    JSON.stringify({ ...report, photos: entries.length, albums: manifest.albums.length }, null, 2),
  );

  console.log('--- 构建完成 ---');
  console.log(`扫描 ${scanned} 张 / 忽略 ${ignored.length} 张 / 去重 ${duplicates.length} 张 / 产出 ${entries.length} 张`);
  console.log(`新增 ${report.added} / 跳过 ${report.skipped} / 失败 ${report.failed.length}`);
  console.log(`无 EXIF 走兜底 ${report.timeFallback.length} 张，清理旧目录 ${removedDirs} 个`);
  console.log(`相册 ${manifest.albums.length} 个，产物目录 dist/`);
  if (report.failed.length) {
    for (const item of report.failed) console.error(`  ✗ ${item.file}: ${item.error}`);
    process.exitCode = 1;
  }
  if (!entries.length) {
    console.warn('提示：photos/ 中没有照片，已生成空站点。把照片放进 photos/ 后重跑 npm run build 即可。');
  }
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exitCode = 1;
});
