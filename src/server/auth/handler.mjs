import { env, envInt } from '../lib/config.mjs';
import { json, readJson, bearerToken, routeKey } from '../lib/http.mjs';
import { log, maskPhone, errorFields } from '../lib/log.mjs';
import { loadSecrets } from '../lib/params.mjs';
import { verifySharedKey, DUMMY_HASH } from '../lib/scrypt.mjs';
import { signToken, verifyToken, subjectFor } from '../lib/token.mjs';
import { attemptKey, readAttempts, recordFailure, clearAttempts } from './attempts.mjs';
import { presignUploads } from './upload.mjs';

/**
 * 认证函数：一个函数三个路由。
 *
 * 为什么不分三个函数：这条路径上的代码总量不到 200 行，共享同一份 SSM 缓存
 * 与同一个容器反而更快；拆开只会多两份冷启动、两份权限、两套日志。
 * 路由分发写在 handler 里，靠 `event.routeKey`（API Gateway 自己给）。
 *
 * One function, three routes. The whole path is under 200 lines and shares the
 * SSM cache and container warm-up; splitting it would only buy extra cold
 * starts, extra IAM policies and extra log groups. Dispatch uses the routeKey
 * that API Gateway already provides.
 */

const SSM = () => ({
  phones: env('SSM_PHONES'),
  keyHash: env('SSM_KEY_HASH'),
  jwtSecret: env('SSM_JWT_SECRET'),
});

/** 中国大陆手机号：11 位、以 1 开头；容忍 +86 / 86 前缀与空格横线 */
export function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
  return /^1\d{10}$/.test(digits) ? digits : '';
}

function allowlist(phones) {
  return String(phones || '')
    .split(',')
    .map((item) => normalizePhone(item))
    .filter(Boolean);
}

/** 401 与 429 是仅有的两种拒绝，其余一律 400，不泄漏是哪一条不过 */
async function login(event) {
  const body = readJson(event);
  if (!body) return json(400, { error: 'invalid_request' });

  // 同一个端点兼做刷新：客户端 401 后拿刷新令牌回来换新的访问令牌，
  // 这样路由表里不必多一条 /refresh。
  if (typeof body.refresh === 'string' && body.refresh) return refresh(body.refresh);

  const phone = normalizePhone(body.phone);
  const key = typeof body.key === 'string' ? body.key : '';
  if (!phone || !key) return json(400, { error: 'invalid_request' });

  const secrets = await loadSecrets(SSM());
  const subject = subjectFor(secrets.jwtSecret, phone);
  const bucket = attemptKey(subject);

  const maxAttempts = envInt('MAX_ATTEMPTS', 10);
  const { count } = await readAttempts(bucket);
  if (count >= maxAttempts) {
    log.warn('auth.blocked', { phone: maskPhone(phone), count });
    return json(429, { error: 'too_many_attempts' });
  }

  const phoneOk = allowlist(secrets.phones).includes(phone);
  // 号码不在白名单时用假哈希跑一次同等代价的校验：
  // 否则「响应快」本身就暴露了号码是否存在。
  const keyOk = verifySharedKey(key, phoneOk ? secrets.keyHash : DUMMY_HASH);

  if (!phoneOk || !keyOk) {
    await recordFailure(bucket);
    log.warn('auth.rejected', { phone: maskPhone(phone), allowlisted: phoneOk, keyOk });
    return json(401, { error: 'invalid_credentials' });
  }

  await clearAttempts(bucket);

  const ttl = envInt('TOKEN_TTL', 3600);
  const refreshTtl = envInt('REFRESH_TTL', 604800);
  const token = signToken({ sub: subject, typ: 'access' }, secrets.jwtSecret, ttl);
  const refreshToken = signToken({ sub: subject, typ: 'refresh' }, secrets.jwtSecret, refreshTtl);

  log.info('auth.ok', { phone: maskPhone(phone), attempt: count + 1 });
  return json(200, { token, refresh: refreshToken, expiresIn: ttl });
}

async function refresh(token) {
  const secrets = await loadSecrets(SSM());
  const claims = verifyToken(token, secrets.jwtSecret, 'refresh');
  if (!claims) return json(401, { error: 'invalid_credentials' });

  const ttl = envInt('TOKEN_TTL', 3600);
  return json(200, {
    token: signToken({ sub: claims.sub, typ: 'access' }, secrets.jwtSecret, ttl),
    expiresIn: ttl,
  });
}

async function authorize(event) {
  const token = bearerToken(event);
  if (!token) return null;
  const secrets = await loadSecrets(SSM());
  return verifyToken(token, secrets.jwtSecret, 'access');
}

async function uploadUrl(event) {
  const claims = await authorize(event);
  if (!claims) return json(401, { error: 'unauthorized' });

  const body = readJson(event);
  if (!body) return json(400, { error: 'invalid_request' });

  const result = await presignUploads(body);
  if (result.error) {
    log.warn('upload.rejected', { reason: result.error, index: result.index });
    return json(400, {
      error: result.error,
      ...(result.index === undefined ? {} : { index: result.index }),
      ...(result.max === undefined ? {} : { max: result.max }),
      ...(result.limit === undefined ? {} : { limit: result.limit }),
    });
  }

  log.info('upload.presigned', { count: result.items.length });
  return json(200, { items: result.items });
}

async function dispatch(event) {
  switch (routeKey(event)) {
    case 'POST /auth':
      return login(event);
    case 'POST /upload-url':
      return uploadUrl(event);
    case 'GET /health':
      return json(200, { ok: true, v: '4' });
    default:
      return json(404, { error: 'not_found' });
  }
}

export async function handler(event) {
  try {
    return await dispatch(event);
  } catch (err) {
    // 内部细节只进日志，响应体永远是一个笼统的错误码
    log.error('auth.unhandled', errorFields(err));
    return json(500, { error: 'internal_error' });
  }
}
