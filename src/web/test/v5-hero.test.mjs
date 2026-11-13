import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HERO_SECTION_FIELDS, HERO_MAX_SECTIONS, AUTO_MAX_SECTIONS,
  normalizeHeroSections, autoHeroSections, buildHeroSections,
  preloadPlan, srcsetForSection, detectLowPower, viewTransitionsSupported,
  motionProfile,
} from '../js/hero.js';

/**
 * V5 hero 注册表的纯逻辑断言：上限、字段白名单、未知照片回退、自动生成、
 * 预加载计划、动效降级与能力探测。夹具只用无意义的占位 id 与相对路径。
 *
 * Pure assertions for the V5 hero registry: cap, field whitelist, unknown-photo
 * fallback, auto-generation, preload plan, motion fallback and capability
 * probes. Fixtures use only meaningless placeholder ids and relative paths.
 */

const photo = (id, ratio = 1.5) => ({ id, ratio, title: '', grid: `${id}/grid.webp`, view: `${id}/view.webp` });
const manifestWith = (heroSections, photos = [photo('aaa'), photo('bbb', 0.8)]) => ({
  site: { title: '测试相册', subtitle: '' },
  hero: photos[0]?.id || '',
  photos,
  heroSections,
});

test('hero 配置最多 8 个 section（超出截断）', () => {
  const raw = Array.from({ length: 11 }, (_, i) => ({
    photo: `p${i}`, title: `章节 ${i}`, eyebrow: 'E', subtitle: 'S', cta: '看', target: '#catalog', duration: 5000,
  }));
  const sections = buildHeroSections(manifestWith(raw, raw.map((r) => photo(r.photo))));
  assert.equal(sections.length, HERO_MAX_SECTIONS);
  assert.equal(sections.length, 8);
});

test('heroSections 遵守字段白名单，禁止字段与多余键都被丢弃', () => {
  const byId = new Map([['aaa', photo('aaa')]]);
  const sections = normalizeHeroSections([
    {
      photo: 'aaa', eyebrow: 'E', title: 'T', subtitle: 'S', cta: '看', target: '#catalog', duration: 99999,
      gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak', rawExif: 'leak',
    },
  ], byId, { fallbackId: 'aaa' });
  assert.equal(sections.length, 1);
  const keys = Object.keys(sections[0]).sort();
  assert.deepEqual(keys, [...HERO_SECTION_FIELDS].sort());
  for (const forbidden of ['gps', 'deviceSerial', 'originalFilename', 'rawExif']) {
    assert.ok(!(forbidden in sections[0]), `${forbidden} 不应进入 section`);
  }
  assert.equal(sections[0].duration, 20000, 'duration 应夹到上限');
});

test('target 只接受 #锚点，外部地址与绝对路径被忽略', () => {
  const byId = new Map([['aaa', photo('aaa')]]);
  const [section] = normalizeHeroSections([
    { photo: 'aaa', title: 'T', target: 'https://example.invalid/path' },
  ], byId, { fallbackId: 'aaa' });
  assert.ok(!('target' in section));
  const [okSection] = normalizeHeroSections([
    { photo: 'aaa', title: 'T', target: '#catalog' },
  ], byId, { fallbackId: 'aaa' });
  assert.equal(okSection.target, '#catalog');
});

test('未知照片回退到 fallback（首张横图）', () => {
  const byId = new Map([['aaa', photo('aaa', 1.6)], ['bbb', photo('bbb', 0.8)]]);
  const sections = normalizeHeroSections([
    { photo: 'ghost', title: '幽灵' },
    { photo: 'aaa', title: '正常' },
  ], byId, { fallbackId: 'aaa' });
  assert.equal(sections[0].photo, 'aaa');
  assert.equal(sections[1].photo, 'aaa');
});

test('无配置时从 manifest 自动生成最多 3 个 section', () => {
  const many = Array.from({ length: 9 }, (_, i) => photo(`p${i}`, i % 2 ? 0.8 : 1.5));
  const sections = buildHeroSections({ site: { title: 'T' }, hero: 'p0', photos: many, heroSections: [] });
  assert.equal(sections.length, AUTO_MAX_SECTIONS);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].photo, 'p0', '优先用 manifest.hero');
  // 自动生成的文案是自有中文，且字段都在白名单内
  for (const section of sections) {
    for (const key of Object.keys(section)) {
      assert.ok(HERO_SECTION_FIELDS.includes(key), `多余字段 ${key}`);
    }
  }
});

test('照片不足时按实际数量生成，空 manifest 返回空', () => {
  const two = [photo('x'), photo('y')];
  assert.equal(autoHeroSections({ site: {}, photos: two }).length, 2);
  assert.deepEqual(autoHeroSections({ site: {}, photos: [] }), []);
  assert.deepEqual(buildHeroSections({ site: {}, photos: [], heroSections: [] }), []);
});

test('预加载计划只含当前与下一张', () => {
  const sections = ['a', 'b', 'c'];
  assert.deepEqual(preloadPlan(sections, 0), [0, 1]);
  assert.deepEqual(preloadPlan(sections, 2), [2, 0]);
  assert.deepEqual(preloadPlan(['only'], 0), [0]);
  assert.deepEqual(preloadPlan([], 0), []);
  assert.deepEqual(preloadPlan(sections, 99), [0, 1], '越界索引归一化');
});

test('srcset 复用现有 WebP 多档，不裁切', () => {
  const set = srcsetForSection(photo('a'));
  assert.ok(set.includes('a/grid.webp 768w'));
  assert.ok(set.includes('a/view.webp 2048w'));
  assert.equal(srcsetForSection(null), '');
});

test('低性能设备探测', () => {
  assert.equal(detectLowPower({ hardwareConcurrency: 2 }), true);
  assert.equal(detectLowPower({ deviceMemory: 1 }), true);
  assert.equal(detectLowPower({ connection: { saveData: true } }), true);
  assert.equal(detectLowPower({ hardwareConcurrency: 8, deviceMemory: 8 }), false);
  assert.equal(detectLowPower({}), false);
});

test('View Transitions 能力探测', () => {
  assert.equal(viewTransitionsSupported({ startViewTransition: () => {} }), true);
  assert.equal(viewTransitionsSupported({}), false);
  assert.equal(viewTransitionsSupported(null), false);
});

test('reduced-motion 与低性能 → 静态降级（不自动轮播、不隐藏内容）', () => {
  const reduced = motionProfile({ reducedMotion: true, lowPower: false, viewTransitions: true });
  assert.equal(reduced.staticFallback, true);
  assert.equal(reduced.animate, false);
  assert.equal(reduced.autoplay, false);
  assert.equal(reduced.reason, 'reduced-motion');

  const low = motionProfile({ reducedMotion: false, lowPower: true, viewTransitions: true });
  assert.equal(low.staticFallback, true);
  assert.equal(low.autoplay, false);

  // 不支持 View Transitions：不做动画过渡，但内容仍可见、仍可切换
  const noVT = motionProfile({ reducedMotion: false, lowPower: false, viewTransitions: false });
  assert.equal(noVT.animate, false);
  assert.equal(noVT.autoplay, true);
  assert.equal(noVT.reason, 'no-view-transitions');

  const full = motionProfile({ reducedMotion: false, lowPower: false, viewTransitions: true });
  assert.equal(full.animate, true);
  assert.equal(full.autoplay, true);
});
