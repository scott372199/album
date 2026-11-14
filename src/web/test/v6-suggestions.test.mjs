import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { INDEX_VERSION, deriveSuggestions, parseQuery, runSearch } from '../js/search.js';
import { TERM_ZH } from '../js/lexicon.generated.js';

/**
 * V6 T-07：建议词由索引派生，不写死示例列表。
 *
 * 这条要守住的是一句很朴素的话：**点了就一定有东西看**。
 * 旧实现硬编码了示例词，其中「摩托车」在这批照片里一张都没有——
 * 用户点一下得到空结果，会以为是自己不会用。
 *
 * A suggestion must lead somewhere. The old hardcoded list offered 摩托车,
 * which has zero photos in the corpus, so clicking it produced an empty result
 * and made the user think they were using search wrong.
 */

const photo = (id, year = 2026, month = 11) => ({
  id, type: 'image', album: String(year), year, month, tags: [String(year)],
  title: '', caption: '', ratio: 1.5, lqip: 'data:image/webp;base64,AAAA',
  featured: false, thumb: `photos/${id}/thumb.webp`, grid: `photos/${id}/grid.webp`,
  view: `photos/${id}/view.webp`,
});
const label = (term, kind = 'object', confidence = 0.9) => ({ term, zh: '', kind, confidence });
const item = (id, labels) => ({ id, year: 2026, month: 11, tags: ['2026'], labels, colors: [] });

const total = 100;
const photos = [];
const items = [];

// 每张都有 lake（覆盖率 100%），不该出现在建议里
for (let i = 0; i < total; i += 1) {
  const id = `p${String(i).padStart(3, '0')}`;
  photos.push(photo(id));
  const labels = [label('lake', 'scene')];
  // 20% 的照片有 car（落在 8%–60% 黄金区间）
  if (i < 20) labels.push(label('car'));
  // 2% 的照片有 spaceship（长尾）
  if (i < 2) labels.push(label('spaceship'));
  items.push(item(id, labels));
}

const index = { version: INDEX_VERSION, items };

test('只给出语料里真实出现、且有中文名的词', () => {
  const out = deriveSuggestions(index, { limit: 10 });
  assert.ok(out.includes(TERM_ZH.car), 'car 覆盖 20%，应入选');
  assert.ok(!out.includes(TERM_ZH.lake), 'lake 覆盖 100%，太泛，不该建议');

  // spaceship 不在词表里 → zh 缺失 → 不进建议（推荐一个搜不了的词没意义）
  for (const word of out) {
    assert.ok(Object.values(TERM_ZH).includes(word), `${word} 必须是已收录的中文名`);
  }
});

test('覆盖率落在黄金区间之外的词不参与，除非区间为空', () => {
  const banded = deriveSuggestions(index, { limit: 10 });
  assert.deepEqual(banded, [TERM_ZH.car], '只有 car 落在 8%–60%');

  // 全都不在区间内时退化为按频次排，而不是硬凑
  const flat = {
    version: INDEX_VERSION,
    items: items.map((it) => ({ ...it, labels: it.labels.filter((l) => l.term === 'lake') })),
  };
  const fallback = deriveSuggestions(flat, { limit: 3 });
  assert.deepEqual(fallback, [TERM_ZH.lake], '区间为空时退化为按频次给出');
});

test('已经在查询里的词不再建议', () => {
  const out = deriveSuggestions(index, { limit: 10, query: '汽车' });
  assert.deepEqual(parseQuery('汽车').terms, ['car']);
  assert.ok(!out.includes(TERM_ZH.car), '查询里已有的词应排除');
});

test('空索引不产出建议', () => {
  assert.deepEqual(deriveSuggestions(null), []);
  assert.deepEqual(deriveSuggestions({ items: [] }), []);
  assert.deepEqual(deriveSuggestions({ version: INDEX_VERSION, items: [] }), []);
});

/* ---------------- 核心不变量：点了就有东西看 ---------------- */

test('每条建议点进去都能搜到照片', () => {
  const out = deriveSuggestions(index, { limit: 10 });
  assert.ok(out.length > 0, '应至少给出一条建议');
  for (const word of out) {
    const r = runSearch({
      index, parse: parseQuery(word), photos, query: word, pageSize: 100,
    });
    assert.ok(r.total > 0, `建议「${word}」点进去是空的，等于骗用户`);
  }
});

/* ---------------- 真实语料回归 ---------------- */

const CORPUS = 'data/search-index.json';
test('真实语料：每条建议都非空，且不含零结果的词', { skip: !existsSync(CORPUS) }, () => {
  const raw = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const realPhotos = raw.items.map((i) => photo(i.id, i.year, i.month));
  const real = { version: INDEX_VERSION, items: raw.items };

  const out = deriveSuggestions(real, { limit: 12 });
  assert.ok(out.length >= 5, `建议数量过少：${out.length}`);

  for (const word of out) {
    const r = runSearch({
      index: real, parse: parseQuery(word), photos: realPhotos, query: word, pageSize: 100,
    });
    assert.ok(r.total > 0, `建议「${word}」在真实语料里是空的`);
  }

  // 旧硬编码列表里有「摩托车」，语料里 0 张 —— 派生池不得再出现这种词
  assert.ok(!out.includes('摩托车'), '不得再建议语料里不存在的词');
});
