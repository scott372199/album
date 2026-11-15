import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutParams, normalizeDensity, DENSITY, computeEditorialRows,
} from '../js/state.js';
import { planCatalog } from '../js/gallery.js';

/**
 * V6 T-15：网格密度三档。
 *
 * 密度只改「目标行宽」，不改裁切规则——所以任何一档下：
 *   - 并排行的瓦片宽度之和 + gap 必须正好等于容器宽度（等比填满，不裁不挤）；
 *   - 每张瓦片的宽高比必须等于照片自身比例。
 * 这两条比「看起来更紧凑了」可靠得多。
 *
 * Density only changes the target row width, never the crop: in every mode the
 * row must still add up to exactly the container width, with each tile keeping
 * the photo's own aspect ratio.
 */

const photos = (n, ratio = 1.5) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, year: 2025, month: 12 - (i % 3), ratio, type: 'image',
}));

const WIDTH = 1280;

test('三档目标行宽：紧凑 200 / 标准 340 / 大图 520', () => {
  assert.equal(layoutParams(WIDTH, 'compact').target, DENSITY.compact);
  assert.equal(layoutParams(WIDTH, 'standard').target, DENSITY.standard);
  assert.equal(layoutParams(WIDTH, 'large').target, DENSITY.large);
  assert.equal(DENSITY.compact, 200);
  assert.equal(DENSITY.standard, 340);
  assert.equal(DENSITY.large, 520);
});

test('未知档位落回标准，不抛错', () => {
  assert.equal(normalizeDensity('huge'), 'standard');
  assert.equal(normalizeDensity(undefined), 'standard');
  assert.equal(normalizeDensity(null), 'standard');
  assert.equal(layoutParams(WIDTH, 'nonsense').target, DENSITY.standard);
});

test('密度越紧凑，同样宽度下每行放得越多', () => {
  const list = photos(24);
  const rowsOf = (density) => computeEditorialRows(list, WIDTH, layoutParams(WIDTH, density));

  const count = (density) => {
    const rows = rowsOf(density);
    return rows.reduce((sum, row) => sum + row.items.length, 0) / rows.length;
  };

  const compact = count('compact');
  const standard = count('standard');
  const large = count('large');

  assert.ok(compact >= standard, `紧凑平均每行 ${compact} 张，不该少于标准 ${standard}`);
  assert.ok(standard >= large, `标准平均每行 ${standard} 张，不该少于大图 ${large}`);
});

test('并排行的宽度正好填满容器，每张保持原比例（不裁切）', () => {
  for (const density of ['compact', 'standard', 'large']) {
    const plan = planCatalog(photos(30), WIDTH, density);
    const params = layoutParams(WIDTH, density);
    let strips = 0;

    for (const year of plan.years) {
      for (const item of year.rows) {
        if (item.kind !== 'row' || item.type !== 'strip') continue;
        strips += 1;
        const used = item.tiles.reduce((sum, tile) => sum + tile.width, 0)
          + params.gap * (item.tiles.length - 1);
        assert.ok(Math.abs(used - WIDTH) < 0.001, `${density} 档一行用了 ${used}px，应为 ${WIDTH}px`);
        for (const tile of item.tiles) {
          assert.ok(Math.abs(tile.width / tile.height - 1.5) < 1e-9, '宽高比被改了，等于裁切');
        }
      }
    }
    assert.ok(strips > 0, `${density} 档夹具没生成并排行，断言没意义`);
  }
});

test('大图行宽度不超过容器宽度', () => {
  for (const density of ['compact', 'standard', 'large']) {
    const plan = planCatalog(photos(12, 2.4), WIDTH, density);
    for (const year of plan.years) {
      for (const item of year.rows) {
        if (item.kind !== 'row' || item.type !== 'feature') continue;
        for (const tile of item.tiles) {
          assert.ok(tile.width <= WIDTH + 1e-9, `大图宽 ${tile.width} 溢出了 ${WIDTH}`);
        }
      }
    }
  }
});

test('planCatalog 真的用上了 density 形参（这个形参漏过一次）', () => {
  // 事故还原：`planCatalog(photos, width)` 只声明两个参数，调用处照常传第三个
  // `density`，JS 不报错、参数被静默丢弃，于是三档密度排出来一模一样，
  // 下拉框换了等于没换。这条测试问的是「同一批照片，三档的行数必须不同」。
  //
  // Regression: `planCatalog` used to declare only two parameters while callers
  // still passed `density`; the extra argument was silently dropped, so all three
  // modes laid out identically. Rows must differ per mode.
  const list = photos(24);
  const rowCount = (density) => planCatalog(list, WIDTH, density).years
    .reduce((sum, year) => sum + year.rows.filter((row) => row.kind === 'row').length, 0);

  const compact = rowCount('compact');
  const standard = rowCount('standard');
  const large = rowCount('large');

  // 越紧凑，一行装得越多，总行数就越少
  assert.ok(compact < standard, `紧凑 ${compact} 行，应该少于标准 ${standard} 行`);
  assert.ok(standard < large, `标准 ${standard} 行，应该少于大图 ${large} 行`);
});

test('密度不影响分年分组与瓦片总数', () => {
  const list = photos(20);
  for (const density of ['compact', 'standard', 'large']) {
    const plan = planCatalog(list, WIDTH, density);
    const tiles = plan.years.reduce((sum, y) => sum
      + y.rows.reduce((s, r) => s + (r.kind === 'row' ? r.tiles.length : 0), 0), 0);
    assert.equal(tiles, list.length);
    assert.equal(plan.years.length, 1);
  }
});
