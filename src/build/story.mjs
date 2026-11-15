/**
 * 故事文案的**构建期落盘**（V6 T-23）/ Build-time file writing for story copy.
 *
 * 规则与文案都在 `src/server/curation/story.mjs`：线上（处理器 Lambda）也要产出
 * 同一份产物，而镜像只 `COPY src/server/`，所以规则必须是服务端模块。这里只剩
 * 「写哪两个文件」——构建期写进 `dist/data/`，线上写进站点桶，两者产物逐字节相同。
 *
 * 分组与播放器一致这件事，现在由 `v6-artifact-publish.test.mjs` 的
 * `chaptersOf()` ≟ `buildStory()` 逐键比对来守，不再依赖「构建期恰好调了前端函数」。
 *
 * Rules and copy live in src/server/curation/story.mjs because the runtime image
 * only copies src/server/. This file is just the filesystem writer; grouping
 * parity with the player is now enforced by an equality test.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { labelsFromIndex } from '../server/curation/rules.mjs';
import { chaptersOf, storyDocument, storyJobs } from '../server/curation/story.mjs';

// 只转手，不复制：构建期与线上必须共用同一份 STORY_VERSION
export * from '../server/curation/story.mjs';

const DATA_SUBDIR = 'data';

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
  log = console.log,
} = {}) {
  if (!dist) throw new Error('writeStoryArtifacts 需要 dist 目录');
  const labelsById = labelsFromIndex(index || {});

  const { chapters } = chaptersOf(Array.isArray(photos) ? photos : []);
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
