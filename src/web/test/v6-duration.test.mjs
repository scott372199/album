import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration, spokenDuration, badgeText, durationNote, isTimed,
} from '../js/duration.js';

/**
 * V6 T-20 的展示层。核心规矩只有一条：**不知道就说不知道**。
 * 清单里没有 duration、或者视频被降级成静图（duration: 0）时，
 * 角标必须退回纯 ▶，绝不能渲染 0:00 —— 那是在编造一个事实。
 *
 * One rule: an unknown duration must look unknown. No `0:00` placeholders.
 */

const video = (duration) => ({ type: 'video', duration });
const image = { type: 'image', ratio: 1.5 };

test('formatDuration：m:ss', () => {
  assert.equal(formatDuration(34), '0:34');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(59), '0:59');
});

test('formatDuration：一小时以上给 h:mm:ss', () => {
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('formatDuration：认不出或不大于零返回空串', () => {
  for (const value of [undefined, null, 0, -3, NaN, 'abc', '', {}]) {
    assert.equal(formatDuration(value), '', `${String(value)} 应当没有展示值`);
  }
});

test('formatDuration：小数四舍五入到秒（服务端已经取整，这里兜住老数据）', () => {
  assert.equal(formatDuration(30.4), '0:30');
  assert.equal(formatDuration(30.6), '0:31');
  assert.equal(formatDuration('40'), '0:40');
});

test('isTimed：视频 / 实况 / 动图算动效，静图不算', () => {
  assert.equal(isTimed({ type: 'video' }), true);
  assert.equal(isTimed({ type: 'live' }), true);
  assert.equal(isTimed({ type: 'animation' }), true);
  assert.equal(isTimed(image), false);
  assert.equal(isTimed(null), false);
});

test('badgeText：有时长就是「▶ m:ss」', () => {
  assert.equal(badgeText(video(34)), '▶ 0:34');
  assert.equal(badgeText(video(125)), '▶ 2:05');
});

test('badgeText：没有时长回退成纯 ▶', () => {
  assert.equal(badgeText(video(0)), '▶');
  assert.equal(badgeText({ type: 'video' }), '▶');
  assert.equal(badgeText(video(NaN)), '▶');
});

test('badgeText：静图没有角标', () => {
  assert.equal(badgeText(image), '');
});

test('spokenDuration：读屏听得懂的写法', () => {
  assert.equal(spokenDuration(34), '34 秒');
  assert.equal(spokenDuration(65), '1 分 5 秒');
  assert.equal(spokenDuration(120), '2 分');
  assert.equal(spokenDuration(0), '');
  assert.equal(spokenDuration(undefined), '');
});

test('durationNote：灯箱元信息只加知道的那一段', () => {
  assert.equal(durationNote(video(34)), '0:34');
  assert.equal(durationNote(video(0)), '', '未知就不加，避免多一个孤零零的分隔点');
  assert.equal(durationNote(image), '');
});

test('角标文案不含任何时刻信息（不变量 1）', () => {
  const text = badgeText(video(34)) + durationNote(video(34));
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(text, /\d{1,2}:\d{2}:\d{2}/);
});

/* ---------- 标记层：控件必须是原生那套 ---------- */

import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('灯箱视频用原生 controls：拖动进度、全屏、音量都不自己造', () => {
  const tag = html.match(/<video id="lb-video"[^>]*>/);
  assert.ok(tag, '找不到 #lb-video');
  assert.match(tag[0], /\bcontrols\b/);
  assert.match(tag[0], /playsinline/, 'iOS 上不加 playsinline 会强制全屏接管');
});

test('播完有「重新播放」，不靠自动翻页兜', () => {
  assert.match(html, /<button[^>]*id="lb-replay"[^>]*>重新播放<\/button>/);
});
