import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 模板结构的两条硬约束（线上验收第 2、3 条）。
 *
 * 这两条不是审美偏好，是「找不到入口」和「找不准入口」两个真实问题：
 *   1. 上传按钮放页脚 = 在安卓上要滑过整条时间流，实测用户找不到；
 *   2. 搜索框放导航右上角 = 结果在内容列，视线要横跨整屏。
 *
 * 断言写成对**模板**的结构检查，而不是对截图，原因是它们属于「元素放在哪」这一层，
 * 纯函数测不到、样式也测不出。id 集合与位置一旦被无意挪回去，这里会红。
 *
 * Structural assertions on the template, because "which container the control
 * lives in" is neither a pure function nor a style: it is markup placement.
 */

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

/** 取出某个 `<tag ...class="X"...>` 到它闭合标签之间的片段（够用即可，不写解析器） */
function sliceBetween(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + startMarker.length);
  return to < 0 ? source.slice(from) : source.slice(from, to);
}

const countOf = (needle) => html.split(needle).length - 1;

test('上传入口在导航里，不在页脚', () => {
  assert.equal(countOf('id="open-upload"'), 1, '上传按钮只应有唯一一个，否则两个按钮会抢同一个 id');

  const nav = sliceBetween(html, '<nav class="site-nav"', '</nav>');
  assert.ok(nav.includes('id="open-upload"'), '上传按钮必须在主导航里，页脚位置在安卓上滑不到');

  const footer = sliceBetween(html, '<footer class="site-footer"', '</footer>');
  assert.equal(footer.includes('id="open-upload"'), false, '页脚里不要再留一个上传按钮');
});

test('上传按钮仍然默认 hidden：没有后端时不该出现', () => {
  const button = html.slice(html.indexOf('id="open-upload"') - 120, html.indexOf('id="open-upload"') + 40);
  assert.match(button, /hidden/, 'upload.js 负责在有 api base 时解除 hidden，模板里必须是隐藏态');
});

test('搜索框在内容列里，排在首屏之后、照片目录之前', () => {
  assert.equal(countOf('id="search-wrap"'), 1, '搜索容器只能有一份');

  const navAt = html.indexOf('<nav class="site-nav"');
  const heroEndAt = html.indexOf('</header>');
  const barAt = html.indexOf('class="search-bar"');
  const wrapAt = html.indexOf('id="search-wrap"');
  const catalogAt = html.indexOf('class="catalog"');

  assert.ok(barAt > 0, '缺少 .search-bar 容器');
  assert.ok(wrapAt > barAt, '搜索容器必须在 .search-bar 里');
  assert.ok(navAt < barAt, '搜索条应在导航之后');
  // 首屏大图仍然是第一屏的第一件事；搜索条排在它后面，不能把 LCP 顶下去
  assert.ok(heroEndAt < barAt, '搜索条必须在首屏之后，否则首屏大图被顶到第二屏');
  // 但又要紧贴结果：搜索态下首屏整块隐藏，搜索条自然顶到导航下面
  assert.ok(barAt < catalogAt, '搜索条必须在照片目录之前，否则又离结果很远');
});

test('搜索框不再留在导航里', () => {
  const nav = sliceBetween(html, '<nav class="site-nav"', '</nav>');
  assert.equal(nav.includes('id="search-wrap"'), false, '搜索框不要放回导航右上角');
  assert.equal(nav.includes('id="q"'), false, '输入框跟着搜索容器走');
});

test('JS 依赖的 id 一个都没丢', () => {
  for (const id of ['q', 'search-wrap', 'search-panel', 'search-suggestions', 'search-chips', 'search-status']) {
    assert.equal(countOf(`id="${id}"`), 1, `id=${id} 必须恰好一份`);
  }
});

test('首屏图仍在模板里，且没有被改成脚本注入', () => {
  assert.match(html, /<img[^>]+id="hero-media"[^>]+src="data\/hero\.webp"/, '首屏图必须是静态的，LCP 不等脚本');
  assert.match(html, /class="hero"[^>]*id="top"|id="top"[^>]*class="hero"/, 'hero 容器 id 必须是 top（applyView 靠它隐藏）');
});
