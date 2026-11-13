import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SITE, HERO_MAX_SECTIONS, HERO_FIELD_WHITELIST,
  loadSite, parseHeroSections, resolveHeroSections,
} from '../../build/site.mjs';
import { buildManifest } from '../../build/manifest.mjs';

/**
 * V5 站点配置 / manifest 字段断言：heroSections 上限、字段白名单、未知照片
 * 回退、公开字段白名单与禁止字段不出现。契约是唯一机器可读来源。
 * 夹具只用无意义占位 id 与相对路径，不含手机号、令牌、密钥或绝对路径。
 *
 * V5 site-config / manifest assertions: heroSections cap, field whitelist,
 * unknown-photo fallback, public-field whitelist and forbidden-field absence.
 * The contract JSON is the single source of truth. Fixtures use placeholder
 * ids and relative paths only.
 */

const contract = JSON.parse(await readFile(
  new URL('../../../spec/v5/contracts/v5-contracts.json', import.meta.url), 'utf8',
));

const IMAGE_KEYS = [
  'id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'thumb', 'grid', 'view',
];

async function withSiteConfig(config, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'album-v5-site-'));
  const file = path.join(dir, 'site.json');
  await writeFile(file, JSON.stringify(config));
  try { return await fn(file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const minimal = (extra = {}) => ({
  entries: [],
  site: { title: '测试相册', subtitle: '', wall: {}, story: {} },
  overrides: new Map(),
  hero: '',
  featured: new Set(),
  ...extra,
});

/* ---------------- heroSections 解析 / Parsing ---------------- */

test('loadSite 无配置时 heroSections 缺省为空数组', async () => {
  await withSiteConfig({ title: '测试相册' }, async (file) => {
    const site = await loadSite(file, () => {});
    assert.deepEqual(site.heroSections, []);
    assert.deepEqual(DEFAULT_SITE.heroSections, []);
  });
});

test('heroSections 上限 8（超出截断并给出告警）', async () => {
  const raw = Array.from({ length: 11 }, (_, i) => ({
    photo: `p${i}`, eyebrow: 'E', title: `章节 ${i}`, subtitle: 'S',
    cta: '看', target: '#catalog', duration: 5000,
  }));
  await withSiteConfig({ heroSections: raw }, async (file) => {
    const warns = [];
    const site = await loadSite(file, (message) => warns.push(message));
    assert.equal(site.heroSections.length, HERO_MAX_SECTIONS);
    assert.equal(site.heroSections.length, 8);
    assert.ok(warns.some((message) => message.includes('8')));
  });
});

test('heroSections 遵守字段白名单，禁止字段与多余键被丢弃', async () => {
  await withSiteConfig({
    heroSections: [{
      photo: 'a', eyebrow: 'E', title: 'T', subtitle: 'S', cta: '看',
      target: '#catalog', duration: 4000,
      gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak', rawExif: 'leak',
    }],
  }, async (file) => {
    const site = await loadSite(file, () => {});
    const section = site.heroSections[0];
    for (const key of Object.keys(section)) {
      assert.ok(HERO_FIELD_WHITELIST.includes(key), `多余字段 ${key}`);
    }
    for (const forbidden of ['gps', 'deviceSerial', 'originalFilename', 'rawExif']) {
      assert.ok(!(forbidden in section));
    }
  });
});

test('parseHeroSections 夹取 duration、只留 #锚点、丢弃未知键', () => {
  const [section] = parseHeroSections([{
    photo: 'a', title: 'T', duration: 999999, target: 'not-an-anchor',
    extra: 'leak', originalFilename: 'leak',
  }], () => {});
  assert.equal(section.duration, 20000);
  assert.ok(!('target' in section));
  assert.ok(!('extra' in section));
  assert.ok(!('originalFilename' in section));
  assert.deepEqual(Object.keys(section).sort(), ['duration', 'photo', 'title']);
});

test('未知照片回退到首张横图，已知照片保留', () => {
  const photos = [
    { id: 'a', ratio: 0.8 }, { id: 'b', ratio: 1.6 }, { id: 'c', ratio: 1.4 },
  ];
  const out = resolveHeroSections([
    { photo: 'ghost', title: 'X' }, { photo: 'a', title: 'Y' },
  ], photos, () => {});
  assert.equal(out[0].photo, 'b');
  assert.equal(out[1].photo, 'a');
});

test('无 photos 时透传（web 目标由运行时对真实 manifest 再校验）', () => {
  const sections = [{ photo: 'ghost', title: 'X' }];
  assert.deepEqual(resolveHeroSections(sections, [], () => {}), sections);
});

/* ---------------- manifest schema / 公开字段 ---------------- */

test('buildManifest 顶层 heroSections 缺省 []，schema 与 v4 一致', () => {
  const manifest = buildManifest(minimal());
  assert.deepEqual(manifest.heroSections, []);
  for (const key of ['site', 'wall', 'story', 'hero', 'heroSections', 'photos', 'albums']) {
    assert.ok(key in manifest, `缺少顶层字段 ${key}`);
  }
  assert.deepEqual(manifest.photos, []);
  const withSections = buildManifest(minimal({ heroSections: [{ photo: 'a', title: 'T' }] }));
  assert.equal(withSections.heroSections.length, 1);
});

test('manifest 照片按类型遵守公开字段白名单', () => {
  const entry = {
    id: 'aaaaaaaaaaaa', type: 'image', album: '2025', year: 2025, month: 7,
    rel: 'placeholder.webp',
    assets: {
      thumb: 'photos/aaaaaaaaaaaa/thumb.webp',
      grid: 'photos/aaaaaaaaaaaa/grid.webp',
      view: 'photos/aaaaaaaaaaaa/view.webp',
      ratio: 1.5,
      lqip: 'data:image/webp;base64,AAAA',
    },
    meta: {},
    // 这些字段来自扫描阶段，绝不能进入公开产物
    gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak', srcPath: 'leak',
  };
  const manifest = buildManifest(minimal({ entries: [entry] }));
  assert.equal(manifest.photos.length, 1);
  assert.deepEqual(Object.keys(manifest.photos[0]).sort(), [...IMAGE_KEYS].sort());
});

test('公开产物中禁止字段不出现（含 heroSections 配置）', async () => {
  await withSiteConfig({
    title: '测试相册',
    heroSections: [{
      photo: 'aaaaaaaaaaaa', eyebrow: 'E', title: 'T', subtitle: 'S', cta: '看', target: '#catalog',
      gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak', rawExif: 'leak',
    }],
  }, async (file) => {
    const site = await loadSite(file, () => {});
    const manifest = buildManifest(minimal({
      site,
      heroSections: site.heroSections,
      entries: [{
        id: 'aaaaaaaaaaaa', type: 'image', album: '2025', year: 2025, month: 7,
        rel: 'placeholder.webp',
        assets: {
          thumb: 'photos/aaaaaaaaaaaa/thumb.webp', grid: 'photos/aaaaaaaaaaaa/grid.webp',
          view: 'photos/aaaaaaaaaaaa/view.webp', ratio: 1.5,
          lqip: 'data:image/webp;base64,AAAA',
        },
        meta: {},
      }],
    }));
    const text = JSON.stringify(manifest);
    for (const field of contract.forbiddenFields) {
      assert.ok(!text.includes(`"${field}"`), `公开产物出现禁止字段 ${field}`);
    }
    assert.equal(manifest.heroSections.length, 1);
    assert.equal(manifest.photos.length, 1);
    assert.equal(manifest.albums.length, 1);
    // 顶层结构稳定：type/year/month/ratio + photos/<id>/... 与 v4 一致
    assert.equal(manifest.photos[0].type, 'image');
    assert.equal(manifest.photos[0].year, 2025);
    assert.equal(manifest.photos[0].month, 7);
    assert.equal(manifest.photos[0].ratio, 1.5);
    assert.ok(manifest.photos[0].view.startsWith('photos/aaaaaaaaaaaa/'));
  });
});

test('契约的 publicFields / forbiddenFields 与前端常量一致', async () => {
  const { PUBLIC_FIELDS, FORBIDDEN_FIELDS } = await import('../../web/js/search.js');
  assert.deepEqual([...PUBLIC_FIELDS].sort(), [...contract.publicFields].sort());
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), [...contract.forbiddenFields].sort());
});
