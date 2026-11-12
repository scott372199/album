/**
 * 重试相关的纯判定。
 *
 * 单独放一个文件是为了能被单测覆盖：`store.mjs` 依赖 AWS SDK，而 CI 的
 * 测试任务不装依赖（这正是把这些判定拆出来的原因）。
 *
 * Kept separate so it can be unit-tested: `store.mjs` imports the AWS SDK and
 * the CI test job installs nothing, which is exactly why these predicates live
 * outside it.
 */

/**
 * 前置条件失败：别人抢先写过了，重读再来就是，不该当成错误。
 *
 * S3 / DynamoDB 对条件写失败返回 412 PreconditionFailed；同一键被并发写入时
 * 偶尔给 409 ConditionalRequestConflict。两个都认，否则并发上传会直接失败。
 *
 * A precondition failure means someone else wrote first — re-read and retry.
 * S3 answers 412, and 409 when the same key is written concurrently.
 */
export function isPreconditionFailed(err) {
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name || '';
  return status === 412
    || status === 409
    || name === 'PreconditionFailed'
    || name === 'ConditionalRequestConflict';
}

/**
 * 退避时间：线性增长 + 抖动。
 *
 * 两个实例同时冲突后如果按同样的节奏重试，会一直撞在一起；加抖动把它们错开。
 * Linear backoff with jitter: identical schedules would keep colliding.
 */
export function backoffMs(attempt, baseMs = 50, rand = Math.random) {
  const safeAttempt = Math.min(Math.max(attempt, 1), 10);
  return baseMs * safeAttempt + Math.floor(rand() * baseMs);
}
