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
    tags: [...tags].sort((a, b) => a.localeCompare(b, 'zh')),
    years: [...years].sort((a, b) => b - a),
    months: [...months].sort((a, b) => a - b),
    hero: manifest.hero || photos[0]?.id || '',
    // V5：hero 章节配置（缺省空数组，由 hero.js 按需自动生成）
    // V5: hero sections (empty by default; hero.js auto-generates on demand)
    heroSections: Array.isArray(manifest.heroSections) ? manifest.heroSections : [],
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
