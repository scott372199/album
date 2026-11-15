import { el, toast } from './ui.js';
import { hasNativeBridge } from './native.js';
import { labelFor } from './upload-state.js';

/**
 * 上传面板：登录 → 选图 → 直传 S3。
 *
 * 四条约束决定了这里的设计：
 *
 * 1. **入口只在安卓壳里出现**（存在原生桥且构建时配了接口地址）。
 *    站点本身是「只读相册」，浏览器访问者不该看到上传按钮。
 * 2. **不上报 takenAt**。浏览器只能拿到 File.lastModified（文件修改时间，
 *    常常是拷贝时间），而处理函数的时间优先级是 takenAt → EXIF → LastModified，
 *    上报 mtime 反而会盖掉真实的 EXIF 拍摄时间。让服务端读 EXIF 更准。
 * 3. **HEIC 转换失败就不传**。服务端镜像里的 sharp 不带 libheif，解不了 HEIC，
 *    原样上传只会进死信队列；与其静默失败，不如当场告诉用户换个格式。
 * 4. **单张 PUT 必须重试**。手机网络到新加坡的 S3 是一次长连接，
 *    连接被重置时浏览器只给 `xhr.onerror`（status 0），既不知道原因也没有补
 *    偿；一次 5 张里抖掉 1~2 张是常态。重传是幂等的（key 是内容哈希，
 *    重签地址 15 分钟有效），所以直接重试，而不是把失败丢给用户。
 *
 * Upload panel: login, pick, direct-to-S3.
 *   1. Only inside the Android shell — the site itself is a read-only album.
 *   2. takenAt is never sent: the browser only has File.lastModified, which would
 *      shadow the real EXIF capture time on the server.
 *   3. Undecodable HEIC is refused rather than uploaded: the server-side sharp has
 *      no libheif, so the object would only end up in the DLQ.
 *   4. A single PUT is retried. One long-lived connection to S3 in Singapore gets
 *      reset often on mobile networks, and the browser reports that only as
 *      `xhr.onerror` (status 0). Re-uploading is idempotent (the key is the content
 *      hash, the presigned URL lives 15 minutes), so retry instead of surfacing it.
 */

import { buildSuggestion, suggestionNote } from './upload-suggest.js';
import {
  failureLabel, remainingParts, signedStillValid, photoIdFor,
} from './upload-state.js';

const MAX_BATCH = 20;
/** 3 次重试的等待时间（毫秒），总补偿 ≈ 13 秒，压在预签名 15 分钟有效期之内 */
const RETRY_DELAYS = [1200, 3500, 8000];
const TOKEN_KEY = 'album.token';
const REFRESH_KEY = 'album.refresh';
const HEIC = /\.hei[cf]$/i;

const state = {
  token: '',
  refresh: '',
  busy: false,
  /** 本次会话里失败、仍可重试的条目（保留 blob，点「重试失败项」直接续传） */
  failed: [],
  /** 连 blob 都拿不到的失败（HEIC 解不开等），只能计数，无法重试 */
  bad: 0,
  ok: 0,
  /** 用户是否自己动过相册名：动过就不再给建议，不和人的输入抢方向盘 */
  albumTouched: false,
  /** 归位建议面板挂着时，外部（关闭面板）也能把它结掉，避免 await 永远不回 */
  settleSuggestion: null,
  /** 由 main.js 注入：拿既有相册名与语义索引，纯读 */
  getLibrary: () => ({ albums: [], items: [] }),
  /** 最近一次上传成功的内容哈希：ID 就藏在里面（见 goSee） */
  lastSha: '',
};

function apiBase() {
  const meta = document.querySelector('meta[name="album-api"]');
  const value = meta?.content?.trim() || '';
  // 占位符没被构建替换掉，或者本来就是空的：都视为「没有后端」
  if (!value || value.includes('__')) return '';
  return value.replace(/\/+$/, '');
}

/* ---------------- 令牌 ---------------- */

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function tokenValid(token) {
  const claims = decodeJwt(token);
  return Boolean(claims && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 60_000);
}

function loadTokens() {
  try {
    state.token = localStorage.getItem(TOKEN_KEY) || '';
    state.refresh = localStorage.getItem(REFRESH_KEY) || '';
  } catch {
    state.token = '';
    state.refresh = '';
  }
}

function saveTokens(token, refresh) {
  state.token = token || '';
  if (refresh) state.refresh = refresh;
  try {
    if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
    if (state.refresh) localStorage.setItem(REFRESH_KEY, state.refresh);
  } catch {
    // 隐私模式下 localStorage 可能不可写：本次会话内仍可用，只是下次要重新登录
  }
}

function clearTokens() {
  state.token = '';
  state.refresh = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch { /* 忽略 */ }
}

/* ---------------- 接口 ---------------- */

async function call(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  let response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // 访问令牌 1 小时；过期就用刷新令牌换一次，换不到才要求重新登录
  if (response.status === 401 && state.refresh) {
    const renewed = await tryRefresh();
    if (renewed) {
      headers.authorization = `Bearer ${state.token}`;
      response = await fetch(`${apiBase()}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }
  }
  return response;
}

async function tryRefresh() {
  try {
    const response = await fetch(`${apiBase()}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh: state.refresh }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data.token) return false;
    saveTokens(data.token, data.refresh);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 登录 ---------------- */

function showLogin(message) {
  el('upload-login').hidden = false;
  el('upload-body').hidden = true;
  const error = el('upload-error');
  error.hidden = !message;
  error.textContent = message || '';
}

function showPicker() {
  el('upload-login').hidden = true;
  el('upload-body').hidden = false;
  if (!el('upload-album').value) el('upload-album').value = String(new Date().getFullYear());
}

async function login(event) {
  event.preventDefault();
  const phone = el('upload-phone').value.trim();
  const key = el('upload-key').value;
  if (!phone || !key) return;

  const submit = el('upload-submit');
  submit.disabled = true;
  submit.textContent = '登录中…';
  try {
    const response = await fetch(`${apiBase()}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, key }),
    });
    if (response.status === 429) {
      showLogin('尝试次数过多，请过几分钟再试。');
      return;
    }
    if (!response.ok) {
      showLogin('手机号或密钥不对。');
      return;
    }
    const data = await response.json();
    saveTokens(data.token, data.refresh);
    el('upload-key').value = '';
    showPicker();
    toast('登录成功');
  } catch {
    showLogin('网络不通，稍后再试。');
  } finally {
    submit.disabled = false;
    submit.textContent = '登录';
  }
}

/* ---------------- 预处理 ---------------- */

/**
 * HEIC → JPEG。Chromium 内核（安卓 WebView）通常解不了 HEIC，
 * 所以这里的失败是常态而非异常，必须给出可执行的提示。
 */
async function prepare(file) {
  if (!HEIC.test(file.name) && !/hei[cf]/i.test(file.type)) {
    return { blob: file, name: file.name, converted: false };
  }
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('此设备无法转换 HEIC');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('HEIC 无法在此设备解码，请先在相册里导出为 JPEG');
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  return { blob, name: file.name.replace(HEIC, '.jpg'), converted: true };
}

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function extOf(name) {
  const match = /\.[a-z0-9]+$/i.exec(name || '');
  return match ? match[0].toLowerCase() : '';
}

/* ---------------- 行与进度 ---------------- */

function makeRow(name) {
  const item = document.createElement('li');
  item.className = 'upload-row';

  const label = document.createElement('span');
  label.className = 'upload-row-name';
  label.textContent = name;

  const status = document.createElement('span');
  status.className = 'upload-row-status';
  status.textContent = labelFor('queued');

  const bar = document.createElement('span');
  bar.className = 'upload-row-bar';
  const fill = document.createElement('span');
  fill.className = 'upload-row-fill';
  bar.appendChild(fill);

  item.append(label, status, bar);
  item.dataset.state = 'queued';
  el('upload-list').appendChild(item);

  // 五态只影响展示与 data-state；下方所有上传 / 分片逻辑保持 v4 原样。
  // The five states affect presentation only; every upload / multipart routine
  // below is left byte-for-byte as accepted in v4.
  return {
    item,
    set(text, ratio, state = null) {
      status.textContent = text;
      item.dataset.state = state
        || (String(text).startsWith(labelFor('uploading')) ? 'uploading' : item.dataset.state || 'queued');
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    },
    done() {
      item.classList.add('is-done');
      item.dataset.state = 'published';
      this.set(labelFor('published'), 1, 'published');
    },
    fail(reason) {
      item.classList.add('is-failed');
      item.dataset.state = 'failed';
      this.set(reason, 1, 'failed');
    },
    reset() {
      item.classList.remove('is-done', 'is-failed');
      item.dataset.state = 'queued';
      this.set(labelFor('queued'), 0, 'queued');
    },
    processing() {
      item.dataset.state = 'processing';
      this.set(labelFor('processing'), 1, 'processing');
    },
  };
}

/**
 * `xhr.onerror` / `ontimeout` 都只给 status 0——断网、连接被重置、跨域被拦，
 * 浏览器一律报同一个码，前端拿不到区别。所以除了重试，还要自己记两样东西：
 * **已经发出去多少字节**和**这次尝试花了多久**。这两样能分开两种完全不同的故障：
 *
 * - 0% + 一两秒就断 → 请求根本没发出去（连接层、或本地读不到文件）
 * - 90% + 几十秒才断 → 发到一半链路掉了（真·网络抖动）
 *
 * status 0 from `onerror`/`ontimeout` is the browser's catch-all. We therefore
 * record bytes-sent and elapsed time ourselves: 0% in one second and 90% in a
 * minute are two entirely different bugs.
 */
function connectionError(message, retries = RETRY_DELAYS.length) {
  const error = new Error(message);
  error.status = 0;
  error.retryable = retries > 0;
  error.retries = retries;
  return error;
}

/**
 * 哪些失败值得重试：
 * - 403 → 多半是预签名过期，重试前会重新取地址，所以能修好
 * - 5xx / 408 / 429 → 服务端临时问题
 * - 其它 4xx → 请求本身就错了（超限、key 不对），重试只是浪费 13 秒
 */
function httpError(status) {
  const error = new Error(`上传失败 ${status}`);
  error.status = status;
  error.retryable = status >= 500 || status === 403 || status === 408 || status === 429;
  error.retries = RETRY_DELAYS.length;
  return error;
}

const MIN_TIMEOUT = 60_000;
const MAX_TIMEOUT = 480_000;

/**
 * 单次 PUT 的超时按体积给：60 秒起步，每 MB 再加 3 秒，封顶 8 分钟。
 * 固定 180 秒对 100MB 以上的视频是必然不够的——那不是网络问题，是我们自己设的闹钟。
 *
 * A fixed 180 s timeout is simply too short for a 100 MB+ video; the budget now
 * scales with size, capped at 8 minutes (the presigned URL lives 15).
 */
function timeoutFor(bytes) {
  const mb = Math.ceil((Number(bytes) || 0) / (1024 * 1024));
  return Math.min(MAX_TIMEOUT, MIN_TIMEOUT + mb * 3000);
}

/**
 * 一次 PUT。**只接受内存里的字节**（`Uint8Array`），不再把 `File` 直接交给网络栈：
 * 真机上 `xhr.send(File)` 需要底层拿到 content:// URI 的文件描述符，拿不到就以
 * 「0 字节 + 0.4 秒」失败；而 `blob.arrayBuffer()` 走的是另一条管道，一直好用。
 * 单张图片最大 30MB、分片 8MB，内存代价完全可接受。
 *
 * Only in-memory bodies. Handing a `File` to the network stack requires a real file
 * descriptor behind the content:// URI, which the WebView sometimes cannot get —
 * the failure that showed up as "0 bytes in 0.4 s".
 *
 * 成功时 resolve 出 ETag（分片合并要用），失败时 reject 一个带 `sent`/`total` 的错。
 */
function put(url, headers, body, onProgress) {
  const size = body.byteLength ?? body.size ?? 0;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let sent = 0;
    xhr.open('PUT', url, true);
    for (const [name, value] of Object.entries(headers || {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.timeout = timeoutFor(size);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      sent = event.loaded;
      onProgress(event.loaded / event.total);
    };
    const fail = (error) => {
      error.sent = sent;
      error.total = size;
      error.url = url;
      reject(error);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('etag') || '');
      else fail(httpError(xhr.status));
    };
    xhr.onerror = () => fail(connectionError('连接中断'));
    // 超时说明这条路已经堵了很久，再自动重试只是把等待翻倍；交给「重试失败项」。
    xhr.ontimeout = () => fail(connectionError('上传超时', 0));
    xhr.onabort = () => fail(connectionError('上传被中断'));
    xhr.send(body);
  });
}

/* ---------------- 主流程 ---------------- */

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取一批预签名地址；`key` 由内容哈希决定，所以同一张图反复取地址得到同一个 key */
async function requestUrls(album, entries) {
  const response = await call('/upload-url', {
    album,
    files: entries.map((entry) => ({ name: entry.name, size: entry.blob.size, sha256: entry.sha256 })),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.error || '取上传地址失败');
    error.status = response.status;
    error.retryable = false;
    throw error;
  }
  const { items } = await response.json();
  const byKey = new Map(items.map((item) => [item.key, item]));
  return entries.map((entry) => {
    const item = byKey.get(entry.key);
    if (!item) throw new Error('服务端未返回地址');
    return item;
  });
}

/**
 * 带退避重试地跑一段上传动作。`attempt > 1` 时先等一下再跑，
 * 具体要重新取地址还是重发同一片，由动作自己决定。
 *
 * Runs one upload action with backoff. What a retry actually re-does (re-sign,
 * or just resend the same part) is the action's business.
 */
async function withRetry(entry, label, action) {
  const maxAttempts = 1 + RETRY_DELAYS.length;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      entry.row.set(`${label} · 重试 ${attempt - 1}`, entry.progress || 0);
      await sleep(RETRY_DELAYS[attempt - 2] + Math.random() * 400);
    }
    const started = Date.now();
    try {
      return await action(attempt);
    } catch (err) {
      err.ms = Date.now() - started;
      err.tries = attempt;
      if (!err.retryable) throw err;
      // 超时自带 retries=0，于是不会自动重试
      const allowed = Number.isFinite(err.retries) ? Math.min(maxAttempts, 1 + err.retries) : maxAttempts;
      if (attempt >= allowed) throw err;
    }
  }
  return undefined;
}

/** 读一段文件到内存。分片和整发都走这条路——见 put() 的注释。 */
async function readSlice(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** 小文件：一次 PUT 发完。 */
async function uploadWhole(album, entry, first) {
  let signed = first;
  await withRetry(entry, '上传', async (attempt) => {
    if (attempt > 1) [signed] = await requestUrls(album, [entry]);
    const bytes = await readSlice(entry.blob, 0, entry.blob.size);
    await put(signed.url, signed.headers, bytes, (ratio) => {
      entry.progress = ratio;
      entry.row.set('上传中', ratio);
    });
  });
}

/**
 * 大文件：逐片上传，最后让服务端合并。
 *
 * 每片单独重试，所以一次抖动只损失 8MB，不用把整段视频从头再传一遍；
 * 内存里同时只有一片（8MB），150MB 的视频也不会撑爆 WebView 的堆。
 *
 * Part-by-part with per-part retry: a blip costs 8 MB instead of the whole video,
 * and only one part is ever in memory.
 */
async function uploadParts(entry, signed) {
  const { key, uploadId, partSize, parts } = signed;
  const total = entry.blob.size;
  // 续传（T-21）：上次已经拿到 etag 的分片直接跳过，只发剩下的。
  // etag 挂在 entry 上而不是内存局部变量，跨「重试失败项」仍然有效。
  const etags = Array.isArray(entry.etags) ? [...entry.etags] : [];
  const todo = remainingParts(parts, etags);
  let uploaded = parts.length - todo.length === 0
    ? 0
    : parts.filter((part) => !todo.some((left) => left.partNumber === part.partNumber))
      .reduce((sum, part) => {
        const start = (part.partNumber - 1) * partSize;
        return sum + Math.max(0, Math.min(start + partSize, total) - start);
      }, 0);
  if (etags.length) {
    entry.row.set(`续传 ${etags.length}/${parts.length} 片`, uploaded / total);
  }

  for (const part of todo) {
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, total);
    const size = end - start;

    await withRetry(entry, `第 ${part.partNumber}/${parts.length} 片`, async () => {
      const bytes = await readSlice(entry.blob, start, end);
      const etag = await put(part.url, {}, bytes, (ratio) => {
        entry.progress = (uploaded + ratio * size) / total;
        entry.row.set(`上传中 ${part.partNumber}/${parts.length}`, entry.progress);
      });
      if (!etag) throw new Error('分片没有返回 ETag');
      etags.push({ partNumber: part.partNumber, etag });
      entry.etags = etags;
    }).catch((err) => {
      // 让失败文案能说清「挂在哪一片」，而不是只报一个 8MB 的数字
      err.part = part.partNumber;
      err.partCount = parts.length;
      throw err;
    });

    uploaded += size;
    entry.progress = uploaded / total;
    entry.row.set(`上传中 ${part.partNumber}/${parts.length}`, entry.progress);
  }

  const response = await call('/upload-complete', { key, uploadId, parts: etags });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    // 合并失败不该当成网络错误重试：片已经在 S3 上了，问题出在服务端这一步
    throw new Error(`${detail.error || '合并分片失败'}（${etags.length}/${parts.length} 片已传完）`);
  }
}

async function uploadOne(album, entry, signed) {
  if (signed.multipart) await uploadParts(entry, signed);
  else await uploadWhole(album, entry, signed);
}

function fmtBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

async function timed(url, options) {
  const started = Date.now();
  try {
    const response = await fetch(url, options);
    // no-cors 的响应是 opaque，看不到状态码，能 resolve 就说明 TCP+TLS+HTTP 走通了
    return { ok: response.ok || response.type === 'opaque', status: response.status, ms: Date.now() - started };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - started };
  }
}

/**
 * 失败后量两条路，几十毫秒，比任何猜测都直接：
 *
 * - **站点**（同源 GET，走 CloudFront）→ 手机有没有网
 * - **S3 主机**（`no-cors`，只看能不能握手）→ 上传这条路通不通
 *
 * 两条路不是同一台机器，站点通不代表 S3 通。`no-cors` 不要求 CORS 头，
 * 所以「解析失败 = 网络层就没通」，不会被跨域错误混淆。
 *
 * Two probes: the site itself (same-origin, CloudFront) for "is the phone online",
 * and the upload host with `no-cors` for "is this path reachable at all". They are
 * different machines; one working says nothing about the other.
 */
async function selfCheck(uploadUrl) {
  const site = await timed(`${location.origin}/data/version.json?probe=${Date.now()}`, { cache: 'no-store' });
  const parts = [`站点${site.ok ? '正常' : '不通'} ${site.ms}ms`];
  if (uploadUrl) {
    try {
      const bucket = await timed(`${new URL(uploadUrl).origin}/`, { mode: 'no-cors', cache: 'no-store' });
      parts.push(`S3${bucket.ok ? '可达' : '不可达'} ${bucket.ms}ms`);
    } catch {
      parts.push('S3地址无法解析');
    }
  }
  return parts.join(' · ');
}

async function failureText(err) {
  if (!err.retryable) return err.message;
  const total = Number(err.total) || 0;
  const percent = total ? Math.round(((Number(err.sent) || 0) / total) * 100) : 0;
  const elapsed = err.ms ? `${(err.ms / 1000).toFixed(1)}s` : '—';
  const tries = `已重试 ${Math.max(0, (err.tries || 1) - 1)} 次`;
  const where = err.part ? `第 ${err.part}/${err.partCount} 片 · ` : '';
  const probe = await selfCheck(err.url);
  // 万一以后能接 adb，console 里这份比屏幕上那行更全
  console.warn('upload.failed', {
    status: err.status, sent: err.sent, total, tries: err.tries, ms: err.ms, part: err.part, probe,
  });
  // 开头一句是「你该做什么」，后面才是现场数据；两类都不夹带 URL / 状态码 / 对象 key
  return `${failureLabel(err)}（${err.message}，${tries}）· ${where}已发 ${percent}%（${fmtBytes(err.sent)}/${fmtBytes(total)}）· ${elapsed} · ${probe}`;
}

async function run(album, entries) {
  for (const batch of chunk(entries, MAX_BATCH)) {
    // 续传（T-21）：预签名还没过期的条目不再重新取地址。
    // 重新取地址 = 新的 uploadId = 之前的分片白传，这是「重试就从头再来」的根因。
    const signed = new Map();
    for (const entry of batch) {
      if (entry.signed && signedStillValid(entry.signedAt)) signed.set(entry, entry.signed);
    }
    const fresh = batch.filter((entry) => !signed.has(entry));
    if (fresh.length) {
      try {
        const items = await requestUrls(album, fresh);
        fresh.forEach((entry, index) => {
          entry.signed = items[index];
          entry.signedAt = Date.now();
          signed.set(entry, items[index]);
        });
      } catch (err) {
        for (const entry of fresh) {
          entry.row.fail(failureLabel(err));
          state.failed.push(entry);
        }
      }
    }

    for (const entry of batch) {
      const permission = signed.get(entry);
      if (!permission) continue;
      try {
        await uploadOne(album, entry, permission);
        entry.row.done();
        entry.signed = null;
        state.ok += 1;
        state.lastSha = entry.sha256;
      } catch (err) {
        entry.row.fail(await failureText(err));
        state.failed.push(entry);
      }
    }
  }
  el('upload-open').hidden = !state.lastSha;
}

function updateCount() {
  const failed = state.failed.length + state.bad;
  el('upload-count').textContent = `${state.ok} 个已上传${failed ? `，${failed} 个失败` : ''}`;
  el('upload-retry').hidden = state.failed.length === 0;
}

/**
 * 展示归位建议，等用户选「用这个」或「不用了」。
 * 关闭面板 / 按 Esc 也当成「不用了」——绝不能让上传卡在一个没人回答的
 * Promise 上。
 */
function askSuggestion(suggestion) {
  const panel = el('upload-suggest');
  el('upload-suggest-title').textContent = `建议放进「${suggestion.album.name}」`;
  el('upload-suggest-note').textContent = suggestionNote(suggestion);
  el('upload-suggest-accept').textContent = `用「${suggestion.album.name}」`;

  const tags = el('upload-suggest-tags');
  tags.replaceChildren(...suggestion.tags.map((tag) => {
    const chip = document.createElement('span');
    chip.className = 'upload-suggest-tag';
    chip.textContent = tag.zh;
    return chip;
  }));
  tags.hidden = suggestion.tags.length === 0;

  panel.hidden = false;
  const accept = el('upload-suggest-accept');
  const skip = el('upload-suggest-skip');

  return new Promise((resolve) => {
    const finish = (choice) => {
      accept.removeEventListener('click', onAccept);
      skip.removeEventListener('click', onSkip);
      panel.hidden = true;
      state.settleSuggestion = null;
      resolve(choice);
    };
    const onAccept = () => finish('accept');
    const onSkip = () => finish('skip');
    accept.addEventListener('click', onAccept);
    skip.addEventListener('click', onSkip);
    state.settleSuggestion = finish;
    accept.focus({ preventScroll: true });
  });
}

async function uploadFiles(files) {
  if (state.busy) return;

  // 归位建议（T-27）：用户自己改过相册名就不打扰；只读内存，不发请求
  if (!state.albumTouched && files.length >= 2) {
    const library = state.getLibrary() || {};
    const suggestion = buildSuggestion({ files, albums: library.albums, items: library.items });
    if (suggestion && !suggestion.weak) {
      const choice = await askSuggestion(suggestion);
      if (choice === 'accept') el('upload-album').value = suggestion.album.name;
    }
  }

  state.busy = true;
  el('upload-retry').hidden = true;

  try {
    const prepared = [];
    for (const file of files) {
      const row = makeRow(file.name);
      try {
        const ready = await prepare(file);
        const sha256 = await sha256Hex(ready.blob);
        prepared.push({
          ...ready,
          sha256,
          key: `incoming/${sha256.slice(0, 16)}${extOf(ready.name)}`,
          row,
        });
      } catch (err) {
        row.fail(err.message);
        state.bad += 1;
      }
    }

    await run(el('upload-album').value.trim(), prepared);
  } finally {
    state.busy = false;
    updateCount();
    if (state.ok) toast('已上传，几秒后刷新即可看到');
  }
}

/** 只重跑失败项，已成功的不会重传（key 是内容哈希，重传也只是覆盖） */
async function retryFailed() {
  if (state.busy || !state.failed.length) return;
  const pending = state.failed;
  state.failed = [];
  state.busy = true;
  el('upload-retry').hidden = true;

  try {
    for (const entry of pending) entry.row.reset();
    await run(el('upload-album').value.trim(), pending);
  } finally {
    state.busy = false;
    updateCount();
    if (state.ok) toast('已上传，几秒后刷新即可看到');
  }
}

/* ---------------- 去看看（T-21） ---------------- */

/**
 * 等这张出现在清单里。处理是异步的（几秒），立刻跳过去只会撞一个空 ID。
 * 四轮 × 2.5 秒，约 10 秒；还不行就明说「还在处理」，而不是假装成功。
 */
async function lookupPhoto(id, attempts = 4) {
  for (let round = 0; round < attempts; round += 1) {
    try {
      const version = await fetch(`data/version.json?_=${Date.now()}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null));
      const url = version?.manifest || 'data/manifest.json';
      const manifest = await fetch(url, { cache: 'no-cache' })
        .then((response) => (response.ok ? response.json() : null));
      if (Array.isArray(manifest?.photos) && manifest.photos.some((photo) => photo.id === id)) return true;
    } catch { /* 网络抖动：下一轮再试 */ }
    if (round < attempts - 1) await sleep(2500);
  }
  return false;
}

async function goSee() {
  const id = photoIdFor(state.lastSha);
  if (!id) return;
  const button = el('upload-open');
  button.disabled = true;
  try {
    if (await lookupPhoto(id)) {
      close();
      location.hash = `#p=${id}`;
    } else {
      toast('还在处理，过几秒刷新就能看到');
    }
  } finally {
    button.disabled = false;
  }
}

/* ---------------- 装配 ---------------- */

function open() {
  el('upload').hidden = false;
  document.body.classList.add('is-uploading');
  if (tokenValid(state.token)) showPicker();
  else showLogin('');
}

function close() {
  // 面板被关掉时建议还挂着：当成「不用了」，否则上传会停在那里等一个不会再来的点击
  state.settleSuggestion?.('skip');
  el('upload').hidden = true;
  document.body.classList.remove('is-uploading');
}

/**
 * 只在「有原生桥 + 配了接口地址」时才挂载上传入口。
 * 浏览器里这段代码不产生任何可见元素，也不会发请求。
 * `?upload=1` 是本地调试用的逃生口——它只影响面板是否可见，
 * 真正的授权在服务端（没有令牌，取不到任何上传地址）。
 *
 * Mounted only with a native bridge and a configured API base; in a browser it
 * creates nothing and issues no requests. `?upload=1` is a local debugging
 * escape hatch that only affects visibility — authorisation lives on the server,
 * where no token means no upload URL.
 */
export function initUpload({ getLibrary } = {}) {
  if (typeof getLibrary === 'function') state.getLibrary = getLibrary;
  const base = apiBase();
  if (!base) return;
  if (!hasNativeBridge() && !new URLSearchParams(location.search).has('upload')) return;

  loadTokens();
  el('open-upload').hidden = false;

  el('open-upload').addEventListener('click', open);
  el('upload-close').addEventListener('click', close);
  el('upload-login').addEventListener('submit', login);
  el('upload-retry').addEventListener('click', retryFailed);
  el('upload-open').addEventListener('click', goSee);
  el('upload-logout').addEventListener('click', () => {
    clearTokens();
    el('upload-list').replaceChildren();
    el('upload-count').textContent = '';
    el('upload-retry').hidden = true;
    state.failed = [];
    state.bad = 0;
    state.ok = 0;
    showLogin('');
  });
  // 用户一动手就永久退出「建议」：之后的上传不再弹面板
  el('upload-album').addEventListener('input', () => {
    state.albumTouched = true;
    el('upload-suggest').hidden = true;
  });

  el('upload-files').addEventListener('change', (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (files.length) uploadFiles(files);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el('upload').hidden) close();
  });
}
