import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterPhotos } from '../js/state.js';

/**
 * 相册按钮必须**各自打开各自的东西**。
 *
 * 2026-11-16 第二轮验收现场：点「2026」和点「未分类」，落在同一个页面、同一批照片，
 * 只有标题变了。根因不在过滤（`filterPhotos` 一直是对的），在重绘入口——相册卡片
 * 的回调直接调了 `applyView()`，而 `applyView()` 只切区块显隐、**不重画目录**；
 * 真正把 `state.filtered` 送进目录的是 `refresh()`。其余入口（品牌、返回、年份条、
 * 筛选项）走的都是 `refresh()`，所以只有这一个入口坏掉。
 *
 * 线上数据形状：`albums = [{2026, 51}, {未分类, 2}]`。两个相册必须给出**不同且
 * 不相交**的照片集合，否则「相册」这个词在这个站点上就没有意义。
 *
 * The click handlers are all supposed to funnel through `refresh()`; the album card
 * was the only one calling `applyView()` and therefore never repainting the catalog.
 */

/** 按线上形状造数据：51 张在「2026」，2 张在「未分类」 */
function prodShaped() {
  const list = [];
  for (let i = 0; i < 51; i += 1) {
    list.push({ id: `a${i}`, year: 2026, month: (i % 11) + 1, album: '2026', tags: ['2026', '2026'] });
  }
  for (let i = 0; i < 2; i += 1) {
    list.push({ id: `b${i}`, year: 2026, month: 11, album: '未分类', tags: ['未分类', '2026'] });
  }
  return list;
}

test('相册筛选：两个相册给出不同的、不相交的照片集合', () => {
  const list = prodShaped();
  const a = filterPhotos(list, { album: '2026' });
  const b = filterPhotos(list, { album: '未分类' });

  assert.equal(a.length, 51, '「2026」应该是 51 张');
  assert.equal(b.length, 2, '「未分类」应该是 2 张');
  assert.notEqual(a.length, b.length, '两个相册不能是同一批照片');
  assert.equal(a.length + b.length, list.length, '合计必须等于总数，不能有照片两边都进');
  assert.ok(!a.some((p) => p.album === '未分类') && !b.some((p) => p.album === '2026'));
});

test('相册筛选：不存在的相册是 0 张，而不是「筛选没生效」', () => {
  const list = prodShaped();
  assert.equal(filterPhotos(list, { album: '没有这个相册' }).length, 0);
  assert.equal(filterPhotos(list, { album: '' }).length, list.length, '空相册值等于不筛');
});

test('相册筛选与其他条件叠加时仍然生效', () => {
  const list = prodShaped();
  const both = filterPhotos(list, { album: '2026', tag: '2026', month: '11' });
  assert.ok(both.length > 0 && both.length < 51, `叠加后应收窄，实得 ${both.length}`);
  assert.ok(both.every((p) => p.album === '2026' && p.month === 11));
});

test('结构守卫：只有 refresh() 调 applyView()，相册卡片走 enterAlbum', async () => {
  const src = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');

  // applyView() 只切显隐，不重画目录。任何入口直接调它 = 「点了但画面没变」。
  const bare = src.match(/^\s*applyView\(\);\s*$/gm) || [];
  assert.equal(bare.length, 1, `applyView() 只该在 refresh() 里被调用，实得 ${bare.length} 处`);

  assert.match(
    src,
    /onOpenAlbum:\s*enterAlbum/,
    '相册卡片必须绑到 enterAlbum()（它走 refresh()），不要写成内联回调',
  );
  assert.match(src, /function enterAlbum\s*\(/, 'enterAlbum() 应该是一个具名函数，便于复用与检查');
});
