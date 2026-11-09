import { reducedMotion } from './ui.js';

/** 顶部导航的毛玻璃在滚动后加深（CSS 滚动驱动不可用时的兜底） */
function initNav() {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;
  const update = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/** 章节入场：优先交给 CSS 的 view() 时间线，不支持的浏览器用 IO 加类名 */
function initReveal() {
  if (typeof IntersectionObserver !== 'function') return;
  const targets = document.querySelectorAll('.section-head, .year-group, .cta-inner, .stats-inner');
  if (!targets.length) return;

  // 页面本身不可滚动时（内容比视口短），view() 时间线拿不到推进量，
  // 元素会永远停在起始帧变得半透明 —— 这种情况直接全显。
  const scrollable = document.documentElement.scrollHeight > window.innerHeight + 24;
  if (!scrollable || reducedMotion.matches) {
    targets.forEach((node) => node.classList.add('is-visible'));
    return;
  }

  if (CSS.supports?.('animation-timeline: view()')) {
    targets.forEach((node) => node.classList.add('reveal--css'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.1 });
  targets.forEach((node) => {
    node.classList.add('reveal');
    observer.observe(node);
  });
}

/**
 * 网格 → 灯箱的共享元素过渡。
 * 不支持 View Transitions 或用户要求减少动效时，直接执行（等价淡入）。
 */
export async function photoTransition(originImage, photoId, mutate) {
  if (!document.startViewTransition || reducedMotion.matches || !originImage) {
    mutate();
    return;
  }
  const name = `ph-${photoId}`;
  originImage.style.viewTransitionName = name;
  try {
    const transition = document.startViewTransition(() => {
      originImage.style.viewTransitionName = '';
      mutate();
      const target = document.getElementById('lb-image');
      if (target) target.style.viewTransitionName = name;
    });
    await transition.finished;
  } catch {
    mutate();
  } finally {
    originImage.style.viewTransitionName = '';
    const target = document.getElementById('lb-image');
    if (target) target.style.viewTransitionName = '';
  }
}

export function initMotion() {
  initNav();
  initReveal();
}
