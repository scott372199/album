/**
 * 识别 worker：SQS 消费入口 / Recognition worker: SQS consumer entry.
 *
 * 与 processor 发布链路彻底解耦：本文件不 import 任何 processor 模块，
 * 识别失败只写 DLQ + 结构化日志，并仍然发出 recognition event，
 * 让索引为该照片保留 source=manifest 的条目。照片上线由 v4 processor 独立完成，
 * 识别超时/限流/不可用绝不阻塞它（FR-02、硬性不变量 2）。
 *
 * Fully decoupled from processor publication: this file imports no processor
 * module. Recognition failure writes to the DLQ plus a structured log and still
 * emits a recognition event so the index keeps a source=manifest entry.
 * Publication is owned by the v4 processor and is never blocked by recognition
 * timeouts, throttling or outages (FR-02, hard invariant 2).
 *
 * queue / provider / dedupe / logger / clock 全部可注入，离线测试零云依赖。
 * queue/provider/dedupe/logger/clock are all injectable: no cloud in tests.
 */
import { createHash } from 'node:crypto';
import {
  resolveCorrelationId, safeObjectKeyDigest, createConsoleLogger,
} from '../v5/correlation.mjs';
import { backoffMs } from '../lib/retry.mjs';
import { buildRecognitionInput, RecognitionInputError } from './input.mjs';
import {
  assertProvider, normalizeLabels, assertNoRawResponse, toEventLabels,
  isRetryableProviderError,
} from './provider.mjs';

/** 与契约 recognition.event 一致的字段白名单 / contract event field whitelist. */
export const RECOGNITION_EVENT_NAME = 'recognition.completed';
export const EVENT_STATUSES = ['success', 'failed', 'skipped'];

/** 幂等去重存储（可注入）/ injectable idempotency store. */
export function createInMemoryDedupe() {
  const keys = new Set();
  return {
    keys,
    has(key) { return keys.has(key); },
    add(key) { keys.add(key); return true; },
    release(key) { keys.delete(key); },
  };
}

/**
 * 离线 SQS 替身：retry 会把消息重新投递并递增 attempt，
 * 模拟真实 SQS 的可见性超时重投。
 *
 * Offline SQS double: retry re-delivers the message with an incremented
 * attempt, mirroring real SQS visibility-timeout redelivery.
 */
export function createMemoryQueue(messages = []) {
  const pending = [...messages];
  const acked = [];
  const dlq = [];
  const retries = [];
  return {
    pending, acked, dlq, retries,
    async receive({ maxNumber = 10 } = {}) {
      return pending.splice(0, maxNumber);
    },
    async ack(receiptHandle) { acked.push(receiptHandle); },
    async retry(message, { attempt = 1, delayMs = 0 } = {}) {
      retries.push({ receiptHandle: message.receiptHandle, attempt, delayMs });
      pending.push({
        ...message,
        attempt,
        receiptHandle: `${message.receiptHandle}#retry${attempt}`,
      });
    },
    async toDlq(message, { reason = '', errorClass = null } = {}) {
      dlq.push({ message, reason, errorClass });
    },
  };
}

export function parseMessageBody(message) {
  const body = message?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return { ...body };
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return {};
}

/**
 * 构造 recognition.completed 事件（契约 recognition.event 形状）。
 * 标签在这里由 {term,zh,kind,confidence} 转成 {name,confidence,category}。
 *
 * Build a recognition.completed event in the contract shape; labels are
 * converted here from {term,zh,kind,confidence} to {name,confidence,category}.
 */
export function buildRecognitionEvent({
  input, correlationId, status = 'success', labels = [],
  errorClass = null, provider = null, occurredAt,
}) {
  if (!EVENT_STATUSES.includes(status)) {
    throw new Error(`非法识别状态 / invalid recognition status: ${status}`);
  }
  const eventId = `evt_${createHash('sha256')
    .update(`${input.idempotencyKey}:${status}`, 'utf8')
    .digest('hex').slice(0, 16)}`;
  return {
    event: RECOGNITION_EVENT_NAME,
    eventId,
    correlationId,
    assetId: input.assetId,
    contentHash: input.contentHash,
    sourceAsset: input.sourceAsset,
    provider,
    status,
    labels: toEventLabels(labels),
    errorClass,
    occurredAt: occurredAt || new Date().toISOString(),
  };
}

/**
 * 创建 worker。关键回调 onOutcome(event)：成功与最终失败都会调用，
 * 由调用方把事件送进索引构建；这正是「识别失败仍可发布」的接线点。
 *
 * Create the worker. onOutcome(event) fires on both success and final failure;
 * the caller feeds it into index building. This is the wiring that keeps
 * publication alive when recognition fails.
 */
export function createWorker({
  queue = createMemoryQueue(),
  provider,
  dedupe = createInMemoryDedupe(),
  logger = createConsoleLogger(),
  clock = { now: () => Date.now() },
  maxAttempts = 3,
  onOutcome = null,
} = {}) {
  assertProvider(provider);

  const notify = async (event) => {
    if (typeof onOutcome === 'function') await onOutcome(event);
  };

  async function processMessage(message) {
    const started = clock.now();
    const elapsed = () => Math.max(0, clock.now() - started);
    const body = parseMessageBody(message);
    const correlationId = resolveCorrelationId(
      body.correlationId ?? message?.attributes?.correlationId,
    );
    const attempt = Number.isInteger(message?.attempt)
      ? message.attempt
      : Number(message?.attributes?.approximateReceiveCount) || 1;
    const stage = 'recognition';
    const digest = safeObjectKeyDigest(String(body.sourceAsset || ''));
    const base = { correlationId, stage, objectKeyDigest: digest, attempt };

    // 1) 坏事件（含 incoming/ 原图）：直接入 DLQ，不重试、不进索引
    //    Bad events (including incoming originals): straight to DLQ.
    let input;
    try {
      input = buildRecognitionInput({ ...body, correlationId });
    } catch (err) {
      const errorClass = err instanceof RecognitionInputError
        ? err.errorClass : 'invalid-event';
      await queue.toDlq(message, { reason: 'invalid-recognition-input', errorClass });
      await queue.ack(message.receiptHandle);
      logger.emit({
        ...base, event: 'recognition.dlq', outcome: 'dlq', durationMs: elapsed(),
        errorClass,
      });
      return { outcome: 'dlq', errorClass, correlationId };
    }

    // 2) 幂等去重：重复触发只 ack，不再调用 provider
    //    Idempotency: a duplicate is acked without calling the provider.
    if (dedupe.has(input.idempotencyKey)) {
      await queue.ack(message.receiptHandle);
      logger.emit({
        ...base, event: 'recognition.duplicate', outcome: 'duplicate',
        durationMs: elapsed(), assetId: input.assetId,
      });
      return { outcome: 'duplicate', correlationId, idempotencyKey: input.idempotencyKey };
    }
    dedupe.add(input.idempotencyKey);

    // 3) 识别 + 事件日志
    try {
      const result = await provider.detectLabels(input);
      assertNoRawResponse(result);
      const labels = normalizeLabels(result.labels);
      const event = buildRecognitionEvent({
        input, correlationId, status: 'success', labels,
        errorClass: null, provider: result.provider ?? null,
        occurredAt: new Date(clock.now()).toISOString(),
      });
      await queue.ack(message.receiptHandle);
      logger.emit({
        ...base, event: RECOGNITION_EVENT_NAME, outcome: 'success',
        durationMs: elapsed(), assetId: input.assetId,
        provider: result.provider ?? null, errorClass: null,
      });
      await notify(event);
      return { outcome: 'success', event, correlationId };
    } catch (err) {
      const errorClass = err?.errorClass || 'provider-error';
      const retryable = isRetryableProviderError(err);

      // 3a) 瞬时失败：退避后重投，释放幂等键让重投能重新处理
      //     Transient failure: back off, redeliver, release the idempotency key.
      if (retryable && attempt < maxAttempts) {
        dedupe.release(input.idempotencyKey);
        await queue.retry(message, {
          attempt: attempt + 1,
          delayMs: backoffMs(attempt),
        });
        logger.emit({
          ...base, event: 'recognition.retry', outcome: 'retry',
          durationMs: elapsed(), assetId: input.assetId,
          errorClass,
        });
        return { outcome: 'retry', correlationId, attempt: attempt + 1, errorClass };
      }

      // 3b) 最终失败：坏事件进 DLQ，但仍产出 failed 事件与日志，
      //     索引据此保留 source=manifest 条目；照片上线不受影响。
      //     Final failure: DLQ + failed event + log. The index keeps a
      //     source=manifest entry; publication is unaffected.
      dedupe.release(input.idempotencyKey);
      const event = buildRecognitionEvent({
        input, correlationId, status: 'failed', labels: [],
        errorClass, provider: null,
        occurredAt: new Date(clock.now()).toISOString(),
      });
      await queue.toDlq(message, { reason: 'recognition-failed', errorClass });
      await queue.ack(message.receiptHandle);
      logger.emit({
        ...base, event: 'recognition.failed', outcome: 'failure',
        durationMs: elapsed(), assetId: input.assetId,
        errorClass,
      });
      await notify(event);
      return { outcome: 'dlq', event, correlationId, errorClass };
    }
  }

  async function run({ maxBatches = 20, maxNumber = 10 } = {}) {
    const results = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const messages = await queue.receive({ maxNumber });
      if (!messages || !messages.length) break;
      for (const message of messages) {
        results.push(await processMessage(message));
      }
    }
    return results;
  }

  return { processMessage, run };
}
