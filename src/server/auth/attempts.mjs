import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { envInt } from '../lib/config.mjs';

/**
 * 登录失败计数。存在 DynamoDB 里而不是内存里：Lambda 容器随时会被回收，
 * 内存计数器挡不住「换一个容器继续试」。
 *
 * Failure counters live in DynamoDB, not memory: containers come and go, and an
 * in-memory counter would reset with every cold start.
 */

let document;
function ddb() {
  if (!document) {
    document = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return document;
}

function table() {
  const name = process.env.ATTEMPTS_TABLE;
  if (!name) throw new Error('缺少环境变量 / missing env var: ATTEMPTS_TABLE');
  return name;
}

/** 计数键：由令牌主体派生，表里不出现明文手机号 */
export function attemptKey(subject) {
  return `p#${subject}`;
}

export async function readAttempts(key) {
  const response = await ddb().send(new GetCommand({
    TableName: table(),
    Key: { pk: key },
  }));
  const count = Number(response.Item?.count ?? 0);
  return { count: Number.isFinite(count) ? count : 0 };
}

export async function recordFailure(key) {
  const window = envInt('ATTEMPT_WINDOW', 900);
  const expiresAt = Math.floor(Date.now() / 1000) + window;
  await ddb().send(new UpdateCommand({
    TableName: table(),
    Key: { pk: key },
    // 每次失败都把窗口往后推：连续尝试会一直被挡住，而不是等固定窗口过去
    // Each failure extends the window, so sustained guessing stays blocked
    UpdateExpression: 'ADD #count :one SET #expires = :expires',
    ExpressionAttributeNames: { '#count': 'count', '#expires': 'expires_at' },
    ExpressionAttributeValues: { ':one': 1, ':expires': expiresAt },
  }));
}

/** 登录成功后清零，避免「昨天输错几次」影响今天 */
export async function clearAttempts(key) {
  await ddb().send(new DeleteCommand({
    TableName: table(),
    Key: { pk: key },
  }));
}
