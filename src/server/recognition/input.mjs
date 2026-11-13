/**
 * 识别输入校验 / Recognition input validation.
 *
 * 硬性不变量：识别只读取已脱敏的派生图 photos/<12hex>/(grid|view).webp，
 * incoming/ 原图（含 EXIF/GPS）一律拒绝，绝不发给第三方识别服务。
 *
 * Hard invariant: recognition reads only redacted derivatives; incoming/
 * originals (which may carry EXIF/GPS) are always rejected and never sent
 * to a third-party recognition service.
 *
 * 纯校验 + 纯构造，不碰网络、不引入依赖。
 * Pure validation and construction: no network, no dependencies.
 */
import { createHash } from 'node:crypto';
import { CONTRACT, resolveCorrelationId } from '../v5/correlation.mjs';

/** 白名单直接取自契约 / whitelist straight from the contract. */
export const SOURCE_ASSET_PATTERN = new RegExp(
  CONTRACT.recognition.event.properties.sourceAsset.pattern,
);
export const ASSET_ID_PATTERN = /^[a-f0-9]{12}$/;
export const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const INCOMING_PREFIX = 'incoming/';
export const DERIVATIVE_NAMES = ['grid.webp', 'view.webp'];

export class RecognitionInputError extends Error {
  constructor(message, errorClass) {
    super(message);
    this.name = 'RecognitionInputError';
    this.errorClass = errorClass;
  }
}

export function isIncomingOriginal(key) {
  return typeof key === 'string' && key.startsWith(INCOMING_PREFIX);
}

export function isRedactedDerivative(key) {
  return typeof key === 'string' && SOURCE_ASSET_PATTERN.test(key);
}

/**
 * 严格校验三要素，并确认 assetId 与 sourceAsset 里的目录一致。
 * 非法输入一律抛 RecognitionInputError（带 errorClass 供日志/DLQ 分类）。
 *
 * Strictly validate the three fields and confirm the assetId matches the
 * directory inside sourceAsset. Invalid input throws with an errorClass.
 */
export function validateRecognitionInput(raw = {}) {
  const sourceAsset = typeof raw.sourceAsset === 'string' ? raw.sourceAsset : '';
  const assetId = typeof raw.assetId === 'string' ? raw.assetId : '';
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash : '';

  // 原图必须最先被识别，给出专门的 errorClass，而不是笼统的「非法资产」
  // Detect originals first so they get a dedicated errorClass.
  if (isIncomingOriginal(sourceAsset)) {
    throw new RecognitionInputError(
      'incoming/ 原图禁止进入识别 / incoming original is rejected',
      'incoming-original-rejected',
    );
  }
  if (!isRedactedDerivative(sourceAsset)) {
    throw new RecognitionInputError(
      'sourceAsset 必须是已脱敏派生图 / redacted derivative required',
      'invalid-source-asset',
    );
  }
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new RecognitionInputError(
      'assetId 必须是 12 位小写十六进制 / 12-hex asset id required',
      'invalid-asset-id',
    );
  }
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new RecognitionInputError(
      'contentHash 必须是小写 sha256 / lowercase sha256 required',
      'invalid-content-hash',
    );
  }
  if (sourceAsset.split('/')[1] !== assetId) {
    throw new RecognitionInputError(
      'assetId 与 sourceAsset 不一致 / asset id mismatch',
      'asset-id-mismatch',
    );
  }
  return { sourceAsset, assetId, contentHash };
}

/** 幂等键 = sha256(assetId:contentHash:sourceAsset) / deterministic idempotency key. */
export function buildIdempotencyKey({ assetId, contentHash, sourceAsset }) {
  return createHash('sha256')
    .update(`${assetId}:${contentHash}:${sourceAsset}`, 'utf8')
    .digest('hex');
}

/**
 * 构造 vendor-neutral 识别输入：不含 S3Object / Bucket / 命令对象等
 * 云厂商字段，adapter 负责再映射到具体 SDK 参数。
 *
 * Build a vendor-neutral recognition input: no S3Object / Bucket / command
 * objects. The adapter maps it to SDK parameters later.
 */
export function buildRecognitionInput(raw = {}) {
  const validated = validateRecognitionInput(raw);
  return {
    assetId: validated.assetId,
    contentHash: validated.contentHash,
    sourceAsset: validated.sourceAsset,
    idempotencyKey: buildIdempotencyKey(validated),
    correlationId: resolveCorrelationId(raw.correlationId),
    image: { key: validated.sourceAsset },
  };
}
