/**
 * 清单的「读-改-写」纯函数部分。不碰网络，方便单测。
 *
 * 字段必须与 v3 本地构建产出的清单**完全一致**：同一个前端要能同时渲染
 * 「本地构建的照片」和「服务端追加的照片」，两套 schema 会立刻把画廊搞坏。
 * 顶层的 site / wall / story / hero 是站点的静态配置，处理函数不动它，
 * 只在缺省时补一份合理的默认值。
 *
 * Pure read-modify-write helpers for the manifest, so they can be unit tested
 * without network. The record shape must match what the v3 local build emits —
 * one frontend renders both local and server-appended photos, and two schemas
 * would break the gallery immediately. Top-level site/wall/story/hero are static
 * site config; the processor only fills in defaults when they are absent.
 */

const DEFAULT_WALL = { interval: 10, clock: true, night: { from: '22:00', to: '07:00' } };

export function emptyManifest() {
  return {
    site: { title: '个人相册', subtitle: '' },
    wall: { ...DEFAULT_WALL, night: { ...DEFAULT_WALL.night } },
    story: { pace: 'normal' },
    hero: '',
    photos: [],
    albums: [],
  };
}

/** 时间倒序，同月内按 id 稳定排序——顺序必须确定，否则清单哈希每次都变 */
export function comparePhotos(a, b) {
  return (b.year - a.year)
    || (b.month - a.month)
    || String(a.id).localeCompare(String(b.id));
}

/**
 * 相册封面取该相册里最新的一条。
 * 因为 photos 已按时间倒序，首次出现的即最新，与本地构建的规则一致。
 */
export function buildAlbums(photos) {
  const map = new Map();
  for (const photo of photos) {
    if (!map.has(photo.album)) {
      map.set(photo.album, {
        name: photo.album,
        count: 0,
        cover: photo.id,
        coverType: photo.type,
      });
    }
    map.get(photo.album).count += 1;
  }
  return [...map.values()];
}

export function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyManifest();
  return { ...emptyManifest(), ...value };
}

/** 同 id 覆盖而不是追加：重传同一张图应当只更新那一条 */
export function upsertPhoto(manifest, record) {
  const base = normalizeManifest(manifest);
  const photos = (Array.isArray(base.photos) ? base.photos : [])
    .filter((photo) => photo && photo.id !== record.id);
  photos.push(record);
  photos.sort(comparePhotos);

  return {
    ...base,
    photos,
    albums: buildAlbums(photos),
    hero: base.hero || '',
  };
}

export function countTypes(photos) {
  const list = Array.isArray(photos) ? photos : [];
  return {
    photos: list.filter((photo) => photo.type !== 'video').length,
    videos: list.filter((photo) => photo.type === 'video').length,
  };
}
