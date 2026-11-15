import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, usefulTags, PLACEHOLDER_TAGS } from '../js/data.js';

/**
 * 「标签」筛选栏必须真的能筛出东西。
 *
 * 线上现状（2026-11-16 验收）：53 张照片的 tags 是 `[相册名, 年份]`，相册名统一
 * 是「未分类」，于是这一栏只剩 `2026`——和「年份」下拉框完全重复。用户连问两次
 * 「标签下拉框的作用是筛选什么」，答案是「什么都筛不了」。
 *
 * 这里的规则是数据驱动的，不是把控件删掉：
 *   - 纯年份值、占位名（未分类）剔掉；
 *   - 剩下的不足两个值，调用方隐藏整栏；
 *   - 将来真有自定义标签时，它会自己长回来。
 *
 * The tag facet must be able to filter something. Tags are `[album, year]` with
 * album = "未分类", so the control duplicated the year filter. Year-like and
 * placeholder values are dropped here; callers hide the field when fewer than two
 * survive, and real tags bring it back with no code change.
 */

test('纯年份与占位名不算标签', () => {
  assert.deepEqual(usefulTags(['2026'], [2026]), []);
  assert.deepEqual(usefulTags(['未分类', '2026'], [2026]), []);
  assert.deepEqual(usefulTags(['2026', '未命名'], ['2026']), []);
});

test('真标签保留，去重且保序', () => {
  assert.deepEqual(usefulTags(['2026', '生日', '生日', '第一天上幼儿园'], ['2026']),
    ['生日', '第一天上幼儿园']);
});

test('脏数据不抛错', () => {
  assert.deepEqual(usefulTags(null, null), []);
  assert.deepEqual(usefulTags([undefined, '', '  '], []), []);
  assert.deepEqual(usefulTags([' 生日 '], []), ['生日']);
});

test('buildIndex 产出的 tags 就是筛选栏的选项：线上形状下为空', () => {
  const manifest = {
    photos: [
      { id: 'a', year: 2026, month: 1, tags: ['未分类', '2026'] },
      { id: 'b', year: 2026, month: 2, tags: ['2026'] },
    ],
  };
  const index = buildIndex(manifest);
  assert.deepEqual(index.tags, [], '只有年份与占位名时，标签栏应没有选项');
  assert.deepEqual(index.years, [2026], '年份筛选照常可用');
});

test('一旦照片带上自定义标签，标签栏的选项就出现', () => {
  const manifest = {
    photos: [
      { id: 'a', year: 2026, month: 1, tags: ['未分类', '2026', '生日'] },
      { id: 'b', year: 2026, month: 2, tags: ['2026', '幼儿园'] },
      { id: 'c', year: 2026, month: 3, tags: ['2026', '在家'] },
    ],
  };
  const index = buildIndex(manifest);
  assert.deepEqual(index.tags.sort(), ['在家', '幼儿园', '生日'].sort());
  assert.ok(!index.tags.includes('2026'), '年份值不该混进标签选项');
});

test('占位名表只包含占位名，不误伤真实标签', () => {
  assert.ok(PLACEHOLDER_TAGS.has('未分类'));
  assert.ok(!PLACEHOLDER_TAGS.has('生日'));
});
