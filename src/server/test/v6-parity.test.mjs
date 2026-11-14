import test from 'node:test';
import assert from 'node:assert/strict';
import * as web from '../../web/js/search.js';
import { search as serverSearch, INDEX_VERSION as SERVER_INDEX_VERSION } from '../search/index.mjs';
import { parseQuery as serverParse } from '../search/query.mjs';

/**
 * V6 C-6：前端与服务端是**两套同源逻辑**，必须钉死不许漂移。
 *
 * 为什么会有两套：浏览器 bundle 只搬 `src/web/js/`，Lambda 镜像只 COPY
 * `src/server/`（docker/Dockerfile:38），物理上无法共享一个模块。于是
 * `parseQuery` / `scoreItem` 各有一份实现。这不是疏忽，是部署约束。
 *
 * 代价是「改一侧忘了另一侧」不会有任何测试变红——除非有这么一条测试。
 * 本文件用同一份 fixture + 同一批查询，断言两侧的 `total` 与 `items[].id`
 * 序列完全相等。任何一侧单边修改都会立刻变红。
 *
 * Two implementations by necessity (the browser bundle and the Lambda image
 * cannot share a module). This test feeds both the same fixture and the same
 * queries, and asserts identical totals and id sequences, so a one-sided edit
 * cannot slip through.
 */

/* ---------- 确定性 fixture / Deterministic fixture ---------- */

/** 线性同余，保证任何机器上序列一致 / LCG so the sequence is identical everywhere */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TERM_POOL = [
  { term: 'lake', kind: 'scene' },
  { term: 'mountain', kind: 'object' },
  { term: 'blue sky', kind: 'scene' },
  { term: 'car', kind: 'object' },
  { term: 'motorcycle', kind: 'object' },
  { term: 'shirt', kind: 'object' },
  { term: 'person', kind: 'object' },
  { term: 'tree', kind: 'object' },
  { term: 'red', kind: 'color' },
  { term: 'blue', kind: 'color' },
  { term: 'grey', kind: 'color' },
];

const N = 200;
const rand = lcg(20261114);
const YEARS = [2024, 2025, 2026];

const photos = [];
const items = [];
for (let i = 0; i < N; i += 1) {
  const id = `p${String(i).padStart(4, '0')}`;
  const year = YEARS[Math.floor(rand() * YEARS.length)];
  const month = 1 + Math.floor(rand() * 12);
  photos.push({
    id, type: 'image', album: String(year), year, month, tags: [String(year)],
    title: '', caption: '', ratio: 1.5, lqip: 'data:image/webp;base64,AAAA',
    featured: false, thumb: `photos/${id}/thumb.webp`, grid: `photos/${id}/grid.webp`,
    view: `photos/${id}/view.webp`,
  });

  const labelCount = 1 + Math.floor(rand() * 4);
  const picked = new Map();
  for (let k = 0; k < labelCount; k += 1) {
    const choice = TERM_POOL[Math.floor(rand() * TERM_POOL.length)];
    if (!picked.has(choice.term)) {
      picked.set(choice.term, {
        term: choice.term,
        zh: '',
        kind: choice.kind,
        confidence: Number((0.5 + rand() * 0.5).toFixed(2)),
      });
    }
  }
  items.push({
    id, year, month, tags: [String(year)], labels: [...picked.values()],
    colors: [], source: 'rekognition',
  });
}

const index = { version: SERVER_INDEX_VERSION, items };
const manifest = { photos };

/* ---------- 同一批查询 / The shared query set ---------- */

const QUERIES = [
  '湖水',
  '汽车',
  '湖水 汽车',
  '蓝天',
  '山峰',
  '红色',
  '灰色',
  '红色衬衫',
  '蓝天和汽车',
  '2026',
  '2026 年',
  '2026 年 11 月',
  '2026 年的湖水',
  '2024 年的红色衬衫',
  '大象',
  '飞机',
  '摩托车',
  '人',
  '树',
  '灰色 汽车',
];

/* ---------- 一致性 / Parity ---------- */

test('前后端对同一批查询给出完全相同的 total 与 id 序列', () => {
  const mismatches = [];

  for (const q of QUERIES) {
    const wParse = web.parseQuery(q);
    const sParse = serverParse(q);

    // 解析结果先对齐：这是最容易漂移的一层
    assert.deepEqual(wParse.terms, sParse.terms, `terms 不一致：${q}`);
    assert.deepEqual(wParse.filters.colors, sParse.filters.colors, `colors 不一致：${q}`);
    assert.equal(wParse.filters.year, sParse.filters.year, `year 不一致：${q}`);
    assert.equal(wParse.filters.month, sParse.filters.month, `month 不一致：${q}`);
    assert.deepEqual(
      [...wParse.unmatched].sort(), [...(sParse.unmatched || [])].sort(),
      `unmatched 不一致：${q}`,
    );

    const w = web.runSearch({
      index, parse: wParse, photos, query: q, pageSize: 100,
    });
    const s = serverSearch(index, sParse, manifest, { page: 1, pageSize: 100 });

    const wIds = w.items.map((p) => p.id).join(',');
    const sIds = s.items.map((p) => p.id).join(',');
    if (w.total !== s.total || wIds !== sIds) {
      mismatches.push({ q, web: { total: w.total, ids: wIds }, server: { total: s.total, ids: sIds } });
    }
  }

  assert.deepEqual(mismatches, [], `前后端漂移：\n${JSON.stringify(mismatches, null, 2)}`);
});

test('同一份 fixture 上两侧都遵守 AND 语义', () => {
  // 只用**双方都能识别**的词组合：「树」不在词表里，会把查询降级成单词，
  // 交集必然违反下界——那不是 AND 失效，是另一条语义（见下一条测试）。
  // Only pairs of mutually-understood words: an unknown word degrades the query
  // to a single term, which is a different rule covered by the next test.
  const pairs = [
    ['湖泊', '汽车'], ['蓝天', '汽车'], ['红色', '衬衫'],
    ['湖水', '山峰'], ['湖水', '灰色'], ['汽车', '灰色'],
  ];
  for (const [a, b] of pairs) {
    const wA = web.runSearch({ index, parse: web.parseQuery(a), photos, query: a, pageSize: 100 });
    const wB = web.runSearch({ index, parse: web.parseQuery(b), photos, query: b, pageSize: 100 });
    if (wA.total === 0 || wB.total === 0) continue; // 该 fixture 没这类照片，无从比较

    const wAB = web.runSearch({
      index, parse: web.parseQuery(`${a} ${b}`), photos, query: `${a} ${b}`, pageSize: 100,
    });
    const sAB = serverSearch(index, serverParse(`${a} ${b}`), manifest, { pageSize: 100 });

    assert.equal(wAB.total, sAB.total, `${a} ${b}：前后端 total 不一致`);
    assert.ok(
      wAB.total <= Math.min(wA.total, wB.total),
      `${a} ${b}：交集 ${wAB.total} 不应超过单词较小值 ${Math.min(wA.total, wB.total)}`,
    );
  }
});

test('部分未识别：忽略未知词、保留已识别词，并把未知词交回去', () => {
  // plan.md §4.3 规定的行为：unmatched 非空但仍可解读时是 `ok`，
  // 附「已忽略」提示。不能因为一个词不认识就把整个查询作废。
  const q = '大象 湖泊';
  const parse = web.parseQuery(q);
  assert.deepEqual(parse.terms, ['lake']);
  assert.deepEqual(parse.unmatched, ['大象']);

  const w = web.runSearch({ index, parse, photos, query: q, pageSize: 100 });
  const s = serverSearch(index, serverParse(q), manifest, { pageSize: 100 });
  assert.equal(w.queryStatus, 'ok', '仍有已识别词时应为 ok，而不是 unknown-term');
  assert.equal(w.total, s.total, '前后端应一致');
  assert.ok(w.total > 0, '应返回湖泊的结果');
});
