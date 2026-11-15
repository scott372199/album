/**
 * 清单条目的构造：把「处理产物 + 对象元数据」压成前端要的那一条记录。
 *
 * 单独成一个模块，是因为这是**公开产物的最后一道闸**——凡是不该出站的东西
 * （原始文件名、GPS、设备序号、精确拍摄时刻）都在这一步被丢掉。抽出来才好在
 * 单测里直接对着字段表断言「这条记录里一个时刻字符串都没有」，而不是靠人眼
 * 逐个字段检查。
 *
 * Record building lives apart so the last gate before publication is unit
 * testable: field tables are asserted against directly instead of eyeballed.
 * Anything that must not leave the device (original filename, GPS, device serial,
 * exact capture instant) is dropped here.
 */

import { parseIso, resolveYearMonth, tagsFor } from './derive.mjs';
import { publicDuration } from './video.mjs';

/**
 * 字段表即白名单。新增字段必须先加到这里，否则测试会红：
 * 这样「顺手多带一个字段」不会悄悄把元数据漏出去。
 *
 * The field table IS the whitelist; adding a field without registering it here
 * turns the tests red, so metadata cannot leak by accident.
 */
export const IMAGE_RECORD_FIELDS = [
  'id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'thumb', 'grid', 'view',
];

export const VIDEO_RECORD_FIELDS = [
  'id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'poster', 'src', 'duration',
];

/** 只允许 m:ss 角标用得上的信息：时长是「多长」，不是「什么时候」 */
export function imageRecord({ id, album, image, meta, videoShotAt }) {
  const { year, month } = resolveYearMonth({
    takenAt: parseIso(meta.metadata['taken-at']),
    exifShotAt: image.exifShotAt,
    // 视频降级成静图时，拍摄时间来自视频容器标签（绝对时刻），不能塞进 exifShotAt
    videoShotAt,
    lastModified: meta.lastModified,
  });

  return {
    id,
    type: 'image',
    album,
    year,
    month,
    tags: tagsFor(album, year),
    title: '',
    caption: '',
    ratio: image.ratio,
    lqip: image.lqip,
    featured: false,
    thumb: `photos/${id}/thumb.webp`,
    grid: `photos/${id}/grid.webp`,
    view: `photos/${id}/view.webp`,
  };
}

export function videoRecord({ id, album, video, meta }) {
  const { year, month } = resolveYearMonth({
    takenAt: parseIso(meta.metadata['taken-at']),
    videoShotAt: video.videoShotAt,
    lastModified: meta.lastModified,
  });

  return {
    id,
    type: 'video',
    album,
    year,
    month,
    tags: tagsFor(album, year),
    title: '',
    caption: '',
    ratio: video.ratio,
    lqip: video.lqip,
    featured: false,
    poster: `photos/${id}/poster.webp`,
    src: `photos/${id}/clip.mp4`,
    // 整数秒；降级视频是 0，前端回退成纯 ▶ 角标（V6 T-20）
    duration: publicDuration(video.duration),
  };
}
