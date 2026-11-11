import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * 极简 Lambda runtime client。
 *
 * 为什么自己写而不是用官方的 `aws-lambda-ric`：那个包要在构建时做原生编译
 * （cmake + g++，几分钟且容易失败），而 runtime API 本身只有「取任务 → 回结果」
 * 两个动作。自带这个循环之后，基础镜像可以放心用 `node:22-bookworm-slim`
 * ——那里 `apt install ffmpeg` 是一条稳当的路，而官方 Lambda 基础镜像的
 * AL2023 仓库里没有 ffmpeg。
 *
 * 入口由 `image_config.command` 决定（`auth/handler.handler`），因此
 * 「同一个镜像两个函数」不需要额外机制。
 *
 * Why hand-roll instead of `aws-lambda-ric`: that package needs a native build
 * (cmake + g++) which is slow and fragile, while the runtime API itself is just
 * "get invocation, post result". Owning this loop lets the base image be plain
 * `node:22-bookworm-slim`, where `apt install ffmpeg` is dependable — the
 * official Lambda base (AL2023) has no ffmpeg package.
 *
 * The entrypoint comes from `image_config.command`, which is how one image
 * serves two functions.
 */

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API;
if (!RUNTIME_API) {
  console.error('AWS_LAMBDA_RUNTIME_API is not set; this entrypoint only runs inside Lambda');
  process.exit(2);
}

const BASE = `http://${RUNTIME_API}/2018-06-01/runtime`;

/** "auth/handler.handler" → { file: "auth/handler.mjs", name: "handler" } */
export function parseSpec(spec) {
  const dot = String(spec || '').lastIndexOf('.');
  if (dot <= 0) throw new Error(`handler spec 不合法 / invalid handler spec: ${spec}`);
  return {
    file: `${String(spec).slice(0, dot)}.mjs`,
    name: String(spec).slice(dot + 1) || 'handler',
  };
}

function serializeError(err) {
  return {
    errorType: err?.name || 'Error',
    errorMessage: String(err?.message ?? err).slice(0, 2048),
    stackTrace: String(err?.stack || '').split('\n').slice(0, 20),
  };
}

async function post(url, body, errorType) {
  const headers = { 'content-type': 'application/json' };
  if (errorType) headers['lambda-runtime-function-error-type'] = errorType;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? null),
  });
  if (!response.ok) {
    throw new Error(`runtime api POST ${url} → ${response.status}`);
  }
}

const { file, name } = parseSpec(process.argv[2]);

let handler;
try {
  const module = await import(pathToFileURL(resolve(process.cwd(), file)).href);
  handler = module[name] || module.default;
  if (typeof handler !== 'function') {
    throw new Error(`导出 ${name} 不是函数 / export ${name} is not a function`);
  }
} catch (err) {
  // 初始化失败的函数永远跑不起来，必须让 Lambda 知道，否则会一直等到超时
  await post(`${BASE}/init/error`, serializeError(err), 'Runtime.InitError').catch(() => {});
  process.exit(1);
}

for (;;) {
  let next;
  try {
    next = await fetch(`${BASE}/invocation/next`);
  } catch (err) {
    console.error(`runtime api unavailable: ${err?.message ?? err}`);
    await new Promise((done) => setTimeout(done, 200));
    continue;
  }

  const requestId = next.headers.get('lambda-runtime-aws-request-id');
  const deadlineMs = Number(next.headers.get('lambda-runtime-deadline-ms') || 0);
  const raw = await next.text();

  let event;
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch {
    event = raw;
  }

  try {
    const result = await handler(event, { requestId, deadlineMs });
    await post(`${BASE}/invocation/${requestId}/response`, result === undefined ? null : result);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'invocation failed',
      requestId,
      errorType: err?.name || 'Error',
      detail: String(err?.message ?? err).slice(0, 300),
    }));
    // 回错误而不是退出：Lambda 会按函数的重试策略决定重试，进程要留着接下一单
    await post(`${BASE}/invocation/${requestId}/error`, serializeError(err), 'Runtime.UnhandledError')
      .catch(() => {});
  }
}
