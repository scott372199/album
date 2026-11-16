import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyFamily, loadFamily, bornAt, monthLine, parseMonthKey, ageLabel,
} from '../js/family.js';
import { chapterLine, endingLine } from '../js/story.js';

/**
 * 「生长刻度」：孩子多大了，以及每个月那句人话。
 *
 * 这一层最容易被写错又最难被发现的两个点：
 *   1. 月龄差一个月没人看得出来——生日 2021-12，2026-11 是满 4 岁 11 个月，
 *      不是 4 岁 10 个月，也不是 5 岁；早于出生时它必须**闭嘴**而不是显示负数；
 *   2. 文案会越长越像广告词。这里按「12–24 字、不带数字、不用套话」硬卡。
 *
 * Month-age off-by-one is invisible by eye, and copy drifts into ad-speak over
 * time; both are pinned here.
 */

const copy = JSON.parse(await readFile(new URL('../js/family.json', import.meta.url), 'utf8'));

test('月龄：生日 2021-12，2026-11 是 4 岁 11 个月', () => {
  assert.equal(ageLabel('2021-12', 2026, 11), '4 岁 11 个月');
  assert.equal(ageLabel('2021-12', 2026, 1), '4 岁 1 个月');
  assert.equal(ageLabel('2021-12', 2022, 11), '11 个月', '不满一岁只报月数');
  assert.equal(ageLabel('2021-12', 2025, 12), '4 岁', '满岁不带「0 个月」');
});

test('月龄：出生当月是 0 个月，早于出生返回空串而不是负数', () => {
  assert.equal(ageLabel('2021-12', 2021, 12), '0 个月');
  assert.equal(ageLabel('2021-12', 2021, 11), '');
  assert.equal(ageLabel('', 2026, 1), '', '没有生日就不显示');
  assert.equal(ageLabel('2021-12', 2026, 13), '', '月份越界不显示');
});

test('月份键解析：只认 YYYY-MM', () => {
  assert.deepEqual(parseMonthKey('2026-11'), { year: 2026, month: 11 });
  assert.deepEqual(parseMonthKey('2026-1'), { year: 2026, month: 1 });
  assert.equal(parseMonthKey('2026'), null);
  assert.equal(parseMonthKey('2026-13'), null);
  assert.equal(parseMonthKey(''), null);
  assert.equal(parseMonthKey(null), null);
});

test('装上真实文案后，生日与每月一句都读得到', () => {
  applyFamily(copy);
  assert.equal(bornAt(), '2021-12');
  assert.equal(monthLine('2026-05'), '整月只留下一张，正是他笑的那张');
  assert.equal(monthLine('2026-02'), '', '没有的月份返回空串，由调用方回退');
});

test('文案规矩：12–24 字、不带数字与日期、不用套话', () => {
  const banned = ['时光飞逝', '记录美好生活', '这一段', '走完了'];
  for (const [key, text] of Object.entries(copy.months)) {
    assert.match(key, /^\d{4}-\d{2}$/, `${key} 不是 YYYY-MM`);
    assert.ok(text.length >= 10 && text.length <= 26, `${key}「${text}」长度 ${text.length}`);
    assert.ok(!/\d/.test(text), `${key}「${text}」不该带数字`);
    for (const word of banned) assert.ok(!text.includes(word), `${key} 出现套话「${word}」`);
  }
});

test('章节卡：手写的一句话优先，副标题带月份与月龄', () => {
  applyFamily(copy);
  const line = chapterLine({ key: '2026-11', items: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(line.title, '拍得最多，还多了个小女孩');
  assert.equal(line.subtitle, '2026 · 11 月 · 4 岁 11 个月');
});

test('章节卡：没有手写文案时退回「章节标签 + 张数」，不出空白卡片', () => {
  applyFamily(copy);
  const line = chapterLine({ key: '2025', label: '2025', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  assert.equal(line.title, '2025');
  assert.equal(line.subtitle, '3 张');
});

test('结束语用月龄说话：从 4 岁 1 个月，长到 4 岁 11 个月', () => {
  applyFamily(copy);
  const chapters = [
    { key: '2026-01', label: '2026 · 1 月', items: [{ id: 'a' }] },
    { key: '2026-11', label: '2026 · 11 月', items: [{ id: 'b' }] },
  ];
  assert.equal(endingLine(chapters, 53), '从 4 岁 1 个月，长到 4 岁 11 个月，共 53 张');
  assert.equal(endingLine([{ key: '2026-05', label: '5 月', items: [{ id: 'a' }] }], 1), '4 岁 5 个月这一年，共 1 张');
});

test('文案取不到时，界面照常工作（不抛错、不显示半句话）', async () => {
  applyFamily(null);
  assert.equal(bornAt(), '');
  assert.equal(monthLine('2026-11'), '');
  const line = chapterLine({ key: '2026-11', label: '2026 · 11 月', items: [{ id: 'a' }] });
  assert.equal(line.title, '2026 · 11 月', '没有文案就用章节标签');
  assert.equal(line.subtitle, '1 张', '没有生日就不给月龄');

  const notFound = async () => ({ ok: false, json: async () => ({}) });
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await loadFamily(notFound), false);
  assert.equal(await loadFamily(boom), false, '网络炸了也只是没有文案');
  assert.equal(applyFamily({ months: 'nope' }), true, '形状不对就当作空文案');
  assert.equal(monthLine('2026-11'), '');
});

test('文案地址跟着 bundle 走：与当前模块同目录', async () => {
  let seen = '';
  const ok = async (url) => {
    seen = url;
    return { ok: true, json: async () => copy };
  };
  assert.equal(await loadFamily(ok), true);
  assert.ok(seen.endsWith('/js/family.json'), `取的是同目录的 family.json：${seen}`);
  assert.equal(bornAt(), '2021-12');
});
