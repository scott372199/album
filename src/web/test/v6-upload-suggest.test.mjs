import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_SUGGESTED_TAGS, MIN_SUGGESTED_TAGS,
  fileClock, dominantMonth, albumPattern, suggestAlbum, suggestTags,
  buildSuggestion, suggestionNote,
} from '../js/upload-suggest.js';

/**
 * V6 T-27 上传归位建议。
 *
 * 判据里有一条是数字（12 张 → 1 个相册名 + ≥3 个标签，≤300 ms），一条是
 * 行为（忽略后流程与现状一致），一条是纪律（S3 无新增对象）。
 *
 * 最后一条在这里是用**源码检查**落实的：这个模块里不许出现任何网络调用。
 * 建议只是把值填进输入框，一旦它自己会发请求，「纯内存」就成了空话。
 *
 * Three criteria: 12 files must yield one album name and at least three tags in
 * under 300 ms, ignoring must leave the flow untouched, and the module must not
 * touch the network at all — checked by reading its own source.
 */

/** 一批 12 个文件，mtime 都在 2026-11-14（UTC+8 的下午） */
function batch(count = 12, iso = '2026-11-14T06:30:00Z') {
  const base = Date.parse(iso);
  return Array.from({ length: count }, (_, i) => ({
    name: `IMG_${1000 + i}.jpg`,
    lastModified: base + i * 60_000,
  }));
}

const albums = [{ name: '2026' }, { name: '2025' }, { name: '海边' }];

const items = [
  { id: 'p1', year: 2026, month: 11, labels: [
    { term: 'shirt', zh: '衬衫', kind: 'object' },
    { term: 'car', zh: '汽车', kind: 'object' },
    { term: 'person', zh: 'person', kind: 'object' },
  ] },
  { id: 'p2', year: 2026, month: 11, labels: [
    { term: 'shirt', zh: '衬衫', kind: 'object' },
    { term: 'lake', zh: '湖水', kind: 'scene' },
  ] },
  { id: 'p3', year: 2026, month: 9, labels: [
    { term: 'bus', zh: '公交车', kind: 'object' },
    { term: 'red', zh: '红色', kind: 'color' },
  ] },
];

test('fileClock：认不出就是 null，不拿 now() 冒充', () => {
  assert.equal(fileClock({ lastModified: 1000 }), 1000);
  for (const value of [undefined, null, {}, { lastModified: 0 }, { lastModified: -1 }, { lastModified: 'x' }]) {
    assert.equal(fileClock(value), null);
  }
});

test('dominantMonth：取文件数最多的那个月', () => {
  const files = [
    ...batch(3, '2026-11-14T06:30:00Z'),
    ...batch(1, '2026-09-02T06:30:00Z'),
  ];
  const month = dominantMonth(files);
  assert.equal(month.year, 2026);
  assert.equal(month.month, 11);
  assert.equal(month.count, 3);
});

test('dominantMonth：按 UTC+8 换算，月初清晨不会掉进上个月', () => {
  // 2026-10-31T20:00Z = 2026-11-01 04:00 (UTC+8)
  const month = dominantMonth([{ lastModified: Date.parse('2026-10-31T20:00:00Z') }]);
  assert.equal(month.month, 11);
});

test('dominantMonth：一个文件时间都没有就返回 null', () => {
  assert.equal(dominantMonth([{ name: 'a.jpg' }]), null);
  assert.equal(dominantMonth([]), null);
});

test('albumPattern：认得出既有的命名写法', () => {
  assert.equal(albumPattern(['2026', '2025']).id, 'year');
  assert.equal(albumPattern(['2026-11', '2026-09']).id, 'year-month-dash');
  assert.equal(albumPattern(['2026 年', '2025 年']).id, 'year-cn');
  assert.equal(albumPattern(['2026 年 11 月']).id, 'year-month-cn');
  assert.equal(albumPattern(['海边', '山里']), null);
});

test('suggestAlbum：有现成相册就复用，不另造一个', () => {
  const album = suggestAlbum({ month: { year: 2026, month: 11 }, albums: ['2026', '海边'] });
  assert.equal(album.name, '2026');
  assert.equal(album.reason, 'reuse-existing');
  assert.equal(album.exists, true);
});

test('suggestAlbum：按既有命名习惯造名字', () => {
  const album = suggestAlbum({ month: { year: 2026, month: 11 }, albums: ['2024 年 3 月', '2024 年 4 月'] });
  assert.equal(album.name, '2026 年 11 月');
  assert.equal(album.reason, 'pattern:year-month-cn');
});

test('suggestAlbum：没有任何命名线索时退回年份（就是原来的默认值）', () => {
  const album = suggestAlbum({ month: { year: 2026, month: 11 }, albums: ['海边'] });
  assert.equal(album.name, '2026');
  assert.match(album.reason, /year/, '没有线索时退回年份，也就是原来的默认值');
});

test('suggestTags：同月够三个就只用同月的', () => {
  const tags = suggestTags({ month: { year: 2026, month: 11 }, items, albumName: '2026' });
  const names = tags.map((tag) => tag.zh);
  assert.equal(names[0], '衬衫');
  assert.ok(names.includes('汽车'));
  assert.ok(names.includes('湖水'));
  assert.ok(!names.includes('公交车'), '同月已经有三个，不该扯到 9 月的标签');
  assert.ok(tags.length >= MIN_SUGGESTED_TAGS);
});

test('suggestTags：同月不够三个，放宽到同年补齐', () => {
  // 同月只有「衬衫」一个，9 月还有公交车 → 补进来
  const sparse = items.filter((item) => item.month !== 11 || item.id === 'p1');
  const names = suggestTags({ month: { year: 2026, month: 11 }, items: sparse, albumName: '2026' })
    .map((tag) => tag.zh);
  assert.ok(names.includes('衬衫'));
  assert.ok(names.includes('汽车'));
  assert.ok(names.includes('公交车'), '同月不足三个要放宽到同年');
  assert.ok(names.length >= MIN_SUGGESTED_TAGS);
});

test('suggestTags：只收中文、颜色不进标签位、相册名与年份重复的不给', () => {
  const tags = suggestTags({ month: { year: 2026, month: 11 }, items, albumName: '衬衫' });
  const names = tags.map((tag) => tag.zh);
  assert.ok(!names.includes('person'), '未翻译的词不该出现');
  assert.ok(!names.includes('红色'), '颜色不算标签');
  assert.ok(!names.includes('衬衫'), '相册名已经是一个标签，不重复建议');
  assert.ok(!names.includes('2026'), '年份也会成为标签，不再建议一次');
});

test('suggestTags：上限 5 个', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `x${i}`, year: 2026, month: 11,
    labels: [{ term: `t${i}`, zh: `词${i}`, kind: 'object' }],
  }));
  assert.equal(suggestTags({ month: { year: 2026, month: 11 }, items: many }).length, MAX_SUGGESTED_TAGS);
});

test('12 张 → 1 个相册名 + ≥3 个标签，且 ≤300 ms', () => {
  // 把索引撑到 2000 条，模拟真实库规模；计时不看单次偶然值，取 5 次的平均
  const big = [];
  for (let i = 0; i < 2000; i += 1) {
    big.push({
      id: `b${i}`,
      year: 2026,
      month: 1 + (i % 12),
      labels: [
        { term: 'shirt', zh: '衬衫', kind: 'object' },
        { term: `t${i % 40}`, zh: `词${i % 40}`, kind: 'object' },
      ],
    });
  }

  const files = batch(12);
  const started = performance.now();
  let suggestion;
  for (let round = 0; round < 5; round += 1) {
    suggestion = buildSuggestion({ files, albums, items: big });
  }
  const avg = (performance.now() - started) / 5;

  assert.ok(avg < 300, `12 张的建议耗时 ${avg.toFixed(1)} ms，应当 ≤300 ms`);
  assert.equal(typeof suggestion.album.name, 'string');
  assert.ok(suggestion.album.name.length > 0);
  assert.ok(suggestion.tags.length >= MIN_SUGGESTED_TAGS, '至少给出 3 个标签建议');
});

test('buildSuggestion：单张照片不给建议，别打扰', () => {
  assert.equal(buildSuggestion({ files: batch(1), albums, items }), null);
  assert.equal(buildSuggestion({ files: [], albums, items }), null);
});

test('buildSuggestion：文件没有可用时间就不猜', () => {
  assert.equal(buildSuggestion({ files: [{ name: 'a.jpg' }, { name: 'b.jpg' }], albums, items }), null);
});

test('buildSuggestion：相册名与标签都没新意时标成 weak，界面据此不打扰', () => {
  const suggestion = buildSuggestion({
    files: batch(12),
    albums: ['2026'],
    items: [{ id: 'z', year: 2026, month: 11, labels: [] }],
  });
  assert.equal(suggestion.weak, true);
});

test('建议说明只讲月，不讲日（不变量 6）', () => {
  const suggestion = buildSuggestion({ files: batch(12), albums, items });
  const note = suggestionNote(suggestion);
  assert.match(note, /2026 年 11 月/);
  assert.doesNotMatch(note, /11 月 1[0-9] 日|\d{4}-\d{2}-\d{2}/, '不能出现日级措辞');
});

test('纪律：这个模块不碰网络，也不写任何东西', () => {
  const source = readFileSync(new URL('../js/upload-suggest.js', import.meta.url), 'utf8');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'S3', 'presign', 'PUT']) {
    assert.ok(!source.includes(banned), `归位建议里不该出现 ${banned}`);
  }
  assert.doesNotMatch(source, /localStorage|sessionStorage/, '建议不该落任何本地状态');
});
