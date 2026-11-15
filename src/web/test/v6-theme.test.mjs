import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEMES, THEME_KEY, THEME_COLORS, normalizeTheme, decide, nextTheme,
  themeLabel, applyTheme, initTheme,
} from '../js/theme.js';

/**
 * 主题三档（V6 T-14）的断言：档位逻辑、DOM/meta 落地、持久化、系统偏好跟随，
 * 以及两套主题的对比度实测。
 *
 * 对比度是**算**出来的，不是截图看出来的：把 style.css 的两份令牌块解析成字典，
 * 对 8 组前景/背景跑 WCAG 相对亮度公式。这样「≥4.5:1」这条验收标准就落到了
 * CI 里，改色改坏了当场红。
 *
 * Assertions for the three-way theme: the档 logic, what lands on the DOM and
 * the metas, persistence, following the OS preference, and measured contrast.
 * Contrast is computed from style.css rather than eyeballed on a screenshot, so
 * the ≥4.5:1 acceptance criterion lives in CI.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = await readFile(path.resolve(HERE, '../style.css'), 'utf8');

/** 极简假环境：root 只需要 dataset/style，doc 只需要 querySelectorAll */
function fakeEnv({ stored = null, prefersDark = false } = {}) {
  const listeners = [];
  const storage = new Map();
  if (stored) storage.set('album.theme', stored);

  const mkMeta = (name) => ({ name, content: '', setAttribute(key, value) { this[key] = value; } });
  const metas = [mkMeta('color-scheme'), mkMeta('theme-color')];

  const media = {
    matches: prefersDark,
    addEventListener: (type, fn) => listeners.push(fn),
  };

  const win = {
    matchMedia: () => media,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };

  return {
    root: { dataset: {}, style: {} },
    doc: {
      querySelectorAll: (sel) => {
        const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
        return name ? metas.filter((m) => m.name === name) : [];
      },
    },
    win,
    storage,
    metas,
    /** 模拟系统切到深色 / 浅色 */
    flip(toDark) {
      media.matches = toDark;
      for (const fn of listeners) fn({ matches: toDark });
    },
  };
}

/* ---------------- 档位逻辑 ---------------- */

test('三档只认三档，其它值一律当「跟随」', () => {
  assert.deepEqual(THEMES, ['auto', 'light', 'dark']);
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('auto'), 'auto');
  assert.equal(normalizeTheme('sepia'), 'auto');
  assert.equal(normalizeTheme(null), 'auto');
  assert.equal(normalizeTheme(undefined), 'auto');
});

test('固定档忽略系统偏好，跟随档看系统偏好', () => {
  assert.equal(decide('light', true), 'light');
  assert.equal(decide('dark', false), 'dark');
  assert.equal(decide('auto', true), 'dark');
  assert.equal(decide('auto', false), 'light');
  assert.equal(decide('bogus', true), 'dark');
});

test('点击循环：跟随 → 浅色 → 深色 → 跟随', () => {
  assert.equal(nextTheme('auto'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'auto');
  assert.equal(nextTheme('nonsense'), 'light');
});

test('按钮文案说的是「现在是什么档」', () => {
  assert.equal(themeLabel('auto'), '主题：跟随系统');
  assert.equal(themeLabel('light'), '主题：浅色');
  assert.equal(themeLabel('dark'), '主题：深色');
});

/* ---------------- DOM 与 meta ---------------- */

test('applyTheme 同时写 data-theme、color-scheme 与两个 meta', () => {
  const env = fakeEnv();
  const resolved = applyTheme({
    root: env.root, doc: env.doc, choice: 'dark', prefersDark: false,
  });
  assert.equal(resolved, 'dark');
  assert.equal(env.root.dataset.theme, 'dark');
  assert.equal(env.root.style.colorScheme, 'dark');
  assert.equal(env.metas[0].content, 'dark');
  assert.equal(env.metas[1].content, THEME_COLORS.dark);
});

test('跟随档下把系统偏好翻译成实际主题', () => {
  const env = fakeEnv({ prefersDark: true });
  applyTheme({ root: env.root, doc: env.doc, choice: 'auto', prefersDark: true });
  assert.equal(env.root.dataset.theme, 'dark');
  assert.equal(env.metas[1].content, '#121214');
});

/* ---------------- 持久化与系统跟随 ---------------- */

test('initTheme 读回存储的档位并落到 DOM', () => {
  const env = fakeEnv({ stored: 'dark' });
  const theme = initTheme({ root: env.root, doc: env.doc, win: env.win });
  assert.equal(theme.choice, 'dark');
  assert.equal(theme.resolved, 'dark');
  assert.equal(env.root.dataset.theme, 'dark');
});

test('next() 换档并持久化；回到跟随档时清掉存储', () => {
  const env = fakeEnv();
  const theme = initTheme({ root: env.root, doc: env.doc, win: env.win });
  theme.next();
  assert.equal(theme.choice, 'light');
  assert.equal(env.storage.get(THEME_KEY), 'light');
  theme.next();
  assert.equal(env.storage.get(THEME_KEY), 'dark');
  theme.next();
  assert.equal(theme.choice, 'auto');
  assert.equal(env.storage.has(THEME_KEY), false, '跟随档不该留值，否则系统偏好被钉死');
});

test('跟随档下系统切换即时生效，并回调一次', () => {
  const env = fakeEnv({ prefersDark: false });
  const seen = [];
  const theme = initTheme({
    root: env.root, doc: env.doc, win: env.win, onChange: (r) => seen.push(r),
  });
  assert.equal(theme.resolved, 'light');
  env.flip(true);
  assert.equal(theme.resolved, 'dark');
  assert.equal(env.root.dataset.theme, 'dark');
  assert.deepEqual(seen, ['dark']);
});

test('固定档下系统切换被忽略（不回调、不改属性）', () => {
  const env = fakeEnv({ stored: 'light' });
  const seen = [];
  initTheme({ root: env.root, doc: env.doc, win: env.win, onChange: (r) => seen.push(r) });
  env.flip(true);
  assert.equal(env.root.dataset.theme, 'light');
  assert.deepEqual(seen, []);
});

test('存储被禁用时退回跟随档，且不抛错', () => {
  const env = fakeEnv();
  env.win.localStorage.getItem = () => { throw new Error('SecurityError'); };
  env.win.localStorage.setItem = () => { throw new Error('SecurityError'); };
  const theme = initTheme({ root: env.root, doc: env.doc, win: env.win });
  assert.equal(theme.choice, 'auto');
  assert.doesNotThrow(() => theme.next());
});

/* ---------------- 对比度实测 ---------------- */

function tokenBlock(selector) {
  const start = CSS.indexOf(selector);
  assert.notEqual(start, -1, `style.css 里找不到 ${selector}`);
  const end = CSS.indexOf('\n}', start);
  return CSS.slice(start, end);
}

function tokens(selector) {
  const out = {};
  // 值可能是 hex、rgba() 或 rgb(var(--x) / a)，这里全都收下；
  // 对比度那几条只挑 PAIRS 里的 hex，别的值进不去计算。
  for (const m of tokenBlock(selector).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const toLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS = [
  ['--c-text', '--c-bg'],
  ['--c-text-dim', '--c-bg'],
  ['--c-text-mute', '--c-bg'],
  ['--c-text', '--c-surface'],
  ['--c-accent', '--c-bg'],
  ['--c-danger', '--c-surface'],
  ['--c-ok', '--c-surface'],
  ['--c-warn-text', '--c-surface'],
];

for (const [name, selector] of [['浅色', ':root {'], ['深色', ':root[data-theme="dark"] {']]) {
  test(`${name}档 8 组前景/背景对比度 ≥ 4.5:1`, () => {
    const t = tokens(selector);
    const rows = PAIRS.map(([fg, bg]) => {
      assert.ok(t[fg] && t[bg], `${name}档缺少 ${t[fg] ? bg : fg}`);
      return { pair: `${fg} on ${bg}`, ratio: contrast(t[fg], t[bg]) };
    });
    const bad = rows.filter((r) => r.ratio < 4.5);
    assert.deepEqual(bad, [], `对比度不足：${bad.map((b) => `${b.pair} = ${b.ratio.toFixed(2)}`).join('; ')}`);
    // 顺带把最小值钉住，防止有人把某组刚好压到 4.51 就算过关
    const min = Math.min(...rows.map((r) => r.ratio));
    assert.ok(min >= 4.6, `${name}档最小对比度只有 ${min.toFixed(2)}:1`);
  });
}

test('每个会翻的语义令牌在深色档都有值，深色固定层则一个都不缺', () => {
  // 这条是「六处无亮色残留」的可执行版本：所有颜色都来自 --c-*，只要深色档
  // 覆盖了每一个「会翻」的令牌，深色下就不可能漏出一块浅色；反过来，新加一个
  // 语义令牌却忘了给深色值，这里会立刻红。
  const FIXED_DARK = new Set([
    '--c-night', '--c-night-2', '--c-night-text', '--c-night-clock', '--c-night-clock-soft',
    '--c-stage', '--c-stage-top', '--c-toast', '--c-wall-bar',
    '--c-on-rgb', '--c-off-rgb', '--c-inverse', '--c-inverse-ink',
  ]);
  const light = Object.keys(tokens(':root {')).filter((name) => name.startsWith('--c-'));
  const dark = new Set(Object.keys(tokens(':root[data-theme="dark"] {')));
  const forgot = light.filter((name) => !FIXED_DARK.has(name) && !dark.has(name));
  assert.deepEqual(forgot, [], `这些令牌在深色档没有值，深色下会露出浅色：${forgot.join(', ')}`);
  const pointless = [...dark].filter((name) => FIXED_DARK.has(name));
  assert.deepEqual(pointless, [], `深色档重复定义了固定层：${pointless.join(', ')}`);
});

test('深色档只覆盖语义层与毛玻璃层，不碰深色固定层', () => {
  const dark = tokenBlock(':root[data-theme="dark"] {');
  // 看图/故事/照片墙本来就是黑的，主题切换不该把它们翻白
  for (const fixed of ['--c-night', '--c-stage', '--c-inverse', '--c-on-rgb', '--c-off-rgb']) {
    assert.ok(!dark.includes(`${fixed}:`), `深色档不该覆盖 ${fixed}`);
  }
  // 而六处里靠语义色的那些必须覆盖到
  for (const flipped of ['--c-bg', '--c-surface', '--c-text', '--c-nav-glass', '--c-panel-bg']) {
    assert.ok(dark.includes(`${flipped}:`), `深色档缺少 ${flipped}`);
  }
});
