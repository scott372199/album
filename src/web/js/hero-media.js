/**
 * 首屏图的兜底 / Fallback for the static hero image.
 *
 * 首屏是**静态** HTML（T-11），`<img src="data/hero.webp">` 写在模板里。那张图由
 * 处理函数在发布照片时写成，所以**全新站点、或者还没传过照片的站点，它根本不存在**
 * ——线上第一次验收就是这样：`data/hero.webp` 返回 403，首屏挂着一个破图图标。
 *
 * 模板里那句「alt 留空也不会露出破图图标」是个没验证过的假设。这里补上真正的判断：
 * `complete` 为真、`naturalWidth` 仍为 0，就是加载失败，给 `.hero` 打上 `is-degraded`，
 * CSS 那边把 img 藏掉，只留舞台底色与标题——那本来就是设计里的无图状态。
 *
 * The hero image is written by the processor at publish time, so a brand new site
 * has no `data/hero.webp` at all and the template would paint a broken-image
 * glyph. `complete + naturalWidth === 0` is the reliable failure test; the caller
 * then marks the hero so CSS can drop the img and fall back to the stage colour.
 */

/**
 * 这张图现在是不是「已经确定失败」。纯判断，不碰 DOM 方法，方便用假对象测。
 * Whether the image is known to have failed — pure, so a fake node can test it.
 *
 * @param {{ complete?: boolean, naturalWidth?: number } | null} img
 * @returns {boolean}
 */
export function heroMediaFailed(img) {
  if (!img) return false;
  // 还没加载完就还不知道结果；complete 为假不代表失败
  if (img.complete !== true) return false;
  return !(Number(img.naturalWidth) > 0);
}

/**
 * 监听首屏图，失败时回调一次。
 * Watch the hero image and report a single failure.
 *
 * 图带着 `fetchpriority="high"`，往往在脚本执行之前就已经失败了，那时 `error`
 * 事件早已发完——所以除了挂监听，还要立刻查一次当前状态。
 *
 * Returns a cleanup function; calling it stops future reports.
 *
 * @param {{ addEventListener?: Function, removeEventListener?: Function, complete?: boolean, naturalWidth?: number } | null} img
 * @param {{ onMissing?: () => void }} [options]
 * @returns {() => void}
 */
export function watchHeroMedia(img, { onMissing } = {}) {
  if (!img) return () => {};
  let reported = false;

  const report = () => {
    if (reported) return;
    reported = true;
    if (typeof onMissing === 'function') onMissing();
  };

  const onError = () => report();
  img.addEventListener?.('error', onError);
  if (heroMediaFailed(img)) report();

  return () => {
    reported = true;
    img.removeEventListener?.('error', onError);
  };
}
