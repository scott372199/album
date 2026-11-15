import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  STORY_VERSION, ENDING_KEY, TITLE_SUFFIX, SUBTITLE_SUFFIX,
  derivedSubtitle, derivedEnding, storyJobs, storyDocument, isStoryUsable, writeStoryArtifacts,
} from '../../build/story.mjs';
import { buildStory } from '../../web/js/state.js';

/**
 * V6 T-23 故事文案：构建期产出章节标题 / 一句话副标题 / 结束语。
 *
 * 三条要证的事：
 *   1. **分组与播放器一致**——产物里的章，必须是运行时 `buildStory()` 分出来的章，
 *      否则文案会贴到别的章节上。这里直接对同一个函数求值比对。
 *   2. **模型不可用时构建成功且故事可读**——没有模型就是派生文案（每章词不同），
 *      不是空字符串，也不是「这一段，走完了」那种套话。
 *   3. **同 rev 幂等**——产物逐字节相同，章节按 key 码点序（不依赖 ICU）。
 */

/* ---------- 夹具 ---------- */

const photo = (id, year, month) => ({ id, type: 'image', year, month, album: String(year) });

const photos = [
  photo('a1', 2025, 3), photo('a2', 2025, 4),
  photo('b1', 2026, 3), photo('b2', 2026, 11), photo('b3', 2026, 11),
];

const index = {
  items: [
    { id: 'a1', labels: [{ term: 'lake', zh: '湖水', kind: 'scene' }] },
    { id: 'a2', labels: [{ term: 'lake', zh: '湖水', kind: 'scene' }, { term: 'tree', zh: '树', kind: 'object' }] },
    { id: 'b1', labels: [{ term: 'shirt', zh: '衬衫', kind: 'object' }] },
    { id: 'b2', labels: [{ term: 'shirt', zh: '衬衫', kind: 'object' }] },
    { id: 'b3', labels: [{ term: 'shirt', zh: '衬衫', kind: 'object' }, { term: 'car', zh: '汽车', kind: 'object' }] },
  ],
};

/* ---------- 分组一致性 ---------- */

test('产物按运行时同一个 buildStory() 分组：年份够多就按年，否则按月', () => {
  const { chapters, byYear } = buildStory(photos);
  assert.equal(byYear, true, '两个年份 → 按年分章');

  const doc = storyDocument({ rev: 'abcdef12', chapters, labelsById: new Map() });
  assert.deepEqual(doc.chapters.map((item) => item.key), ['2025', '2026']);

  const oneYear = photos.filter((item) => item.year === 2026);
  const single = buildStory(oneYear);
  assert.equal(single.byYear, false, '只有一个年份 → 按月分章');
  const doc2 = storyDocument({ rev: 'abcdef12', chapters: single.chapters });
  assert.deepEqual(doc2.chapters.map((item) => item.key), ['2026-03', '2026-11']);
});

test('章节按 key 码点序，不按分组顺序也不按 locale', () => {
  const shuffled = [...buildStory(photos).chapters].reverse();
  const doc = storyDocument({ rev: 'abcdef12', chapters: shuffled });
  assert.deepEqual(doc.chapters.map((item) => item.key), ['2025', '2026']);
});

/* ---------- 派生文案 ---------- */

test('副标题带该章出现最多的两个词；没有词汇就只报张数', () => {
  const labelsById = new Map(index.items.map((item) => [item.id, item.labels]));
  const { chapters } = buildStory(photos);
  const y2025 = chapters.find((chapter) => chapter.key === '2025');
  const y2026 = chapters.find((chapter) => chapter.key === '2026');

  assert.equal(derivedSubtitle(y2025, labelsById), '2 张 · 湖水、树');
  assert.equal(derivedSubtitle(y2026, labelsById), '3 张 · 衬衫、汽车');
  assert.equal(derivedSubtitle(y2025, new Map()), '2 张', '没有索引时不再编词');
});

test('结束语由数据算出：一章就是那一章，多章就是首章到末章', () => {
  const { chapters } = buildStory(photos);
  assert.equal(derivedEnding(chapters, 5), '2025 到 2026，共 5 张');
  assert.equal(derivedEnding([chapters[0]], 2), '2025，共 2 张');
  assert.equal(derivedEnding([], 0), '');
});

test('派生结束语不再是那句套话，且每章都带着自己的内容', () => {
  const labelsById = new Map(index.items.map((item) => [item.id, item.labels]));
  const doc = storyDocument({ rev: 'abcdef12', chapters: buildStory(photos).chapters, labelsById });
  const text = JSON.stringify(doc);
  assert.ok(!text.includes('走完了'));
  assert.ok(!text.includes('时光飞逝'));
  assert.ok(doc.ending.length > 0);
  assert.notEqual(doc.chapters[0].subtitle, doc.chapters[1].subtitle, '两章内容不同，副标题不该一样');
});

/* ---------- 模型文案 ---------- */

test('模型写了就用模型的，写歪了就退回派生；含数字与网址的句子一律不要', () => {
  const { chapters } = buildStory(photos);
  const labelsById = new Map(index.items.map((item) => [item.id, item.labels]));

  const copy = new Map([
    [`2025${TITLE_SUFFIX}`, '湖边的开头'],
    [`2025${SUBTITLE_SUFFIX}`, '水还没暖'],
    [`2026${TITLE_SUFFIX}`, '2026 年的冬天'],   // 含数字 → 丢
    [ENDING_KEY, '从三月走到十一月'],
  ]);
  const doc = storyDocument({ rev: 'abcdef12', chapters, labelsById, copy });
  const y2025 = doc.chapters.find((item) => item.key === '2025');
  const y2026 = doc.chapters.find((item) => item.key === '2026');

  assert.equal(y2025.title, '湖边的开头');
  assert.equal(y2025.subtitle, '水还没暖');
  assert.equal(y2026.title, '2026', '模型那句被筛掉了，退回章节标签');
  assert.equal(y2026.subtitle, '3 张 · 衬衫、汽车');
  assert.equal(doc.ending, '从三月走到十一月');
});

test('给模型的工作项：每章两条 + 一条结束语，事实里只有中文词', () => {
  const labelsById = new Map(index.items.map((item) => [item.id, item.labels]));
  const { chapters } = buildStory(photos);
  const jobs = storyJobs(chapters, labelsById);
  assert.equal(jobs.length, chapters.length * 2 + 1);
  assert.equal(jobs.at(-1).key, ENDING_KEY);
  const facts = JSON.stringify(jobs);
  assert.ok(!facts.includes('lake'), '内部英文 term 不进提示词');
  assert.ok(facts.includes('湖水'));
  assert.ok(jobs.some((job) => job.key === `2026${TITLE_SUFFIX}`));
});

/* ---------- 产物 ---------- */

test('产物白名单：只有 key / title / subtitle 与一句 ending', () => {
  const doc = storyDocument({ rev: 'abcdef12', chapters: buildStory(photos).chapters });
  assert.deepEqual(Object.keys(doc).sort(), ['chapters', 'ending', 'rev', 'version']);
  assert.deepEqual(Object.keys(doc.chapters[0]).sort(), ['key', 'subtitle', 'title']);
  assert.equal(doc.version, STORY_VERSION);
  assert.equal(isStoryUsable(doc), true);
  assert.equal(isStoryUsable({ ...doc, version: 99 }), false);
  assert.equal(isStoryUsable({ version: STORY_VERSION }), false);
});

test('幂等：同一 rev 重复构建，JSON 逐字节相同', () => {
  const chapters = buildStory(photos).chapters;
  const first = JSON.stringify(storyDocument({ rev: 'abcdef12', chapters }));
  const second = JSON.stringify(storyDocument({ rev: 'abcdef12', chapters: [...chapters].reverse() }));
  assert.equal(first, second, '章节顺序被规整过，所以入参顺序不影响产物');
});

/* ---------- 落盘 ---------- */

const fakeWriter = (enabled = false, table = new Map()) => ({ enabled, write: async () => table });

test('双写 + 幂等：story.<rev>.json 与 story.json 逐字节相同', async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'story-dist-'));
  const first = await writeStoryArtifacts({
    photos, rev: 'abcdef12', dist, index, writer: fakeWriter(), warn: () => {}, log: () => {},
  });
  const versioned = await readFile(path.join(dist, 'data', 'story.abcdef12.json'), 'utf8');
  const fixed = await readFile(path.join(dist, 'data', 'story.json'), 'utf8');
  assert.equal(versioned, fixed);
  assert.deepEqual(JSON.parse(fixed), first);

  await writeStoryArtifacts({
    photos, rev: 'abcdef12', dist, index, writer: fakeWriter(), warn: () => {}, log: () => {},
  });
  assert.equal(await readFile(path.join(dist, 'data', 'story.json'), 'utf8'), fixed);

  await rm(dist, { recursive: true, force: true });
});

test('模型不可用时构建照常成功，故事可读（派生文案不为空）', async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'story-dist-'));
  const doc = await writeStoryArtifacts({
    photos, rev: 'abcdef12', dist, index, writer: fakeWriter(false), warn: () => {}, log: () => {},
  });
  assert.equal(doc.chapters.length, 2);
  for (const chapter of doc.chapters) {
    assert.ok(chapter.title.length > 0);
    assert.ok(chapter.subtitle.length > 0);
  }
  assert.ok(doc.ending.length > 0);
  await rm(dist, { recursive: true, force: true });
});

test('没有照片也照写：空章节 + 空结束语，读取路径平时就是通的', async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'story-dist-'));
  const doc = await writeStoryArtifacts({
    photos: [], rev: 'abcdef12', dist, index: null, writer: fakeWriter(), warn: () => {}, log: () => {},
  });
  assert.deepEqual(doc.chapters, []);
  assert.equal(doc.ending, '');
  assert.equal(isStoryUsable(doc), true, '结构完整，只是没内容');
  const raw = await readFile(path.join(dist, 'data', 'story.json'), 'utf8');
  assert.ok(raw.includes('"chapters":[]'));
  await rm(dist, { recursive: true, force: true });
});

test('模型给了文案就落进产物（这条路径是通的，不是死代码）', async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'story-dist-'));
  const table = new Map([[`2026${TITLE_SUFFIX}`, '风起的那年'], [ENDING_KEY, '到这里就散了']]);
  const doc = await writeStoryArtifacts({
    photos, rev: 'abcdef12', dist, index,
    writer: fakeWriter(true, table), warn: () => {}, log: () => {},
  });
  assert.equal(doc.chapters.find((item) => item.key === '2026').title, '风起的那年');
  assert.equal(doc.ending, '到这里就散了');
  await rm(dist, { recursive: true, force: true });
});

/* ---------- 真实语料暴露的两件事 ---------- */

test('没翻译的标签不进文案：词表没覆盖到的词仍是英文 term', () => {
  const labels = new Map([
    ['x1', [{ term: 'brown', zh: 'brown' }, { term: 'grey', zh: 'grey' }]],
    ['x2', [{ term: 'sky', zh: '天空' }, { term: 'person', zh: 'person' }]],
  ]);
  const chapter = { key: '2026-11', label: '2026 · 11 月', items: [{ id: 'x1' }, { id: 'x2' }] };
  assert.equal(derivedSubtitle(chapter, labels), '2 张 · 天空');
  // 实测语料里 4 月是「boy、brown」、11 月是「grey、person」——中文卡片里混英文词很刺眼
  assert.ok(!derivedSubtitle(chapter, labels).includes('brown'));
});

test('同年按月分章时结束语不重复写年份', () => {
  const chapters = [
    { key: '2026-01', label: '2026 · 1 月', items: [] },
    { key: '2026-11', label: '2026 · 11 月', items: [] },
  ];
  assert.equal(derivedEnding(chapters, 47), '2026 年 1 月 到 11 月，共 47 张');

  const crossing = [
    { key: '2025-12', label: '2025 · 12 月', items: [] },
    { key: '2026-01', label: '2026 · 1 月', items: [] },
  ];
  assert.equal(derivedEnding(crossing, 12), '2025 · 12 月 到 2026 · 1 月，共 12 张');
});
