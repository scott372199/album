import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeEditorialRows, layoutParams, buildHash, parseHashString, buildStory, PACE,
} from '../src/web/js/state.js';
import { buildDistributionConfig } from '../src/deploy/distribution-config.mjs';
import { generatePolicies } from '../src/deploy/aws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
let checks = 0;

function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

async function okAsync(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function mockState() {
  return {
    view: 'album',
    album: '2026-京都',
    q: '海边 日落 & 咖啡',
    tag: '旅行',
    year: '2026',
    month: '11',
    filtered: [{ id: 'abc123' }, { id: 'def456' }],
    lightbox: { index: 1 },
  };
}

console.log('--- 第三版本地结构验证 ---');

/* 1. 编辑式行模型（feature 大图 + strip 小图组） */
const OPTS_1200 = layoutParams(1200);

ok('computeEditorialRows 保持条目顺序且覆盖全部照片', () => {
  const items = [1.5, 0.8, 1.3333, 0.5625, 2, 1.1, 0.75, 1.6].map((ratio, id) => ({ id, ratio }));
  const rows = computeEditorialRows(items, 1200, OPTS_1200);
  const flat = rows.flatMap((row) => row.items);
  assert.equal(flat.length, items.length);
  assert.deepEqual(flat.map((x) => x.id), items.map((x) => x.id));
});

ok('strip 行正好等比填满容器（不裁切的几何前提）', () => {
  const width = 1200;
  const { gap } = OPTS_1200;
  const items = Array.from({ length: 30 }, (_, id) => ({ id, ratio: 0.6 + (id % 5) * 0.35 }));
  const rows = computeEditorialRows(items, width, OPTS_1200);
  for (const row of rows) {
    assert.ok(row.height > 0, '行高必须为正');
    if (row.type !== 'strip') continue;
    const sumRatio = row.items.reduce((sum, item) => sum + item.ratio, 0);
    const total = row.height * sumRatio + (row.items.length - 1) * gap;
    assert.ok(Math.abs(total - width) < 1e-6, `strip 行宽 ${total} 未填满 ${width}`);
  }
});

ok('feature 行整行一张，高度夹在 [featureMin, featureMax]', () => {
  const items = Array.from({ length: 12 }, (_, id) => ({ id, ratio: id % 3 === 0 ? 0.56 : 1.5 }));
  const rows = computeEditorialRows(items, 1200, OPTS_1200);
  const features = rows.filter((row) => row.type === 'feature');
  assert.ok(features.length > 0, '应当存在大图行');
  for (const row of features) {
    assert.equal(row.items.length, 1);
    assert.ok(row.height >= OPTS_1200.featureMin - 1e-9);
    assert.ok(row.height <= OPTS_1200.featureMax + 1e-9);
  }
});

ok('strip 行不超过 maxPerRow，且首条必为大图', () => {
  const items = Array.from({ length: 20 }, (_, id) => ({ id, ratio: 1.4 }));
  const rows = computeEditorialRows(items, 800, layoutParams(800));
  assert.equal(rows[0].type, 'feature');
  const max = layoutParams(800).maxPerRow;
  for (const row of rows) {
    if (row.type === 'strip') assert.ok(row.items.length <= max, `strip 行 ${row.items.length} 超过 ${max}`);
  }
});

ok('视频条目会触发大图行，且空输入 / 非法 ratio 兜底', () => {
  assert.deepEqual(computeEditorialRows([], 1000, OPTS_1200), []);
  const rows = computeEditorialRows([{ ratio: 0 }, { ratio: 'abc' }], 1000, OPTS_1200);
  const all = rows.flatMap((row) => row.items);
  assert.equal(all.length, 2);
  // 非法 ratio 视作 1：单条大图行的高度应等于 clamp(width / 1)
  const solo = computeEditorialRows([{ ratio: 0 }], 1000, OPTS_1200);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].height, Math.min(OPTS_1200.featureMax, 1000));

  const mixed = [
    { id: 'a', ratio: 1.5 }, { id: 'b', ratio: 1.5 },
    { id: 'c', ratio: 1.5 }, { id: 'v', ratio: 0.5625, type: 'video' },
  ];
  const withVideo = computeEditorialRows(mixed, 1200, OPTS_1200);
  const videoRow = withVideo.find((row) => row.items.some((item) => item.id === 'v'));
  assert.equal(videoRow.type, 'feature', '视频应独占一行');
});

ok('layoutParams 随容器宽度单调变化', () => {
  const widths = [600, 800, 1100, 1300];
  const params = widths.map((w) => layoutParams(w));
  for (let i = 1; i < params.length; i += 1) {
    assert.ok(params[i].gap >= params[i - 1].gap);
    assert.ok(params[i].target >= params[i - 1].target);
    assert.ok(params[i].featureMax >= params[i - 1].featureMax);
  }
});

ok('buildStory 跨年按年分章、单年按月分章', () => {
  const multi = [
    { id: 'a', year: 2024, month: 5 }, { id: 'b', year: 2026, month: 11 },
    { id: 'c', year: 2026, month: 3 },
  ];
  const story = buildStory(multi);
  assert.equal(story.byYear, true);
  assert.equal(story.chapters.length, 2);
  assert.deepEqual(story.chapters.map((c) => c.key), ['2024', '2026']);

  const single = [
    { id: 'a', year: 2026, month: 11 }, { id: 'b', year: 2026, month: 3 },
  ];
  const byMonth = buildStory(single);
  assert.equal(byMonth.byYear, false);
  assert.deepEqual(byMonth.chapters.map((c) => c.label), ['2026 · 3 月', '2026 · 11 月']);
});

ok('故事节奏档位为正数且慢 > 标准 > 快', () => {
  assert.ok(PACE.slow > PACE.normal && PACE.normal > PACE.fast && PACE.fast > 0);
});

/* 2. URL hash 序列化 / 反序列化 */
ok('buildHash → parseHashString 往返一致（含中文与特殊字符）', () => {
  const original = mockState();
  const hash = buildHash(original);
  const restored = { lightbox: {} };
  const photoId = parseHashString(hash, restored);
  assert.equal(restored.view, 'album');
  assert.equal(restored.album, '2026-京都');
  assert.equal(restored.q, '海边 日落 & 咖啡');
  assert.equal(restored.tag, '旅行');
  assert.equal(restored.year, '2026');
  assert.equal(restored.month, '11');
  assert.equal(photoId, 'def456');
});

ok('故事 / 照片墙模式可往返', () => {
  for (const mode of ['story', 'wall']) {
    const hash = buildHash({ ...mockState(), mode, pace: 'fast' });
    const restored = { lightbox: {} };
    parseHashString(hash, restored);
    assert.equal(restored.mode, mode, `${mode} 模式未保留`);
    assert.equal(restored.pace, 'fast');
  }
  const restored = { lightbox: {} };
  parseHashString('#mode=bogus', restored);
  assert.equal(restored.mode, null);
});

ok('非法 hash 值容错回落到全量默认', () => {
  const restored = { lightbox: {} };
  parseHashString('#view=secret&year=abc&month=99&p=x', restored);
  assert.equal(restored.view, 'timeline');
  assert.equal(restored.year, '');
  assert.equal(restored.month, '');
});

ok('默认状态生成空 hash', () => {
  const empty = {
    view: 'timeline', album: '', q: '', tag: '', year: '', month: '',
    filtered: [], lightbox: { index: -1 }, mode: null,
  };
  assert.equal(buildHash(empty), '');
});

/* 3. 前端结构与产物 */
const html = await readFile(path.join(ROOT, 'src/web/index.html'), 'utf8');
const css = await readFile(path.join(ROOT, 'src/web/style.css'), 'utf8');
const jsDir = path.join(ROOT, 'src/web/js');
const jsNames = (await readdir(jsDir)).filter((f) => f.endsWith('.js')).sort();
const jsSources = await Promise.all(jsNames.map(async (f) => [f, await readFile(path.join(jsDir, f), 'utf8')]));
const allJs = jsSources.map(([, text]) => text).join('\n');

ok('前端已按模块拆分，入口为 main.js', () => {
  assert.ok(jsNames.includes('main.js'));
  for (const name of ['state.js', 'data.js', 'gallery.js', 'lightbox.js', 'story.js',
    'wall.js', 'motion.js', 'update.js', 'ui.js']) {
    assert.ok(jsNames.includes(name), `缺少模块 ${name}`);
  }
  assert.ok(!html.includes('app.js'), 'index.html 仍引用旧 app.js');
});

ok('JS 模块引用的所有 DOM id 都有定义（静态骨架或运行时模板）', () => {
  const ids = new Set([
    ...[...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...allJs.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ]);
  const used = [...new Set([...allJs.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

ok('所有模块的 import 目标都存在', () => {
  for (const [name, text] of jsSources) {
    for (const match of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
      assert.ok(jsNames.includes(match[1]), `${name} 引用了不存在的 ${match[1]}`);
    }
  }
});

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop().trim();
      if (alias) names.add(alias);
    }
  }
  return names;
}

ok('所有具名 import 都能在目标模块找到对应导出', () => {
  const exportsByFile = new Map(jsSources.map(([name, text]) => [name, exportedNames(text)]));
  for (const [name, text] of jsSources) {
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/g)) {
      const target = exportsByFile.get(m[2]);
      if (!target) continue;
      for (const part of m[1].split(',')) {
        const wanted = part.trim().split(/\s+as\s+/)[0].trim();
        if (!wanted) continue;
        assert.ok(target.has(wanted), `${name} 从 ${m[2]} 导入了不存在的 ${wanted}`);
      }
    }
  }
});

ok('index.html 只保留三个构建占位符且无绝对外链', () => {
  // v4 起 __MANIFEST__ 被移除：清单地址在运行时由 version.json 解析，
  // 前端产物不再包含任何内容地址。
  // __MANIFEST__ was removed in v4: the manifest URL is resolved at runtime
  // from version.json, so the bundle embeds no content addresses.
  for (const token of ['__TITLE__', '__STYLE__', '__APP__']) {
    assert.ok(html.includes(token), `缺少占位符 ${token}`);
  }
  assert.ok(!html.includes('__MANIFEST__'), 'index.html 不应再注入清单地址');
  assert.ok(!html.includes('ALBUM_MANIFEST'), 'index.html 不应再注入全局清单变量');
  assert.ok(!html.includes('http://') && !html.includes('https://'));
});

await okAsync('清单改为运行时解析，且 web 构建不依赖 photos/', async () => {
  const data = jsSources.find(([name]) => name === 'data.js')?.[1] || '';
  assert.ok(data.includes('export async function resolveManifest'), 'data.js 应导出 resolveManifest');
  assert.ok(data.includes('version.json'), 'resolveManifest 应先读 version.json');
  assert.ok(data.includes("cache: 'no-store'"), 'version.json 必须以 no-store 取，否则热更新失效');

  const build = await readFile(path.join(ROOT, 'src/build/build.mjs'), 'utf8');
  assert.ok(build.includes("'--target='"), 'build.mjs 应支持 --target');
  assert.ok(/TARGET === 'all'\s*\?\s*await buildFromPhotos/.test(build),
    'web 目标必须跳过照片处理');
  assert.ok(build.includes("if (TARGET === 'all') {\n    await writeFile(CACHE"),
    'web 目标不得写增量缓存，否则全量重建');

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['build:web']?.includes('--target=web'), '缺少 build:web 脚本');
  assert.ok(pkg.scripts['build:all']?.includes('--target=all'), '缺少 build:all 脚本');
});

ok('style.css 含深浅章节、Apple 风格 token、不裁切与 reduced-motion', () => {
  for (const token of ['.section--dark', 'backdrop-filter', '--accent', '.tile',
    'object-fit: contain', 'prefers-reduced-motion', ':focus-visible',
    '.story-slide', '.wall-slide', '.hero-stage']) {
    assert.ok(css.includes(token), `缺少 ${token}`);
  }
});

ok('CSS 未对照片施加滤镜或裁切类属性', () => {
  // 允许 backdrop-filter（毛玻璃），禁止真正作用于照片的 filter
  assert.ok(!/(^|[^-a-z])filter\s*:/m.test(css), 'CSS 中不应出现 filter');
  assert.ok(!/object-fit:\s*cover/.test(css), '照片不得 cover 裁切');
});

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

await okAsync('dist 产物无 http:// 引用', async () => {
  const files = [
    path.join(DIST, 'index.html'),
    ...await walk(path.join(DIST, 'assets')),
    ...await walk(path.join(DIST, 'data')),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('http://'), `${path.relative(ROOT, file)} 含 http://`);
  }
});

const dataFiles = await readdir(path.join(DIST, 'data'));
const manifestName = dataFiles.find((f) => f.startsWith('manifest.'));
const manifest = JSON.parse(await readFile(path.join(DIST, 'data', manifestName), 'utf8'));

const IMAGE_KEYS = ['id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'thumb', 'grid', 'view'];
const VIDEO_KEYS = ['id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'poster', 'src', 'duration'];
const LIVE_KEYS = [...new Set([...IMAGE_KEYS, 'poster', 'src', 'duration'])];

ok('manifest 按类型遵守字段白名单', () => {
  assert.equal(typeof manifest.site.title, 'string');
  assert.equal(typeof manifest.hero, 'string');
  for (const photo of manifest.photos) {
    const expected = photo.type === 'video' ? VIDEO_KEYS
      : photo.type === 'live' ? LIVE_KEYS
        : photo.type === 'animation' ? ['id', 'type', 'album', 'year', 'month', 'tags', 'title',
          'caption', 'ratio', 'lqip', 'featured', 'poster', 'src']
          : IMAGE_KEYS;
    assert.deepEqual(Object.keys(photo).sort(), [...expected].sort(), `${photo.id} 字段不符`);
  }
});

ok('manifest 不含源路径 / 原始文件名 / 具体日期 / 文件大小', () => {
  const text = JSON.stringify(manifest);
  for (const forbidden of ['srcPath', '"rel"', 'mtime', '"size"', '"day"', 'hasAudio', '.MOV', '.JPG']) {
    assert.ok(!text.includes(forbidden), `manifest 中出现 ${forbidden}`);
  }
});

ok('每条都带 LQIP 占位且为内联 data URI', () => {
  for (const photo of manifest.photos) {
    assert.ok(photo.lqip.startsWith('data:image/webp;base64,'), `${photo.id} 缺少 lqip`);
    assert.ok(photo.lqip.length > 80);
  }
});

await okAsync('图片条目三档文件齐全，视频条目有短片与封面', async () => {
  for (const photo of manifest.photos) {
    if (photo.type === 'image' || photo.type === 'live') {
      for (const rel of [photo.thumb, photo.grid, photo.view]) {
        await access(path.join(DIST, rel));
      }
    }
    if (photo.type === 'video') {
      await access(path.join(DIST, photo.src));
      await access(path.join(DIST, photo.poster));
      assert.ok(photo.duration > 0 && photo.duration <= 30);
    }
  }
});

await okAsync('data/version.json 与 manifest 哈希一致', async () => {
  const version = JSON.parse(await readFile(path.join(DIST, 'data', 'version.json'), 'utf8'));
  assert.equal(version.rev, manifestName.replace(/^manifest\./, '').replace(/\.json$/, ''));
  assert.equal(version.manifest, `data/${manifestName}`);
  assert.equal(version.counts.photos, manifest.photos.filter((p) => p.type !== 'video').length);
  assert.equal(version.counts.videos, manifest.photos.filter((p) => p.type === 'video').length);
});

await okAsync('JS 产物走目录级哈希，模块间相对引用可解析', async () => {
  const distHtml = await readFile(path.join(DIST, 'index.html'), 'utf8');
  const match = /src="(assets\/js\.[0-9a-f]+\/main\.js)"/.exec(distHtml);
  assert.ok(match, 'index.html 未引用目录级哈希入口');
  const entryDir = path.join(DIST, path.dirname(match[1]));
  const entrySource = await readFile(path.join(entryDir, 'main.js'), 'utf8');
  const locals = [...entrySource.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(locals.length > 0, '入口应引用同目录模块');
  for (const name of locals) await access(path.join(entryDir, name));
});

ok('视频转码参数先取时间再清元数据，且带 faststart', async () => {
  const video = await readFile(path.join(ROOT, 'src/build/video.mjs'), 'utf8');
  for (const token of ['-map_metadata', '-map_chapters', '+bitexact', 'creation_time', '+faststart']) {
    assert.ok(video.includes(token), `视频转码缺少 ${token}`);
  }
  assert.ok(video.includes('probeVideo'), '应先探测元数据再转码');
});

const report = JSON.parse(await readFile(path.join(DIST, '.build-report.json'), 'utf8'));
ok('构建报告的 invalidation 状态合法（未部署为 null，已部署为结构体）', () => {
  const value = report.invalidation;
  if (value === null) return;
  assert.equal(typeof value, 'object');
  assert.equal(value.executed, true);
  assert.ok(Array.isArray(value.paths) && value.paths.includes('/index.html'));
  assert.ok(value.paths.includes('/data/version.json'));
});

/* 4. 部署配置 */
const config = JSON.parse(await readFile(path.join(ROOT, 'src/deploy/config.json'), 'utf8'));

ok('config.json 为 v2 配置，无 website endpoint 残留', () => {
  assert.equal(config.acmRegion, 'us-east-1');
  assert.equal(config.region, 'ap-southeast-1');
  assert.ok(config.siteUrl.startsWith('https://'));
  assert.ok(!JSON.stringify(config).includes('s3-website'));
});

ok('DistributionConfig 字段正确，不配置 CustomErrorResponses', () => {
  const state = {
    oacId: 'OAC_ID',
    certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/demo',
  };
  const dc = buildDistributionConfig(config, state, 'CACHE_POLICY_ID');
  assert.equal(dc.DefaultRootObject, 'index.html');
  assert.equal(dc.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(dc.DefaultCacheBehavior.CachePolicyId, 'CACHE_POLICY_ID');
  assert.equal(dc.ViewerCertificate.SSLSupportMethod, 'sni-only');
  assert.equal(dc.ViewerCertificate.MinimumProtocolVersion, 'TLSv1.2_2021');
  assert.equal(dc.CustomErrorResponses.Quantity, 0);
  assert.equal(dc.Origins.Items[0].OriginAccessControlId, 'OAC_ID');
  assert.equal(dc.Origins.Items[0].S3OriginConfig.OriginAccessIdentity, '');
  assert.ok(!dc.Origins.Items[0].DomainName.includes('s3-website'));
  assert.deepEqual(dc.Aliases.Items, [config.domain]);
});

/* 策略文件是运行时生成的（不入库），这里直接调生成函数拿对象断言，不需要真跑 AWS。 */
const policyConfig = { bucket: 'demo-bucket', region: 'ap-southeast-1', domain: 'photos.example.com' };
const { bucketPolicy, iamPolicy } = await generatePolicies(policyConfig, {}, '000000000000', { write: false });

ok('桶策略仅授权 CloudFront OAC，无公开读', () => {
  const statement = bucketPolicy.Statement[0];
  assert.equal(statement.Principal.Service, 'cloudfront.amazonaws.com');
  assert.equal(statement.Action, 's3:GetObject');
  assert.ok(statement.Condition.StringEquals['AWS:SourceArn']);
  assert.ok(!JSON.stringify(bucketPolicy).includes('"*"'));
});

ok('IAM 最小权限含 ACM 与 CloudFront，且移除 v1 的建桶权限', () => {
  const actions = iamPolicy.Statement.flatMap((s) => s.Action);
  assert.ok(actions.includes('acm:DescribeCertificate'));
  assert.ok(actions.includes('cloudfront:CreateInvalidation'));
  assert.ok(actions.includes('s3:DeleteBucketWebsite'));
  assert.ok(!actions.includes('s3:CreateBucket'));
  assert.ok(!actions.includes('s3:PutBucketWebsite'));
});

/* 5. 临时预览通道：CloudFront 账号验证期的过渡命令，必须严格不越界 */
const previewMjs = await readFile(path.join(ROOT, 'src/deploy/preview.mjs'), 'utf8');
const syncStart = previewMjs.indexOf('const syncArgs');
const previewSync = previewMjs.slice(syncStart, previewMjs.indexOf('];', syncStart));

ok('临时预览只同步 S3 对象：不 --delete、不动 CloudFront / 桶配置', () => {
  assert.ok(previewSync.includes("'s3', 'sync'"));
  assert.ok(!previewSync.includes('--delete'));
  for (const forbidden of [
    'put-bucket-policy', 'put-public-access-block', 'delete-bucket-website',
    'create-invalidation', 'create-distribution',
  ]) {
    assert.ok(!previewMjs.includes(forbidden), `预览脚本不应执行 ${forbidden}`);
  }
});

ok('临时预览提供 v1 入口页备份与一键回滚，且备份不被重复覆盖', () => {
  assert.ok(previewMjs.includes('.rollback-v1'));
  assert.ok(previewMjs.includes('--rollback'));
  assert.ok(previewMjs.includes('exists(backupFile)'));
});

/* 6. 正式部署的缓存头两段式 */
const deployMjs = await readFile(path.join(ROOT, 'src/deploy/deploy.mjs'), 'utf8');

ok('部署先全量长缓存 sync，再单独覆盖入口页与版本文件', () => {
  const syncAt = deployMjs.indexOf("'s3', 'sync'");
  const cpAt = deployMjs.indexOf("'s3', 'cp'");
  assert.ok(syncAt > 0 && cpAt > syncAt, '顺序必须是先 sync 后 cp');
  assert.ok(deployMjs.includes('31536000') && deployMjs.includes('immutable'), '产物应长缓存');
  assert.ok(deployMjs.includes('index.html') && deployMjs.includes('data/version.json'));
  assert.ok(deployMjs.includes('no-store'), 'version.json 必须 no-store');
  assert.ok(deployMjs.includes('--metadata-directive'), '覆盖缓存头需 REPLACE 元数据');
});

ok('同步不把入口页排除在外（--exclude 会连带影响 --delete 判定）', () => {
  const start = deployMjs.indexOf('const syncArgs');
  const raw = deployMjs.slice(start, deployMjs.indexOf('];', start));
  // 去掉注释再判断，注释里提到 index.html 是说明文字，不是 exclude 参数
  const syncBlock = raw.replace(/\/\/[^\n]*/g, '');
  const excludes = [...syncBlock.matchAll(/'--exclude',\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(!excludes.some((value) => value.includes('index.html')), '入口页不应出现在 exclude 中');
  assert.ok(syncBlock.includes('--delete'));
  assert.ok(syncBlock.includes('--size-only'), '同尺寸即同内容，避免每轮重传');
});

console.log(`--- 全部通过：${checks} 项断言 ---`);
