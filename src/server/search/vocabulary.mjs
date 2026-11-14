/**
 * V5 中文检索词表 / V5 Chinese search vocabulary.
 *
 * 规范词（canonical term）用小写英文，与索引 labels[].term、前端 LEXICON、
 * Rekognition 规范化输出三方对齐；中文词只用于查询输入与展示。
 *
 * Canonical terms are lowercase and shared by the index labels, the frontend
 * lexicon and the normalized Rekognition output; Chinese phrases are for query
 * input and display only.
 *
 * 本模块是纯数据 + 纯函数，不碰网络、不引入依赖。
 * Pure data plus pure functions: no network, no dependencies.
 */

/**
 * 词表数据：**不再在本文件内定义**。
 *
 * 唯一真相是 `src/shared/lexicon.json`；`scripts/gen-lexicon.mjs` 生成
 * `lexicon.generated.mjs`（与前端那份内容完全一致，因为 Docker 镜像只拷 src/server/，
 * 服务端无法 import `src/web/`）。本模块只保留查询函数。
 *
 * Vocabulary data lives in one JSON source with one generated artifact per
 * consumer; this module keeps only the query helpers.
 */
import {
  LEXICON, LEXICON_KEYS, TERM_ZH, TERM_KIND, COLOR_TERMS, COLOR_OBJECT_COMBINATIONS,
} from './lexicon.generated.mjs';

export {
  LEXICON, LEXICON_KEYS, TERM_ZH, TERM_KIND, COLOR_TERMS, COLOR_OBJECT_COMBINATIONS,
};

export function lookup(phrase) {
  const entry = LEXICON[phrase];
  return entry ? { canonical: entry[0], kind: entry[1] } : null;
}

export function canonicalFor(phrase) {
  return lookup(phrase)?.canonical ?? null;
}

export function zhForTerm(term) {
  return TERM_ZH[term] || (typeof term === 'string' ? term : '');
}

export function kindForTerm(term) {
  return TERM_KIND[term] || 'object';
}

/** 返回映射到同一规范词的所有中文短语（含展示词）/ all Chinese phrases for a term. */
export function expandSynonyms(canonical) {
  return Object.keys(LEXICON).filter((phrase) => LEXICON[phrase][0] === canonical);
}

export function resolveCombination(text) {
  const value = String(text ?? '');
  return COLOR_OBJECT_COMBINATIONS.find((combo) => value.includes(combo.phrase)) || null;
}

/**
 * 契约 searchIndex.shape.vocabulary 形状：
 * { "<中文展示词>": ["<规范词>", "<同义词>", ...] }
 *
 * Contract-shaped vocabulary: Chinese display term -> [canonical, synonyms...].
 */
export function vocabularySnapshot() {
  const groups = new Map();
  for (const [phrase, [canonical]] of Object.entries(LEXICON)) {
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(phrase);
  }
  const out = {};
  for (const [canonical, phrases] of groups) {
    const zh = zhForTerm(canonical);
    const synonyms = phrases.filter((phrase) => phrase !== zh);
    out[zh] = [canonical, ...synonyms];
  }
  return out;
}
