/**
 * 生日与每月一句话（`family.json`）：文案是**内容**，放 JSON——随 bundle 的内容
 * 哈希发布，改一句不脏代码，也不计入 JS 体积预算。
 */
let data = { bornAt: '', months: {} };

export function applyFamily(doc) {
  const months = doc && typeof doc.months === 'object' && doc.months ? doc.months : {};
  data = { bornAt: String((doc && doc.bornAt) || ''), months };
  return true;
}

/** 拉一次 family.json；失败只是没有文案 / load the copy, failure is harmless */
export async function loadFamily(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(new URL('family.json', import.meta.url).href, { cache: 'no-cache' });
    if (!response || !response.ok) return false;
    return applyFamily(await response.json());
  } catch {
    return false;
  }
}

export const bornAt = () => data.bornAt;

/** 那个月的一句话；没有就返回空串 / hand copy for a month */
export const monthLine = (key) => data.months[String(key || '')] || '';

/** `YYYY-MM` → {year, month}；不合法返回 null / parse a month key */
export function parseMonthKey(key) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(key || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

/**
 * 月龄：`2026-11` + `2021-12` → 「4 岁 11 个月」。满岁不带「0 个月」，
 * 不满一岁只报月数，早于出生返回空串（不显示负数）。
 */
export function ageLabel(born, year, month) {
  const at = parseMonthKey(born);
  const y = Number(year);
  const m = Number(month);
  if (!at || !Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
  const total = (y - at.year) * 12 + (m - at.month);
  if (total < 0) return '';
  const years = Math.floor(total / 12);
  const rest = total % 12;
  if (years === 0) return `${rest} 个月`;
  return rest === 0 ? `${years} 岁` : `${years} 岁 ${rest} 个月`;
}
