/**
 * 灯箱的「同月横条」与标签 chips / Same-month strip and label chips (V6 T-19).
 *
 * 两件事，都不需要新数据：
 *
 * 1. **同月横条**：把灯箱当前列表里同年同月的照片排成一条可横滑的小图。列表
 *    就是用户在看的这一组（时间流 / 搜索结果 / 漫游序列），所以横条里的每一张
 *    点了都真的跳得到——从 `state.filtered` 里另取一份的话，漫游模式下会出现
 *    「点了没反应」的条目。窄屏默认收起，不占首屏高度。
 * 2. **标签 chips**：取自这张照片的识别标签（`labels[].zh`），点一下就是按这个
 *    词搜索（复用既有 `#mode=search&q=` 键，不新增 hash 键）。
 *
 * 粒度上只说「月」：不变量 6 禁止「这天拍了 N 张」这类日级措辞，横条只按年月
 * 聚合，文案也只写「本月 N 张」。
 *
 * Two things, no new data required: a horizontally scrollable strip of the same
 * month taken from the lightbox's *current* list (so every item is reachable),
 * and chips built from the photo's recognition labels that jump to a search for
 * that term. Month granularity only — day-level wording is forbidden by
 * invariant 6.
 */

export const MONTH_STRIP_COLLAPSE_WIDTH = 640;
export const MAX_CHIPS = 8;
/** 一个月不可能有几百张，超过这个数说明列表被别的东西污染了，截断即可 */
export const MAX_STRIP_ITEMS = 60;

/** 年月键：`2026-11`。缺年份/月份的照片返回空串，不参与横条。 */
export function monthKeyOf(photo) {
  const year = Number(photo?.year);
  const month = Number(photo?.month);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return '';
  if (!year || month < 1 || month > 12) return '';
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 同月照片：保持列表原顺序（也就是用户看到的顺序），截断到上限。
 * 不按时间重排——横条是「在当前这一组里换一张」，不是另一套时间轴。
 */
export function monthItems(photos, photo, { max = MAX_STRIP_ITEMS } = {}) {
  const key = monthKeyOf(photo);
  if (!key) return [];
  const list = Array.isArray(photos) ? photos : [];
  const out = [];
  for (const item of list) {
    if (monthKeyOf(item) !== key) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** 横条的完整计划：键、条目、当前下标、左右是否还有（给预取用） */
export function monthStripPlan(photos, currentId) {
  const list = Array.isArray(photos) ? photos : [];
  const current = list.find((photo) => photo && photo.id === currentId);
  const key = monthKeyOf(current);
  const items = monthItems(list, current);
  return {
    key,
    items,
    index: items.findIndex((photo) => photo.id === currentId),
    count: items.length,
  };
}

/**
 * 标签 chips：只认 `zh` 字段（中文词表单一来源），去重，按置信度降序，
 * 截断到 8 个。`kind === 'color'` 的标签也照收——点进去正好是颜色筛选。
 */
export function labelChips(labels, { limit = MAX_CHIPS } = {}) {
  const list = Array.isArray(labels) ? labels : [];
  const seen = new Set();
  const out = [];
  for (const label of list) {
    if (!label || typeof label !== 'object') continue;
    const zh = typeof label.zh === 'string' ? label.zh.trim() : '';
    if (!zh || seen.has(zh)) continue;
    const conf = Number(label.conf);
    seen.add(zh);
    out.push({ zh, conf: Number.isFinite(conf) ? conf : 0, kind: label.kind || '' });
  }
  out.sort((a, b) => b.conf - a.conf);
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 预取哪几张：当前左右各 span 张，跳过自己与视频（视频要拖整段，不预取）。
 * 返回的是 id 列表而不是 Image 对象，方便单测；真正的预加载在调用方做。
 */
export function prefetchTargets(items, index, { span = 2 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || index < 0) return [];
  const out = [];
  for (let offset = 1; offset <= span; offset += 1) {
    for (const i of [index - offset, index + offset]) {
      const photo = list[i];
      if (!photo || photo.type === 'video' || photo.type === 'live') continue;
      if (!(photo.view || photo.grid)) continue;
      out.push(photo.id);
    }
  }
  return [...new Set(out)];
}

/** 窄屏默认收起：横条不该在手机首屏抢走一整行的高度 */
export function shouldCollapse(width, { threshold = MONTH_STRIP_COLLAPSE_WIDTH } = {}) {
  const value = Number(width);
  if (!Number.isFinite(value) || value <= 0) return true;
  return value < threshold;
}

/**
 * 装配。`host` 里建三个节点：一行「本月 N 张」的开关、可横滑的小图轨、chips。
 * `wide()` 每次渲染都问一次当前宽度，窗口改变后下一次渲染就换布局。
 */
export function createMonthStrip({
  host,
  onPick = null,
  onChip = null,
  wide = () => (typeof window !== 'undefined' ? window.innerWidth : 1280),
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  if (!host || !doc) return { render() {}, destroy() {} };

  let collapsed = true;
  let currentKey = '';
  let lastCount = 0;

  const head = doc.createElement('div');
  head.className = 'lb-month-head';
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lb-month-toggle';
  head.appendChild(toggle);

  const track = doc.createElement('div');
  track.className = 'lb-month-track';
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', '同月照片');

  const chips = doc.createElement('div');
  chips.className = 'lb-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', '这张照片的标签');

  host.replaceChildren(head, track, chips);

  /** 收起状态落到三个地方：容器属性（CSS 用）、按钮文字、aria-expanded */
  function paintToggle() {
    host.dataset.collapsed = collapsed ? 'true' : 'false';
    toggle.textContent = collapsed ? `本月 ${lastCount} 张 · 展开` : '收起';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    paintToggle();
  });

  function render(photos, photo, labels = []) {
    const plan = monthStripPlan(photos, photo?.id);
    const chipList = labelChips(labels);
    const previousKey = currentKey;
    currentKey = plan.key;

    // 一张同月都没有、也没有标签：整块收起来，别在灯箱里留一条空行
    if (plan.count <= 1 && !chipList.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    // 换到另一个月时回到默认（窄屏收起、宽屏展开）；同月内保留用户手动展开的状态，
    // 否则在手机上一张张翻，每翻一张就被收起来一次。
    if (plan.key !== previousKey) collapsed = shouldCollapse(wide());
    lastCount = plan.count;

    toggle.hidden = plan.count <= 1;
    paintToggle();

    track.hidden = plan.count <= 1;
    const fragment = doc.createDocumentFragment();
    plan.items.forEach((item, i) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'lb-month-item';
      if (item.id === photo?.id) button.classList.add('is-current');
      button.dataset.id = item.id;
      button.setAttribute('aria-label', String(item.title || item.caption || '照片'));
      button.setAttribute('aria-current', item.id === photo?.id ? 'true' : 'false');
      const img = doc.createElement('img');
      img.alt = '';
      img.loading = i === plan.index ? 'eager' : 'lazy';
      img.src = item.thumb || item.grid || item.poster || '';
      button.appendChild(img);
      if (item.type === 'video' || item.type === 'live') {
        const dot = doc.createElement('span');
        dot.className = 'thumb-play';
        dot.textContent = '▶';
        button.appendChild(dot);
      }
      button.addEventListener('click', () => onPick?.(item.id));
      fragment.appendChild(button);
    });
    track.replaceChildren(fragment);

    // 当前这张滚到可见处：横条默认从头开始，用户看到的该是「现在这张」
    const active = track.querySelector?.('.lb-month-item.is-current');
    if (active?.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
    }

    chips.replaceChildren();
    for (const chip of chipList) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'lb-chip';
      button.textContent = chip.zh;
      button.dataset.term = chip.zh;
      button.addEventListener('click', () => onChip?.(chip.zh));
      chips.appendChild(button);
    }
    chips.hidden = !chipList.length;
  }

  return {
    render,
    get key() { return currentKey; },
    destroy() { host.replaceChildren(); host.hidden = true; },
  };
}
