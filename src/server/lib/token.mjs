import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 极简 JWT（HS256）。不引第三方库：只需要签名与校验两个动作，
 * 而 `jsonwebtoken` 会把一堆用不到的算法一起带进镜像。
 *
 * Minimal HS256 JWT. No third-party dependency: signing and verifying are the
 * only operations needed, and `jsonwebtoken` drags in algorithms we never use.
 */

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

export function signToken(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  })).toString('base64url');
  const body = `${HEADER}.${payload}`;
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

/**
 * 校验签名与过期时间。任何异常都返回 null——调用方只需要「通过 / 不通过」，
 * 不需要知道具体错在哪，也就不会把细节泄漏给客户端。
 *
 * Returns null on any failure. Callers only need pass/fail, and this keeps the
 * reason out of the response body.
 */
export function verifyToken(token, secret, expectedType) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = sign(`${header}.${payload}`, secret);
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (expectedType && claims.typ !== expectedType) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims;
}

/**
 * 手机号 → 令牌主体。用 HMAC 而不是裸 sha256：11 位号码的空间只有千亿量级，
 * 裸哈希几分钟就能反查；加了密钥之后，没有密钥就不可逆。
 *
 * HMAC rather than plain sha256: the space of 11-digit numbers is small enough
 * to brute force a bare hash in minutes, while HMAC is not reversible without
 * the key.
 */
export function subjectFor(secret, phone) {
  return sign(`phone:${phone}`, secret).toString('hex').slice(0, 32);
}
