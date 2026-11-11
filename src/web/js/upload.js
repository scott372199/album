import { el, toast } from './ui.js';
import { hasNativeBridge } from './native.js';

/**
 * 上传面板：登录 → 选图 → 直传 S3。
 *
 * 三条约束决定了这里的设计：
 *
 * 1. **入口只在安卓壳里出现**（存在原生桥且构建时配了接口地址）。
 *    站点本身是「只读相册」，浏览器访问者不该看到上传按钮。
 * 2. **不上报 takenAt**。浏览器只能拿到 File.lastModified（文件修改时间，
 *    常常是拷贝时间），而处理函数的时间优先级是 takenAt → EXIF → LastModified，
 *    上报 mtime 反而会盖掉真实的 EXIF 拍摄时间。让服务端读 EXIF 更准。
 * 3. **HEIC 转换失败就不传**。服务端镜像里的 sharp 不带 libheif，解不了 HEIC，
 *    原样上传只会进死信队列；与其静默失败，不如当场告诉用户换个格式。
 *
 * Upload panel: login, pick, direct-to-S3.
 *   1. Only inside the Android shell — the site itself is a read-only album.
 *   2. takenAt is never sent: the browser only has File.lastModified, which would
 *      shadow the real EXIF capture time on the server.
 *   3. Undecodable HEIC is refused rather than uploaded: the server-side sharp has
 *      no libheif, so the object would only end up in the DLQ.
 */

const MAX_BATCH = 20;
const TOKEN_KEY = 'album.token';
const REFRESH_KEY = 'album.refresh';
const HEIC = /\.hei[cf]$/i;

const state = {
  token: '',
  refresh: '',
  busy: false,
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
  status.textContent = '准备中';

  const bar = document.createElement('span');
  bar.className = 'upload-row-bar';
  const fill = document.createElement('span');
  fill.className = 'upload-row-fill';
  bar.appendChild(fill);

  item.append(label, status, bar);
  el('upload-list').appendChild(item);

  return {
    item,
    set(text, ratio) {
      status.textContent = text;
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    },
    done() {
      item.classList.add('is-done');
      this.set('已上传', 1);
    },
    fail(reason) {
      item.classList.add('is-failed');
      this.set(reason, 1);
    },
  };
}

function put(url, headers, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [name, value] of Object.entries(headers || {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.timeout = 180_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`上传失败 ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络中断'));
    xhr.ontimeout = () => reject(new Error('超时'));
    xhr.send(blob);
  });
}

/* ---------------- 主流程 ---------------- */

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function uploadFiles(files) {
  if (state.busy) return;
  state.busy = true;
  const album = el('upload-album').value.trim();
  let ok = 0;
  let failed = 0;

  try {
    const prepared = [];
    for (const file of files) {
      const row = makeRow(file.name);
      try {
        const ready = await prepare(file);
        const sha256 = await sha256Hex(ready.blob);
        prepared.push({ ...ready, sha256, row });
      } catch (err) {
        row.fail(err.message);
        failed += 1;
      }
    }

    for (const batch of chunk(prepared, MAX_BATCH)) {
      const response = await call('/upload-url', {
        album,
        files: batch.map((entry) => ({
          name: entry.name,
          size: entry.blob.size,
          sha256: entry.sha256,
        })),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        for (const entry of batch) entry.row.fail(detail.error || '取上传地址失败');
        failed += batch.length;
        continue;
      }

      const { items } = await response.json();
      const byKey = new Map(items.map((item) => [item.key, item]));

      for (const entry of batch) {
        const key = `incoming/${entry.sha256.slice(0, 16)}${extOf(entry.name)}`;
        const item = byKey.get(key);
        if (!item) {
          entry.row.fail('服务端未返回地址');
          failed += 1;
          continue;
        }
        try {
          entry.row.set('上传中', 0);
          await put(item.url, item.headers, entry.blob, (ratio) => entry.row.set('上传中', ratio));
          entry.row.done();
          ok += 1;
        } catch (err) {
          entry.row.fail(err.message);
          failed += 1;
        }
      }
    }
  } finally {
    state.busy = false;
    el('upload-count').textContent = `${ok} 个已上传${failed ? `，${failed} 个失败` : ''}`;
    if (ok) toast('已上传，几秒后刷新即可看到');
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
export function initUpload() {
  const base = apiBase();
  if (!base) return;
  if (!hasNativeBridge() && !new URLSearchParams(location.search).has('upload')) return;

  loadTokens();
  el('open-upload').hidden = false;

  el('open-upload').addEventListener('click', open);
  el('upload-close').addEventListener('click', close);
  el('upload-login').addEventListener('submit', login);
  el('upload-logout').addEventListener('click', () => {
    clearTokens();
    el('upload-list').replaceChildren();
    el('upload-count').textContent = '';
    showLogin('');
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
