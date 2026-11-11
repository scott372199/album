import { env } from './config.mjs';

/**
 * 结构化日志：一行一个 JSON，CloudWatch Logs Insights 可直接查字段。
 * 绝不允许把手机号明文、共享密钥、令牌写进日志——这是 FR-25.3 的硬要求，
 * 所以掩码函数由本模块统一提供，不在调用处临时拼字符串。
 *
 * Structured logging: one JSON object per line so CloudWatch Logs Insights can
 * query fields directly. Plaintext phone numbers, the shared key and tokens are
 * never logged (FR-25.3), which is why masking lives here rather than at call
 * sites.
 */

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  return ORDER[env('LOG_LEVEL', 'info')] ?? ORDER.info;
}

function write(level, message, fields) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    level,
    msg: message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

/** 18650090309 → 186****0309；长度异常的输入一律退化为固定串 */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 错误只取类型与消息，不把堆栈塞进业务字段（堆栈由运行时打进 stderr） */
export function errorFields(err) {
  return {
    error: err?.name || 'Error',
    detail: String(err?.message ?? err).slice(0, 300),
  };
}
