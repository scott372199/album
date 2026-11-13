import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEXICON, TERM_KIND, TERM_ZH, COLOR_TERMS, COLOR_OBJECT_COMBINATIONS,
  lookup, canonicalFor, zhForTerm, kindForTerm, expandSynonyms,
  resolveCombination, vocabularySnapshot,
} from '../search/vocabulary.mjs';
import {
  parseQuery, toQuery, validatePagination, EXPLANATION_KINDS, DEFAULT_PAGE_SIZE,
} from '../search/query.mjs';
import {
  INDEX_VERSION, ITEM_FIELDS, SOURCES, RANKING, EmbeddingPort,
  manifestPhotoIds, assertNoDuplicateIds, validateIndexItem, validateIndexItems,
  validateIndex, createIndex, mergeIndex, scoreItem, rankAndPage,
  projectResult, projectPublic, search,
} from '../search/index.mjs';
import {
  SEARCH_INDEX_KEY_PATTERN, SEARCH_INDEX_OWNER, assertSearchIndexKey,
  computeRev, indexObjectKey, createMemoryWriter, latestIndex, publishIndex, ownership,
} from '../search/publish.mjs';
import { isIndexUsable, fallbackSearch, runSearch } from '../search/fallback.mjs';
import { defaultManifest, defaultLabels, sha256 } from '../search/e2e.mjs';
import {
  CONTRACT, PUBLIC_FIELDS, FORBIDDEN_FIELDS, findForbidden, createMemoryLogger,
} from '../v5/correlation.mjs';

/**
 * V5 搜索链路测试：词表、查询解析、索引校验、排序、发布、降级。
 * 契约 v5-contracts.json 是白名单与示例的唯一来源。
 *
 * V5 search tests: vocabulary, query parsing, index validation, ranking,
 * publishing, fallback. The contract JSON is the single source for whitelists.
 */
const manifest = defaultManifest();
const item = (id, labels = [], extra = {}) => ({
  id,
  year: 2025,
  month: 7,
  tags: ['2025'],
  labels,
  colors: [],
  source: 'rekognition',
  ...extra,
});

/* ---------------- 词表 / Vocabulary ---------------- */

test('六个示例词都映射到规范 term', () => {
  const expected = {
    '湖水': 'lake', '山峰': 'mountain', '蓝天': 'blue sky',
    '汽车': 'car', '摩托车': 'motorcycle', '衬衫': 'shirt',
  };
  for (const [phrase, canonical] of Object.entries(expected)) {
    assert.equal(canonicalFor(phrase), canonical);
    assert.equal(lookup(phrase).canonical, canonical);
    assert.equal(zhForTerm(canonical), TERM_ZH[canonical]);
  }
  assert.ok(COLOR_TERMS.has('red'));
});

test('同义词映射与 TERM_KIND 分类', () => {
  for (const [phrase, canonical] of Object.entries({
    '湖泊': 'lake', '群山': 'mountain', '机车': 'motorcycle', '轿车': 'car', '衬衣': 'shirt',
  })) {
    assert.equal(canonicalFor(phrase), canonical);
    assert.equal(lookup(phrase).kind, 'synonym');
  }
  assert.equal(TERM_KIND.lake, 'scene');
  assert.equal(TERM_KIND.car, 'object');
  assert.equal(kindForTerm('red'), 'color');
  assert.ok(expandSynonyms('lake').includes('湖泊'));
});

test('颜色+物体组合「红色衬衫」被显式登记并可解析', () => {
  const combo = resolveCombination('红色衬衫');
  assert.ok(combo);
  assert.equal(combo.color, 'red');
  assert.equal(combo.term, 'shirt');
  assert.ok(COLOR_OBJECT_COMBINATIONS.some((c) => c.phrase === '红色衬衫'));
  const parse = parseQuery('红色衬衫');
  assert.deepEqual(parse.filters.colors, ['red']);
  assert.deepEqual(parse.terms, ['shirt']);
  assert.deepEqual(parse.explanation.map((e) => e.kind), ['color', 'term']);
});

test('vocabularySnapshot 符合契约 shape：中文词 → [规范词, 同义词...]', () => {
  const snapshot = vocabularySnapshot();
  assert.equal(snapshot['湖水'][0], 'lake');
  assert.ok(snapshot['湖水'].includes('湖泊'));
  for (const [, value] of Object.entries(snapshot)) {
    assert.ok(Array.isArray(value) && value.length >= 1);
    assert.ok(value.every((v) => typeof v === 'string'));
  }
  assert.deepEqual(Object.keys(LEXICON).length > 20, true);
});

/* ---------------- 查询解析 / Query parsing ---------------- */

test('六个示例查询都产出合法 explanation，涵盖 term/synonym/year/month/color', () => {
  for (const example of CONTRACT.queryContract.examples) {
    const parse = parseQuery(example);
    assert.equal(parse.page, 1);
    assert.equal(parse.pageSize, DEFAULT_PAGE_SIZE);
    for (const entry of parse.explanation) {
      assert.ok(EXPLANATION_KINDS.includes(entry.kind), `${example} -> ${entry.kind}`);
      assert.ok(entry.input.length > 0 && entry.mappedTo.length > 0);
    }
  }
});

test('2025 年解析成年份；年份组合与年月组合正确', () => {
  assert.equal(parseQuery('2025 年').filters.year, 2025);
  assert.deepEqual(parseQuery('2025 年').terms, []);
  const combo = parseQuery('2025 年的蓝天和汽车');
  assert.equal(combo.filters.year, 2025);
  assert.deepEqual(combo.terms, ['blue sky', 'car']);
  assert.deepEqual(combo.explanation.map((e) => e.kind), ['year', 'term', 'term']);
  const month = parseQuery('2025 年 7 月的湖水');
  assert.equal(month.filters.year, 2025);
  assert.equal(month.filters.month, 7);
  assert.deepEqual(month.terms, ['lake']);
});

test('非法年月被忽略，分页参数越界回退到安全默认', () => {
  assert.equal(parseQuery('99 月').filters.month, null);
  assert.equal(parseQuery('999 年').filters.year, null);
  assert.deepEqual(validatePagination(0, 0), { page: 1, pageSize: 40 });
  assert.deepEqual(validatePagination(2, 101), { page: 2, pageSize: 40 });
  assert.deepEqual(validatePagination(3, 50), { page: 3, pageSize: 50 });
});

test('toQuery 符合契约 search.query 形状，filters 不含 colors', () => {
  const raw = '2025 年的蓝天和汽车';
  const query = toQuery(parseQuery(raw), raw);
  assert.deepEqual(Object.keys(query).sort(), ['filters', 'page', 'pageSize', 'query']);
  assert.equal(query.query, raw);
  assert.equal(query.filters.year, 2025);
  assert.ok(!('colors' in query.filters), '契约 query.filters 不含 colors');
  assert.ok(query.pageSize >= 1 && query.pageSize <= 100);
});

/* ---------------- 索引校验 / Index validation ---------------- */

test('createIndex 以 manifest 为骨架，识别结果只补 labels/colors/source', () => {
  const index = createIndex({
    manifest,
    items: [{
      id: 'a1b2c3d4e5f6',
      labels: [{ term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.9 }],
      colors: ['red'],
      source: 'rekognition',
    }],
  });
  assert.equal(index.version, INDEX_VERSION);
  assert.equal(index.items.length, manifest.photos.length);
  const first = index.items.find((it) => it.id === 'a1b2c3d4e5f6');
  assert.equal(first.year, 2025, 'year 来自 manifest');
  assert.equal(first.labels[0].term, 'lake');
  const others = index.items.filter((it) => it.id !== 'a1b2c3d4e5f6');
  assert.ok(others.every((it) => it.source === 'manifest'), '未识别照片保留基础条目');
  assert.deepEqual(Object.keys(first).sort(), [...ITEM_FIELDS].sort());
});

test('重复 id、manifest 之外的 id、非单 float 置信度、禁止字段全部拒绝', () => {
  assert.throws(() => createIndex({ manifest, items: [item('a1b2c3d4e5f6'), item('a1b2c3d4e5f6')] }), /duplicate/);
  assert.throws(() => createIndex({ manifest, items: [item('deadbeefdead')] }), /manifest/);
  assert.throws(() => createIndex({
    manifest,
    items: [item('a1b2c3d4e5f6', [{ term: 'x', zh: 'x', kind: 'scene', confidence: '0.9' }])],
  }), /confidence/);
  assert.throws(() => createIndex({
    manifest,
    items: [item('a1b2c3d4e5f6', [{ term: 'x', zh: 'x', kind: 'scene', confidence: [0.9] }])],
  }), /confidence/);
  assert.throws(() => validateIndexItem({ id: 'a1b2c3d4e5f6', gps: 'leak' }), /invalid index item field/);
  assert.throws(() => validateIndexItem({ id: 'a1b2c3d4e5f6', sourcePath: 'leak' }), /invalid index item field/);
  assert.throws(() => validateIndexItem({ id: 'a1b2c3d4e5f6', source: 'bogus' }), /source/);
  assert.throws(() => assertNoDuplicateIds([{ id: 'a' }, { id: 'a' }]), /duplicate/);
  assert.ok(SOURCES.includes('manifest'));
  assert.equal(manifestPhotoIds(manifest).size, 4);
});

test('mergeIndex 同 id 覆盖（幂等 upsert），但数组内重复 id 拒绝', () => {
  const base = createIndex({ manifest });
  const merged = mergeIndex(base, [{
    id: 'a1b2c3d4e5f6',
    labels: [{ term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.9 }],
    colors: ['red'],
    source: 'rekognition',
  }], manifest);
  const first = merged.items.find((it) => it.id === 'a1b2c3d4e5f6');
  assert.equal(first.labels[0].term, 'lake');
  assert.equal(first.year, 2025, '未覆盖的字段来自 base');
  assert.equal(merged.items.length, 4);
  assert.throws(() => mergeIndex(base, [item('x'), item('x')], manifest), /duplicate/);
  assert.deepEqual(validateIndex(createIndex({ manifest }), manifest).items.length, 4);
  assert.throws(() => validateIndex({ version: 'v0', items: [] }, manifest), /version/);
  assert.throws(() => validateIndexItems('nope', manifest), /must be an array/);
});

test('确定性排序：命中数 desc → 置信度和 desc → year desc → id asc', () => {
  assert.equal(RANKING, 'match count desc, confidence sum desc, year desc, id asc');
  const scored = [
    { item: { id: 'b', year: 2024 }, matchCount: 1, confidenceSum: 0.5 },
    { item: { id: 'a', year: 2025 }, matchCount: 2, confidenceSum: 0.4 },
    { item: { id: 'c', year: 2025 }, matchCount: 1, confidenceSum: 0.9 },
  ];
  assert.deepEqual(rankAndPage(scored, 1, 10).ordered.map((e) => e.item.id), ['a', 'c', 'b']);
  const tie = [
    { item: { id: 'z', year: 2024 }, matchCount: 1, confidenceSum: 0.5 },
    { item: { id: 'a', year: 2025 }, matchCount: 1, confidenceSum: 0.5 },
    { item: { id: 'm', year: 2025 }, matchCount: 1, confidenceSum: 0.5 },
  ];
  assert.deepEqual(rankAndPage(tie, 1, 10).ordered.map((e) => e.item.id), ['a', 'm', 'z']);
  assert.equal(rankAndPage(scored, 2, 1).pageItems[0].item.id, 'c');
});

test('scoreItem：时间/颜色不匹配返回 null，命中数含语义词', () => {
  const row = item('a1b2c3d4e5f6', [
    { term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.9 },
    { term: 'red', zh: '红色', kind: 'color', confidence: 0.7 },
  ], { colors: ['red'], year: 2025, month: 7 });
  assert.equal(scoreItem(row, parseQuery('2026 年')), null);
  assert.equal(scoreItem(row, parseQuery('蓝色衬衫')), null);
  const score = scoreItem(row, parseQuery('湖水 红色衬衫'));
  assert.ok(score && score.matchCount >= 2);
});

test('结果只含 publicFields；projectPublic 也只含白名单且无禁止字段', () => {
  const photo = manifest.photos[0];
  const result = projectResult(photo, item(photo.id), { matchCount: 2, conditionCount: 3 });
  for (const key of Object.keys(result)) assert.ok(PUBLIC_FIELDS.includes(key), `${key}`);
  assert.ok(result.paths.grid.startsWith('photos/'));
  assert.ok(result.score > 0 && result.score <= 1);
  assert.deepEqual(findForbidden(result), []);

  const projected = projectPublic({
    ...photo, gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak',
  }, { score: 0.8, explanation: [], colors: ['red'], labels: [] });
  for (const key of Object.keys(projected)) assert.ok(PUBLIC_FIELDS.includes(key));
  assert.deepEqual(findForbidden(projected), []);
  assert.ok(!('gps' in projected));
  assert.deepEqual([...PUBLIC_FIELDS].sort(), [...CONTRACT.publicFields].sort());
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), [...CONTRACT.forbiddenFields].sort());
});

test('EmbeddingPort 是占位，embed 不实现', async () => {
  await assert.rejects(() => new EmbeddingPort().embed(), /not implemented/);
});

/* ---------------- 发布 / Publish ---------------- */

test('rev = 内容 sha256，确定性且随内容变化', () => {
  const built = createIndex({ manifest });
  const rev = computeRev(built);
  assert.match(rev, /^[0-9a-f]{64}$/);
  assert.equal(computeRev(createIndex({ manifest })), rev);
  const changed = createIndex({
    manifest, items: [{ id: 'a1b2c3d4e5f6', labels: [], colors: [], source: 'rekognition' }],
  });
  assert.notEqual(computeRev(changed), rev);
  assert.equal(indexObjectKey(rev), `data/search-index.${rev}.json`);
  assert.throws(() => indexObjectKey('../evil'));
});

test('assertSearchIndexKey 只放行唯一写前缀，拒绝路径注入', () => {
  const rev = computeRev(createIndex({ manifest }));
  assert.equal(assertSearchIndexKey(`data/search-index.${rev}.json`), `data/search-index.${rev}.json`);
  for (const key of ['data/version.json', 'data/manifest.json', 'data/search-index.abc.json',
    'data/search-index.evil/../x.json', 'incoming/a.jpg']) {
    assert.throws(() => assertSearchIndexKey(key));
  }
  assert.ok(SEARCH_INDEX_KEY_PATTERN.test(`data/search-index.${rev}.json`));
  assert.equal(SEARCH_INDEX_OWNER, 'album-search-publisher');
  assert.equal(ownership().writer, 'album-search-publisher');
  assert.equal(ownership().canDelete, false);
});

test('publishIndex 只写一次对象，body 符合契约 shape 且无禁止字段', async () => {
  const writer = createMemoryWriter();
  const index = createIndex({ manifest });
  const logger = createMemoryLogger();
  const published = await publishIndex({
    index, manifest, writer, logger, correlationId: 'corr_0123456789abcdef',
  });
  assert.equal(writer.puts.length, 1);
  assert.equal(published.key, writer.puts[0].key);
  assert.match(published.key, SEARCH_INDEX_KEY_PATTERN);
  const body = JSON.parse(writer.puts[0].body);
  assert.equal(body.version, INDEX_VERSION);
  assert.equal(body.rev, published.rev);
  assert.ok(Array.isArray(body.items) && typeof body.vocabulary === 'object');
  assert.deepEqual(findForbidden(body), []);
  assert.equal(latestIndex(writer).rev, published.rev);
  assert.ok(logger.events.some((e) => e.event === 'index.published' && e.stage === 'index'));
  assert.ok(!writer.puts[0].body.includes('rawModelResponse'));
  assert.equal(sha256(published.rev).length, 64);
});

/* ---------------- 降级 / Fallback ---------------- */

test('isIndexUsable：缺 items / 版本过期 / rev 过期都判不可用', () => {
  assert.equal(isIndexUsable(null), false);
  assert.equal(isIndexUsable({}, { version: INDEX_VERSION }), false);
  assert.equal(isIndexUsable({ version: 'v0', items: [] }, { version: INDEX_VERSION }), false);
  assert.equal(isIndexUsable({ version: INDEX_VERSION, rev: 'old', items: [] }, { version: INDEX_VERSION, rev: 'new' }), false);
  assert.equal(isIndexUsable({ version: INDEX_VERSION, items: [] }, { version: INDEX_VERSION }), true);
});

test('索引不可用时降级为 manifest 年份/月份/标签基础筛选', () => {
  const parse = parseQuery('2025 年的蓝天');
  const result = fallbackSearch(parse, manifest, { page: 1, pageSize: 10 });
  assert.deepEqual(result.items.map((p) => p.id), ['a1b2c3d4e5f6']);
  const bare = fallbackSearch(parseQuery('2025 年'), manifest, { page: 1, pageSize: 10 });
  assert.equal(bare.total, 3);
  for (const p of bare.items) for (const k of Object.keys(p)) assert.ok(PUBLIC_FIELDS.includes(k));
});

test('runSearch 编排：索引可用走索引，否则标记 degraded', () => {
  const index = createIndex({ manifest, items: defaultLabelsToItems() });
  const parse = parseQuery('湖水');
  const withIndex = runSearch({ index, parse, manifest, indexOptions: { version: INDEX_VERSION } });
  assert.equal(withIndex.fromIndex, true);
  assert.equal(withIndex.degraded, false);
  assert.ok(withIndex.result.total > 0);
  const without = runSearch({ index: null, parse, manifest, indexOptions: { version: INDEX_VERSION } });
  assert.equal(without.fromIndex, false);
  assert.equal(without.degraded, true);
  assert.ok(Array.isArray(without.explanation));
  assert.equal(search(index, parseQuery('2026 年'), manifest).total, 0);
});

function defaultLabelsToItems() {
  return [...defaultLabels().entries()].map(([id, labels]) => ({
    id,
    labels,
    colors: labels.filter((l) => l.kind === 'color').map((l) => l.term),
    source: 'rekognition',
  }));
}
