import path from 'node:path';
import { processImage } from './image.mjs';
import { processVideo, convertAnimation } from './video.mjs';

/**
 * 按类型分发处理：
 *  image / live → 三档图（live 额外产出短片与封面）
 *  video        → 转码 + 封面；体积兜底失败则降级为静图
 *  animation    → 尝试转 MP4 循环，失败则原样保留
 */
export async function processEntry(entry, { distRoot, tmpDir }) {
  if (entry.type === 'video') {
    const video = await processVideo(entry, distRoot, tmpDir);
    if (!video.degraded) {
      return {
        type: 'video',
        assets: video.assets,
        meta: video.meta,
        createdAt: video.createdAt,
      };
    }
    // 降级：用封面图当静图，保证页面上仍有一条内容
    const posterPath = path.join(distRoot, 'photos', entry.id, 'poster.webp');
    const image = await processImage({ ...entry, srcPath: posterPath, ext: '.webp' }, distRoot, tmpDir);
    return { type: 'image', assets: image, meta: { ratio: image.ratio }, createdAt: video.createdAt };
  }

  if (entry.type === 'live') {
    const image = await processImage(entry, distRoot, tmpDir);
    const video = await processVideo(entry, distRoot, tmpDir);
    return {
      type: 'live',
      assets: {
        thumb: image.thumb,
        grid: image.grid,
        view: image.view,
        lqip: image.lqip,
        ratio: image.ratio,
        ...(video.degraded ? {} : {
          src: video.assets.src,
          poster: video.assets.poster,
          duration: video.meta.duration,
        }),
      },
      meta: { ratio: image.ratio, duration: video.meta.duration },
      createdAt: video.createdAt,
    };
  }

  if (entry.type === 'animation') {
    const anim = await convertAnimation(entry, distRoot, tmpDir);
    return { type: 'animation', assets: anim.assets, meta: anim.meta, createdAt: null };
  }

  const image = await processImage(entry, distRoot, tmpDir);
  return { type: 'image', assets: image, meta: { ratio: image.ratio }, createdAt: null };
}
