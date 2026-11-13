/**
 * RecognitionProvider port / 识别供应商端口.
 *
 * 供应商差异被挡在这个端口后面：worker 只依赖 detectLabels(input)，
 * 不认识 AWS SDK、命令对象或模型原始响应。
 *
 * Vendor differences stay behind this port: the worker only depends on
 * detectLabels(input) and knows nothing about the AWS SDK, command objects
 * or raw model responses.
 *
 * 这里的守卫是「任何情况下不返回 raw response」的最后一道：
 * 只保留 {term, zh, kind, confidence} 四个白名单字段。
 *
 * This is the last guard for "never return a raw response": only the four
 * whitelisted fields {term, zh, kind, confidence} survive.
 */
import { findForbidden, FORBIDDEN_FIELDS } from '../v5/correlation.mjs';

export const LABEL_KINDS = ['object', 'scene', 'color'];

/** AWS / 常见模型响应里的原始字段，出现即视为泄漏 / raw-response hints. */
export const RAW_RESPONSE_KEYS = [
  'raw', 'rawResponse', 'rawResult', 'ResponseMetadata', '$metadata',
  'Labels', 'ImageProperties', 'DetectLabelsResponse', 'Instances', 'Parents',
];

/** 抽象 port：adapter 必须实现 detectLabels / adapters must implement detectLabels. */
export class RecognitionProvider {
  // eslint-disable-next-line class-methods-use-this
  async detectLabels() {
    throw new Error(
      'RecognitionProvider.detectLabels 必须由 adapter 实现 / must be implemented by an adapter',
    );
  }
}

/** 鸭子类型校验：可注入 fake，不要求继承 / duck-typed, so fakes need not subclass. */
export function assertProvider(provider) {
  if (!provider || typeof provider.detectLabels !== 'function') {
    throw new TypeError('不是合法的 RecognitionProvider / invalid RecognitionProvider');
  }
  return provider;
}

/** 可重试的供应商错误类别 / retryable provider error classes. */
export const RETRYABLE_ERROR_CLASSES = [
  'provider-throttled', 'provider-timeout', 'provider-unavailable',
];

/**
 * 供应商错误：带 errorClass 与 retryable，供 worker 决定重试还是入 DLQ。
 * 消息里绝不携带原始响应。
 *
 * Provider error with errorClass/retryable so the worker can retry or send to
 * the DLQ. It never carries a raw response.
 */
export class RecognitionProviderError extends Error {
  constructor(message, { errorClass = 'provider-unavailable', retryable = true } = {}) {
    super(message);
    this.name = 'RecognitionProviderError';
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}

export function isRetryableProviderError(err) {
  if (err instanceof RecognitionProviderError) return err.retryable === true;
  return typeof err?.errorClass === 'string' && RETRYABLE_ERROR_CLASSES.includes(err.errorClass);
}

/** confidence 必须是单个有限 float ∈ [0,1] / a single finite float in [0,1]. */
export function isFiniteConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 规范化标签：只挑白名单字段、去重、按置信度倒序确定性排序。
 * 绝不 spread 原始响应对象；任何形状不合法的标签直接抛错，而不是静默丢弃。
 *
 * Normalize labels: whitelist fields only, de-duplicate, deterministic sort.
 * Never spread a raw response; malformed labels throw instead of being dropped.
 */
export function normalizeLabels(labels) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(labels) ? labels : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const term = typeof raw.term === 'string' ? raw.term.trim().toLowerCase() : '';
    const { kind, confidence } = raw;
    if (!term || !LABEL_KINDS.includes(kind) || !isFiniteConfidence(confidence)) {
      throw new TypeError('标签形状非法 / invalid normalized label');
    }
    const key = `${term}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term,
      zh: typeof raw.zh === 'string' ? raw.zh : '',
      kind,
      confidence,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence || a.term.localeCompare(b.term));
  return out;
}

/**
 * 结果守卫：扫描禁止字段与 raw response 提示键，命中即拒绝。
 * 这是「原始模型响应绝不进产物/日志」的强保证。
 *
 * Result guard: reject forbidden fields and raw-response hint keys. This is the
 * hard guarantee that raw model responses never enter artifacts or logs.
 */
export function assertNoRawResponse(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  for (const key of RAW_RESPONSE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`识别结果含原始响应字段 / raw response field leaked: ${key}`);
    }
  }
  const hits = findForbidden(result);
  if (hits.length) {
    throw new Error(`识别结果含禁止字段 / forbidden fields leaked: ${hits.join(', ')}`);
  }
  return result;
}

export { FORBIDDEN_FIELDS };

/**
 * recognition.event 的标签形状是 {name, confidence, category}，
 * 与索引的 {term, zh, kind, confidence} 不同；这里做显式转换。
 *
 * recognition.event labels are {name, confidence, category}, distinct from
 * index labels {term, zh, kind, confidence}; convert explicitly here.
 */
export function toEventLabels(labels) {
  return normalizeLabels(labels).map((label) => ({
    name: label.term,
    confidence: label.confidence,
    category: label.kind,
  }));
}
