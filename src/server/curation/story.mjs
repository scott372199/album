/**
 * 故事的分章与文案（V6 T-23）/ Story chapters and copy.
 *
 * 分章规则**必须与播放器一致**：播放器拿 `web/js/state.js#buildStory()` 分组，
 * 产物则按章 key 给文案；两边差一个规则，文案就会贴到别的章上——而且只在
 * 某个年份边界上出错，最难查。所以这里的 `chaptersOf()` 是对同一个算法的服务端
 * 实现，且由 `v6-artifact-publish.test.mjs` 直接拿两边的输出逐键比对。
 *
 * 为什么不直接 import 那个函数：它住在 `src/web/js/`，而镜像只 `COPY src/server/`；
 * 反向让 web 依赖服务端目录，前端构建又拷不到。真正消除漂移的是那条比对用例，
 * 不是共享物理路径。
 *
 * The grouping must match the player's. `chaptersOf()` mirrors buildStory() and a
 * test compares both outputs key by key — that, not a shared file path, is what
 * prevents drift (the image only copies src/server/, the bundle only src/web/js/).
 */

import { topWords, compareKeys } from './rules.mjs';
import { sanitizeSentence } from './llm.mjs';

/** 产物版本：字段改动时 +1，前端据此拒绝不认识的产物 */
export const STORY_VERSION = 1;
/** 结束语长度上限 */
export const ENDING_MAX = 40;
/** 副标题里带几个词 */
export const SUBTITLE_WORDS = 2;
/** 模型工作项的 key 后缀：标题与副标题分开取，一句失败不牵连另一句 */
export const TITLE_SUFFIX = '#title';
export const SUBTITLE_SUFFIX = '#subtitle';
export const ENDING_KEY = '#ending';

/** 与播放器同一个分章规则：年份够两个就按年，否则按月 */
export function chaptersOf(photos) {
  const list = Array.isArray(photos) ? photos.filter((photo) => photo && photo.id && photo.year) : [];
  if (!list.length) return { chapters: [], byYear: false };

  const byYear = new Set(list.map((photo) => photo.year)).size >= 2;
  // id 只用码点序做稳定排序：产物不依赖它，但同一输入要有同一顺序
  const sorted = [...list].sort((a, b) => a.year - b.year
    || (a.month || 0) - (b.month || 0)
    || compareKeys(a.id, b.id));

  const map = new Map();
  for (const photo of sorted) {
    const key = byYear ? String(photo.year) : `${photo.year}-${String(photo.month || 0).padStart(2, '0')}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: byYear ? `${photo.year}` : `${photo.year} · ${photo.month} 月`,
        items: [],
      });
    }
    map.get(key).items.push(photo);
  }
  return { chapters: [...map.values()], byYear };
}

/** 副标题的派生文案：`9 张 · 衬衫、湖水`；没有汉字词时只留张数 */
export function derivedSubtitle(chapter, labelsById) {
  const count = `${chapter.items.length} 张`;
  const words = topWords(chapter.items.map((photo) => photo.id), labelsById, SUBTITLE_WORDS);
  return words.length ? `${count} · ${words.join('、')}` : count;
}

/**
 * 结束语由数据算出：一章 `2026，共 9 张`；同年按月 `2026 年 1 月 到 11 月，共 47 张`
 * （不重复写年份）；跨年 `2025 到 2026，共 47 张`。都不是套路感叹。
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
 * 产物：只抄白名单字段。章节按 key 码点序排——产物要跨机器逐字节一致，
 * 而 `localeCompare` 的排序依赖 ICU，macOS 与 CI 上可能不同。
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

  // 用排好序的 ordered 算：否则把章节数组倒过来就会得到「2026 到 2025」
  const ending = pick(ENDING_KEY)
    || derivedEnding(ordered, total || ordered.reduce((sum, chapter) => sum + chapter.items.length, 0));

  return {
    version: STORY_VERSION,
    rev: String(rev || ''),
    chapters: items,
    ending: ending.length > ENDING_MAX ? `${ending.slice(0, ENDING_MAX - 1)}…` : ending,
  };
}

/** 产物是否可用：版本对得上、章节是数组、结束语是字符串 */
export function isStoryUsable(document, { version = STORY_VERSION } = {}) {
  return Boolean(document)
    && typeof document === 'object'
    && Number(document.version) === Number(version)
    && Array.isArray(document.chapters)
    && typeof document.ending === 'string';
}
