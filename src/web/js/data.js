/** manifest 载入与索引，不碰 DOM。 */

/**
 * 解析清单地址 / Resolve the manifest URL.
 *
 * 先问一次 version.json（no-store，永远拿最新的几字节），由它指出清单的
 * 真实文件名。清单文件名带内容哈希，所以可以放心长缓存。
 *
 * v3 把清单地址写死在 index.html 里，等于「加一张照片就得重新发布前端」。
 * v4 照片由服务端写入，前端产物与内容彻底解耦，靠这层间接寻址实现。
 *
 * Ask version.json first (no-store, always a few fresh bytes); it points at
 * the real manifest file, whose name carries a content hash and can therefore
 * be cached for a long time. v3 baked the URL into index.html, which meant a
 * new photo required a frontend redeploy; this indirection removes that.
 */
export async function resolveManifest() {
  const response = await fetch(`data/version.json?_=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`version.json 载入失败：${response.status}`);
  const version = await response.json();
  return {
    url: version.manifest || 'data/manifest.json',
    rev: version.rev || '',
  };
}

export async function loadManifest(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`manifest 载入失败：${response.status}`);
  return response.json();
}

/**
 * 拉取 S3 静态语义索引 / Fetch the static S3 search index.
 * 失败只抛一个不含地址、状态码的通用错误，避免把内部实现细节带进 UI；
 * 调用方据此降级为 manifest 本地筛选。
 *
 * On failure it throws a generic error with no URL or status code, so no
 * internal detail reaches the UI; the caller then degrades to manifest-only
 * filtering.
 */
export async function loadSearchIndex(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('search index unavailable');
  return response.json();
}

/**
 * 拉取构建期产物（策展 / 故事文案同一套约定）：先按 `rev` 拿不可变的那份，
 * 没有再退到固定名；都不行就是 null。产物缺失是正常状态，不是错误。
 * Shared artifact loader: versioned file first, fixed name as fallback; null when
 * neither exists, because a missing artifact is a normal state.
 */
export async function loadArtifact(name, { rev = '', version = 1, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const clean = String(rev || '').trim();
  const urls = [];
  if (/^[0-9a-f]{8,64}$/i.test(clean)) urls.push(`data/${name}.${clean}.json`);
  urls.push(`data/${name}.json?_=${now()}`);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { cache: 'no-cache' });
      if (!response || !response.ok) continue;
      const data = await response.json();
      if (data && Number(data.version) === Number(version)) return data;
    } catch {
      // 这一份没有就试下一份
    }
  }
  return null;
}

/** 流水线占位名，不算标签 / placeholder tag names from the pipeline */
export const PLACEHOLDER_TAGS = new Set(['未分类', '未命名', 'uncategorized']);

/**
 * 「标签」筛选里值得给用户看的取值：照片 tags 是 `[相册名, 年份]`，相册名统一
 * 「未分类」，这一栏于是成了「年份」的复制品。纯年份与占位名剔掉；不足两个值时
 * 调用方隐藏整栏，等真有自定义标签时它会自己长回来。
 */
export function usefulTags(tags, years = []) {
  const yearSet = new Set((Array.isArray(years) ? years : []).map(String));
  const seen = new Set();
  const out = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag ?? '').trim();
    if (!value || seen.has(value) || yearSet.has(value) || PLACEHOLDER_TAGS.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function buildIndex(manifest) {
  const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
  const albums = Array.isArray(manifest.albums) ? manifest.albums : [];
  const byId = new Map(photos.map((photo) => [photo.id, photo]));

  const tags = new Set();
  const years = new Set();
  const months = new Set();
  for (const photo of photos) {
    for (const tag of photo.tags || []) tags.add(tag);
    years.add(photo.year);
    months.add(photo.month);
  }

  return {
    photos,
    albums,
    byId,
    tags: usefulTags([...tags].sort((a, b) => a.localeCompare(b, 'zh')), [...years]),
    years: [...years].sort((a, b) => b - a),
    months: [...months].sort((a, b) => a - b),
    // 首屏那张的 id（V6 T-11）：只为把静态首屏的链接指过去，图片本身不靠它。
    // The hero photo id (V6 T-11): only used to point the static hero's link;
    // the image itself does not depend on it.
    hero: manifest.hero || photos[0]?.id || '',
  };
}

/**
 * 把新 manifest 的新增条目并入旧数据。
 * 照片墙长期开着时用它做「不刷新热更新」。
 */
export function mergeManifest(current, next) {
  if (!current) return { manifest: next, added: next.photos || [] };
  const known = new Set((current.photos || []).map((photo) => photo.id));
  const added = (next.photos || []).filter((photo) => !known.has(photo.id));
  return { manifest: next, added };
}
