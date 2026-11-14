import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_KEY, serializeAnchor, parseAnchor, nearestAnchor, anchorExists,
} from '../js/anchor.js';

/**
 * V6 T-17：回到上次位置。
 *
 * 存的是年月而不是像素——像素偏移在照片增删、密度切换、窗口变宽之后会指向
 * 一个不存在的地方，而年月永远落在有内容的位置上。
 * 这里把「序列化 / 脏数据 / 选哪一个」三件事钉住。
 */

test('序列化：月份补零，年月可逆', () => {
  assert.equal(serializeAnchor({ year: 2024, month: 3 }), '2024-03');
  assert.deepEqual(parseAnchor('2024-03'), { year: 2024, month: 3 });
  assert.deepEqual(parseAnchor('2024-3'), { year: 2024, month: 3 }, '旧数据没有补零也要能读');
});

test('非法输入一律当成「没有记忆」，不抛错', () => {
  for (const bad of [null, undefined, '', 'abc', '2024-13', '2024-0', '1800-5', '99999-1']) {
    assert.equal(parseAnchor(bad), null, `${String(bad)} 不该被解析成有效锚点`);
  }
  assert.equal(serializeAnchor({ year: 2024, month: 13 }), '');
  assert.equal(serializeAnchor({ year: NaN, month: 3 }), '');
  assert.equal(serializeAnchor(null), '');
});

test('挑选：取最后一个越过参考线的锚点', () => {
  const entries = [
    { year: 2026, month: 12, top: -800 },
    { year: 2026, month: 11, top: -100 },
    { year: 2026, month: 10, top: 240 },
    { year: 2025, month: 9, top: 900 },
  ];
  const picked = nearestAnchor(entries, 200);
  assert.deepEqual({ year: picked.year, month: picked.month }, { year: 2026, month: 11 });
});

test('挑选：全都还在下方时返回 null（不硬塞一个错的）', () => {
  const entries = [{ year: 2026, month: 12, top: 400 }, { year: 2026, month: 11, top: 900 }];
  assert.equal(nearestAnchor(entries, 200), null);
});

test('挑选：全部已经滚过去时停在最后一个，而不是回顶部', () => {
  const entries = [{ year: 2026, month: 12, top: -900 }, { year: 2025, month: 11, top: -200 }];
  const picked = nearestAnchor(entries, 100);
  assert.deepEqual({ year: picked.year, month: picked.month }, { year: 2025, month: 11 });
});

test('挑选：空列表与非数组都不炸', () => {
  assert.equal(nearestAnchor([], 0), null);
  assert.equal(nearestAnchor(null, 0), null);
  assert.equal(nearestAnchor([{ top: 'x' }], 0), null, 'top 不是数字的条目要跳过');
});

test('记忆是否还算数：要看当前结果里有没有这个月', () => {
  const available = [{ year: 2026, month: 12 }, { year: 2026, month: 11 }];
  assert.equal(anchorExists({ year: 2026, month: 11 }, available), true);
  assert.equal(anchorExists({ year: 2025, month: 3 }, available), false);
  assert.equal(anchorExists(null, available), false);
  assert.equal(anchorExists({ year: 2026, month: 11 }, null), false);
});

test('存储键是带命名空间的小写键（别和别的东西撞）', () => {
  assert.equal(ANCHOR_KEY, 'album.anchor');
});
