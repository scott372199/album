import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryScheduler, explainText } from '../js/search-ui.js';

/**
 * V6 T-09：输入防抖 + IME 组合期挂起。
 *
 * 现状是每次按键都查一次，中文输入法打「湖水」会依次查 `h` `hu` `hu shui`，
 * 前面几次必然「没听懂」，面板一路闪。这里把时序钉死：
 *   - 组合期一次都不查；
 *   - 组合结束立刻查一次；
 *   - 非组合期 150 ms 防抖。
 *
 * 断言的是**提交次数**，不是耗时，所以没有 sleep 之外的不确定性；
 * `wait` 在测试里调到 10 ms，仍走真实定时器。
 */

const WAIT = 10;

/** 等真实定时器跑完（比 wait 多留一点余量） */
const settle = (ms = WAIT * 3) => new Promise((resolve) => { setTimeout(resolve, ms); });

function collect(options = {}) {
  const calls = [];
  const scheduler = createQueryScheduler({ wait: WAIT, commit: (value) => calls.push(value), ...options });
  return { scheduler, calls };
}

test('连打 10 个字符只提交 1 次，值是最后那个', async () => {
  const { scheduler, calls } = collect();
  for (const char of '一二三四五六七八九十') scheduler.input(char);
  await settle();
  assert.deepEqual(calls, ['十']);
  assert.equal(scheduler.commits, 1);
});

test('IME 组合期不提交：模拟输入「湖水」的全过程', async () => {
  const { scheduler, calls } = collect();
  scheduler.compositionStart();
  scheduler.input('hu');
  scheduler.input('hu shui');
  await settle();
  assert.deepEqual(calls, [], '组合期不该有任何查询');

  scheduler.compositionEnd('湖水');
  assert.deepEqual(calls, ['湖水']);
  assert.equal(scheduler.commits, 1, '一次输入只查一次');
});

test('组合结束后不再补一次防抖查询（否则同一句话查两遍）', async () => {
  const { scheduler, calls } = collect();
  scheduler.compositionStart();
  scheduler.input('hu');
  scheduler.compositionEnd('湖');
  await settle();
  assert.deepEqual(calls, ['湖']);
});

test('两次输入间隔超过防抖窗口 → 提交两次', async () => {
  const { scheduler, calls } = collect();
  scheduler.input('湖');
  await settle();
  scheduler.input('湖水');
  await settle();
  assert.deepEqual(calls, ['湖', '湖水']);
});

test('回车（flush）立刻提交，不等防抖', () => {
  const { scheduler, calls } = collect();
  scheduler.input('湖水');
  assert.deepEqual(calls, []);
  scheduler.flush();
  assert.deepEqual(calls, ['湖水']);
  // 已经提交过的不会再重复提交
  scheduler.flush();
  assert.deepEqual(calls, ['湖水']);
});

test('组合期按回车不提交（isComposing 由调用方挡，这里只保证 flush 有值才发）', () => {
  const { scheduler, calls } = collect();
  scheduler.compositionStart();
  scheduler.flush();
  assert.deepEqual(calls, [], '没有 pending 值时 flush 是空操作');
});

test('清空输入框也会提交一次空串（结果要回到全部）', async () => {
  const { scheduler, calls } = collect();
  scheduler.input('湖水');
  await settle();
  scheduler.input('');
  await settle();
  assert.deepEqual(calls, ['湖水', '']);
});

test('部分未识别时解释文案里点名被忽略的词', () => {
  const parse = {
    explanation: [{ kind: 'term', input: '湖水', mappedTo: 'lake' }],
    unmatched: ['大象'],
  };
  const text = explainText(parse);
  assert.match(text, /已按/);
  assert.match(text, /已忽略：大象/);
});
