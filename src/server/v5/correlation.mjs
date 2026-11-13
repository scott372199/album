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

/** 契约只加载一次 / Load the contract once. */
export const CONTRACT = JSON.parse(
  readFileSync(new URL('../../../spec/v5/contracts/v5-contracts.json', import.meta.url), 'utf8'),
);

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
