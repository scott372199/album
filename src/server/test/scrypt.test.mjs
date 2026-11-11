import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSharedKey, verifySharedKey, parseHash, DUMMY_HASH } from '../lib/scrypt.mjs';

// 用较小的 N 跑测试：参数是自描述的，校验时按值里的 N 算，所以小 N 也能
// 完整走通格式与比对逻辑，只是快得多。
const FAST = { N: 1024, r: 8, p: 1 };

test('正确密钥通过，错误密钥不通过', () => {
  const stored = hashSharedKey('N4yjrz-YezR0cdMcK6FnXSZjUI6AO3S0', FAST);
  assert.equal(verifySharedKey('N4yjrz-YezR0cdMcK6FnXSZjUI6AO3S0', stored), true);
  assert.equal(verifySharedKey('N4yjrz-YezR0cdMcK6FnXSZjUI6AO3S1', stored), false);
  assert.equal(verifySharedKey('', stored), false);
});

test('哈希格式与 infra 的变量校验一致：scrypt$N$r$p$salt$hash', () => {
  const stored = hashSharedKey('k', FAST);
  assert.match(stored, /^scrypt\$1024\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(parseHash(stored)).sort(), ['N', 'hash', 'p', 'r', 'salt']);
});

test('每次生成的盐都不同，但都指向同一个密钥', () => {
  const a = hashSharedKey('k', FAST);
  const b = hashSharedKey('k', FAST);
  assert.notEqual(a, b);
  assert.equal(verifySharedKey('k', a), true);
  assert.equal(verifySharedKey('k', b), true);
});

test('格式损坏一律判不通过而不是抛错', () => {
  for (const bad of ['', 'plain', 'scrypt$1$2', 'bcrypt$1024$8$1$aa$bb', 'scrypt$abc$8$1$aa$bb']) {
    assert.equal(verifySharedKey('k', bad), false);
    assert.equal(parseHash(bad), null);
  }
});

test('参数过大直接拒绝，避免一次登录吃穿 CPU', () => {
  assert.equal(parseHash(`scrypt$99999999$8$1$${'00'.repeat(16)}$${'00'.repeat(32)}`), null);
});

test('DUMMY_HASH 是合法格式：白名单外也要付出同样的代价', () => {
  assert.ok(parseHash(DUMMY_HASH));
  assert.equal(verifySharedKey('anything', DUMMY_HASH), false);
});
