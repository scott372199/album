import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  INDEX_VERSION, PUBLIC_FIELDS, FORBIDDEN_FIELDS,
  parseQuery, toQuery, indexUrl, isIndexUsable, sanitizeIndex,
  findForbidden, projectPublic, searchWithIndex, searchFallback, runSearch,
} from '../js/search.js';
import { suggestionsFor, yearChips, explainText, emptyText, statusText } from '../js/search-ui.js';
import {
  UPLOAD_STATES, STATE_LABELS, canTransition, isRetryable, labelFor,
  projectPublic as uploadProject, findUnsafe, safeFailure, createTracker,
} from '../js/upload-state.js';

/**
 * V5 搜索与状态测试。契约是唯一机器可读来源：白名单/禁止字段直接从
 * v5-contracts.json 读取比对。夹具不含手机号、令牌、密钥或绝对路径。
 *
 * V5 search and upload-state tests. The contract JSON is the single source of
 * truth for whitelists/forbidden fields. No phone, token, key or absolute path
 * appears in any fixture.
 */

const contract = JSON.parse(await readFile(
  new URL('../../../spec/v5/contracts/v5-contracts.json', import.meta.url), 'utf8',
));

const photo = (id, year = 2025, month = 7, extra = {}) => ({
  id, type: 'image', album: String(year), year, month,
  tags: [String(year)], title: '', caption: '', ratio: 1.5,
  grid: `${id}/grid.webp`, view: `${id}/view.webp`, thumb: `${id}/thumb.webp`, ...extra,
});

const item = (id, labels = [], extra = {}) => ({
  id, year: 2025, month: 7, tags: [], labels, colors: [], source: 'rekognition', ...extra,
});

/* ---------------- 查询解析 / Query parsing ---------------- */

test('六个示例词都解析成规范 term', () => {
  const expected = {
    '湖水': 'lake', '山峰': 'mountain', '蓝天': 'blue sky',
    '汽车': 'car', '摩托车': 'motorcycle', '衬衫': 'shirt',
  };
  for (const [input, canonical] of Object.entries(expected)) {
    const parse = parseQuery(input);
    assert.ok(parse.terms.includes(canonical), `${input} 未映射到 ${canonical}`);
  }
});

test('红色衬衫拆成颜色条件 + 物体词，且 explanation 可解释', () => {
  const parse = parseQuery('红色衬衫');
  assert.deepEqual(parse.filters.colors, ['red']);
  assert.deepEqual(parse.terms, ['shirt']);
  assert.deepEqual(parse.explanation.map((e) => e.kind), ['color', 'term']);
  for (const entry of parse.explanation) {
    assert.ok(['term', 'synonym', 'year', 'month', 'color'].includes(entry.kind));
    assert.equal(typeof entry.input, 'string');
    assert.equal(typeof entry.mappedTo, 'string');
  }
});

test('2025 年解析成年份条件', () => {
  const parse = parseQuery('2025 年');
  assert.equal(parse.filters.year, 2025);
  assert.equal(parse.filters.month, null);
  assert.deepEqual(parse.terms, []);
  assert.deepEqual(parse.explanation, [{ kind: 'year', input: '2025 年', mappedTo: '2025' }]);
});

test('年份组合：2025 年的蓝天和汽车', () => {
  const parse = parseQuery('2025 年的蓝天和汽车');
  assert.equal(parse.filters.year, 2025);
  assert.deepEqual(parse.terms, ['blue sky', 'car']);
  assert.deepEqual(parse.explanation.map((e) => e.kind), ['year', 'term', 'term']);
});

test('年月组合与合法范围', () => {
  const parse = parseQuery('2025 年 7 月的湖水');
  assert.equal(parse.filters.year, 2025);
  assert.equal(parse.filters.month, 7);
  assert.deepEqual(parse.terms, ['lake']);
  // 非法月份被忽略
  assert.equal(parseQuery('99 月').filters.month, null);
  assert.equal(parseQuery('999 年').filters.year, null);
});

test('同义词映射：湖泊 / 群山 / 机车 / 轿车', () => {
  for (const [input, canonical] of Object.entries({
    '湖泊': 'lake', '群山': 'mountain', '机车': 'motorcycle', '轿车': 'car',
  })) {
    const parse = parseQuery(input);
    assert.deepEqual(parse.terms, [canonical]);
    assert.equal(parse.explanation[0].kind, 'synonym');
  }
});

test('契约里的全部示例查询都能产出合法 explanation', () => {
  for (const example of contract.queryContract.examples) {
    const parse = parseQuery(example);
    assert.equal(parse.page, 1);
    assert.equal(parse.pageSize, 40);
    assert.ok(Array.isArray(parse.explanation));
    for (const entry of parse.explanation) {
      assert.ok(['term', 'synonym', 'year', 'month', 'color'].includes(entry.kind));
      assert.ok(entry.input.length > 0 && entry.mappedTo.length > 0);
    }
  }
});

test('toQuery 符合契约的 search.query 形状', () => {
  const raw = '2025 年的蓝天和汽车';
  const query = toQuery(parseQuery(raw), raw);
  assert.equal(query.query, raw);
  assert.equal(query.filters.year, 2025);
  assert.ok(Array.isArray(query.filters.tags));
  assert.ok(!('colors' in query.filters), '契约的 query.filters 不含 colors');
  assert.equal(query.page, 1);
  assert.ok(query.pageSize >= 1 && query.pageSize <= 100);
});

/* ---------------- 索引可用性 / Index availability ---------------- */

test('indexUrl 只接受十六进制 rev，否则回退固定名', () => {
  assert.equal(indexUrl('4e17b22b'), 'data/search-index.4e17b22b.json');
  assert.equal(indexUrl('../evil'), 'data/search-index.json');
  assert.equal(indexUrl(''), 'data/search-index.json');
});

test('索引缺失 / 版本过期 / rev 过期都判不可用', () => {
  assert.equal(isIndexUsable(null), false);
  assert.equal(isIndexUsable({}, { version: INDEX_VERSION }), false, '缺 items 数组');
  assert.equal(isIndexUsable({ version: 'v0', items: [] }, { version: INDEX_VERSION }), false, '版本过期');
  assert.equal(isIndexUsable({ version: INDEX_VERSION, rev: 'old', items: [] }, { version: INDEX_VERSION, rev: 'new' }), false, 'rev 过期');
  assert.equal(isIndexUsable({ version: INDEX_VERSION, rev: 'new', items: [] }, { version: INDEX_VERSION, rev: 'new' }), true);
  assert.equal(isIndexUsable({ version: INDEX_VERSION, items: [] }), true, '合法但为空的索引可用');
});

test('分页与确定性排序（匹配数 → 置信和 → 年份 → id）', () => {
  const index = {
    version: INDEX_VERSION,
    items: [
      item('a', [{ term: 'blue sky', zh: '蓝天', kind: 'scene', confidence: 0.9 }, { term: 'car', zh: '汽车', kind: 'object', confidence: 0.8 }]),
      item('b', [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.6 }], { year: 2025 }),
      item('c', [{ term: 'blue sky', zh: '蓝天', kind: 'scene', confidence: 0.5 }], { year: 2024 }),
    ],
  };
  const photos = [photo('a'), photo('b'), photo('c', 2024)];

  // 单词查询：a 与 b 都有 car，按置信和 0.8 > 0.6 排；c 没有，被淘汰
  const result = searchWithIndex(index, parseQuery('汽车'), photos, { page: 1, pageSize: 2 });
  assert.equal(result.fromIndex, true);
  assert.equal(result.degraded, false);
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(result.matched.map((p) => p.id), ['a', 'b']);
  // 结果是同一批 photo 对象引用，供现有渲染器复用
  assert.equal(result.items[0], photos[0]);
});

test('多词查询是「且」：只有一个条目同时命中两项', () => {
  // FR-03 的语义反例。旧实现返回并集 3 条（a、b、c），看起来合理却是错的。
  // AND semantics: only `a` carries both terms. The old union returned all 3.
  const index = {
    version: INDEX_VERSION,
    items: [
      item('a', [{ term: 'blue sky', zh: '蓝天', kind: 'scene', confidence: 0.9 }, { term: 'car', zh: '汽车', kind: 'object', confidence: 0.8 }]),
      item('b', [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.6 }], { year: 2025 }),
      item('c', [{ term: 'blue sky', zh: '蓝天', kind: 'scene', confidence: 0.5 }], { year: 2024 }),
    ],
  };
  const photos = [photo('a'), photo('b'), photo('c', 2024)];
  const result = searchWithIndex(index, parseQuery('蓝天和汽车'), photos, { page: 1, pageSize: 10 });
  assert.equal(result.total, 1);
  assert.deepEqual(result.matched.map((p) => p.id), ['a']);
});

test('索引不可用或过期时降级为 manifest 本地筛选', () => {
  const photos = [
    photo('a', 2025, 7, { tags: ['2025', '蓝天'] }),
    photo('b', 2025, 7, { tags: ['2025', '汽车'] }),
    photo('c', 2024, 3, { tags: ['2024'] }),
  ];
  for (const index of [null, { version: 'v0', items: [{ id: 'a' }] }]) {
    const result = runSearch({ index, parse: parseQuery('2025 年的蓝天'), photos, indexOptions: { version: INDEX_VERSION } });
    assert.equal(result.fromIndex, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.matched.map((p) => p.id), ['a']);
  }
  const bare = searchFallback(photos, parseQuery('2025 年'), { page: 1, pageSize: 10 });
  assert.deepEqual(bare.matched.map((p) => p.id), ['a', 'b']);
});

/* ---------------- 公开字段白名单 / Public fields ---------------- */

test('PUBLIC_FIELDS / FORBIDDEN_FIELDS 与契约逐字一致', () => {
  assert.deepEqual([...PUBLIC_FIELDS].sort(), [...contract.publicFields].sort());
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), [...contract.forbiddenFields].sort());
});

test('findForbidden 能递归找出禁止字段', () => {
  const dirty = { id: 'a', nested: { gps: 'leak', list: [{ token: 'leak' }] } };
  const found = findForbidden(dirty);
  assert.ok(found.some((path) => path.endsWith('gps')));
  assert.ok(found.some((path) => path.endsWith('token')));
});

test('公开投影只含白名单字段，禁止字段不出现', () => {
  const dirty = photo('a', 2025, 7, {
    gps: 'leak', deviceSerial: 'leak', originalFilename: 'leak', rawExif: 'leak',
  });
  const projected = projectPublic(dirty, { score: 0.8, explanation: [] });
  for (const key of Object.keys(projected)) {
    assert.ok(PUBLIC_FIELDS.includes(key), `${key} 不在公开白名单`);
  }
  assert.deepEqual(findForbidden(projected), []);
  assert.ok(!('thumb' in projected) && !('grid' in projected) && !('view' in projected),
    '内部三档路径不直接暴露，只以 paths 出现');
});

test('sanitizeIndex 丢弃禁止字段与重复 id', () => {
  const dirty = {
    version: INDEX_VERSION,
    items: [
      { id: 'a', year: 2025, month: 7, tags: [], labels: [], colors: [], gps: 'leak', originalKey: 'leak' },
      { id: 'a', year: 2025, month: 7, tags: [], labels: [], colors: [], token: 'leak' },
    ],
  };
  const clean = sanitizeIndex(dirty);
  assert.equal(clean.items.length, 1, '重复 id 被拒绝');
  assert.deepEqual(findForbidden(clean), []);
  assert.equal(clean.items[0].id, 'a');
});

/* ---------------- 搜索界面文案 / Search UI text ---------------- */

test('建议、时间 chip、解释、空结果与错误状态文案安全', () => {
  assert.ok(suggestionsFor('蓝').includes('蓝天'));
  assert.deepEqual(yearChips([2025, 2024]), [
    { label: '2025 年', query: '2025 年' }, { label: '2024 年', query: '2024 年' },
  ]);
  const text = explainText(parseQuery('2025 年的蓝天和汽车'));
  assert.ok(text.includes('2025 年') && text.includes('蓝天') && text.includes('汽车'));
  for (const status of ['loading', 'error', 'degraded']) {
    const message = statusText(status);
    assert.ok(message.length > 0);
    assert.ok(!message.includes('http://') && !message.includes('https://'), '失败信息不含外部地址');
    assert.ok(!/\b\d{3}\b/.test(message), '失败信息不含状态码');
  }
  assert.ok(emptyText(parseQuery('湖水'), true).includes('基础筛选'));
});

/* ---------------- 上传五态 / Upload five states ---------------- */

test('上传状态五态明确区分', () => {
  assert.deepEqual(UPLOAD_STATES, ['queued', 'uploading', 'processing', 'published', 'failed']);
  assert.equal(new Set(Object.values(STATE_LABELS)).size, 5, '五个状态文案互不相同');
  for (const state of UPLOAD_STATES) assert.equal(labelFor(state), STATE_LABELS[state]);
});

test('状态迁移合法，且只有 failed 可重试', () => {
  assert.equal(canTransition('queued', 'uploading'), true);
  assert.equal(canTransition('uploading', 'processing'), true);
  assert.equal(canTransition('processing', 'published'), true);
  assert.equal(canTransition('failed', 'queued'), true);
  assert.equal(canTransition('published', 'uploading'), false);
  assert.equal(canTransition('queued', 'published'), false);
  assert.equal(isRetryable('failed'), true);
  assert.equal(isRetryable('published'), false);
});

test('上传状态公开投影与失败文案不泄露凭据或实现细节', () => {
  const projected = uploadProject({ id: 'a', name: 'n', state: 'failed', phone: 'leak', token: 'leak', url: 'leak' });
  assert.deepEqual(Object.keys(projected).sort(), ['id', 'name', 'state']);
  assert.deepEqual(findUnsafe(projected), []);
  assert.ok(findUnsafe({ deep: { authorization: 'leak' } }).length > 0);
  for (const err of [{ retryable: false }, { retryable: true }, null]) {
    const message = safeFailure(err);
    assert.ok(message.length > 0);
    assert.ok(!message.includes('http://') && !message.includes('https://'));
    assert.ok(!message.includes('ETag') && !message.includes('status'));
  }
});

test('createTracker 汇总各状态并列出可重试项', () => {
  const tracker = createTracker();
  tracker.set('a', 'uploading');
  tracker.set('b', 'failed');
  tracker.set('c', 'published');
  assert.deepEqual(tracker.retryable(), ['b']);
  assert.equal(tracker.summarize().failed, 1);
  assert.equal(tracker.summarize().published, 1);
  assert.equal(tracker.get('b').state, 'failed');
});
