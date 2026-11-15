/**
 * 主题三档 / Three-way theme (V6 T-14).
 *
 * 「跟随系统 / 浅色 / 深色」三档，用户的选择存在 localStorage，实际生效的
 * 只有浅色与深色两种——写成 `data-theme="light|dark"` 挂在 `<html>` 上。
 * CSS 只认这个属性，不直接写 `@media (prefers-color-scheme)`，理由是：
 * 系统偏好要在「跟随」档才生效，而 CSS 媒体查询没法读到用户选的是哪一档；
 * 把判断放在 JS 里，CSS 就只有一份深色变量，也不会出现「用户选了浅色但系统
 * 是深色」时两套规则打架。
 *
 * 代价是首次绘制前必须有脚本把属性写上，否则深色用户会看到一闪而过的白页。
 * 所以 index.html 的 `<head>` 里有一小段同步脚本干这件事（读同一份 localStorage、
 * 同一套判断），本模块负责之后的切换与持久化。两处逻辑必须一致——`decide()`
 * 就是那份「同一套判断」，页面里的内联副本与它逐字对应。
 *
 * Three choices stored in localStorage; only two are ever applied as
 * `data-theme="light|dark"` on `<html>`. CSS reads that attribute instead of
 * `prefers-color-scheme`, because the media query cannot tell whether the user
 * chose "follow system" or "dark" — keeping the decision in JS leaves exactly
 * one copy of the dark palette. An index.html head script runs the same
 * `decide()` before first paint so dark users never see a white flash.
 */

export const THEME_KEY = 'album.theme';
export const THEMES = ['auto', 'light', 'dark'];

/** 跟随档生效时的页面底色，与 CSS 的 --c-bg 保持一致 / Canvas colours per theme */
export const THEME_COLORS = { light: '#ffffff', dark: '#121214' };

/** 三档的显示名 / Labels for the cycle control */
export const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

/** 只接受三个合法值，别的一律当「跟随」 / Anything unknown falls back to auto */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'auto';
}

/**
 * 一档偏好 + 系统偏好 → 实际生效的主题。纯函数，内联脚本用的也是这套判断。
 * A stored choice plus the OS preference decides what actually applies.
 */
export function decide(choice, prefersDark) {
  const value = normalizeTheme(choice);
  if (value === 'light' || value === 'dark') return value;
  return prefersDark ? 'dark' : 'light';
}

/** 点一下换下一档：跟随 → 浅色 → 深色 → 跟随 / Cycle order */
export function nextTheme(value) {
  const index = THEMES.indexOf(normalizeTheme(value));
  return THEMES[(index + 1) % THEMES.length];
}

/** 控制按钮上的文字：告诉用户「现在是什么」，而不是「点一下会变成什么」 */
export function themeLabel(choice) {
  return `主题：${THEME_LABELS[normalizeTheme(choice)]}`;
}

/**
 * 把主题落到 DOM 上：`data-theme`、`color-scheme`、`theme-color`。
 *
 * 三个都要改，少一个就露馅：只改 `data-theme`，移动端浏览器的地址栏还是白的；
 * 只改 `theme-color`，表单控件与滚动条仍按浅色画。
 *
 * `doc` / `root` / `storage` 都可注入，方便在 Node 里测。
 */
export function applyTheme({
  root = typeof document !== 'undefined' ? document.documentElement : null,
  doc = typeof document !== 'undefined' ? document : null,
  choice = 'auto',
  prefersDark = false,
} = {}) {
  const resolved = decide(choice, prefersDark);
  if (root) {
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }
  if (doc) {
    for (const meta of doc.querySelectorAll('meta[name="color-scheme"]')) {
      meta.setAttribute('content', resolved);
    }
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', THEME_COLORS[resolved]);
    }
  }
  return resolved;
}

/**
 * 挂载：读偏好、跟随系统变化、提供三档切换。
 *
 * 返回 `{ choice, resolved, set, next }`。`onChange` 只在「实际生效的主题」
 * 变了的时候回调——用户在「跟随」档下切换系统主题也算。
 */
export function initTheme({
  root = typeof document !== 'undefined' ? document.documentElement : null,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
  onChange = null,
} = {}) {
  const media = win && typeof win.matchMedia === 'function'
    ? win.matchMedia('(prefers-color-scheme: dark)')
    : null;
  const prefersDark = () => Boolean(media && media.matches);

  let choice = 'auto';
  try {
    choice = normalizeTheme(win?.localStorage?.getItem(THEME_KEY) || 'auto');
  } catch {
    // 隐私模式/被禁用的存储：读不到就跟随系统，不影响任何功能
    choice = 'auto';
  }

  let resolved = applyTheme({ root, doc, choice, prefersDark: prefersDark() });

  const commit = (nextChoice) => {
    choice = normalizeTheme(nextChoice);
    const before = resolved;
    resolved = applyTheme({ root, doc, choice, prefersDark: prefersDark() });
    try {
      if (choice === 'auto') win?.localStorage?.removeItem(THEME_KEY);
      else win?.localStorage?.setItem(THEME_KEY, choice);
    } catch { /* 存不了就是下次回到跟随，不影响这一次 */ }
    if (resolved !== before && typeof onChange === 'function') onChange(resolved, choice);
    return resolved;
  };

  // 系统主题在「跟随」档下要实时生效；固定档时它只是白跑一趟 matchMedia
  if (media) {
    const onSystemChange = () => {
      if (choice !== 'auto') return;
      const before = resolved;
      resolved = applyTheme({ root, doc, choice, prefersDark: prefersDark() });
      if (resolved !== before && typeof onChange === 'function') onChange(resolved, choice);
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
  }

  return {
    get choice() { return choice; },
    get resolved() { return resolved; },
    set: commit,
    next() { return commit(nextTheme(choice)); },
  };
}
