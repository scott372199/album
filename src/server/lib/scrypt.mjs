import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 共享密钥的 scrypt 哈希。
 *
 * 格式与 infra 层的变量校验一致：`scrypt$N$r$p$saltHex$hashHex`。
 * 用「带参数的自描述格式」而不是固定常量，是为了以后能调大 N 而不破坏旧值：
 * 校验时按值里写的参数来算，存量哈希继续有效。
 *
 * Format matches the infra variable validation: `scrypt$N$r$p$saltHex$hashHex`.
 * Parameters are stored inline so N can be raised later without invalidating
 * existing hashes — verification always uses the parameters found in the value.
 */

export const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 32 };

function maxmemFor(N, r) {
  // scrypt 需要 128 * N * r 字节；留一倍余量，否则 Node 直接抛错
  return 128 * N * r * 2;
}

export function hashSharedKey(plain, options = {}) {
  const { N, r, p, keylen } = { ...SCRYPT_DEFAULTS, ...options };
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 解析失败返回 null：格式不对的值一律视为「验不过」，而不是抛错中断登录 */
export function parseHash(stored) {
  const parts = String(stored ?? '').trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, rawN, rawR, rawP, saltHex, hashHex] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return null;
  // 上限拦住恶意/误配的超大参数，避免一次登录把 CPU 吃穿
  if (N > 1 << 20 || r > 32 || p > 16) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  return {
    N,
    r,
    p,
    salt: Buffer.from(saltHex, 'hex'),
    hash: Buffer.from(hashHex, 'hex'),
  };
}

export function verifySharedKey(plain, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (typeof plain !== 'string' || !plain) return false;
  const actual = scryptSync(String(plain), parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: maxmemFor(parsed.N, parsed.r),
  });
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

/**
 * 手机号不在白名单时也要跑一次同样代价的校验，否则「响应快 = 号码不存在」
 * 就成了一个可探测的信号。
 *
 * Runs an equally expensive check even when the phone is not allowlisted,
 * so response timing cannot reveal whether a number exists.
 */
export const DUMMY_HASH = `scrypt$${SCRYPT_DEFAULTS.N}$${SCRYPT_DEFAULTS.r}$${SCRYPT_DEFAULTS.p}$${'00'.repeat(16)}$${'00'.repeat(SCRYPT_DEFAULTS.keylen)}`;
