/**
 * V5 搜索界面 / V5 search UI.
 *
 * 搜索框、即时建议、时间 chip、空结果解释、加载/错误状态。
 * 失败信息可操作，且不含 URL、状态码、对象 key 或任何内部实现细节。
 * 纯文案函数可被 Node 直接导入；`initSearchUI` 才触碰 DOM。
 *
 * Search box, instant suggestions, time chips, explainable empty/loading/error
 * states. Failure text is actionable and leaks no URLs, status codes, object
 * keys or implementation details. The text helpers are pure; only
 * `initSearchUI` touches the DOM.
 */

import { el } from './ui.js';

/** 契约里的示例查询 / Example queries from queryContract */
export const EXAMPLE_QUERIES = [
  '湖水', '山峰', '蓝天', '汽车', '摩托车', '红色衬衫',
  '2025 年', '2025 年的蓝天和汽车',
];

/** 即时建议：按输入过滤示例词 / Instant suggestions: filter examples by input */
export function suggestionsFor(input) {
  const q = String(input || '').trim();
  if (!q) return EXAMPLE_QUERIES.slice(0, 6);
  const hits = EXAMPLE_QUERIES.filter((item) => item.includes(q) || q.includes(item));
  return hits.length ? hits.slice(0, 6) : EXAMPLE_QUERIES.slice(0, 4);
}

/** 时间 chip：由 manifest 的公开年份派生 / Time chips from public manifest years */
export function yearChips(years) {
  return (Array.isArray(years) ? years : [])
    .slice(0, 6)
    .map((year) => ({ label: `${year} 年`, query: `${year} 年` }));
}

/** 把 explanation 翻成中文检索说明 / Human-readable query explanation */
export function explainText(parse) {
  if (!parse || !Array.isArray(parse.explanation)) return '';
  const parts = [];
  for (const entry of parse.explanation) {
    if (entry.kind === 'year') parts.push(`${entry.mappedTo} 年`);
    else if (entry.kind === 'month') parts.push(`${entry.mappedTo} 月`);
    else if (entry.kind === 'color') parts.push(`颜色：${entry.input}`);
    else if (entry.kind === 'synonym') parts.push(`${entry.input} → ${entry.mappedTo}`);
    else parts.push(entry.input);
  }
  const unique = [...new Set(parts)];
  return unique.length ? `已按 ${unique.join(' · ')} 检索` : '';
}

/** 空结果解释 / Explainable empty state */
export function emptyText(parse, degraded) {
  const base = '没有找到符合的照片。试试更宽泛的词，或去掉年份 / 颜色条件。';
  return degraded ? `${base}（当前为基础筛选模式）` : base;
}

/** 加载 / 错误 / 降级文案，全部可操作且不含实现细节 / Actionable, detail-free status text */
export function statusText(status) {
  if (status === 'loading') return '正在检索…';
  if (status === 'error') {
    return '智能搜索暂时不可用，已切换为基础筛选。可直接用年份、标签筛选，或点「重试」再载入一次。';
  }
  if (status === 'degraded') {
    return '智能索引暂不可用，已用年份 / 月份 / 标签做基础筛选。照片浏览不受影响。';
  }
  return '';
}

/**
 * 挂载搜索界面。返回 { render, setQuery, focus, close }。
 * onQuery(raw) 由 main.js 写入 state.q + URL；onRetry() 重新载入索引。
 *
 * Mount the search UI. `onQuery` writes `state.q` + URL, `onRetry` reloads the
 * index. Returns { render, setQuery, focus, close }.
 */
export function initSearchUI({ onQuery, onRetry } = {}) {
  const input = el('q');
  const panel = el('search-panel');
  const suggestions = el('search-suggestions');
  const chips = el('search-chips');
  const status = el('search-status');
  const explain = el('search-explain');
  const retry = el('search-retry');
  const empty = el('search-empty');
  const wrap = el('search-wrap');

  let latest = {
    q: '', status: 'idle', parse: null, total: 0,
    degraded: false, years: [], error: '',
  };

  function paintSuggestions(q) {
    if (!suggestions) return;
    suggestions.replaceChildren();
    for (const item of suggestionsFor(q)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-suggestion';
      button.setAttribute('role', 'option');
      button.textContent = item;
      button.addEventListener('click', () => {
        setQuery(item);
        onQuery?.(item.trim());
        close();
      });
      suggestions.appendChild(button);
    }
  }

  function paintChips(years) {
    if (!chips) return;
    chips.replaceChildren();
    for (const chip of yearChips(years)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-chip';
      button.textContent = chip.label;
      button.addEventListener('click', () => {
        setQuery(chip.query);
        onQuery?.(chip.query.trim());
        close();
      });
      chips.appendChild(button);
    }
  }

  function open() {
    if (!panel) return;
    panel.hidden = false;
    paintSuggestions(latest.q);
  }

  function close() {
    if (panel) panel.hidden = true;
  }

  function setQuery(value) {
    if (input) input.value = value;
    latest.q = value;
  }

  function render(meta = {}) {
    latest = { ...latest, ...meta };
    const q = String(latest.q || '').trim();

    if (status) {
      const text = statusText(latest.status);
      status.textContent = text;
      status.hidden = !text;
      status.dataset.tone = (latest.status === 'error' || latest.status === 'degraded') ? 'warn' : 'info';
    }
    if (explain) {
      const text = q ? explainText(latest.parse) : '';
      explain.textContent = text;
      explain.hidden = !text;
    }
    if (empty) {
      const showEmpty = Boolean(q) && latest.total === 0 && latest.status !== 'loading';
      empty.textContent = showEmpty ? emptyText(latest.parse, latest.degraded) : '';
      empty.hidden = !showEmpty;
    }
    if (retry) {
      // 索引不可用时给出可操作的「重试」入口
      // Offer an actionable retry when the index is unavailable
      retry.hidden = !(latest.status === 'error' || (latest.status === 'degraded' && latest.degraded));
    }
    paintChips(latest.years);
    if (panel && !panel.hidden) paintSuggestions(latest.q);
  }

  if (input) {
    input.addEventListener('focus', open);
    input.addEventListener('input', (event) => {
      const q = event.target.value.trim();
      latest.q = q;
      onQuery?.(q);
      open();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); input.blur(); }
    });
  }
  if (retry) retry.addEventListener('click', () => onRetry?.());
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', (event) => {
      if (wrap && !wrap.contains(event.target)) close();
    });
  }

  return {
    render,
    setQuery,
    focus() { input?.focus(); },
    close,
  };
}
