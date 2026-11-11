import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

/**
 * SSM 参数读取，带进程内缓存。
 *
 * 三个密钥每次登录都读一遍会白白多出一次 30~80ms 的往返，而 Lambda 容器
 * 会复用，所以缓存是有意义的。代价是轮换密钥后最多有 TTL 的延迟——5 分钟
 * 对「个位数用户 + 私有发布」的场景完全可接受。
 *
 * SSM reads are cached per container. Re-reading the three secrets on every
 * login wastes a round trip while containers are reused; the cost is up to TTL
 * of staleness after a rotation, which is fine here.
 */

const TTL_MS = Number(process.env.SSM_CACHE_TTL_MS || 300_000);

let client;
let cache = null;
let cachedAt = 0;

function ssm() {
  client ??= new SSMClient({});
  return client;
}

/** 测试与运维用：强制下次读取回源 */
export function resetSecretCache() {
  cache = null;
  cachedAt = 0;
}

/**
 * names 是「逻辑名 → 参数路径」的映射，返回「逻辑名 → 值」。
 * 任何一个参数缺失都直接抛错：宁可登录全挂（会立刻被发现），
 * 也不要在缺一个密钥的情况下「部分能用」。
 *
 * Missing parameters throw: a loud failure beats a half-working auth path.
 */
export async function loadSecrets(names) {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;

  const paths = Object.values(names);
  const response = await ssm().send(new GetParametersCommand({
    Names: paths,
    WithDecryption: true,
  }));

  const found = new Map((response.Parameters || []).map((item) => [item.Name, item.Value]));
  const missing = (response.InvalidParameters || []).filter((path) => !found.has(path));
  if (missing.length) {
    throw new Error(`SSM 参数缺失 / missing SSM parameters: ${missing.join(', ')}`);
  }

  const resolved = {};
  for (const [key, path] of Object.entries(names)) {
    const value = found.get(path);
    if (value === undefined || value === '') {
      throw new Error(`SSM 参数为空 / empty SSM parameter: ${path}`);
    }
    resolved[key] = value;
  }

  cache = resolved;
  cachedAt = now;
  return resolved;
}
