/**
 * 构建期文案生成（V6 T-22 / T-23 共用）/ Build-time sentence writer.
 *
 * 一件事：把「这个月（这一年）有什么」交给模型，要回一两句中文。
 * **模型只写句子，不选片、不改结构**——选片在 `curation.mjs` 里由规则定死。
 *
 * 三条纪律，比功能本身重要：
 *
 * 1. **没有凭据就什么都不做**。`config === null` 时 `write()` 直接返回空表，
 *    不发请求、不抛错、不留缓存。CI 里没有凭据是常态，构建必须照常成功。
 * 2. **失败只丢文案，不丢产物**。超时、非 2xx、返回的不是 JSON、句子跑题，
 *    一律当作「这句没生成」——照片的 9 张精选照发。
 * 3. **按 (rev, prompt 版本) 缓存**。同一份清单重复构建不重复计费，也是
 *    「同一 rev 产物一致」的落地方式；缓存写在 `src/build/cache/`（见 plan §4.6）。
 *
 * 日志里不出现地址与凭据：失败只报一句「模型不可用」，因为构建日志会进 CI。
 *
 * The model writes sentences only — selection is rule-based elsewhere. No
 * credentials means no request at all; any failure loses the sentence, never the
 * artifact; output is cached per (rev, prompt version) so rebuilds are free and
 * idempotent. Logs never carry the endpoint or the key.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 提示词版本：改提示词就 +1，旧缓存自然失效 */
export const PROMPT_VERSION = 1;
/** 一次请求的上限：构建不能被网络拖住 */
export const REQUEST_TIMEOUT_MS = 20000;
/** 一次批量最多带这么多条，超出的分批 */
export const BATCH_SIZE = 12;

const SYSTEM_PROMPT = [
  '你在为一个私人相册写一句话导读。',
  '只写一句中文，12 到 24 个字，平实、具体，像家人翻相册时随口说的一句话。',
  '只能使用给你的「张数」与「内容词」，不要编造没给你的东西。',
  '禁止出现：日期、具体时间、地名、人名、相机型号、任何网址。',
  '禁止套话：「这一段，走完了」「时光飞逝」「记录美好生活」这类一律不要。',
  '结尾不加句号。',
  '只输出 JSON 数组，形如 [{"key":"2026-11","text":"..."}]，不要任何解释。',
].join('\n');

/**
 * 从环境变量读配置。缺一个就当作没有配置——半个配置比没有配置更危险。
 * 只接受 https：不该向明文地址发送凭据。
 *
 * **凭据有两种来源，优先级明确**：
 *   - `ALBUM_LLM_KEY`（构建期 / 本地）：直接给明文，方便离线和一次性构建；
 *   - `ALBUM_LLM_KEY_PARAM`（线上）：只给 **SSM 参数路径**，密钥本身在
 *     SecureString 里，运行时才取。环境变量是低密级数据——`lambda:GetFunction
 *     Configuration` 就能读，所以密钥本身绝不放进环境变量。
 *
 * Two credential sources, in order: a plaintext key for local builds, or the
 * path of an SSM SecureString for the runtime. Env vars are readable by anyone
 * with lambda:GetFunctionConfiguration, so the secret itself never goes there.
 */
export function llmConfig(env = process.env) {
  const endpoint = String(env.ALBUM_LLM_ENDPOINT || '').trim();
  const key = String(env.ALBUM_LLM_KEY || '').trim();
  const keyParam = String(env.ALBUM_LLM_KEY_PARAM || '').trim();
  const model = String(env.ALBUM_LLM_MODEL || '').trim();
  if (!endpoint || !model || !(key || keyParam)) return null;
  if (!/^https:\/\//i.test(endpoint)) return null;
  return { endpoint, model, key, keyParam };
}

/** 只留一句能公开的中文：单行、限长、不含数字（数字多半是日期或时间） */
export function sanitizeSentence(text, { max = 48 } = {}) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/["“”「」]/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (/\d/.test(flat)) return '';
  if (/https?:|www\.|\.com/i.test(flat)) return '';
  if (/这一段[，,].{0,4}走完了/.test(flat)) return '';
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped.replace(/[。；;]$/, '');
}

/** 从模型返回里抠出 JSON 数组：允许前后有解释性文字 */
export function parseSentences(raw) {
  if (typeof raw !== 'string') return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => item && typeof item.key === 'string')
    .map((item) => ({ key: item.key, text: sanitizeSentence(item.text) }))
    .filter((item) => item.text);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 造一个写入器。返回值：
 *   enabled —— 有没有真的接上模型
 *   write(rev, jobs) —— jobs: [{ key, facts }]，返回 Map(key → 句子)
 *
 * 缓存文件：`<cacheDir>/<rev>.v<PROMPT_VERSION>.json`。`cacheDir` 给空串时
 * 只在内存里缓存（测试与一次性构建用）。
 */
export function createWriter({
  config = null,
  fetchImpl = globalThis.fetch,
  cacheDir = '',
  timeoutMs = REQUEST_TIMEOUT_MS,
  loadParam = null,
  logger = console.warn,
} = {}) {
  const enabled = Boolean(config && config.endpoint && config.model
    && (config.key || config.keyParam)
    && typeof fetchImpl === 'function');
  const memory = new Map();
  let loadedRev = '';
  let keyCache = '';

  /**
   * 拿到密钥。给了明文就用明文；只给了 SSM 路径就去取（进程内缓存由
   * `lib/params.mjs` 负责，5 分钟）。**取不到不算错误**——没有密钥和没有
   * 配置是同一种情况：这一次不写文案，产物照发。
   *
   * 动态 import 是刻意的：本地构建不该为了一个用不到的凭据去加载 AWS SDK。
   */
  async function apiKey() {
    if (config.key) return config.key;
    if (keyCache) return keyCache;
    if (!config.keyParam) return '';
    try {
      const resolve = loadParam || (async (name) => {
        const { loadSecrets } = await import('../lib/params.mjs');
        const secrets = await loadSecrets({ llmKey: name });
        return secrets.llmKey;
      });
      keyCache = String(await resolve(config.keyParam) || '');
      return keyCache;
    } catch (err) {
      // 只报「取不到」，不报参数路径以外的任何内容，绝不带出值
      logger(`文案凭据读取失败（不影响产物）：${err.message}`);
      return '';
    }
  }

  function cacheFile(rev) {
    return cacheDir ? path.join(cacheDir, `${rev}.v${PROMPT_VERSION}.json`) : '';
  }

  async function loadCache(rev) {
    if (loadedRev === rev) return;
    loadedRev = rev;
    const file = cacheFile(rev);
    if (!file) return;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (Number(raw?.version) !== PROMPT_VERSION) return;
      for (const [key, text] of Object.entries(raw.items || {})) {
        const clean = sanitizeSentence(text);
        if (clean) memory.set(key, clean);
      }
    } catch {
      // 没有缓存是常态
    }
  }

  async function saveCache(rev) {
    const file = cacheFile(rev);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const items = {};
      // 码点序输出：缓存文件也不该因机器而异
      for (const key of [...memory.keys()].sort()) items[key] = memory.get(key);
      await writeFile(file, JSON.stringify({ version: PROMPT_VERSION, items }, null, 2));
    } catch (err) {
      logger(`文案缓存写入失败（不影响构建）：${err.message}`);
    }
  }

  async function request(rev, batch, key) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 密钥只在请求头里出现，不进 URL、不进 body、不进日志
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.7,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ rev, items: batch }) },
          ],
        }),
        signal: controller?.signal,
      });
      if (!response || !response.ok) {
        logger(`文案生成不可用（HTTP ${response ? response.status : '无响应'}），本次只用规则选片`);
        return;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      for (const item of parseSentences(content)) memory.set(item.key, item.text);
    } catch {
      // 超时 / 断网 / 返回体不是 JSON：一句话都不写，构建照常往下走
      logger('文案生成不可用（请求失败），本次只用规则选片');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function write(rev, jobs) {
    const wanted = (Array.isArray(jobs) ? jobs : []).filter((job) => job && typeof job.key === 'string');
    if (!wanted.length) return new Map();
    await loadCache(rev);
    const missing = wanted.filter((job) => !memory.has(job.key));
    // 缓存已经覆盖了全部请求时不必去取凭据
    const key = enabled && missing.length ? await apiKey() : '';
    if (!key || !missing.length) {
      return new Map(wanted.filter((job) => memory.has(job.key)).map((job) => [job.key, memory.get(job.key)]));
    }
    for (const batch of chunk(missing, BATCH_SIZE)) {
      await request(rev, batch.map((job) => ({ key: job.key, facts: job.facts || {} })), key);
    }
    await saveCache(rev);
    return new Map(wanted.filter((job) => memory.has(job.key)).map((job) => [job.key, memory.get(job.key)]));
  }

  return { enabled, write };
}
