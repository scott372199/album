/** manifest 载入与索引，不碰 DOM。 */

export async function loadManifest(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`manifest 载入失败：${response.status}`);
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
