import test from 'node:test';
import assert from 'node:assert/strict';
import { publicDuration } from '../processor/video.mjs';
import {
  imageRecord, videoRecord, IMAGE_RECORD_FIELDS, VIDEO_RECORD_FIELDS,
} from '../processor/record.mjs';

/**
 * V6 T-20：视频时长是**新增的公开字段**，所以两件事必须钉死：
 *
 * 1. 它是「多长」，不是「什么时候」。不变量 1 禁止公开产物里出现拍摄时刻的
 *    精确信息，而时长是最容易被顺手写成 `durationSeconds: 30.02` 再被人拿去
 *    反推时长分布的地方。取整、封顶、认不出就是 0。
 * 2. 字段表即白名单。多带一个字段就会红，而不是等上线后才发现清单里夹着
 *    原始文件名。
 *
 * T-20 asserts two things about the new public `duration` field: it says how
 * long, never when (invariant 1), and the record field table is the whitelist.
 */

test('publicDuration：取整到秒', () => {
  assert.equal(publicDuration(30), 30);
  assert.equal(publicDuration(30.02), 30);
  assert.equal(publicDuration(29.6), 30);
  assert.equal(publicDuration('40'), 40, '字符串数字要能接受（ffprobe 给的是字符串）');
});

test('publicDuration：认不出就是 0，不编造', () => {
  for (const value of [undefined, null, '', 0, -1, NaN, Infinity, 'abc']) {
    assert.equal(publicDuration(value), 0, `${String(value)} 应当识别为未知`);
  }
});

test('publicDuration：不足一秒的有效视频向上取到 1', () => {
  assert.equal(publicDuration(0.4), 1, '有画面就不能报 0，否则角标退化成 ▶');
  assert.equal(publicDuration(0.01), 1);
});

test('publicDuration：按上限封顶', () => {
  // 默认上限是「源片上限」900 秒，只是兜底；真正的 30 秒截断发生在转码时（-t）
  assert.equal(publicDuration(99), 99);
  assert.equal(publicDuration(100000), 900);
  assert.equal(publicDuration(900, 900), 900);
  assert.equal(publicDuration(7, 6), 6);
});

/** 一份最小可用的元数据，模拟 S3 对象上挂着的东西 */
function meta(takenAt = '2026-03-14T23:41:07.512Z') {
  return {
    metadata: takenAt ? { 'taken-at': takenAt } : {},
    lastModified: new Date('2026-03-15T01:02:03.456Z'),
  };
}

const videoFixture = { duration: 40.72, ratio: 1.7778, lqip: 'data:image/webp;base64,AA', videoShotAt: null };
const imageFixture = { ratio: 1.5, lqip: 'data:image/webp;base64,AA', exifShotAt: null };

test('videoRecord：字段表就是白名单，多一个都不行', () => {
  const record = videoRecord({ id: 'abc123', album: '海边', video: videoFixture, meta: meta() });
  assert.deepEqual(Object.keys(record).sort(), [...VIDEO_RECORD_FIELDS].sort());
});

test('imageRecord：字段表就是白名单，多一个都不行', () => {
  const record = imageRecord({ id: 'abc123', album: '海边', image: imageFixture, meta: meta() });
  assert.deepEqual(Object.keys(record).sort(), [...IMAGE_RECORD_FIELDS].sort());
});

test('videoRecord：duration 是整数秒，不是浮点，也不是时刻', () => {
  const record = videoRecord({ id: 'abc123', album: '海边', video: videoFixture, meta: meta() });
  assert.equal(record.duration, 41);
  assert.equal(Number.isInteger(record.duration), true);
  assert.ok(record.duration >= 0 && record.duration <= 900);
});

test('videoRecord：降级视频 duration 为 0，前端据此回退 ▶', () => {
  const record = videoRecord({
    id: 'def456',
    album: '海边',
    video: { ...videoFixture, duration: 0 },
    meta: meta(),
  });
  assert.equal(record.duration, 0);
});

test('不变量 1：记录里没有任何精确时刻，只有年月', () => {
  for (const record of [
    videoRecord({ id: 'abc123', album: '海边', video: videoFixture, meta: meta() }),
    imageRecord({ id: 'abc123', album: '海边', image: imageFixture, meta: meta() }),
  ]) {
    const json = JSON.stringify(record);
    // 拍摄时刻是 2026-03-14T23:41:07Z，换算到 UTC+8 是 3 月 15 日 07:41
    assert.doesNotMatch(json, /T\d{2}:\d{2}/, '记录里不该出现带时分的时间串');
    assert.doesNotMatch(json, /\d{2}:\d{2}:\d{2}/);
    assert.doesNotMatch(json, /2026-0?3-1?[45]/);
    assert.equal(record.year, 2026);
    assert.equal(record.month, 3);
    assert.equal(typeof record.duration === 'undefined' || typeof record.duration === 'number', true);
  }
});

test('duration 不会从拍摄时间派生：换一个拍摄时刻，时长不变', () => {
  const a = videoRecord({ id: 'x', album: 'a', video: videoFixture, meta: meta('2020-01-02T03:04:05Z') });
  const b = videoRecord({ id: 'x', album: 'a', video: videoFixture, meta: meta('2026-12-31T23:59:59Z') });
  assert.equal(a.duration, b.duration);
  assert.notEqual(a.year, b.year, '年月该变还是要变');
});
