/**
 * V5 correlation ID 与结构化日志 / V5 correlation IDs and structured logging.
 *
 * 契约 v5-contracts.json 是唯一机器可读来源：correlationId 格式、日志必填字段、
 * 公开/禁止字段白名单都从这里读取，不在代码里另抄一份。
 *
 * The contract JSON is the single machine-readable source: the correlation ID
 * format, required log fields and public/forbidden field lists all come from it.
 *
 * 本模块不碰网络、不引入 AWS SDK；日志 sink 与随机数发生器都可注入，
 * 因此离线测试能完整捕获并断言每一条事件。
 *
 * No network and no AWS SDK here; the log sink and the RNG are injectable so
 * offline tests can capture and assert every event.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 契约只加载一次。两个候选路径对应两种运行环境：
 *   1. 仓库里 src/server/v5/ → ../../../spec/… （开发/单测/CI）
 *   2. Lambda 镜像里 /var/task/v5/ → ../spec/…（Dockerfile 把契约拷进
 *      /var/task/spec/；镜像没有仓库根目录，../../../ 会解析到 /spec/）
 * 契约仍是唯一真相源，不在代码里另抄一份。
 *
 * Load the contract once. Two candidates cover both runtimes:
 *   1. In the repo, src/server/v5/ -> ../../../spec/... (dev/tests/CI)
 *   2. In the Lambda image, /var/task/v5/ -> ../spec/... (the Dockerfile
 *      copies the contract into /var/task/spec/; there is no repo root,
 *      so ../../../ would resolve to /spec/)
 * The contract remains the single source of truth.
 */
function loadContract() {
  const candidates = [
    new URL('../../../spec/v5/contracts/v5-contracts.json', import.meta.url),
    new URL('../spec/v5/contracts/v5-contracts.json', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(url, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  throw new Error('v5-contracts.json 未找到 / not found');
}

export const CONTRACT = loadContract();

export const PUBLIC_FIELDS = [...CONTRACT.publicFields];
export const FORBIDDEN_FIELDS = [...CONTRACT.forbiddenFields];
export const OBSERVABILITY_FORBIDDEN_FIELDS = [...CONTRACT.observability.forbiddenFields];
export const STRUCTURED_LOG_REQUIRED = [...CONTRACT.structuredLogEvent.required];
export const STRUCTURED_LOG_OPTIONAL = [...CONTRACT.structuredLogEvent.optional];
export const LOG_STAGES = [...CONTRACT.structuredLogEvent.stages];
export const CORRELATION_ID_HEADER = CONTRACT.correlationId.header;
export const CORRELATION_ID_FORMAT = CONTRACT.correlationId.format;
export const CORRELATION_PROPAGATION = [...CONTRACT.correlationId.propagation];

/** ^corr_[0-9a-f]{16}$ —— 由契约字符串推导 / derived from the contract string. */
export const CORRELATION_ID_PATTERN = new RegExp(`^${CORRELATION_ID_FORMAT}$`);

export function isValidCorrelationId(value) {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/**
 * 生成 corr_ + 16 位小写十六进制。
 * rand 可注入（返回 8 字节 Buffer），便于测试断言确定性。
 *
 * Generate corr_ + 16 lowercase hex chars. `rand` is injectable (returns an
 * 8-byte Buffer) so tests can assert determinism.
 */
export function generateCorrelationId(rand = randomBytes) {
  const hex = Buffer.from(rand(8)).toString('hex');
  return `corr_${hex.padEnd(16, '0').slice(0, 16)}`;
}

/**
 * 客户端带来的 ID 只有格式合法才沿用，否则服务端重新生成；
 * 绝不把不可信字符串原样写进日志。
 *
 * Reuse a client-supplied ID only when format-valid, otherwise generate one
 * server-side. Untrusted strings are never written to logs verbatim.
 */
export function resolveCorrelationId(candidate, rand = randomBytes) {
  return isValidCorrelationId(candidate) ? candidate : generateCorrelationId(rand);
}

/**
 * 对象 key 的安全摘要：只输出 sha256 前 16 位十六进制，不含原 key 明文。
 * 日志里用它替代 sourceAsset / 原图路径。
 *
 * Safe object-key digest: only the first 16 hex chars of sha256, never the
 * original key. Logs use it instead of sourceAsset / original paths.
 */
export function safeObjectKeyDigest(key) {
  if (typeof key !== 'string' || !key) return '';
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 恢复一次上传的 correlation ID：优先读预签名时写进 S3 对象元数据的
 * x-amz-meta-correlation-id，缺失或非法时退到对象 key 的确定性摘要。
 *
 * key 是内容寻址的（`incoming/<sha256 前 16 位><ext>`），所以这个兜底不是
 * 「随便造一个」：同一对象在重试、事件回放、或者旧版本对象没有元数据时，
 * 都会得到同一个 ID，日志才接得起来。元数据从不原样信任，先过格式校验。
 *
 * Recover an upload's correlation ID: prefer the S3 metadata written at
 * presign time, then fall back to a deterministic digest of the
 * content-addressed key. Retries, event replays and legacy objects without
 * metadata therefore all resolve to the same ID. Metadata is never trusted
 * verbatim; it must pass the format check first.
 */
export function correlationIdFor({ key, metadata } = {}) {
  const raw = metadata && typeof metadata === 'object'
    ? metadata['correlation-id'] ?? metadata['x-amz-meta-correlation-id']
    : undefined;
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (isValidCorrelationId(candidate)) return candidate;
  const digest = safeObjectKeyDigest(key);
  return digest ? `corr_${digest}` : generateCorrelationId();
}

/**
 * CloudFront 失效批次的 CallerReference 带上 correlation ID。
 * 放在这里（而不是 store.mjs）是为了离线可测：store.mjs 顶层就 import
 * AWS SDK，零依赖单测不能碰它。
 *
 * CallerReference for a CloudFront invalidation batch, carrying the
 * correlation ID. It lives here rather than in store.mjs so the zero-install
 * tests can exercise it: store.mjs imports the AWS SDK at module load.
 */
export function invalidationCallerReference(correlationId = '') {
  const prefix = String(correlationId || 'none').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32);
  return `album-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 递归找出禁止字段路径 / Recursively find forbidden-field paths. */
export function findForbidden(value, prefix = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_FIELDS.includes(key)) found.push(path);
    if (val && typeof val === 'object') findForbidden(val, path, found);
  }
  return found;
}

/** 递归剔除禁止字段，返回新对象 / Recursively strip forbidden fields into a new object. */
export function stripForbidden(value) {
  if (Array.isArray(value)) return value.map(stripForbidden);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.includes(key)) continue;
    out[key] = stripForbidden(val);
  }
  return out;
}

/**
 * 构造一条结构化日志事件。
 * 必填 event/correlationId/stage/outcome/durationMs；可选字段按契约追加；
 * provider 与 errorClass 始终存在（可为 null），以同时满足 observability.requiredFields。
 *
 * Build one structured log event. Required: event/correlationId/stage/outcome/
 * durationMs; optional fields are appended per the contract. provider and
 * errorClass are always present (nullable) to also satisfy observability.
 */
export function buildLogEvent(fields = {}) {
  const clean = stripForbidden(fields);
  const event = {
    event: String(clean.event ?? ''),
    correlationId: String(clean.correlationId ?? ''),
    stage: String(clean.stage ?? ''),
    outcome: String(clean.outcome ?? ''),
    durationMs: Number.isFinite(clean.durationMs) ? clean.durationMs : 0,
    provider: clean.provider ?? null,
    errorClass: clean.errorClass ?? null,
  };
  for (const key of STRUCTURED_LOG_OPTIONAL) {
    if (key === 'provider' || key === 'errorClass') continue;
    if (clean[key] !== undefined && clean[key] !== null) event[key] = clean[key];
  }
  for (const key of STRUCTURED_LOG_REQUIRED) {
    if (event[key] === '' || event[key] === undefined || event[key] === null) {
      throw new Error(`结构化日志缺少必填字段 / missing required log field: ${key}`);
    }
  }
  if (!LOG_STAGES.includes(event.stage)) {
    throw new Error(`日志 stage 不在契约内 / log stage not in contract: ${event.stage}`);
  }
  return event;
}

/** 输出一行 JSON（结构化日志）/ Emit one JSON line (structured log). */
export function emitLog(fields, sink = console.log) {
  const line = JSON.stringify(buildLogEvent(fields));
  sink(line);
  return line;
}

/** 生产默认 logger：一行一个 JSON / Production default: one JSON per line. */
export function createConsoleLogger() {
  return { emit: (fields) => emitLog(fields, console.log), events: null };
}

/**
 * 输出一条契约形状的结构化日志（emitLog 的防故障包装）。
 *
 * 日志是取证手段，不是业务步骤：字段名写错、stage 不在契约里，都不该反过来
 * 让一次上传失败。格式错误只留一条 warn，主流程继续。
 *
 * Emit one contract-shaped structured log line. Logging is evidence, not a
 * business step — a malformed field must never fail the upload it describes;
 * the error is reduced to a warn line and the main flow continues.
 */
export function trace(fields = {}, sink = console.log) {
  try {
    return emitLog(fields, sink);
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'trace.invalid',
      error: err?.name || 'Error',
      detail: String(err?.message ?? err).slice(0, 200),
    }));
    return null;
  }
}

/** 离线测试替身：把事件收集到内存 / Offline test double: collect events in memory. */
export function createMemoryLogger() {
  const events = [];
  return {
    events,
    emit(fields) {
      const built = buildLogEvent(fields);
      events.push(built);
      return built;
    },
  };
}
