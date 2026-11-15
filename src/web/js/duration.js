/**
 * 视频时长的展示层换算，纯函数，不碰 DOM。
 *
 * 时长来自清单里的 `duration`（整数秒，由处理函数写进 manifest）。历史数据
 * 里可能没有这个字段、或者视频被降级成静图时它是 0，两种情况都当作「不知道」，
 * 角标回退成纯 ▶——绝不能拿 0 显示成 0:00，那是在编造信息。
 *
 * Presentation-only duration helpers. `duration` is whole seconds from the
 * manifest; a missing field or 0 (degraded video) both mean "unknown" and fall
 * back to a bare ▶ — showing "0:00" would be inventing a fact.
 */

/** 视频类内容的判定；与 gallery/lightbox 的 isMotion 保持一致 */
export function isTimed(photo) {
  const type = photo?.type;
  return type === 'video' || type === 'live' || type === 'animation';
}

/**
 * 秒 → `m:ss`，超过一小时给 `h:mm:ss`。认不出就返回空串，
 * 让调用方走回退分支而不是渲染一个假的 0:00。
 */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

/** 读屏用的口语化时长：「34 秒」「1 分 5 秒」；不知道就不返回内容 */
export function spokenDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return `${total} 秒`;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/**
 * 网格角标文案。有真实时长就是「▶ 0:34」，没有就是「▶」。
 * 非动效内容返回空串——角标本来就不该出现在静图上。
 */
export function badgeText(photo) {
  if (!isTimed(photo)) return '';
  const clock = formatDuration(photo.duration);
  return clock ? `▶ ${clock}` : '▶';
}

/** 灯箱元信息里附在标题后面的一小段；不知道就不加，避免多一个孤零零的点 */
export function durationNote(photo) {
  if (!isTimed(photo)) return '';
  return formatDuration(photo.duration);
}
