import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chapterLine, endingLine, applyStoryCopy } from '../js/story.js';
import { loadArtifact } from '../js/data.js';

/**
 * V6 T-23 故事文案的前端一侧。
 *
 * 只测两件与「不可用也要能读」直接相关的事：
 *   1. 产物没来 / 版本不对 / 章节对不上，**退回既有文案**（章节标签 + 张数），
 *      而不是空白卡片；
 *   2. 结束语不再是那句「这一段，走完了。」——静态 HTML 里也不许再留着它。
 *
 * Only two things matter here: the fallback copy must never be blank, and the old
 * canned ending must be gone from the static HTML too.
 */

const chapter = { key: '2026', label: '2026', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

/** 每个用例都从「没有产物」开始：模块级文案是有状态的，用例之间不能互相借 */
const reset = () => applyStoryCopy({ chapters: [], ending: '' });

test('产物没来：章节卡用既有的「年份 + 张数」', () => {
  reset();
  const line = chapterLine(chapter);
  assert.equal(line.title, '2026');
  assert.equal(line.subtitle, '3 张');
  assert.deepEqual(chapterLine(null), { title: '', subtitle: '' });
});

test('产物来了：只覆盖对得上的章，别的一律退回', () => {
  reset();
  applyStoryCopy({
    chapters: [{ key: '2026', title: '风起的那年', subtitle: '树一直响' }],
    ending: '到这里就散了',
  });
  assert.equal(chapterLine(chapter).title, '风起的那年');
  assert.equal(chapterLine(chapter).subtitle, '树一直响');
  assert.equal(chapterLine({ key: '2025', label: '2025', items: [] }).title, '2025', '对不上就退回');
});

test('结束语：产物用产物的；没有就按首末章算一句', () => {
  reset();
  const chapters = [
    { key: '2025', label: '2025', items: [] },
    { key: '2026', label: '2026', items: [] },
  ];
  applyStoryCopy({ chapters: [], ending: '到这里就散了' });
  assert.equal(endingLine(chapters, 47), '到这里就散了');

  reset();
  assert.equal(endingLine(chapters, 47), '2025 到 2026，共 47 张');
  assert.equal(endingLine([chapters[0]], 9), '2025，共 9 张');
  assert.equal(endingLine([], 0), '');
});

test('结构不对的产物当作没有，不半信半疑地用一半', () => {
  assert.equal(applyStoryCopy(null), false);
  assert.equal(applyStoryCopy({ ending: '只有一句话' }), false);
  assert.equal(applyStoryCopy({ chapters: 'nope' }), false);
});

test('loadArtifact：版本对不上就当没有；断网也不抛', async () => {
  const stale = await loadArtifact('story', {
    rev: '', version: 1,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 7, chapters: [] }) }),
  });
  assert.equal(stale, null);

  const offline = await loadArtifact('story', {
    rev: '', fetchImpl: async () => { throw new Error('断网'); },
  });
  assert.equal(offline, null);

  const hit = await loadArtifact('story', {
    rev: 'abcdef12', version: 1,
    now: () => 9,
    fetchImpl: async (url) => ({
      ok: url === 'data/story.abcdef12.json',
      status: url === 'data/story.abcdef12.json' ? 200 : 404,
      json: async () => ({ version: 1, chapters: [], ending: '' }),
    }),
  });
  assert.deepEqual(hit, { version: 1, chapters: [], ending: '' });
});

test('静态 HTML 里不再有那句套话，结束语由一个可填的标题占位', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('这一段，走完了。'), '结束语不得再固定为这一句');
  assert.ok(!html.includes('时光飞逝'));
  assert.match(html, /id="story-end-title"/, '运行时要把结束语填进这个节点');
});

test('故事模块里没有别的套话兜底', async () => {
  const source = await readFile(new URL('../js/story.js', import.meta.url), 'utf8');
  for (const cliche of ['走完了', '时光飞逝', '记录美好生活', '留住美好']) {
    assert.ok(!source.includes(cliche), `故事模块里不该有「${cliche}」`);
  }
});
