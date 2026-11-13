/**
 * V5 上传状态五态模型 / V5 five-state upload model.
 *
 * 明确区分 queued / uploading / processing / published / failed，
 * 失败可重试，且对外投影不含任何凭据、手机号或内部路径。
 * 纯逻辑 + 一个轻量的图例挂载；不改动 v4 已验收的上传/分片链路。
 *
 * Distinguishes queued / uploading / processing / published / failed. Failed is
 * retryable and public projections never carry credentials, phone numbers or
 * internal paths. Pure logic plus a small legend mount; the accepted v4 upload
 * / multipart chain is left untouched.
 */

export const UPLOAD_STATES = Object.freeze([
  'queued', 'uploading', 'processing', 'published', 'failed',
]);

export const STATE_LABELS = Object.freeze({
  queued: '等待上传',
  uploading: '上传中',
  processing: '处理中',
  published: '已上传',
  failed: '上传失败，可重试',
});

/** 合法状态迁移 / Allowed state transitions */
const TRANSITIONS = Object.freeze({
  queued: ['uploading', 'failed'],
  uploading: ['processing', 'published', 'failed'],
  processing: ['published', 'failed'],
  published: [],
  failed: ['queued'],
});

/** 绝不对外出现的字段 / Fields that must never be projected */
const UNSAFE_FIELDS = [
  'accessKey', 'authorization', 'key', 'originalFilename', 'originalUrl',
  'password', 'phone', 'phoneNumber', 'secret', 'sourcePath', 'token', 'url',
];

/** 允许对外出现的字段 / Fields allowed in a public projection */
const SAFE_FIELDS = ['id', 'name', 'state', 'progress', 'attempts'];

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function isRetryable(state) {
  return state === 'failed';
}

export function labelFor(state) {
  return STATE_LABELS[state] || STATE_LABELS.queued;
}

export function stateClass(state) {
  return state ? `is-${state}` : '';
}

/** 递归查找敏感字段 / Recursively find unsafe field names */
export function findUnsafe(value, prefix = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (UNSAFE_FIELDS.includes(key)) found.push(path);
    if (val && typeof val === 'object') findUnsafe(val, path, found);
  }
  return found;
}

/** 公开投影只保留白名单字段 / Public projection keeps whitelisted fields only */
export function projectPublic(entry, extra = {}) {
  const src = { ...entry, ...extra };
  const out = {};
  for (const field of SAFE_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  return out;
}

/**
 * 可操作、不泄露实现细节的失败文案。
 * 不带 URL、状态码、异常消息或对象 key。
 *
 * Actionable failure text with no URLs, status codes, exception messages or
 * object keys.
 */
export function safeFailure(err) {
  if (err && err.retryable === false) {
    return '这次没有上传成功。请检查网络，再点「重试失败项」试一次。';
  }
  return '上传中断，文件已保留。请点「重试失败项」再试一次。';
}

export function createTracker() {
  const entries = new Map();
  return {
    set(id, state, detail = {}) {
      entries.set(id, { id, state, ...projectPublic(detail) });
      return entries.get(id);
    },
    get(id) { return entries.get(id) || null; },
    retryable() {
      return [...entries.values()].filter((entry) => isRetryable(entry.state)).map((entry) => entry.id);
    },
    summarize() {
      const counts = {};
      for (const state of UPLOAD_STATES) counts[state] = 0;
      for (const entry of entries.values()) counts[entry.state] = (counts[entry.state] || 0) + 1;
      return counts;
    },
    all() { return [...entries.values()]; },
    clear() { entries.clear(); },
  };
}

/** 把五个状态渲染成可见图例（明确区分）/ Render the five states as a visible legend */
export function mountUploadLegend(host) {
  if (!host || typeof document === 'undefined') return;
  host.replaceChildren();
  for (const state of UPLOAD_STATES) {
    const badge = document.createElement('span');
    badge.className = `upload-badge ${stateClass(state)}`;
    badge.dataset.state = state;
    badge.textContent = labelFor(state);
    host.appendChild(badge);
  }
}
