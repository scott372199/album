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

/* ---------------- T-21：五类失败原因 ---------------- */

/**
 * 失败只有五类，别的都不该让用户看见。
 *
 * 分类依据是**用户能采取什么行动**，不是异常长什么样：
 *   网络   → 换个网络 / 等一下重试
 *   权限   → 重新登录
 *   太大   → 换个小一点的，或分段拍
 *   格式   → 先导出成 JPEG
 *   服务   → 服务端的问题，等一会儿
 *
 * 分类结果只用来选一句话，所以它**不能带上任何实现细节**——URL、HTTP 状态码、
 * 对象 key 都不出现在文案里（单测钉住）。
 *
 * Five classes, chosen by what the user can actually do about it. The class only
 * picks a sentence, so no URLs, status codes or object keys may appear in it.
 */
export const FAILURE_KINDS = Object.freeze(['network', 'auth', 'too-large', 'unsupported', 'server', 'unreadable']);

export const FAILURE_LABELS = Object.freeze({
  network: '网络不稳定，换个网络或稍后再试',
  auth: '登录已过期，请重新登录后再传',
  'too-large': '文件太大，请换一个小一点的',
  unsupported: '格式不支持，请先导出成 JPEG',
  server: '服务暂时不可用，过一会儿再试',
  // 系统把文件句柄回收了（见下方 resetPicker 的注释），只能重新选，重试没有意义
  unreadable: '这张已经读不到了，请重新选一次',
});

/**
 * 归类。判据只有 `status` 与 `retryable` 这两个我们自己写上去的字段：
 * 不去啃服务端的错误字符串——那是最容易夹带内部信息的地方。
 */
export function classifyFailure(err) {
  const status = Number(err?.status);
  // 0 = 连接层失败（断网、被重置、超时），浏览器不区分，我们也别假装能区分
  if (status === 0) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported';
  if (status >= 500) return 'server';
  if (err?.kind === 'too-large' || err?.kind === 'unsupported' || err?.kind === 'unreadable') return err.kind;
  if (err?.retryable) return 'network';
  return 'server';
}

export function failureLabel(err) {
  return FAILURE_LABELS[classifyFailure(err)] || FAILURE_LABELS.server;
}

/**
 * 把「文件读不到了」认出来 / Recognise a stale file reference.
 *
 * 真实事故（2026-11-15 线上验收）：选 22 张只成功 3 张，其余报 `The requested
 * file could not be read …`。根因是我们自己在 change 里同步写了 `input.value = ''`，
 * Chromium 立刻作废这批 `File` 的引用；已缓冲好的那几张还能读。
 *
 * 这里只做识别与话术，修法在 upload.js（见 canResetPicker）。
 */
const UNREADABLE = /could not be read|permission problems|not ?readable/i;

export function asReadFailure(err) {
  const name = String(err?.name || '');
  if (name !== 'NotReadableError' && !UNREADABLE.test(String(err?.message || ''))) return null;
  const wrapped = new Error(FAILURE_LABELS.unreadable);
  wrapped.kind = 'unreadable';
  wrapped.cause = err;
  return wrapped;
}

/**
 * 现在能不能安全地清空选择器 / May the picker be reset now?
 *
 * 清空 `<input type=file>` 会作废这一批 `File` 的引用，所以只在没人还需要它们时
 * 才能清：没有进行中的批次，也没有留着等重试的条目。否则不清——代价只是「再选
 * 同一批文件不会触发 change」，那是小事。
 */
export function canResetPicker({ busy = false, failed = [] } = {}) {
  if (busy) return false;
  return !(failed && failed.length);
}

/* ---------------- T-21：断点续传 ---------------- */

export const PART_SIZE_HINT = 8 * 1024 * 1024;

/**
 * 续传的边界：**能续，但只在同一次签名有效期内**。
 *
 * 服务端每次取地址都会 `CreateMultipartUpload`，所以 uploadId 是新的，旧 etag
 * 对新 uploadId 无效。真正跨刷新的续传需要服务端 `ListParts` 复用 uploadId ——
 * 那是接口改动，不在本任务范围内。这里做的是**同一次上传内**的续传：重试时
 * 沿用同一批预签名地址（15 分钟有效），已经拿过 etag 的分片直接跳过。
 *
 * 所以「重试时又传了一遍全量」这个最费流量的问题被解决了，而刷新页面后重选
 * 同一个文件仍会从头传——这一点在界面上不承诺，也不会假装能做到。
 *
 * Resume is bounded by one signing session: the server creates a new multipart
 * uploadId per request, so old etags are invalid for a new one. Real
 * cross-reload resume needs a server-side ListParts, which is out of scope;
 * within one session already-uploaded parts are skipped.
 */
export function remainingParts(parts, etags) {
  const done = new Set((Array.isArray(etags) ? etags : []).map((item) => Number(item?.partNumber)));
  return (Array.isArray(parts) ? parts : []).filter((part) => !done.has(Number(part?.partNumber)));
}

/** 这一轮实际要发的字节数；用来验证「续传字节数 < 全量」 */
export function bytesForParts(totalBytes, partSize, parts) {
  const total = Number(totalBytes) || 0;
  const size = Number(partSize) || 0;
  if (!total || !size) return 0;
  let sum = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    const start = (Number(part.partNumber) - 1) * size;
    const end = Math.min(start + size, total);
    if (end > start) sum += end - start;
  }
  return sum;
}

/** 预签名地址的有效期（服务端 15 分钟）；留 1 分钟余量再判定过期 */
export const SIGNED_TTL_MS = 14 * 60 * 1000;

export function signedStillValid(signedAt, now = Date.now(), ttl = SIGNED_TTL_MS) {
  const at = Number(signedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at < ttl;
}

/**
 * 照片 ID 就是**内容哈希前 12 位**——和 `handler.mjs` 里的 `sha.slice(0, 12)`
 * 是同一条规则。放在这里是为了能被单测钉住：这条规则一旦和服务端分开演化，
 * 「去看看」就会稳定地跳到一个不存在的 ID。
 */
export function photoIdFor(sha) {
  const text = String(sha || '');
  return /^[0-9a-f]{12,}$/i.test(text) ? text.slice(0, 12) : '';
}
