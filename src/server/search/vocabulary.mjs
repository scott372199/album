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
 * 中文词 → [规范词, 查询类别]。
 * 查询类别 kind ∈ term|synonym|color，只用于 explanation.kind；
 * 与索引标签的 object|scene|color 是两套不同的分类，见 TERM_KIND。
 *
 * Chinese phrase -> [canonical term, query kind].
 * The query kind (term|synonym|color) feeds explanation.kind; it is distinct
 * from the index label kind (object|scene|color) in TERM_KIND.
 */
export const LEXICON = {
  // 场景 / scene
  '湖水': ['lake', 'term'],
  '湖泊': ['lake', 'synonym'], '湖': ['lake', 'synonym'],
  '水面': ['lake', 'synonym'], '湖景': ['lake', 'synonym'],
  '山峰': ['mountain', 'term'],
  '山': ['mountain', 'synonym'], '群山': ['mountain', 'synonym'],
  '高山': ['mountain', 'synonym'], '雪山': ['mountain', 'synonym'],
  '山峦': ['mountain', 'synonym'],
  '蓝天': ['blue sky', 'term'],
  '青天': ['blue sky', 'synonym'], '天空': ['blue sky', 'synonym'],
  '晴空': ['blue sky', 'synonym'], '蓝天白云': ['blue sky', 'synonym'],
  // 物体 / object
  '汽车': ['car', 'term'],
  '轿车': ['car', 'synonym'], '小汽车': ['car', 'synonym'],
  '车子': ['car', 'synonym'], '车辆': ['car', 'synonym'],
  '摩托车': ['motorcycle', 'term'],
  '机车': ['motorcycle', 'synonym'], '摩托': ['motorcycle', 'synonym'],
  '电单车': ['motorcycle', 'synonym'],
  '衬衫': ['shirt', 'term'], '衬衣': ['shirt', 'synonym'],
  // 颜色 / color
  '红色': ['red', 'color'], '红': ['red', 'color'],
  '蓝色': ['blue', 'color'], '蓝': ['blue', 'color'],
  '绿色': ['green', 'color'], '绿': ['green', 'color'],
  '白色': ['white', 'color'], '白': ['white', 'color'],
  '黑色': ['black', 'color'], '黑': ['black', 'color'],
  '黄色': ['yellow', 'color'], '黄': ['yellow', 'color'],
};

/** 规范词 → 索引标签类别 / canonical term -> index label kind. */
export const TERM_KIND = {
  lake: 'scene', mountain: 'scene', 'blue sky': 'scene',
  car: 'object', motorcycle: 'object', shirt: 'object',
  red: 'color', blue: 'color', green: 'color',
  white: 'color', black: 'color', yellow: 'color',
};

/** 规范词 → 中文展示词（也供识别器回填 labels[].zh）/ canonical -> Chinese display. */
export const TERM_ZH = {
  lake: '湖水', mountain: '山峰', 'blue sky': '蓝天', sky: '天空',
  car: '汽车', motorcycle: '摩托车', shirt: '衬衫',
  red: '红色', blue: '蓝色', green: '绿色',
  white: '白色', black: '黑色', yellow: '黄色',
  nature: '自然', outdoors: '户外', water: '水面', vehicle: '车辆',
  clothing: '服饰', apparel: '服装', transportation: '交通工具',
};

export const COLOR_TERMS = new Set(['red', 'blue', 'green', 'white', 'black', 'yellow']);

/**
 * 颜色 + 物体组合：把「红色衬衫」显式登记为 color=red / term=shirt。
 * query.mjs 会把命中的组合拆成两段，保证 explanation 顺序稳定且可解释。
 *
 * Color + object combinations: 「红色衬衫」 is explicitly registered as
 * color=red / term=shirt. query.mjs splits a matched combination into two
 * phrases so the explanation order stays deterministic and explainable.
 */
export const COLOR_OBJECT_COMBINATIONS = [
  { phrase: '红色衬衫', colorPhrase: '红色', termPhrase: '衬衫', color: 'red', term: 'shirt' },
  { phrase: '蓝色汽车', colorPhrase: '蓝色', termPhrase: '汽车', color: 'blue', term: 'car' },
  { phrase: '白色摩托车', colorPhrase: '白色', termPhrase: '摩托车', color: 'white', term: 'motorcycle' },
];

/** 最长优先，保证「蓝天白云」不会被「蓝天」截断 / longest match first. */
export const LEXICON_KEYS = Object.keys(LEXICON).sort((a, b) => b.length - a.length);

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
