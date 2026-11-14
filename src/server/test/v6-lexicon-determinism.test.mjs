import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEXICON, LEXICON_KEYS } from '../search/lexicon.generated.mjs';

/**
 * V6 T-01 回归：词表生成顺序必须与 ICU / 操作系统无关。
 *
 * 2026-11-14 事故：生成器用 `localeCompare` 排中文键，本机 macOS 生成的产物
 * 提交后，GitHub ubuntu runner 的 ICU 给出另一套顺序，`check:lexicon` 在 main
 * 上恒红。排序只影响字面量顺序，却足以让逐字节门禁失败，并会让同长词的
 * 最长优先匹配在不同平台上给出不同结果。
 *
 * 这里锁三件事：源码不再出现平台相关排序、运行时匹配顺序有确定性
 * tie-break、两份产物逐字节相同。
 *
 * V6 T-01 regression: lexicon ordering must not depend on ICU or the OS.
 * `localeCompare` produced different Chinese key orders on macOS and Linux,
 * so Linux CI rejected the committed artifacts. These tests pin a deterministic
 * comparator, a stable longest-match tie-break and byte-identical artifacts.
 */

const GENERATOR = new URL('../../../scripts/gen-lexicon.mjs', import.meta.url);
const WEB_ARTIFACT = new URL('../../../src/web/js/lexicon.generated.js', import.meta.url);
const SERVER_ARTIFACT = new URL('../search/lexicon.generated.mjs', import.meta.url);

test('生成器排序不依赖 ICU，禁止 localeCompare / Intl.Collator', () => {
  const source = readFileSync(GENERATOR, 'utf8');
  // 只匹配调用点：注释里会提到这些名字来解释事故，不能因此误判。
  // Match call sites only, not the explanatory comments.
  assert.ok(!/\.localeCompare\s*\(/.test(source),
    'localeCompare 的中文顺序因 ICU 版本而异，会让 CI 判定产物漂移');
  assert.ok(!/new\s+Intl\.Collator\b/.test(source),
    'Collator 同样依赖运行时 ICU，不能用于生成可复现产物');
  assert.ok(source.includes('compareCodePoint'),
    '缺少显式的码点比较器，生成顺序没有契约');
});

test('两份产物逐字节相同，单一来源成立', () => {
  const web = readFileSync(WEB_ARTIFACT, 'utf8');
  const server = readFileSync(SERVER_ARTIFACT, 'utf8');
  assert.equal(web, server, '浏览器与 Lambda 的词表产物必须一致');
});

test('LEXICON_KEYS 为长度降序、同长按码点升序，跨平台稳定', () => {
  const keys = Object.keys(LEXICON);
  assert.ok(keys.length > 100, '词表条目过少，疑似被截断');
  const compare = (a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0);
  const expected = [...keys].sort(compare);
  assert.deepEqual(LEXICON_KEYS, expected,
    '最长优先匹配必须有确定性 tie-break，否则不同引擎结果不同');

  const artifact = readFileSync(SERVER_ARTIFACT, 'utf8');
  assert.match(artifact, /LEXICON_KEYS[\s\S]{0,200}a < b/,
    '产物里缺少同长键的码点 tie-break');
});

test('生成物里的中文键本身也按确定性顺序排列', () => {
  const compare = (a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0);
  const keys = Object.keys(LEXICON);
  assert.deepEqual(keys, [...keys].sort(compare),
    'LEXICON 字面量的键顺序必须与码点序一致');
});
