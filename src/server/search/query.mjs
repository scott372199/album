/**
 * V5 中文自然语言查询解析 / V5 Chinese natural-language query parsing.
 *
 * 把自然语言解析成契约 queryContract.parseResult 形状：
 * { terms, filters:{year,month,colors,tags}, explanation, page, pageSize }。
 * 每条映射都在 explanation 里给出 kind/input/mappedTo，便于前端解释空结果。
 *
 * Parse natural language into the contract parseResult shape; every mapping is
 * recorded in `explanation` (kind/input/mappedTo) so the UI can explain results.
 *
 * 纯逻辑、零依赖、可离线运行；不暴露任何模型原始响应。
 * Pure logic, zero dependencies, offline; no raw model response is exposed.
 */
import { CONTRACT } from '../v5/correlation.mjs';
import {
  LEXICON, LEXICON_KEYS, COLOR_OBJECT_COMBINATIONS,
} from './vocabulary.mjs';

export const EXPLANATION_KINDS = ['term', 'synonym', 'year', 'month', 'color'];
export const QUERY_MAX_LENGTH = CONTRACT.search.query.properties.query.maxLength;
export const PAGE_SIZE_MAX = CONTRACT.search.query.properties.pageSize.maximum;
export const TAGS_MAX = CONTRACT.search.query.properties.filters.properties.tags.maxItems;
export const DEFAULT_PAGE_SIZE = 40;

/** 分页参数校验：非法值回退到安全默认，绝不抛给调用方 / clamp, never throw. */
export function validatePagination(page, pageSize) {
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= PAGE_SIZE_MAX
      ? pageSize : DEFAULT_PAGE_SIZE,
  };
}

function scanChunk(chunk, ctx) {
  let i = 0;
  while (i < chunk.length) {
    const key = LEXICON_KEYS.find((candidate) => chunk.startsWith(candidate, i));
    if (!key) { i += 1; continue; }
    const [canonical, kind] = LEXICON[key];
    if (kind === 'color') {
      if (!ctx.filters.colors.includes(canonical)) ctx.filters.colors.push(canonical);
      ctx.explanation.push({ kind: 'color', input: key, mappedTo: canonical });
    } else {
      if (!ctx.terms.includes(canonical)) ctx.terms.push(canonical);
      if (!ctx.filters.tags.includes(canonical)) ctx.filters.tags.push(canonical);
      ctx.explanation.push({ kind, input: key, mappedTo: canonical });
    }
    i += key.length;
  }
}

/**
 * 解析查询。覆盖六个示例、同义词、年月、颜色与组合：
 * 湖水 / 山峰 / 蓝天 / 汽车 / 摩托车 / 红色衬衫 / 2025 年 /
 * 「2025 年的蓝天和汽车」。
 *
 * Parse a query covering all contract examples, synonyms, year/month, colors
 * and combinations such as 「2025 年的蓝天和汽车」.
 */
export function parseQuery(raw, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const original = String(raw ?? '').slice(0, QUERY_MAX_LENGTH);
  let rest = original.normalize('NFKC');
  const explanation = [];
  const terms = [];
  const filters = { year: null, month: null, colors: [], tags: [] };

  // 年份：优先「2025 年」，其次独立的四位年份 / year, with 年 suffix preferred
  const yearMatch = rest.match(/(\d{4})\s*年/) || rest.match(/(?:^|\s)(\d{4})(?=\s|$)/);
  const yearRange = CONTRACT.search.query.properties.filters.properties.year;
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year >= yearRange.minimum && year <= yearRange.maximum) {
      filters.year = year;
      explanation.push({ kind: 'year', input: yearMatch[0].trim(), mappedTo: String(year) });
      rest = rest.replace(yearMatch[0], ' ');
    }
  }

  // 月份：只接受 1..12 / month, only 1..12
  const monthRange = CONTRACT.search.query.properties.filters.properties.month;
  const monthMatch = rest.match(/(\d{1,2})\s*月/);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    if (month >= monthRange.minimum && month <= monthRange.maximum) {
      filters.month = month;
      explanation.push({ kind: 'month', input: monthMatch[0].trim(), mappedTo: String(month) });
      rest = rest.replace(monthMatch[0], ' ');
    }
  }

  // 颜色+物体组合先拆成两段，保证 color 在前、term 在后的稳定解释顺序
  // Split registered color+object combos first for a deterministic explanation
  for (const combo of COLOR_OBJECT_COMBINATIONS) {
    if (rest.includes(combo.phrase)) {
      rest = rest.replaceAll(combo.phrase, `${combo.colorPhrase} ${combo.termPhrase}`);
    }
  }

  // 去掉语气/连接词，再按最长前缀匹配词表
  // Strip filler words, then longest-prefix match against the lexicon
  rest = rest.replace(/[的和与及了的\s,，、;；]+/g, ' ');
  for (const chunk of rest.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/g) || []) {
    scanChunk(chunk, { explanation, terms, filters });
  }
  filters.tags = filters.tags.slice(0, TAGS_MAX);

  return { terms, filters, explanation, ...validatePagination(page, pageSize) };
}

/**
 * 导出成契约 search.query 形状。注意契约 filters 不含 colors
 * （additionalProperties: false），颜色条件只保留在 parse.filters 内部。
 *
 * Export as the contract search.query shape. The contract filters exclude
 * colors (additionalProperties: false); color conditions stay in parse only.
 */
export function toQuery(parse, raw = '') {
  const filters = {};
  if (parse.filters.year != null) filters.year = parse.filters.year;
  if (parse.filters.month != null) filters.month = parse.filters.month;
  if (parse.filters.tags.length) filters.tags = parse.filters.tags.slice(0, TAGS_MAX);
  return {
    query: String(raw).slice(0, QUERY_MAX_LENGTH),
    filters,
    page: parse.page,
    pageSize: parse.pageSize,
  };
}
