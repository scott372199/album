import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  asReadFailure, canResetPicker, classifyFailure, failureLabel, FAILURE_KINDS,
} from '../js/upload-state.js';

/**
 * 线上事故回归：选 22 张只成功 3 张（2026-11-15）。
 *
 * 报错原文：`The requested file could not be read, typically due to permission
 * problems that have occurred after a reference to a file was acquired.`
 *
 * 根因不是网络也不是权限，是 `change` 里同步写了 `input.value = ''` —— Chromium
 * 会因此立刻作废这批 `File` 的底层引用；刚好缓冲好的那几张还能读（小文件），
 * 其余每次 `arrayBuffer()` 都抛 `NotReadableError`。
 *
 * 所以这里守三条：
 *   1. 这类失败要被认出来，并且给一句能照做的话，而不是浏览器原文；
 *   2. 它**不能**进「重试失败项」——句柄已经没了，重试只会再失败一次；
 *   3. `change` 处理器里不许再出现同步清空（源码守卫，防止手滑加回来）。
 */

const CHROMIUM_TEXT = 'The requested file could not be read, typically due to permission '
  + 'problems that have occurred after a reference to a file was acquired.';

test('按 name 认出 NotReadableError', () => {
  const err = Object.assign(new Error('whatever'), { name: 'NotReadableError' });
  const wrapped = asReadFailure(err);
  assert.ok(wrapped, 'NotReadableError 必须被认出来');
  assert.equal(wrapped.kind, 'unreadable');
  assert.equal(wrapped.cause, err);
});

test('按原文认出线上那句（有些实现不带 name）', () => {
  const wrapped = asReadFailure(new Error(CHROMIUM_TEXT));
  assert.ok(wrapped, '线上这句原文必须被认出来');
  assert.equal(wrapped.kind, 'unreadable');
});

test('普通错误不被误判', () => {
  assert.equal(asReadFailure(new Error('上传失败 500')), null);
  assert.equal(asReadFailure(Object.assign(new Error('boom'), { status: 0 })), null);
  assert.equal(asReadFailure(null), null);
  assert.equal(asReadFailure(undefined), null);
});

test('归类与话术：读不到 = unreadable，且提示「重新选」', () => {
  const wrapped = asReadFailure(new Error(CHROMIUM_TEXT));
  assert.equal(classifyFailure(wrapped), 'unreadable');
  const label = failureLabel(wrapped);
  assert.match(label, /重新选/, '提示必须告诉用户下一步做什么');
  assert.equal(label.includes('permission'), false, '不要把浏览器原文端给用户');
  assert.equal(FAILURE_KINDS.includes('unreadable'), true, '新类别要进种类表');
});

test('读不到的错误不标 retryable：重试没有意义', () => {
  const wrapped = asReadFailure(new Error(CHROMIUM_TEXT));
  assert.notEqual(wrapped.retryable, true);
});

test('canResetPicker：忙的时候、还有待重试条目的时候都不许清', () => {
  assert.equal(canResetPicker({ busy: true, failed: [] }), false);
  assert.equal(canResetPicker({ busy: false, failed: [{ id: 'a' }] }), false);
  assert.equal(canResetPicker({ busy: true, failed: [{ id: 'a' }] }), false);
});

test('canResetPicker：闲且没有待重试条目时才允许清', () => {
  assert.equal(canResetPicker({ busy: false, failed: [] }), true);
  assert.equal(canResetPicker(), true);
  assert.equal(canResetPicker({}), true);
});

test('源码守卫：change 处理器里不许同步清空选择器', async () => {
  const source = await readFile(new URL('../js/upload.js', import.meta.url), 'utf8');
  const start = source.indexOf("el('upload-files').addEventListener('change'");
  assert.ok(start > 0, '找不到 change 监听，用例需要跟着代码更新');
  const end = source.indexOf('});', start);
  const handler = source.slice(start, end);
  // 注释里会提到这条规则本身（"input.value = ''"），先剔掉整行注释再扫
  const code = handler
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.equal(
    /\.value\s*=\s*''/.test(code),
    false,
    '清空 input 会作废 File 引用（线上事故根因），清空只能走 canResetPicker',
  );
  assert.ok(handler.includes('uploadFiles(files)'), '处理器仍然要把文件交给 uploadFiles');
});
