import test from 'node:test';
import assert from 'node:assert/strict';
import { albumSummary, formatAlbumSpan, hashOf } from '../js/state.js';

/**
 * V6 T-18：相册卡片三信息。
 *
 * 关键不是「显示了什么」，而是**同一张卡片重复渲染必须一模一样**。
 * 卡片会在筛选、改密度、窗口缩放时反复重绘；一旦封面随机，用户会看到
 * 同一个相册每次换一张脸。所以封面必须是相册名的确定性函数。
 *
 * The point is determinism: cards re-render constantly, so the cover must be a
 * pure function of the album name.
 */

const photo = (id, year, month, album = 'A') => ({ id, year, month, album, ratio: 1.5 });

test('时间跨度：跨月写成 2024.3–2024.5', () => {
  const members = [photo('a', 2024, 5), photo('b', 2024, 4), photo('c', 2024, 3)];
  assert.equal(formatAlbumSpan(members), '2024.3–2024.5');
});

test('时间跨度：只有一个月时只写一个日期', () => {
  assert.equal(formatAlbumSpan([photo('a', 2024, 5), photo('b', 2024, 5)]), '2024.5');
});

test('时间跨度：跨年两端都带年', () => {
  const members = [photo('a', 2025, 1), photo('b', 2024, 11)];
  assert.equal(formatAlbumSpan(members), '2024.11–2025.1');
});

test('时间跨度：空相册不返回 "NaN.NaN"', () => {
  assert.equal(formatAlbumSpan([]), '');
  assert.equal(formatAlbumSpan(null), '');
});

test('封面是相册名的确定性函数：同一名字永远选到同一张', () => {
  const members = Array.from({ length: 23 }, (_, i) => photo(`p${i}`, 2024, 5));
  const album = { name: '杭州', count: members.length, cover: 'p0' };

  const first = albumSummary(album, members).coverId;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(albumSummary(album, members).coverId, first, '重复渲染换了封面');
  }

  // 不同名字要尽量落到不同成员上——这是「哈希」而不是「永远取第一张」的证据。
  // 取模会撞（杭州与苏州都落到 8），所以只要求「12 个名字至少 8 个不同的封面」。
  const names = ['杭州', '苏州', '上海', '成都', '西安', '厦门',
    '青岛', '大理', '西藏', '日本', '厦门鼓浪屿', '家里'];
  const covers = new Set(names.map((name) => albumSummary({ ...album, name }, members).coverId));
  assert.ok(covers.size >= 8, `12 个相册只选出 ${covers.size} 种封面，分布太差`);
});

test('封面必须落在成员里，不能是别的相册的照片', () => {
  const members = [photo('x1', 2024, 1), photo('x2', 2024, 2)];
  const summary = albumSummary({ name: 'A', count: 2 }, members);
  assert.ok(members.some((p) => p.id === summary.coverId));
});

test('没有成员时回退 manifest 的 cover，仍不编造', () => {
  const summary = albumSummary({ name: 'A', count: 9, cover: 'legacy' }, []);
  assert.equal(summary.coverId, 'legacy');
  assert.equal(summary.count, 9);
  assert.equal(summary.span, '');
});

test('张数用 manifest 的 count，不用成员数（成员可能被筛选截断）', () => {
  const members = [photo('a', 2024, 5)];
  assert.equal(albumSummary({ name: 'A', count: 42 }, members).count, 42);
});

test('哈希：同输入同输出，不同输入基本不同，且是无符号 32 位', () => {
  assert.equal(hashOf('杭州'), hashOf('杭州'));
  assert.notEqual(hashOf('杭州'), hashOf('苏州'));
  for (const name of ['', 'a', '杭州', '很久以前的一次旅行']) {
    const value = hashOf(name);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `${name} 的哈希越界`);
  }
});
