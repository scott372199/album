#!/usr/bin/env node
/**
 * 上传确认页的行为断言（plan v7 §9 的「补充门禁」）。
 *
 * 为什么用 DOM 断言而不是截图：本机 headless 浏览器渲染不出内容（plan R-02），
 * 截图拿不到；DOM 断言反而更硬——它验的是「18 条草稿渲染出来了吗、计数对不对、
 * 点了一键接受之后状态变了吗、接口失败会不会白屏」。
 *
 * 用法：
 *   node scripts/assert-upload.js
 * 依赖：jsdom。若未安装，脚本会给出一行安装命令并以退出码 2 结束。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PAGE = path.join(ROOT, '上传确认页.html');

function loadJsdom() {
  const candidates = ['jsdom', 'C:/tmp/node_modules/jsdom', '/tmp/node_modules/jsdom'];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 继续找 */ }
  }
  return null;
}

const mod = loadJsdom();
if (!mod) {
  console.error('缺少 jsdom。装一次即可： npm i -D jsdom');
  process.exit(2);
}
const { JSDOM } = mod;

/* ---------- 造一份与 ApiServer 同形状的数据 ---------- */
const mk = (id, title, conf, status, extra) => Object.assign({
  id, title,
  candidates: [title, title + '（候选二）', title + '（候选三）'],
  startAt: 0, endAt: 0, range: '2021.03.14 — 2021.11.02', type: 'event',
  age: { fromMonth: 23, toMonth: 31 },
  cover: 'https://example.invalid/' + id + '/300/380',
  people: ['妈妈', '外婆'], scenes: ['家里'],
  photoCount: 12, videoCount: 0,
  confidence: conf, status,
  aiNote: extra && extra.aiNote ? extra.aiNote : '',
  deck: '', body: '', pull: '',
}, extra || {});

const items = [
  mk('st_walk', '走路这件事', 'high', 'draft', { aiNote: 'AI 建议标题 · 三个候选，选一个或自己改', videoCount: 1 }),
  mk('st_plaza', '楼下的小广场', 'high', 'draft'),
  mk('st_plane', '第一次坐飞机', 'high', 'draft'),
  mk('st_newyear', '过年回老家', 'mid', 'draft'),
  mk('st_bath', '洗澡时的照片', 'mid', 'draft'),
  mk('st_er', '2021 年 7 月照片', 'low', 'draft'),
  mk('bt_eat', '第一次自己吃饭', 'high', 'draft'),
  mk('bt_cat', '楼下的猫', 'high', 'draft'),
  mk('bt_talk', '学说话的录音', 'high', 'draft'),
  mk('bt_kg', '幼儿园第一天', 'high', 'draft'),
  mk('bt_hair', '剪头发', 'high', 'draft'),
  mk('bt_cake', '生日蛋糕', 'high', 'draft'),
  mk('bt_shot', '打疫苗', 'mid', 'draft'),
  mk('bt_mart', '逛超市', 'mid', 'draft'),
  mk('bt_rain', '雨天不出门', 'low', 'draft'),
  mk('bt_snow', '第一次看见雪', 'high', 'published'),
  mk('bt_swim', '学游泳', 'high', 'published'),
  mk('bt_move', '搬新家', 'high', 'published'),
];

const bootstrap = {
  stats: { photos: 286, videos: 8, people: 6, batchStories: 18,
           pendingDrafts: 15, highConfidence: 9, stories: 23, doubtfulTime: 15 },
};
const drafts = { total: items.length, highConfidence: 9, items };

/* ---------- 场景 A：App 内（/api 可用） ---------- */
function runLive() {
  const calls = [];
  let accepted = 0;

  const dom = new JSDOM(fs.readFileSync(PAGE, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://appassets.androidplatform.net/assets/www/upload.html',
    beforeParse(win) {
      win.fetch = (url, opt) => {
        const method = (opt && opt.method) || 'GET';
        calls.push(method + ' ' + url.replace('https://appassets.androidplatform.net', ''));
        let body;
        if (url.endsWith('/bootstrap')) body = bootstrap;
        else if (url.endsWith('/drafts')) body = drafts;
        else if (url.endsWith('/accept-all')) { accepted = 9; body = { ok: true, accepted: 9 }; }
        else if (url.includes('/accept')) { accepted += 1; body = { ok: true }; }
        else if (url.includes('/rename')) body = { ok: true };
        else return Promise.reject(new Error('404 ' + url));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      };
      win.prompt = () => '他第一次自己站起来';
    },
  });

  const { window } = dom;
  const d = window.document;

  return new Promise((resolve) => setTimeout(() => {
    const r = [];
    const eq = (name, got, want) => r.push({ name, got: String(got), want: String(want), ok: String(got) === String(want) });

    eq('渲染行数', d.querySelectorAll('.row').length, 18);
    eq('已确认行（status=published）', d.querySelectorAll('.row.done').length, 3);
    eq('三段 tab 文案', Array.from(d.querySelectorAll('.tab')).map(t => t.textContent.trim()).join(' / '),
       '全部 18 / 待确认 15 / 已确认 3');
    eq('底部计数', d.getElementById('okn').textContent + '/' + d.getElementById('tot').textContent, '3/18');
    eq('摘要四项', ['n-photo', 'n-video', 'n-people', 'n-story'].map(i => d.getElementById(i).textContent).join(','), '286,8,6,18');
    eq('一键接受按钮文案', d.getElementById('bulk').textContent, '一键接受 9 个高置信度');
    eq('数据来源标注', /本地数据库/.test(d.getElementById('src').textContent), true);
    eq('低置信度警告块数', d.querySelectorAll('.warnbox').length, 2);
    eq('aiNote 直出', /三个候选/.test(d.querySelector('.row .ailabel').textContent), true);

    const bulk = d.getElementById('bulk');
    bulk.dispatchEvent(new window.Event('click'));
    setTimeout(() => {
      eq('批量接受后已确认', d.querySelectorAll('.row.done').length, 12);
      eq('批量后按钮文案', bulk.textContent, '已接受 9 个高置信度');
      eq('批量后按钮禁用', bulk.disabled, true);

      const todo = Array.from(d.querySelectorAll('.tab')).find(t => t.dataset.t === 'todo');
      todo.dispatchEvent(new window.Event('click'));
      eq('待确认视图可见行', Array.from(d.querySelectorAll('.row')).filter(x => !x.classList.contains('hide')).length, 6);
      const all = Array.from(d.querySelectorAll('.tab')).find(t => t.dataset.t === 'all');
      all.dispatchEvent(new window.Event('click'));

      const first = d.querySelector('.row:not(.done)');
      const before = d.querySelectorAll('.row.done').length;
      first.querySelector('.ok').dispatchEvent(new window.Event('click'));
      setTimeout(() => {
        eq('单条接受 +1', d.querySelectorAll('.row.done').length, before + 1);

        const row = Array.from(d.querySelectorAll('.row')).find(x => !x.classList.contains('done'));
        row.querySelector('.rn').dispatchEvent(new window.Event('click'));
        const chip = row.querySelector('.tchip.on');
        eq('改名后首个 chip', chip ? chip.textContent : '(无)', '他第一次自己站起来');

        const paths = calls.join(' ');
        eq('POST accept-all 被调用', /POST \/api\/drafts\/accept-all/.test(paths), true);
        eq('POST rename 带 title', /POST \/api\/drafts\/[^/]+\/rename\?title=/.test(paths), true);

        resolve(r);
      }, 40);
    }, 40);
  }, 150));
}

/* ---------- 场景 B：浏览器直接打开（/api 不可用） ---------- */
function runFallback() {
  const dom = new JSDOM(fs.readFileSync(PAGE, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://appassets.androidplatform.net/assets/www/upload.html',
    beforeParse(win) {
      win.fetch = () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'));
    },
  });
  return new Promise((resolve) => setTimeout(() => {
    const d = dom.window.document;
    const r = [];
    const eq = (name, got, want) => r.push({ name, got: String(got), want: String(want), ok: String(got) === String(want) });
    eq('回落渲染行数', d.querySelectorAll('.row').length, 6);
    eq('回落无已确认行', d.querySelectorAll('.row.done').length, 0);
    eq('回落来源标注', /演示数据/.test(d.getElementById('src').textContent), true);
    eq('回落不白屏（摘要仍在）', d.getElementById('n-story').textContent, 18);
    resolve(r);
  }, 150));
}

(async () => {
  const results = (await runLive()).concat(await runFallback());
  const width = Math.max(...results.map(x => x.name.length));
  let bad = 0;
  for (const x of results) {
    if (x.ok) {
      console.log(`  ✓ ${x.name.padEnd(width)}  ${x.got}`);
    } else {
      bad += 1;
      console.log(`  ✗ ${x.name.padEnd(width)}  实际 ${x.got} ／ 期望 ${x.want}`);
    }
  }
  console.log();
  console.log(bad === 0
    ? `上传确认页断言全部通过（${results.length} 项）`
    : `${bad} / ${results.length} 项不符`);
  process.exit(bad === 0 ? 0 : 1);
})();
