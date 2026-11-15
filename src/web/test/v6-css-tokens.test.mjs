import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 样式令牌的自检（V6 T-13）。
 *
 * 三条断言，都是「改坏了会立刻红」的那种：
 *   1. 规则里引用的每个 `var(--x)` 都真的定义过——之前 `.tile-error` 引用了
 *      不存在的 `--ink-dim`，浏览器会整条声明失效，肉眼还看不出来；
 *   2. `:root` 以外的规则里没有裸色值，颜色只能从语义层来（这是 T-14 能整体
 *      换主题的前提）；
 *   3. 主题要用的六个面（底、面、文字、次级文字、线、强调）都在语义层里有名字。
 *
 * Three checks that fail loudly instead of silently: every referenced custom
 * property is defined, no raw colour literal survives outside `:root`, and the
 * six surfaces the theme layer needs actually have names.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_FILE = path.resolve(HERE, '../style.css');

const CSS = await readFile(CSS_FILE, 'utf8');

/** :root 块与其余部分分开——令牌表里允许出现裸色值，规则里不允许 */
function splitRoot(css) {
  const start = css.indexOf(':root {');
  assert.notEqual(start, -1, 'style.css 里找不到 :root 令牌块');
  const end = css.indexOf('\n}', start);
  assert.notEqual(end, -1, ':root 块没有闭合');
  return { tokenBlock: css.slice(start, end + 2), body: css.slice(end + 2) };
}

const { tokenBlock, body } = splitRoot(CSS);
const defined = new Set([...tokenBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

test('规则里引用的每个自定义属性都有定义（或自带兜底值）', () => {
  // 带兜底的 var(--x, 8px) 不受这条约束：CSS 自己就给了退路。
  // 运行时才写入的变量（story.js / wall.js 的 --kb 动画时长）也走兜底这条路。
  const missing = new Set();
  for (const m of CSS.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
    const [, name, next] = m;
    if (next === ',' || defined.has(name)) continue;
    missing.add(name);
  }
  assert.deepEqual([...missing], [], `这些变量用了但没定义：${[...missing].join(', ')}`);
});

test(':root 以外的规则里没有裸色值', () => {
  const naked = [];
  for (const line of body.split('\n')) {
    if (!/^\s*[a-z-]+\s*:/.test(line)) continue;         // 只看声明行
    // 先把 var(--x) 与 rgb(var(--x) / α) 这种「合法引用」抹掉，再找剩下的色值
    const bare = line.replace(/rgba?\(\s*var\(--[a-z0-9-]+\)\s*\/[^)]*\)/g, ' ')
      .replace(/var\(--[a-z0-9-]+\s*(,[^)]*)?\)/g, ' ');
    const found = bare.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g);
    if (found) naked.push(`${line.trim()}  ← ${found.join(' ')}`);
  }
  assert.deepEqual(naked, [], `颜色必须来自 --c-* 语义层，不能用裸色值：\n${naked.join('\n')}`);
});

test('语义层覆盖 T-14 要换的六个面', () => {
  for (const name of ['--c-bg', '--c-surface', '--c-text', '--c-text-dim', '--c-line', '--c-accent']) {
    assert.ok(defined.has(name), `语义层缺少 ${name}`);
  }
});

test('深色固定层与毛玻璃底各有独立的名字，不被语义层顺手改掉', () => {
  // 全屏看图/故事/照片墙是「黑盒子」，换主题时不该跟着变白；
  // 导航与浮层的毛玻璃底则会变，所以两者不能共用同一个变量。
  for (const name of ['--c-night', '--c-stage', '--c-inverse', '--c-nav-glass', '--c-panel-bg']) {
    assert.ok(defined.has(name), `缺少 ${name}`);
  }
  assert.ok(!tokenBlock.includes('--c-night: var(--c-bg)'), '深色固定层不得指向会变的语义层');
});

test('V5 旧名仍然可解析（历史规则还在用）', () => {
  for (const legacy of ['--paper', '--ink', '--line', '--accent', '--stage']) {
    assert.ok(defined.has(legacy), `旧名 ${legacy} 被删了，历史规则会失效`);
  }
});
