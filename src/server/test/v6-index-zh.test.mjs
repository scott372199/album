import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, LABEL_FIELDS, INDEX_VERSION, ITEM_FIELDS } from '../search/index.mjs';
import { TERM_ZH, zhForTerm } from '../search/vocabulary.mjs';
import { normalizeLabels } from '../recognition/provider.mjs';

/**
 * V6 C-3：中文名在**索引构建期**回填。
 *
 * 为什么要单独立一条：识别阶段只产出英文 term，中文名来自词表。若回填放在
 * 识别期，那么「补一个中文名」就得重跑 Rekognition——对 3 万张照片是几小时
 * 和一笔真金白银。放在索引期，补词表只需重建索引。
 *
 * 这条测试锁三件事：
 *   1. 没带 zh 的标签，建索引后一定有 zh；
 *   2. 已经带了 zh 的标签，不能被词表覆盖（人工/历史结果优先）；
 *   3. `zhForTerm()` 对词表外的 term 会兜底成 term 本身——所以「有 zh」
 *      **不等于**「有中文名」。这是 scripts/audit-terms.mjs 的判定口径，
 *      也是 B-05 的根因，必须用测试钉住，否则以后又会拿非空当已覆盖。
 *
 * V6 C-3: the Chinese name is resolved at index-build time. Recognition only
 * emits English terms; backfilling at recognition time would mean re-running
 * Rekognition for every vocabulary fix. Three things are pinned here: missing
 * `zh` gets filled, an existing `zh` is never overwritten, and `zhForTerm()`
 * falls back to the term itself — hence "has zh" does NOT mean "has a Chinese
 * name", which is the audit's criterion and the root cause of B-05.
 */

const manifest = {
  site: { title: '测试相册', subtitle: '' },
  photos: [
    { id: 'a1b2c3d4e5f6', year: 2025, month: 7, tags: ['2025'], type: 'image' },
    { id: 'b2c3d4e5f6a7', year: 2025, month: 8, tags: ['2025'], type: 'image' },
  ],
};

const label = (term, kind, confidence, extra = {}) => ({ term, kind, confidence, ...extra });

const item = (id, labels) => ({
  id, year: 2025, month: 7, tags: ['2025'], labels, colors: [], source: 'rekognition',
});

/** 建一个只含单条照片的索引，返回该照片的 labels。 */
function labelsOf(photoId, labels) {
  const index = createIndex({ manifest, items: [item(photoId, labels)] });
  return index.items.find((entry) => entry.id === photoId).labels;
}

test('缺失的 zh 在建索引时用词表回填', () => {
  // 前置：词表里确实有这两个词的中文名，否则这条测试会退化成自我印证
  assert.equal(TERM_ZH.lake, '湖水');
  assert.equal(TERM_ZH.mountain, '山峰');

  const labels = labelsOf('a1b2c3d4e5f6', [
    label('lake', 'scene', 0.91),
    label('mountain', 'object', 0.82),
  ]);

  assert.deepEqual(labels.map((l) => l.zh), ['湖水', '山峰']);
});

test('已有 zh 的标签不被词表覆盖', () => {
  const labels = labelsOf('a1b2c3d4e5f6', [
    label('lake', 'scene', 0.91, { zh: '湖面' }),
  ]);
  assert.equal(labels[0].zh, '湖面', '已有中文名应保留，不能被词表改写');
});

test('回填发生在索引侧：只给英文 term 也能得到中文名', () => {
  // 模拟识别阶段的真实产物：normalizeLabels 会把缺失的 zh 归成空串。
  const fromRecognition = normalizeLabels([label('blue sky', 'scene', 0.95)]);
  assert.equal(fromRecognition[0].zh, '', '识别产物本身不应带中文名');

  const labels = labelsOf('a1b2c3d4e5f6', fromRecognition);
  assert.equal(labels[0].zh, TERM_ZH['blue sky']);
  assert.notEqual(labels[0].zh, '', '索引期必须把中文名补上');
});

test('词表外的 term 兜底为 term 本身，「有 zh」不等于有中文名', () => {
  const labels = labelsOf('a1b2c3d4e5f6', [
    label('spaceship', 'object', 0.77),
  ]);
  assert.equal(labels[0].zh, 'spaceship');
  assert.equal(zhForTerm('spaceship'), 'spaceship');

  // audit-terms.mjs 的判定口径：必须含汉字且不等于 term，才算真有中文名。
  const CJK = /[\u4e00-\u9fff]/;
  assert.equal(CJK.test(labels[0].zh) && labels[0].zh !== labels[0].term, false,
    '兜底值不得被当成已有中文名');
});

test('zh 在白名单内，且无需为它升级索引版本', () => {
  // C-1：zh 本来就在 LABEL_FIELDS 里，加回填不改变索引形状，因此不 bump。
  assert.ok(LABEL_FIELDS.includes('zh'));
  assert.deepEqual(LABEL_FIELDS, ['term', 'zh', 'kind', 'confidence']);
  assert.ok(ITEM_FIELDS.includes('labels'));
  assert.equal(INDEX_VERSION, 'v5.1.0', '回填不改变索引形状，不应升级版本');
});

test('识别失败的照片仍进索引，只是没有标签', () => {
  // I-2：识别失败不得阻塞发布。没有 labels 也要有可用的时间/标签筛选。
  const index = createIndex({ manifest });
  const orphan = index.items.find((entry) => entry.id === 'b2c3d4e5f6a7');
  assert.deepEqual(orphan.labels, []);
  assert.equal(orphan.source, 'manifest');
  assert.equal(orphan.year, 2025);
  assert.equal(orphan.month, 8);
});
