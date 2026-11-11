import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, subjectFor } from '../lib/token.mjs';

const SECRET = 'x'.repeat(40);

test('签发与校验往返', () => {
  const token = signToken({ sub: 'abc', typ: 'access' }, SECRET, 60);
  const claims = verifyToken(token, SECRET, 'access');
  assert.equal(claims.sub, 'abc');
  assert.equal(claims.typ, 'access');
});

test('类型不符的令牌不能当访问令牌用', () => {
  const refresh = signToken({ sub: 'abc', typ: 'refresh' }, SECRET, 600);
  assert.equal(verifyToken(refresh, SECRET, 'access'), null);
  assert.ok(verifyToken(refresh, SECRET, 'refresh'));
});

test('换密钥即失效', () => {
  const token = signToken({ sub: 'abc', typ: 'access' }, SECRET, 60);
  assert.equal(verifyToken(token, 'y'.repeat(40), 'access'), null);
});

test('改一改 payload 就过不了签名', () => {
  const token = signToken({ sub: 'abc', typ: 'access' }, SECRET, 60);
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    sub: 'admin', typ: 'access', iat: 1, exp: 9999999999,
  })).toString('base64url');
  assert.equal(verifyToken(`${header}.${forged}.${signature}`, SECRET, 'access'), null);
});

test('过期即失效', () => {
  const token = signToken({ sub: 'abc', typ: 'access' }, SECRET, -10);
  assert.equal(verifyToken(token, SECRET, 'access'), null);
});

test('结构不对一律返回 null 而不是抛错', () => {
  assert.equal(verifyToken('', SECRET), null);
  assert.equal(verifyToken('a.b', SECRET), null);
  assert.equal(verifyToken('a.b.c', SECRET), null);
  assert.equal(verifyToken(undefined, SECRET), null);
});

test('主体由密钥派生，明文号码不出现在令牌里', () => {
  const subject = subjectFor(SECRET, '18650090309');
  assert.match(subject, /^[0-9a-f]{32}$/);
  assert.ok(!subject.includes('18650090309'));
  // 同密钥同号码必须稳定，否则每次登录都会换一个身份
  assert.equal(subject, subjectFor(SECRET, '18650090309'));
  assert.notEqual(subject, subjectFor('y'.repeat(40), '18650090309'));
});
