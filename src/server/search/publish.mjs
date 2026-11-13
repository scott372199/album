/**
 * 索引发布器 / Search index publisher.
 *
 * 写路径归属（契约 s3PrefixOwnership / iamBoundaries）：
 *   writer = album-search-publisher，只写 data/search-index.<rev>.json，
 *   canDelete = false；IAM 仅允许 s3:PutObject 于 data/search-index.*.json。
 *   绝不写 version.json / manifest / photos，也绝不删除任何对象。
 *
 * Prefix ownership: writer album-search-publisher writes only
 * data/search-index.<rev>.json with canDelete=false; IAM allows s3:PutObject
 * on data/search-index.*.json only. No version.json/manifest/photos writes
 * and no deletes, ever.
 *
 * S3 writer 可注入，离线测试用内存替身；rev = 内容 sha256（确定性）。
 * The S3 writer is injectable (an in-memory double offline); rev is the
 * deterministic content sha256.
 */
import { createHash } from 'node:crypto';
import {
  safeObjectKeyDigest, createConsoleLogger, CONTRACT,
} from '../v5/correlation.mjs';
import { validateIndex } from './index.mjs';

export const SEARCH_INDEX_PREFIX = 'data/search-index.';
export const SEARCH_INDEX_SUFFIX = '.json';
export const SEARCH_INDEX_KEY_PATTERN = /^data\/search-index\.[0-9a-f]{64}\.json$/;
export const SEARCH_INDEX_OWNER = 'album-search-publisher';
export const SEARCH_INDEX_CACHE = 'public, max-age=31536000, immutable';

/** 唯一允许的写 key；任何其它前缀/路径注入都直接拒绝。 */
export function assertSearchIndexKey(key) {
  if (typeof key !== 'string' || !SEARCH_INDEX_KEY_PATTERN.test(key)) {
    throw new Error(`非法索引对象 key / invalid search index key: ${String(key).slice(0, 80)}`);
  }
  return key;
}

/** 规范载荷：键顺序固定、items 已按 id 排序，保证 rev 可复现。 */
function canonicalPayload(index) {
  return {
    version: index.version,
    vocabulary: index.vocabulary || {},
    items: (index.items || []).map((item) => ({
      id: item.id,
      year: item.year,
      month: item.month,
      tags: item.tags || [],
      labels: item.labels || [],
      colors: item.colors || [],
      source: item.source,
    })),
  };
}

/** rev = 内容 sha256 hex / rev is the content sha256 hex. */
export function computeRev(index) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload(index)), 'utf8')
    .digest('hex');
}

export function indexObjectKey(rev) {
  if (typeof rev !== 'string' || !/^[0-9a-f]{64}$/.test(rev)) {
    throw new Error('rev 必须是 64 位小写十六进制 / rev must be 64 lowercase hex');
  }
  return assertSearchIndexKey(`${SEARCH_INDEX_PREFIX}${rev}${SEARCH_INDEX_SUFFIX}`);
}

/** 离线 S3 writer 替身：只接受索引 key / offline S3 writer double. */
export function createMemoryWriter() {
  const puts = [];
  return {
    puts,
    async putObject(key, body, options = {}) {
      assertSearchIndexKey(key);
      puts.push({ key, body, options });
      return { key };
    },
  };
}

/** 从内存 writer 读回最近一次发布的索引 / read back the latest published index. */
export function latestIndex(writer) {
  const last = writer?.puts?.[writer.puts.length - 1];
  return last ? JSON.parse(last.body) : null;
}

/**
 * 发布索引。校验 → 算 rev → 只写一次 PutObject → 结构化日志。
 * 返回 key / rev / bytes / correlationId，不含任何对象内容或 raw 响应。
 *
 * Publish: validate -> compute rev -> exactly one PutObject -> structured log.
 * Returns key/rev/bytes/correlationId; no object content or raw response.
 */
export async function publishIndex({
  index,
  manifest,
  writer = createMemoryWriter(),
  logger = createConsoleLogger(),
  correlationId,
  startedAt = Date.now(),
} = {}) {
  validateIndex(index, manifest);
  const rev = computeRev(index);
  const key = indexObjectKey(rev);
  const body = JSON.stringify({
    version: index.version,
    rev,
    vocabulary: index.vocabulary || {},
    items: index.items,
  });
  await writer.putObject(key, body, {
    contentType: 'application/json; charset=utf-8',
    cacheControl: SEARCH_INDEX_CACHE,
  });
  logger.emit({
    event: 'index.published',
    correlationId,
    stage: 'index',
    outcome: 'success',
    durationMs: Math.max(0, Date.now() - startedAt),
    objectKeyDigest: safeObjectKeyDigest(key),
    provider: null,
    errorClass: null,
  });
  return { key, rev, bytes: Buffer.byteLength(body, 'utf8'), correlationId };
}

/** 契约里的归属记录，供契约测试断言 / ownership record for contract tests. */
export function ownership() {
  return CONTRACT.s3PrefixOwnership['data/search-index.<rev>.json'];
}
