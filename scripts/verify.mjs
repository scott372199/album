import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRows, buildHash, parseHashString } from '../src/web/app.js';
import { buildDistributionConfig } from '../src/deploy/distribution-config.mjs';

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

console.log('--- 第二版本地结构验证 ---');

/* 1. justified rows 纯算法 */
ok('computeRows 保持条目顺序且覆盖全部照片', () => {
  const items = [1.5, 0.8, 1.3333, 0.5625, 2].map((ratio, id) => ({ id, ratio }));
  const rows = computeRows(items, 1000, 300, 18);
  const flat = rows.flatMap((row) => row.items);
  assert.equal(flat.length, items.length);
  assert.deepEqual(flat.map((x) => x.id), items.map((x) => x.id));
});

ok('computeRows 行宽不溢出容器，行高均为正且不超过目标', () => {
  const width = 800; const gap = 12; const target = 200;
  const items = Array.from({ length: 24 }, (_, id) => ({ id, ratio: 0.6 + (id % 5) * 0.35 }));
  const rows = computeRows(items, width, target, gap);
  assert.ok(rows.length > 1);
  for (const row of rows) {
    assert.ok(row.height > 0 && row.height <= target + 1e-9);
    const total = row.items.reduce((sum, item) => sum + row.height * item.ratio, 0)
      + (row.items.length - 1) * gap;
    assert.ok(total <= width + 1e-6, `行宽 ${total} 超出 ${width}`);
  }
});

ok('computeRows 每行按原始 ratio 等比分配（不裁切的几何前提）', () => {
  const width = 900; const gap = 10; const target = 240;
  const items = [0.5625, 1.3333, 1, 1.7778, 0.8, 1.2].map((ratio, id) => ({ id, ratio }));
  const rows = computeRows(items, width, target, gap);
  for (const row of rows) {
    const usable = width - (row.items.length - 1) * gap;
    const expected = Math.min(usable / row.items.reduce((s, i) => s + i.ratio, 0), target);
    assert.ok(Math.abs(row.height - expected) < 1e-9);
  }
});

ok('computeRows 空输入与非法 ratio 兜底', () => {
  assert.deepEqual(computeRows([], 1000, 300, 18), []);
  const rows = computeRows([{ ratio: 0 }, { ratio: 'abc' }], 1000, 300, 18);
  const all = rows.flatMap((row) => row.items);
  assert.equal(all.length, 2);
  assert.ok(all.every((item) => item.ratio === 1));
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
    filtered: [], lightbox: { index: -1 },
  };
  assert.equal(buildHash(empty), '');
});

/* 3. 前端结构与产物 */
const html = await readFile(path.join(ROOT, 'src/web/index.html'), 'utf8');
const appJs = await readFile(path.join(ROOT, 'src/web/app.js'), 'utf8');
const css = await readFile(path.join(ROOT, 'src/web/style.css'), 'utf8');

ok('app.js 引用的所有 DOM id 都有定义（静态骨架或运行时模板）', () => {
  const ids = new Set([
    ...[...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ]);
  const used = [...new Set([...appJs.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

ok('index.html 保留四个构建占位符且无绝对外链', () => {
  for (const token of ['__TITLE__', '__STYLE__', '__APP__', '__MANIFEST__']) {
    assert.ok(html.includes(token), `缺少占位符 ${token}`);
  }
  assert.ok(!html.includes('http://') && !html.includes('https://'));
});

ok('style.css 含深浅章节、Apple 风格 token、降级与 reduced-motion', () => {
  for (const token of ['.section--dark', 'backdrop-filter', '--accent', '.justified',
    'is-fallback', 'prefers-reduced-motion', ':focus-visible']) {
    assert.ok(css.includes(token), `缺少 ${token}`);
  }
});

await okAsync('dist 产物无 http:// 引用', async () => {
  const files = [
    path.join(DIST, 'index.html'),
    ...(await readdir(path.join(DIST, 'assets'))).map((f) => path.join(DIST, 'assets', f)),
    ...(await readdir(path.join(DIST, 'data'))).map((f) => path.join(DIST, 'data', f)),
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
});

const report = JSON.parse(await readFile(path.join(DIST, '.build-report.json'), 'utf8'));
ok('构建报告 invalidation 初始为 null', () => {
  assert.equal(report.invalidation, null);
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

const bucketPolicy = JSON.parse(await readFile(path.join(ROOT, 'src/deploy/bucket-policy.json'), 'utf8'));
const iamPolicy = JSON.parse(await readFile(path.join(ROOT, 'src/deploy/iam-policy.json'), 'utf8'));

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

console.log(`--- 全部通过：${checks} 项断言 ---`);
