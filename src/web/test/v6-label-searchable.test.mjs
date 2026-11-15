import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeIndex, parseQuery, runSearch, deriveSuggestions } from '../js/search.js';
import { labelChips } from '../js/month-strip.js';

/**
 * 一条产品级不变量：**界面上每一块能点的词，点下去都必须有照片。**
 *
 * 起因是线上验收（2026-11-16）：灯箱底下的标签 chips 显示 `person`、`shorts`、
 * `grey`，点一下进到搜索态，页面上写着「shorts 还不在可搜范围里」。用户的诘问
 * 是对的：「如果搜索词没有关联的照片，那为什么要推荐出来让我点？」
 *
 * 根因不是建议算法，是**数据**：识别阶段把英文 term 原样写进 `zh`（线上 124/163
 * 条），而 chips 读的就是 `zh` 并拿它当查询词；`parseQuery` 当时只认中文键。
 *
 * 这里把三处一起钉住：
 *   1. `sanitizeIndex()` 会把英文 `zh` 归一成中文名（旧索引不必等重建）；
 *   2. 词表外的规范词（`interior design`）也能被拉丁词兜底直查；
 *   3. 于是「chips 里的每一个词」和「建议里的每一个词」都能搜到东西。
 *
 * One product-level invariant: every clickable word in the UI must lead to at
 * least one photo. The cause was data, not ranking: recognition wrote the English
 * term into `zh`, the chips read `zh` and searched with it, and the parser only
 * knew Chinese keys. All three layers are pinned here.
 */

/** 线上真实形状：zh 就是英文原文（person 33 条、grey 34 条、shorts 4 条…） */
const LABEL_POOL = [
  { term: 'person', zh: 'person', kind: 'object', confidence: 1 },
  { term: 'boy', zh: 'boy', kind: 'object', confidence: 0.97 },
  { term: 'head', zh: 'head', kind: 'object', confidence: 0.8 },
  { term: 'face', zh: 'face', kind: 'object', confidence: 0.7 },
  { term: 'grey', zh: 'grey', kind: 'color', confidence: 0.35 },
  { term: 'shorts', zh: 'shorts', kind: 'object', confidence: 0.72 },
  { term: 'furniture', zh: '家具', kind: 'object', confidence: 0.95 },
  // 词表里没有中文名的规范词：脏数据（`sneaker`）与多词规范词（`interior design`）
  { term: 'sneaker', zh: 'sneaker', kind: 'object', confidence: 0.6 },
  { term: 'interior design', zh: 'interior design', kind: 'scene', confidence: 0.5 },
];

const PHOTO_COUNT = 12;

const photos = Array.from({ length: PHOTO_COUNT }, (_, i) => ({
  id: `p${String(i).padStart(3, '0')}`,
  type: 'image',
  year: 2026,
  month: 1 + (i % 9),
  tags: ['2026'],
  ratio: 1.5,
}));

const rawIndex = {
  version: 'v5.1.0',
  rev: 'a'.repeat(64),
  vocabulary: {},
  items: photos.map((photo, i) => ({
    id: photo.id,
    year: photo.year,
    month: photo.month,
    tags: photo.tags,
    labels: [0, 1, 2].map((k) => LABEL_POOL[(i + k * 3) % LABEL_POOL.length]),
    colors: [],
    source: 'rekognition',
  })),
};

const index = sanitizeIndex(rawIndex);
const HAN = /[\u3400-\u9fff]/;

/** 用界面上那一串词去搜，返回命中数 */
const hitsOf = (word) => runSearch({
  index, parse: parseQuery(word), photos, query: word, pageSize: 50,
}).total;

/** 全部照片上的全部 chip 词（去重）——这就是用户能点到的那一批 */
function allChipWords() {
  const words = new Set();
  for (const item of index.items) {
    for (const chip of labelChips(item.labels)) words.add(chip.zh);
  }
  return [...words];
}

test('sanitizeIndex 把英文 zh 换成中文名（旧索引不必等重建）', () => {
  const byTerm = new Map();
  for (const item of index.items) {
    for (const label of item.labels) byTerm.set(label.term, label.zh);
  }
  assert.equal(byTerm.get('person'), '人物');
  assert.equal(byTerm.get('grey'), '灰色');
  assert.equal(byTerm.get('shorts'), '短裤');
  assert.equal(byTerm.get('boy'), '男孩');
  // 已经是中文的保持原样
  assert.equal(byTerm.get('furniture'), '家具');
});

test('词表里没有中文名的规范词，zh 就是规范词本身，且仍然能搜到', () => {
  const words = allChipWords();
  assert.ok(words.includes('sneaker'), '词表外规范词应原样出现在 chips 里');
  assert.ok(words.includes('interior design'), '多词规范词也应原样保留');
  assert.equal(hitsOf('sneaker'), index.items.filter(
    (item) => item.labels.some((l) => l.term === 'sneaker'),
  ).length);
});

test('每一块 chip 点下去都有照片（本次验收的核心要求）', () => {
  const words = allChipWords();
  assert.ok(words.length >= 8, `chips 数量异常：${words.join('、')}`);
  const dead = words.filter((word) => hitsOf(word) === 0);
  assert.deepEqual(dead, [], `这些 chip 点了没结果：${dead.join('、')}`);
});

test('chips 里不再出现纯英文（词表有中文名的都必须显示中文）', () => {
  const words = allChipWords();
  const known = new Set(LABEL_POOL.filter((l) => HAN.test(l.zh) || l.term !== l.zh).map((l) => l.term));
  const english = words.filter((word) => !HAN.test(word) && word !== 'sneaker' && word !== 'interior design');
  assert.deepEqual(english, [], `这些 chip 还是英文：${english.join('、')}`);
  assert.ok(known.size > 0);
});

test('建议词同样逐个可搜，且不再出现碎片词（头/脸）', () => {
  const suggestions = deriveSuggestions(index, { limit: 12 });
  assert.ok(suggestions.length > 0, '建议词不该为空');
  const dead = suggestions.filter((word) => hitsOf(word) === 0);
  assert.deepEqual(dead, [], `这些建议词点了没结果：${dead.join('、')}`);
  for (const fragment of ['头', '脸']) {
    assert.ok(!suggestions.includes(fragment), `「${fragment}」不该占建议位`);
  }
});

test('直接打英文也能搜到：规范词按字面直查', () => {
  assert.deepEqual(parseQuery('shorts').terms, ['shorts']);
  assert.deepEqual(parseQuery('person').unmatched, [], '英文规范词不该被报成没听懂');
  assert.equal(parseQuery('interior design').terms.length, 1, '多词规范词应算一个词');
  assert.equal(parseQuery('interior design').terms[0], 'interior design');
});

test('中文未知词仍然如实报成没听懂，不被兜底吞掉', () => {
  const parsed = parseQuery('大象');
  assert.deepEqual(parsed.terms, []);
  assert.deepEqual(parsed.unmatched, ['大象']);
});
