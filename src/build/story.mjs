/**
 * 故事文案构建期生成（V6 T-23）/ Story copy generated at build time.
 *
 * 三样东西：**章节标题**、**一句话副标题**、**结束语**。反过来的四件事不做：
 * 不选片（故事顺序由时间流决定）、不写正文、不在浏览时调模型、不因为模型不可用
 * 就让构建失败。
 *
 * 分组必须与运行时**完全一致**，所以这里直接调用前端那个 `buildStory()`——
 * 两边各写一套分组逻辑，迟早出现「产物里的章在播放时对不上」这种最难查的错。
 *
 * 文案分两层：
 *   1. **派生**（默认，无模型也可用）：标题用既有的「2026 / 2026 · 11 月」，
 *      副标题用该章的「几张 + 出现最多的两个中文词」，结束语用「首章到末章，共几张」。
 *      这些都不是空泛模板——每一章的词不一样，换了照片文案就变。
 *   2. **模型**（有凭据时）：把上面这三处换成一句人写的话，过筛（含数字、网址、
 *      套话一律丢弃）后落盘，失败就退回第 1 层。
 *
 * Grouping reuses the runtime's own `buildStory()` so the artifact and the player
 * can never disagree. Copy has two layers: derived (always available, per-chapter
 * words so it is never a blank template) and model-written (sanitised, with the
 * derived layer as fallback). The model never blocks the build.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStory } from '../web/js/state.js';
import { topWords, compareKeys } from './curation.mjs';
import { sanitizeSentence } from './llm.mjs';

/** 产物版本：字段改动时 +1，前端据此拒绝不认识的产物 */
export const STORY_VERSION = 1;
/** 结束语长度上限（比副标题宽松一点，它是一段收尾） */
export const ENDING_MAX = 40;
/** 副标题里带几个词 */
export const SUBTITLE_WORDS = 2;
/** 模型工作项的 key 后缀：一个章节要标题与副标题两句话，分开取，失败互不牵连 */
export const TITLE_SUFFIX = '#title';
export const SUBTITLE_SUFFIX = '#subtitle';
export const ENDING_KEY = '#ending';

const DATA_SUBDIR = 'data';

/** 副标题的派生文案：`9 张 · 衬衫、湖水`；没有词汇时只留张数 */
export function derivedSubtitle(chapter, labelsById) {
  const count = `${chapter.items.length} 张`;
  const words = topWords(chapter.items.map((photo) => photo.id), labelsById, SUBTITLE_WORDS);
  return words.length ? `${count} · ${words.join('、')}` : count;
}

/**
 * 结束语的派生文案：说的是「这段时间到哪为止」，不是套路感叹。
 *
 * 三种形状：
 *   - 一章：`2026，共 9 张`
 *   - 同年按月分章：`2026 年 1 月 到 11 月，共 47 张`（不重复写年份）
 *   - 其余（跨年）：`2025 到 2026，共 47 张`
 */
export function derivedEnding(chapters, total) {
  if (!chapters.length) return '';
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  if (chapters.length === 1) return `${first.label}，共 ${total} 张`;

  const monthKeys = chapters.every((chapter) => /^\d{4}-\d{2}$/.test(chapter.key));
  const year = first.key.slice(0, 4);
  if (monthKeys && chapters.every((chapter) => chapter.key.slice(0, 4) === year)) {
    const from = Number(first.key.slice(5));
    const to = Number(last.key.slice(5));
    return `${year} 年 ${from} 月 到 ${to} 月，共 ${total} 张`;
  }
  return `${first.label} 到 ${last.label}，共 ${total} 张`;
}

/** 给模型的工作项：每章标题 + 每章副标题 + 一句结束语 */
export function storyJobs(chapters, labelsById) {
  const jobs = [];
  for (const chapter of chapters) {
    const facts = {
      span: chapter.label,
      count: chapter.items.length,
      words: topWords(chapter.items.map((photo) => photo.id), labelsById, 6),
    };
    jobs.push({ key: `${chapter.key}${TITLE_SUFFIX}`, facts: { ...facts, part: '章节标题，四到八个字' } });
    jobs.push({ key: `${chapter.key}${SUBTITLE_SUFFIX}`, facts: { ...facts, part: '一句话副标题' } });
  }
  const total = chapters.reduce((sum, chapter) => sum + chapter.items.length, 0);
  jobs.push({
    key: ENDING_KEY,
    facts: {
      from: chapters[0]?.label || '',
      to: chapters[chapters.length - 1]?.label || '',
      count: total,
      part: '结束语，一句话',
    },
  });
  return jobs;
}

/**
 * 产物：只抄白名单字段。
 * 章节按 key 码点序排（不按分组顺序、更不按 locale）——产物要跨机器逐字节一致。
 */
export function storyDocument({ rev, chapters, labelsById = new Map(), copy = null, total = 0 }) {
  const table = copy instanceof Map ? copy : new Map(Object.entries(copy || {}));
  const pick = (key) => sanitizeSentence(table.get(key) || '');

  const ordered = [...chapters].sort((a, b) => compareKeys(a.key, b.key));
  const items = ordered.map((chapter) => ({
    key: chapter.key,
    title: pick(`${chapter.key}${TITLE_SUFFIX}`) || chapter.label,
    subtitle: pick(`${chapter.key}${SUBTITLE_SUFFIX}`) || derivedSubtitle(chapter, labelsById),
  }));

  // 用排好序的 ordered 算，不用入参顺序：否则把章节数组倒过来就会得到
  // 「2026 到 2025」这种反着的结束语，同一 rev 两份产物还不一样
  const ending = pick(ENDING_KEY)
    || derivedEnding(ordered, total || ordered.reduce((sum, chapter) => sum + chapter.items.length, 0));

  return {
    version: STORY_VERSION,
    rev: String(rev || ''),
    chapters: items,
    ending: ending.length > ENDING_MAX ? `${ending.slice(0, ENDING_MAX - 1)}…` : ending,
  };
}

/** 产物是否可用：版本对得上、章节是数组、结束语非空 */
export function isStoryUsable(document, { version = STORY_VERSION } = {}) {
  return Boolean(document)
    && typeof document === 'object'
    && Number(document.version) === Number(version)
    && Array.isArray(document.chapters)
    && typeof document.ending === 'string';
}

/**
 * 产出并写入故事文案。与策展同一套双写约定（plan §5）：
 *   `data/story.<rev>.json` 不可变主路径；`data/story.json` 固定名兜底。
 *
 * 与策展不同的是：**没有照片也照写**（空章节 + 空结束语）——故事随时可能被打开，
 * 有一份「什么都没有」的产物，前端那条读取路径平时就是通的。
 *
 * Same dual-write convention as curation. Unlike curation it is written even with
 * no photos: an empty artifact keeps the read path exercised.
 */
export async function writeStoryArtifacts({
  photos,
  rev,
  dist,
  index = null,
  writer = null,
  warn = console.warn,
  log = console.log,
} = {}) {
  if (!dist) throw new Error('writeStoryArtifacts 需要 dist 目录');
  const labelsById = new Map();
  for (const item of Array.isArray(index?.items) ? index.items : []) {
    if (!item || typeof item.id !== 'string') continue;
    labelsById.set(item.id, (Array.isArray(item.labels) ? item.labels : [])
      .filter((label) => label && typeof label.term === 'string' && label.term));
  }

  const { chapters } = buildStory(Array.isArray(photos) ? photos : []);
  const total = chapters.reduce((sum, chapter) => sum + chapter.items.length, 0);

  let copy = new Map();
  if (writer && writer.enabled && chapters.length) {
    copy = await writer.write(rev, storyJobs(chapters, labelsById));
  }
  const document = storyDocument({ rev, chapters, labelsById, copy, total });

  const json = JSON.stringify(document);
  const dir = path.join(dist, DATA_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `story.${rev}.json`), json);
  await writeFile(path.join(dir, 'story.json'), json);
  log(`故事文案：${document.chapters.length} 章，${copy.size ? '模型参与了措辞' : '全部为派生文案'}`);
  return document;
}
