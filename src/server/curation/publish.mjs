/**
 * 策展与故事文案的发布（V6 T-22 / T-23）/ Publish the two build-time artifacts.
 *
 * 由服务端发布者在**写完搜索索引的同一时刻**调用，于是「新照片进索引」和
 * 「精选/文案跟上」是同一件事，不存在一段产物比照片落后的窗口。
 *
 * 四条纪律：
 *   1. **只写白名单里的 key**：`data/curation[.rev].json`、`data/story[.rev].json`。
 *      越界直接抛——那是编程错误，不该被当成数据问题悄悄绕过。
 *   2. **rev 版不可变 + 固定名 no-store**：与 `data/search-index.*` 同一套缓存策略。
 *   3. **写不出来不影响照片上线**：调用方（`publishRecognition`）已经把这一步包住，
 *      这里把错误如实抛出，不吞。
 *   4. **没有模型凭据就不写那一句话**：精选照发、故事用派生文案；配了凭据就带上。
 *
 * Called right after the search index is written, so a new photo and its curation
 * never disagree. Whitelisted keys only, same caching policy as the index, failures
 * surface to the (contained) caller, and no credentials simply means no sentence.
 */

import {
  curateMonths, labelsFromIndex, applySentences, curationDocument, monthFacts,
} from './rules.mjs';
import { chaptersOf, storyJobs, storyDocument } from './story.mjs';
import { createWriter, llmConfig } from './llm.mjs';
import { CONTRACT } from '../v5/correlation.mjs';

/** 允许写的两个产物名 / the only two artifact names this publisher may write */
export const ARTIFACT_NAMES = ['curation', 'story'];

/** rev 只接受 8–64 位十六进制，与前端 `loadArtifact` 的正则同源 */
export const ARTIFACT_REV_PATTERN = /^[0-9a-f]{8,64}$/i;

/**
 * 文案生成的总时限。产物本身不依赖模型（没有就写派生文案），所以这笔时间
 * 只能花在「顺手把话说得更好听」上，不能拖住处理函数。
 */
export const SENTENCE_BUDGET_MS = 15000;

const PATTERNS = new Map(ARTIFACT_NAMES.map((name) => [
  name,
  new RegExp(`^data/${name}(\\.[0-9a-f]{8,64})?\\.json$`, 'i'),
]));

/**
 * 唯一允许写入的 key。其它前缀、路径穿越、绝对地址一律拒绝——发布者的写权限
 * 边界靠这一层代码 + IAM 双重守住，不能只靠其中一边。
 */
export function assertArtifactKey(key) {
  if (typeof key !== 'string') throw new Error('非法产物 key / invalid artifact key');
  for (const pattern of PATTERNS.values()) if (pattern.test(key)) return key;
  throw new Error(`非法产物 key / invalid artifact key: ${String(key).slice(0, 80)}`);
}

/** `data/<name>.<rev>.json`；rev 不认识时返回空串（只写固定名，前端仍能兜底） */
export function versionedKey(name, rev) {
  const clean = String(rev || '').trim();
  if (!ARTIFACT_REV_PATTERN.test(clean)) return '';
  return assertArtifactKey(`data/${name}.${clean}.json`);
}

/** 固定名：`data/<name>.json`，rev 版缺失时前端退回它 */
export function fixedKey(name) {
  return assertArtifactKey(`data/${name}.json`);
}

async function putBoth(store, bucket, name, body, rev) {
  const head = { contentType: 'application/json; charset=utf-8' };
  const bytes = Buffer.from(body, 'utf8');
  const versioned = versionedKey(name, rev);
  if (versioned) {
    await store.putBuffer(bucket, versioned, bytes, {
      ...head,
      cacheControl: store.CACHE_IMMUTABLE || 'public, max-age=31536000, immutable',
    });
  }
  await store.putBuffer(bucket, fixedKey(name), bytes, {
    ...head,
    cacheControl: store.CACHE_NO_STORE || 'no-store',
  });
  return versioned || fixedKey(name);
}

/**
 * 给模型调用加一个总时限。这一步跑在处理 Lambda 里，照片已经上线、索引已经写好，
 * 唯一不能发生的就是「为了几句文案把函数跑超时」。超时就当没有文案，
 * 派生文案照样成产物。
 */
async function withinDeadline(promise, ms, fallback) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 产出并发布两个产物。
 *
 * `items` 是索引条目（`{ id, labels }`），用来算清晰度、多样性与副标题用词；
 * 拿不到就当作没有索引——精选降级为「比例 + featured」，副标题只报张数。
 *
 * 返回摘要供 trace 使用；`curation.key` 为空串表示「没有月份凑齐 9 张」，
 * 此时不写文件（空产物只会让线上多一个需要解释的对象）。
 */
export async function publishArtifacts({
  store,
  bucket,
  rev = '',
  photos = [],
  items = null,
  writer = null,
  sentenceBudgetMs = SENTENCE_BUDGET_MS,
  log = console,
} = {}) {
  if (!store || typeof store.putBuffer !== 'function') {
    throw new Error('publishArtifacts 需要可注入的 store');
  }

  const labelsById = labelsFromIndex({ items: Array.isArray(items) ? items : [] });
  const months = curateMonths({ items: photos, labelsById });

  // 一句导读由模型写；没凭据就是没有（不编模板句）。
  // 精选与故事共用同一个写入器：同一次运行、同一个 rev，缓存只需读一遍。
  const sentenceWriter = writer || createWriter({ config: llmConfig(), cacheDir: '', logger: () => {} });
  const ask = (jobs) => withinDeadline(
    Promise.resolve(sentenceWriter.write(String(rev), jobs)).catch(() => new Map()),
    sentenceBudgetMs,
    new Map(),
  );

  let sentences = new Map();
  if (months.length && sentenceWriter.enabled) {
    sentences = await ask(months.map((month) => ({
      key: month.key,
      facts: monthFacts(month, labelsById),
    })));
  }
  const curation = curationDocument({ rev, months: applySentences(months, sentences) });
  let curationKey = '';
  if (curation.months.length) {
    curationKey = await putBoth(store, bucket, 'curation', JSON.stringify(curation), rev);
  }

  const { chapters } = chaptersOf(photos);
  let copy = new Map();
  if (chapters.length && sentenceWriter.enabled) {
    copy = await ask(storyJobs(chapters, labelsById));
  }
  const story = storyDocument({ rev, chapters, labelsById, copy });
  const storyKey = await putBoth(store, bucket, 'story', JSON.stringify(story), rev);

  log.info?.('artifacts.published', {
    curationMonths: curation.months.length,
    curationKey,
    storyChapters: story.chapters.length,
    storyKey,
    sentences: sentences.size + copy.size,
  });

  return {
    curation: { months: curation.months.length, key: curationKey, sentences: sentences.size },
    story: { chapters: story.chapters.length, key: storyKey, sentences: copy.size },
  };
}

/**
 * 契约里的归属记录，供契约测试断言。两个产物的写者与搜索索引是同一个发布者，
 * 所以 IAM 只需要在既有策略里加两条资源，不需要新主体。
 */
export function ownership(name = 'curation') {
  return CONTRACT.s3PrefixOwnership[`data/${name}.<rev>.json`];
}
