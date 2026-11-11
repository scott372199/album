/**
 * 环境变量读取集中在这里，副作用只有 process.env 一处。
 * 好处是测试可以把 env 换掉，不用改业务代码。
 *
 * Env access lives here only, so tests can swap process.env without touching
 * business logic.
 */

function missing(name) {
  return new Error(`缺少环境变量 / missing env var: ${name}`);
}

export function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback === undefined) throw missing(name);
    return fallback;
  }
  return value;
}

export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw missing(name);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，实际为 / must be an integer, got: ${raw}`);
  }
  return value;
}
