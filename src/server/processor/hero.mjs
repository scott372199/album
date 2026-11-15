/**
 * 首屏静态图 / Static hero image (V6 T-11).
 *
 * HTML 里写死的是 `<img src="data/hero.webp">`：没有脚本、没有清单请求，
 * 首屏就能画出来，LCP 不再等前端包。这张图的**唯一**写入者就是这里——
 * 每次发布之后，把当前最该当首屏的那张照片的最大一档衍生图拷成固定名。
 *
 * 固定名不能带内容哈希，所以缓存给得短（10 分钟）再配一次 CDN 失效；
 * 拷贝一次几百 KB，一天几十张上传量完全无所谓，不必为省一次 PUT 去做
 * 「首屏有没有变」的判断——那种判断迟早会和真实内容错位。
 *
 * The HTML hard-codes `<img src="data/hero.webp">`, so the first screen paints
 * with no script and no manifest fetch and the LCP stops waiting on the bundle.
 * This module is that file's only writer: after each publish it copies the
 * largest derivative of whichever photo should lead to the fixed name.
 *
 * A fixed name cannot carry a content hash, so it gets a short TTL plus a CDN
 * invalidation. Each copy is a few hundred KB and uploads are rare, so there is
 * no "did the hero change?" bookkeeping — that bookkeeping is exactly the kind
 * of thing that ends up disagreeing with the real content.
 */

import * as store from './store.mjs';

export const HERO_KEY = 'data/hero.webp';
/** 失效时用的路径，与 HERO_KEY 一一对应 / The invalidation path for HERO_KEY */
export const HERO_PATH = '/data/hero.webp';
/** 固定名没法长缓存：10 分钟后回源，配上发布失效，最坏也只旧 10 分钟 */
export const HERO_CACHE = 'public, max-age=600';

/**
 * 从大到小试：首屏要铺满整屏，view（2048w）优先；视频降级过的条目没有
 * view，退到 grid / thumb，最后才是视频的 poster。
 *
 * Largest first: the hero spans the viewport, so `view` (2048w) leads. A
 * degraded video has no `view`, hence the fallbacks down to `poster`.
 */
export const HERO_TIERS = ['view.webp', 'grid.webp', 'thumb.webp', 'poster.webp'];

/**
 * 选首屏那张：清单里的 hero 优先（构建期已按「最新横图」解析过），
 * 否则取清单里第一张横图，再不行就是第一条——清单本身就是时间倒序，
 * 所以「第一条」就是最新的一张。
 *
 * ratio 缺失的条目按 1 处理：拿 undefined 去比大小会得到 false，反而把
 * 一张正常横图挤掉。
 *
 * Pick the leading photo: the manifest's `hero` first (the build already
 * resolved it to "newest landscape"), then the first landscape, then the first
 * entry — the manifest is newest-first, so the first entry is the newest shot.
 * A missing ratio counts as 1 so an unset value cannot demote a real landscape.
 */
export function pickHeroPhoto(photos, preferredId = '') {
  const list = Array.isArray(photos)
    ? photos.filter((photo) => photo && typeof photo.id === 'string' && photo.id)
    : [];
  if (!list.length) return null;
  if (preferredId) {
    const wanted = list.find((photo) => photo.id === preferredId);
    if (wanted) return wanted;
  }
  const ratioOf = (photo) => {
    const ratio = Number(photo.ratio);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  };
  return list.find((photo) => ratioOf(photo) >= 1.2) || list[0];
}

/**
 * 把选中照片的衍生图拷成 `data/hero.webp`。
 *
 * 返回 `{ written, photo, source, bytes }` 或 `{ written: false, reason }`；
 * **不抛错**——首屏图写不出来绝不该让一张照片发布失败（硬性不变量 2 的
 * 同一个道理：装饰性产物不得阻塞内容上线）。
 *
 * `io` 默认就是 store，留出参数是为了单测能塞一个内存桶，不必真的连 S3。
 *
 * Copies the chosen photo's derivative to `data/hero.webp`. Returns a small
 * result object and never throws: a decorative artifact must not be able to
 * fail a publication. `io` defaults to the real store; tests inject an
 * in-memory bucket so they never touch S3.
 */
export async function publishHero(siteBucket, manifest, { correlationId = '', io = store } = {}) {
  const photo = pickHeroPhoto(manifest?.photos, manifest?.hero || '');
  if (!photo) return { written: false, reason: 'no-photo', correlationId };

  for (const tier of HERO_TIERS) {
    const source = `photos/${photo.id}/${tier}`;
    try {
      if (!(await io.head(siteBucket, source))) continue;
      // 先探再读：head 便宜，读一档不存在的 2048w 图会白拉一次 404 往返。
      const body = await io.getBuffer(siteBucket, source);
      if (!body || !body.length) continue;
      await io.putBuffer(siteBucket, HERO_KEY, body, {
        contentType: 'image/webp',
        cacheControl: HERO_CACHE,
      });
      return {
        written: true, photo: photo.id, source, bytes: body.length, correlationId,
      };
    } catch (err) {
      // 单档失败就试下一档；全都没成也不抛。
      // One tier failing falls through to the next; exhausting them all is
      // still not an error.
      if (tier === HERO_TIERS[HERO_TIERS.length - 1]) {
        return {
          written: false, reason: 'error', photo: photo.id, correlationId, error: err?.name || 'Error',
        };
      }
    }
  }
  return { written: false, reason: 'no-derivative', photo: photo.id, correlationId };
}
