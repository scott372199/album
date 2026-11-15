/**
 * 策展产物的**构建期落盘**（V6 T-22）/ Build-time file writing for curation.
 *
 * 规则在 `src/server/curation/rules.mjs`、发布逻辑在 `src/server/curation/publish.mjs`：
 * 线上（处理器 Lambda）也要产出同一份产物，而镜像只 `COPY src/server/`。这里只剩
 * 「写进 `dist/data/`」这一步——线上是写站点桶，产物逐字节相同。
 *
 * Rules and copy live under src/server/curation/ because the runtime image only
 * copies src/server/. This file only writes to dist/; the runtime writes the same
 * bytes to the site bucket.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  curateMonths, labelsFromIndex, applySentences, curationDocument, monthFacts,
} from '../server/curation/rules.mjs';
import { createWriter, llmConfig } from '../server/curation/llm.mjs';

// 只转手，不复制：构建期与线上必须共用同一套规则与版本号
export * from '../server/curation/rules.mjs';

const DATA_SUBDIR = 'data';

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
