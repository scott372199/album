/**
 * AWS Rekognition DetectLabels provider（注入式）/ injectable AWS Rekognition provider.
 *
 * 决策 D-2：AWS Rekognition DetectLabels + Image Properties（主色）；仅脱敏派生图入参，
 * 数据不出 AWS。仓库未安装 @aws-sdk/client-rekognition，本轮也不新增依赖，
 * 因此 SDK client 通过 `callDetectLabels` 注入：生产 adapter 内部用
 * RekognitionClient + DetectLabelsCommand 调用 send；离线测试注入 fake。
 * 本模块绝不静态 import 任何 AWS SDK 包。
 *
 * D-2: AWS Rekognition DetectLabels + Image Properties (dominant colors),
 * redacted derivatives only. The SDK is injected via `callDetectLabels`
 * (a production adapter wraps RekognitionClient + DetectLabelsCommand).
 * This module never statically imports an AWS SDK package.
 *
 * 任何情况下只返回规范化标签，绝不返回 raw response。
 * Only normalized labels are ever returned; no raw response, ever.
 */
import {
  normalizeLabels, assertNoRawResponse, LABEL_KINDS,
  RecognitionProviderError,
} from './provider.mjs';
import {
  TERM_ZH, TERM_KIND, zhForTerm,
} from '../search/vocabulary.mjs';
import { isRedactedDerivative, RecognitionInputError } from './input.mjs';

/** 中文标签词典：规范词 → 中文展示词 / Chinese label dictionary. */
export const ZH_LABEL_DICT = { ...TERM_ZH };

/** Rekognition 英文标签名 → 规范词 / English label name -> canonical term. */
export const EN_TERM_MAP = {
  lake: 'lake', lakes: 'lake', pond: 'lake', water: 'lake',
  mountain: 'mountain', mountains: 'mountain', peak: 'mountain', hill: 'mountain',
  'blue sky': 'blue sky', sky: 'blue sky', 'clear sky': 'blue sky', cloud: 'blue sky',
  car: 'car', cars: 'car', automobile: 'car', vehicle: 'car', sedan: 'car',
  motorcycle: 'motorcycle', motorbike: 'motorcycle', bike: 'motorcycle',
  shirt: 'shirt', 't-shirt': 'shirt', tshirt: 'shirt', clothing: 'shirt',
  apparel: 'shirt', blouse: 'shirt',
  red: 'red', blue: 'blue', green: 'green', white: 'white',
  black: 'black', yellow: 'yellow',
  nature: 'nature', outdoors: 'outdoors', landscape: 'nature',
};

/** 颜色词集合：命中即强制 kind=color / force kind=color for color terms. */
export const COLOR_WORDS = new Set([
  'red', 'blue', 'green', 'white', 'black', 'yellow',
  'brown', 'pink', 'purple', 'orange', 'gray', 'grey',
  'teal', 'cyan', 'magenta',
]);

function kindFromCategories(categories) {
  const names = (Array.isArray(categories) ? categories : [])
    .map((category) => String(category?.Name || '').toLowerCase());
  if (names.some((name) => name.includes('color') || name.includes('appearance'))) return 'color';
  if (names.some((name) => name.includes('scene') || name.includes('nature')
    || name.includes('outdoor') || name.includes('landscape'))) return 'scene';
  return 'object';
}

/**
 * vendor-neutral input → AWS DetectLabels 参数（adapter 内部，不下发给前端）。
 * Features 同时请求 GENERAL_LABELS 与 IMAGE_PROPERTIES，后者提供主色。
 *
 * Map the vendor-neutral input to AWS DetectLabels parameters (adapter-internal).
 * Features requests both GENERAL_LABELS and IMAGE_PROPERTIES (dominant colors).
 */
export function buildDetectLabelsParams(input, {
  bucket = '', maxLabels = 30, minConfidence = 70,
} = {}) {
  return {
    Image: { S3Object: { Bucket: bucket, Name: input.sourceAsset } },
    MaxLabels: maxLabels,
    MinConfidence: minConfidence,
    Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
    Settings: {
      GeneralLabels: { Blacklist: [] },
      ImageProperties: { MaxDominantColors: 10 },
    },
  };
}

/**
 * 把 DetectLabels 原始响应规范化成 {term, zh, kind, confidence}。
 * 只挑白名单字段，绝不 spread 原响应；Confidence 由 0..100 归一到 0..1 单 float。
 * ImageProperties.DominantColors 的主色转成 kind=color 的标签。
 *
 * Normalize a raw DetectLabels response into {term, zh, kind, confidence}.
 * Only whitelisted fields are read; Confidence is mapped from 0..100 to a
 * single 0..1 float. DominantColors become kind=color labels.
 */
export function normalizeRekognitionResponse(raw = {}) {
  const labels = [];
  for (const entry of Array.isArray(raw?.Labels) ? raw.Labels : []) {
    const name = String(entry?.Name || '').trim();
    if (!name) continue;
    const term = EN_TERM_MAP[name.toLowerCase()] || name.toLowerCase();
    const rawConfidence = Number(entry?.Confidence);
    if (!Number.isFinite(rawConfidence)) continue;
    const fromCategories = kindFromCategories(entry?.Categories);
    let kind = TERM_KIND[term] || fromCategories;
    if (COLOR_WORDS.has(term)) kind = 'color';
    if (!LABEL_KINDS.includes(kind)) continue;
    labels.push({
      term,
      zh: ZH_LABEL_DICT[term] || zhForTerm(term),
      kind,
      confidence: Number(Math.min(1, Math.max(0, rawConfidence / 100)).toFixed(4)),
    });
  }

  const dominant = raw?.ImageProperties?.DominantColors;
  for (const color of Array.isArray(dominant) ? dominant : []) {
    const term = String(color?.SimplifiedColor || '').trim().toLowerCase().replace(/_/g, ' ');
    if (!term) continue;
    const pixelPercent = Number(color?.PixelPercent);
    const confidence = Number.isFinite(pixelPercent)
      ? Number(Math.min(1, Math.max(0, pixelPercent / 100)).toFixed(4))
      : 0.9;
    labels.push({
      term,
      zh: ZH_LABEL_DICT[term] || zhForTerm(term),
      kind: 'color',
      confidence,
    });
  }
  return normalizeLabels(labels);
}

/**
 * 生产 provider 工厂。callDetectLabels 由部署方注入（内部用 AWS SDK v3）。
 * 二次校验拒绝非脱敏输入，即使调用方绕过了 input.mjs。
 *
 * Production provider factory. callDetectLabels is injected by deployment
 * (wrapping AWS SDK v3). A second derivative check rejects invalid input even
 * if a caller bypasses input.mjs.
 */
export function createRekognitionProvider({
  callDetectLabels,
  bucket = '',
  maxLabels = 30,
  minConfidence = 70,
} = {}) {
  if (typeof callDetectLabels !== 'function') {
    throw new TypeError('需要注入 callDetectLabels / callDetectLabels is required');
  }
  return {
    name: 'aws-rekognition',
    async detectLabels(input) {
      if (!isRedactedDerivative(input?.sourceAsset)) {
        throw new RecognitionInputError(
          'provider 拒绝非脱敏输入 / provider rejected non-redacted input',
          'invalid-source-asset',
        );
      }
      const params = buildDetectLabelsParams(input, { bucket, maxLabels, minConfidence });
      // raw 只在本函数内短暂存在，绝不进入返回值或日志
      // raw lives only inside this function; it never enters results or logs
      const raw = await callDetectLabels(params);
      const result = {
        labels: normalizeRekognitionResponse(raw),
        provider: 'aws-rekognition',
      };
      return assertNoRawResponse(result);
    },
  };
}

/**
 * 离线测试替身：按 assetId 返回预置标签，或按 failAssets 模拟超时/限流/不可用。
 * callLog 记录每次调用，供幂等测试断言「只调用一次」。
 *
 * Offline fixture: returns preset labels by assetId, or simulates
 * timeout/throttling/outage for failAssets. callLog proves idempotency.
 */
export function createFixtureProvider({
  labelsByAsset = new Map(),
  failAssets = new Set(),
  defaultLabels = [],
  errorClass = 'provider-unavailable',
  callLog = [],
} = {}) {
  return {
    name: 'fixture',
    async detectLabels(input) {
      callLog.push({
        assetId: input?.assetId,
        sourceAsset: input?.sourceAsset,
        idempotencyKey: input?.idempotencyKey,
      });
      if (!isRedactedDerivative(input?.sourceAsset)) {
        throw new RecognitionInputError(
          'fixture 拒绝非脱敏输入 / fixture rejected non-redacted input',
          'invalid-source-asset',
        );
      }
      if (failAssets.has(input.assetId)) {
        throw new RecognitionProviderError(
          `fixture 模拟识别失败 / simulated failure: ${errorClass}`,
          { errorClass },
        );
      }
      const labels = labelsByAsset.get(input.assetId) || defaultLabels;
      return assertNoRawResponse({
        labels: normalizeLabels(labels),
        provider: 'fixture',
      });
    },
  };
}
