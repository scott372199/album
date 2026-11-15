/**
 * 策展产物的落盘（V6 T-22）/ Writing the curation artifact.
 *
 * 与规则（`curation.mjs`）分开是为了让这一层能被测：规则是纯函数，这里做的是
 * 「写哪两个文件、写不出来怎么办、一次块都没有时写不写」。把文件系统与模型
 * 都做成可注入的，验收里那条「同一 rev 重复构建 sha 相同」才有执行的可能。
 *
 * Split from the pure rules so this layer is testable: which two files, what
 * happens on failure, and whether anything is written when no month qualifies.
 * Filesystem and model are injectable so "same rev rebuilds byte-identically" is
 * an executable assertion rather than a promise.
 *
 * 双写沿用搜索索引的既有约定（plan §5）：
 *   `data/curation.<rev>.json`  不可变，可长缓存，是主路径
 *   `data/curation.json`        固定名兜底，短缓存，给「rev 版还没生成」的时刻
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { curateMonths, labelsFromIndex, applySentences, curationDocument } from './curation.mjs';
import { createWriter, llmConfig } from './llm.mjs';

/** 产物目录：站点静态资源下的 data/ */
const DATA_SUBDIR = 'data';

/** 给模型的事实：只要「几张」与「出现过的中文词」，多一个字段都是在扩大公开面 */
export function monthFacts(month, labelsById) {
  const counts = new Map();
  for (const id of month.picks) {
    for (const label of labelsById.get(id) || []) {
      const zh = typeof label.zh === 'string' ? label.zh.trim() : '';
      if (zh) counts.set(zh, (counts.get(zh) || 0) + 1);
    }
  }
  const words = [...counts.entries()]
    // 词频降序，同频按码点序：任何机器上都得到同一句提示词
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 6)
    .map(([word]) => word);
  return { count: month.count, words };
}

/**
 * 产出并写入策展产物。
 *
 * 返回 `null` 的两种情形都是**成功**，不是失败：
 *   - 一个月份都凑不齐 9 张 → 不写文件（写一份空 months 只会让线上多一个要解释的文件）
 *   - 模型不可用 → 精选照写，只是没有那句导读
 *
 * Both null paths are successes, not failures: nothing qualifies (so nothing is
 * written), or no model (so the picks ship without the sentence).
 */
export async function writeCurationArtifacts({
  photos,
  rev,
  dist,
  index = null,
  writer = null,
  cacheDir = '',
  warn = console.warn,
  log = console.log,
} = {}) {
  if (!dist) throw new Error('writeCurationArtifacts 需要 dist 目录');
  const labelsById = labelsFromIndex(index);
  if (!labelsById.size) warn('策展：本地没有语义索引，清晰度与多样性两项按空处理');

  const months = curateMonths({ items: photos, labelsById });
  if (!months.length) {
    warn('策展：没有月份凑齐 9 张，本次不产出策展产物');
    return null;
  }

  const sentenceWriter = writer || createWriter({ config: llmConfig(), cacheDir, logger: warn });
  if (!sentenceWriter.enabled) warn('策展：没有配置模型凭据，精选照出，导读句留空');
  const sentences = await sentenceWriter.write(rev, months.map((month) => ({
    key: month.key,
    facts: monthFacts(month, labelsById),
  })));

  const document = curationDocument({ rev, months: applySentences(months, sentences) });
  const json = JSON.stringify(document);
  const dir = path.join(dist, DATA_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `curation.${rev}.json`), json);
  await writeFile(path.join(dir, 'curation.json'), json);

  const withSentence = document.months.filter((month) => month.sentence).length;
  log(`策展：${document.months.length} 个月，其中 ${withSentence} 个月带导读句`);
  return document;
}
