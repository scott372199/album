/**
 * HTTP 响应与请求解析（API Gateway HTTP API payload v2）。
 *
 * CORS 由 API Gateway 在路由上统一加，这里不重复设置——两边都加会变成
 * `Access-Control-Allow-Origin: a, a`，浏览器直接判定失败。
 *
 * HTTP API payload v2 helpers. CORS headers come from the API Gateway route
 * configuration; duplicating them here yields an invalid multi-value header.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 令牌与错误响应一律不许被任何中间层缓存
  // Tokens and errors must never be cached by any intermediary
  'cache-control': 'no-store',
};

/**
 * extraHeaders 目前只用于把服务端的 correlation ID 回给调用方（排查时能对上
 * CloudWatch 日志）。每次都构造新对象，绝不改写共享的 JSON_HEADERS。
 *
 * extraHeaders exists to return the server's correlation ID to the caller so
 * it can be matched against CloudWatch logs. A fresh object is built every
 * time; the shared JSON_HEADERS is never mutated.
 */
export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** 解析失败返回 null，由调用方决定回 400 还是直接拒 */
export function readJson(event) {
  if (!event || !event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 头名大小写在不同网关版本里不统一，这里两边都试一次 */
export function bearerToken(event) {
  const headers = event?.headers || {};
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : '';
}

/** 路由键：HTTP API v2 自带，退化时用方法 + 路径拼 */
export function routeKey(event) {
  if (event?.routeKey) return event.routeKey;
  const method = event?.requestContext?.http?.method;
  const path = event?.rawPath || event?.requestContext?.http?.path;
  return method && path ? `${method} ${path}` : '';
}
