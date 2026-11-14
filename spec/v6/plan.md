# 个人相册 · 第六版实施方案 / Personal Album · Version 6 Plan

> Spec-Driven Development · 阶段 2 / 5（Plan） / Stage 2 / 5 (Plan)
> 状态：**已确认** / Status: **Confirmed**
> 日期 / Date: 2026-11-14
> 确认 / Confirmed: 2026-11-14，C-1 ~ C-6 六处技术修正全部采纳；已回写 `spec.md` §11。
> *Confirmed 2026-11-14: all six corrections adopted and written back to spec.md §11.*
> 上游 / Upstream: [`spec.md`](./spec.md)（**已确认**，23 条需求 + 10 条硬性不变量）
> 基线 / Baseline: `album@main` @ `a09314e`
> 本文只回答「怎么做」。做什么、验收口径、不做什么，一律以 `spec.md` 为准，本文不重复、不改写。
> *This document answers "how" only. What to build and how to accept it is owned by spec.md.*

---

## 1. 方案总览 / Overview

一句话：**把前端从「多个模块各自渲染」改成「一条渲染管线 + 一棵数据源」，再让生成式能力只在构建期写三个静态文件。**

*One render pipeline over one data source, with generation confined to three build-time static files.*

| 层 | 改什么 | 承载需求 |
| --- | --- | --- |
| 页面骨架 | 导航收到 3 项；hero 静态化并前移到 HTML；删 `#featured` 与两个 `.cta` | FR-01、FR-05 |
| 渲染 | `createCatalog` 拆成 `paintFull()` + `appendYear()`，`more()` 不再全量重绘 | FR-02、Q-01、P-03 |
| 检索 | 词表单一来源 + 四态状态机 + AND 语义 + 索引派生建议词 | FR-03、FR-04、FR-13、Q-01 |
| 数据 | 三个构建期产物（lexicon / curation / story），各有独立 rev 策略 | FR-06、FR-07、F-01 |
| 交互 | 密度、主题、灯箱上下文、视频控件、回到上次位置 | U-04、U-05、U-06、FR-09、U-08、P-01、P-02 |
| 场景 | 照片墙播放源、上传闭环、离线缓存 | U-07、FR-10、F-02 |
| 工程 | gzip 体积门禁；索引与服务端评分逻辑防漂移 | FR-14、FR-13 |

---

## 2. 实测基线 / Measured baseline

不是估算，是 `gzip -c | wc -c` 跑出来的。

| 资产 | raw | gzip |
| --- | --- | --- |
| 全部 16 个 JS 模块 | 169 KB | **56.6 KB** |
| `style.css` | 46.7 KB | **10.4 KB** |
| 合计 | — | **≈67.0 KB** |
| FR-14 预算 | — | 120 KB（余量 **53 KB**） |

单个模块头部（gz）：`upload.js 10.3K`、`search.js 6.1K`、`hero.js 5.9K`、`main.js 5.9K`、`wall.js 4.0K`、`gallery.js 3.5K`。

**结论：53 KB 的余量足够放下 380 词词表（估 ≈10 KB gz），不需要运行时 fetch。** 这个数字决定了下面 §4.4 的选择。

---

## 3. 对 Spec 的 6 处技术修正 / Corrections to the spec

读完代码后发现 spec 的假设有 5 处需要调整，1 处是 spec 自身前后冲突。**2026-11-14 全部采纳，并已回写进 `spec.md` §11 修订记录。**

| # | Spec 原文 | 实测 | 结论（已采纳） | 影响 |
| --- | --- | --- | --- | --- |
| **C-1** | §5「新增 `labels[].zh`，`INDEX_VERSION` bump」 | `LABEL_FIELDS = ['term','zh','kind','confidence']` 已含 `zh`；`rekognition.mjs:105` 已在填 `zh: ZH_LABEL_DICT[term] \|\| zhForTerm(term)`；前端 `sanitizeIndex` 已读 `zh` | **不需要 bump，不改 `ITEM_FIELDS`**。契约保持 `v5.1.0`，只是 `zh` 的覆盖率从 17 个词扩到 ≈380 | 少一次版本迁移，V5 索引可直接被 V6 读 |
| **C-2** | §5「新增 `weakLabels`（55–75 只做检索）」 | `DETECT_PARAMS.minConfidence = 70`，55–70 区间的标签根本不会产出 | **取消两级标签**，单层 `labels` 够用 | 省掉一次字段扩容与召回逻辑，FR-04 的验收不变 |
| **C-3** | §2.3「为标签附加中文主名」未说在哪一步做 | 现在 `zh` 在**识别期**由 Lambda 计算并写入 `data/labels/<id>.json`；词表一扩，历史照片的中文名不会自动更新，要重跑识别 | **把 `zh` 的解析从识别期下移到索引构建期**（`createIndex` 里按 term 查词表回填）。词表更新后只需重建索引，不碰 Lambda、不重跑 Rekognition | 这是 FR-04 能否低成本迭代的关键；也是一次性改动 |
| **C-4** | FR-14「LCP ≤2.5s 进 CI 门禁」 | CI 环境没有真实图片、没有 CloudFront、没有真实网络，LCP 测出来是假的 | **LCP 不做硬门禁**：CI 只硬卡 JS+CSS gzip ≤120KB（确定性）；LCP 改为每次发布后实测并记入验收矩阵 | 门禁可信，指标真实 |
| **C-5** | FR-01「导航 ≤3 项」与「上传保持既有入口位置」 | 上传按钮 `#open-upload` 现在就在顶部导航里（`index.html:28`） | **上传入口移到页脚**（有原生桥 + 配了接口地址时才显示）。导航只剩 品牌 / 相册 / 搜索 | 两者只能保一个，我选保「≤3 项」 |
| **C-6** | FR-13 只约束词表 | `scoreItem` 在 `src/web/js/search.js:260` 和 `src/server/search/index.mjs:199` **各有一份实现**，AND 语义的 bug 两边都有 | V6.0 两处同批修 + 加**双实现一致性单测**；抽公共模块记为 V6.1 技术债（要动构建拷贝逻辑，风险高于收益） | 否则 FR-03 修完还是会在两边漂移 |

> C-1/C-2 让 FR-04 的工程量比 spec 预估小一档；C-3 是新增的但很值；C-5 需要你明确认可。

---

## 4. 前端架构 / Frontend architecture

### 4.1 页面骨架变更 / DOM changes

`src/web/index.html` 逐项改动（**必须与 `main.js` 同一个提交**，因为 `el()` 返回 `null`、`el('x').addEventListener` 会直接抛错）：

| 位置 | 现状 | V6 | 连带改动 |
| --- | --- | --- | --- |
| `nav .tabs` | 两个 tab：时间轴 / 相册 | **删掉 tablist**，只留一个「相册」按钮（`#nav-albums`） | `wire()` 里的 `.tab` 循环改为空转；`applyView()` 的 `.tab` 循环同步删。**「时间轴」消失后必须有等价出口**：品牌链接 `a.brand` 现在是 `href="#top"` 的死链，改为点击后重置 `view='timeline'`/`album=''`/`q=''` 并滚顶——否则进了相册根目录就回不去 |
| `nav .nav-actions` | 故事 / 照片墙 / 上传 / 搜索 | 只留**搜索** | 移除 `#open-story`、`#open-wall` 的监听；`#open-upload` 移到页脚 |
| `#featured` + `#featured-stream` | 独立精选区 | **删除** | `renderSite()`、`applyView()`、`featuredPhotos()` 三处引用同步删 |
| `.cta#story-cta` / `.cta#wall-cta` | 两个整屏深色区块 | **删除** | 移除 `#story-cta-button`、`#wall-cta-button` 监听；入口见下 |
| hero | `initHero()` 运行时渲染多章节 | **构建期写入静态区块**（见 §4.6） | 运行时不再有 hero 模块 |
| 年份分组末尾 | 无 | 新增「用故事播放这一年」按钮（`data-story-year`） | `openStory` 改为接受年份 scope |
| 页脚 | 统计 + 隐私一行 | 增加「照片墙」「随便翻翻」「上传」三个入口 | 新增 3 个监听；上传按钮沿用 `#open-upload`（`hidden` 的显示条件不变） |

**为什么 hero 要前移到 HTML**：静态单图本来就是构建期就能定的事（`site.mjs` 已有 `resolveFeatured` / `parseHeroSections`）。放到 HTML 里，① 首屏大图不再等 JS，LCP 直接受益；② 省掉 `hero.js` 的 **5.9 KB gz**，正好抵消词表带来的体积增长。代价是首屏图变成 HTML 的一部分，`index.html` 的缓存策略仍是 `no-cache`（现状如此），不新增问题。

### 4.2 渲染管线重构 / Render pipeline（FR-02 的核心）

**为什么能增量**：`paint()` 里每一年的行布局是 `computeEditorialRows(该年的照片, width, params)` —— 行的切分**只依赖这一年自己的照片序列**，与其它年无关（`gallery.js:166`）。所以追加照片只会影响**最后一个已渲染年份**的分组。

接口形状：

```js
// 现状
createCatalog({ container, onOpen, initialBatch, chunk })
  → { update(list, {reset}), more(), hasMore, destroy() }

// V6：对外签名不变，内部拆三条路径
function paintFull()          // 全部重排；用于 reset / resize / 筛选变更
function appendYear(year)     // 只重排一个年份分组；用于「最后一年被追加」
function appendNewYears(list) // 追加完整的年份分组；用于跨年追加
more() {
  const before = limit;
  limit = Math.min(limit + chunk, photos.length);
  const added = photos.slice(before, limit);        // 新增的照片
  const affected = lastRenderedYear();               // 最后一个已渲染的年
  if (added.some(p => p.year === affected)) appendYear(affected);  // 只重排这一年
  appendNewYears(added.filter(p => p.year < affected));            // 其余整年直接 append
  return true;
}
```

**必须同时修的两个隐患**：

1. `container.replaceChildren(fragment)` → 增量路径改用 `appendChild`，容器节点数单调递增（Spec FR-02 的验收就是查这个）。
2. 月标题的张数现在是 `flat.filter(...)`（`gallery.js:172`），每个月份都全量扫一遍 = O(n²)。改成一次 `Map` 计数。

**首屏成本不变**：`initialBatch = 60`，reset 时仍然只排 60 张，`paintFull()` 的代价有上界。

### 4.3 检索四态 / Search four-state（FR-03）

`parseQuery` 需要新增一个返回字段 `unmatched: string[]`——`scanChunk` 现在对词表外的字符**静默跳过**（`search.js:74`：`i += 1; continue`），这正是「显示器」被吞掉的直接原因。改法：一个 chunk 扫完没有任何命中时，把整个 chunk 记入 `unmatched`。

状态机（在 `computeFiltered()` 里判，`main.js:46`）：

```
q 为空                                   → idle
index === null                            → degraded
terms 空 && colors 空 && 无年月 && unmatched 非空 → unknown-term（total=0）
terms 有值 && total === 0                  → no-match
其余                                      → ok（unmatched 非空时附「已忽略」提示）
```

配套三处：

- **AND 语义**：`scoreItem` 的 `for (const term of parse.terms)` 里，未命中要 `return null` 而不是 `continue`（`search.js:279`、`index.mjs:218` 两处同改）；`searchFallback` 的 `words.some(...)` 改成 `every(...)`。
- **建议词**：`suggestionsFor()` 的输入从硬编码 `EXAMPLE_QUERIES` 换成 `deriveSuggestions(index)`——由 `index.vocabulary`（服务端已写入）+ `items[].labels[].term` 的实际频次合成，按「覆盖率的黄金区间 8%–60%」排，过滤掉长尾一张照片才有的词。
- **结果视图（FR-05）**：`state.mode` 新增第三个合法值 `'search'`（复用既有 `mode` 键，不新增 hash 键）。`applyView()` 在 `mode==='search'` 时隐藏 hero / 页脚 CTA，把 `#catalog-title` 与 `#search-explain` 提到 `#content` 之前。

### 4.4 词表单一来源 / Single-source lexicon（FR-13 + FR-04）

链路（**一处资产，两处消费，一道一致性门禁**）：

```
src/shared/lexicon.json          ← 唯一真相：{ term, zh, kind, synonyms[] }
        │
        ├─ 构建期 codegen ─→ src/web/js/lexicon.generated.js   （提交入库）
        │                     └→ search.js 读 LEXICON / TERM_ZH
        │
        └─ 服务端直接读 ───→ vocabulary.mjs 的 LEXICON / TERM_ZH / TERM_KIND / COLOR_TERMS
                              └→ rekognition.mjs 的 zhForTerm()
                              └→ 索引构建期回填 labels[].zh（C-3）
```

**为什么生成文件要提交入库**：`npm test` 在干净 checkout 上要能跑，Node 直接 import 源码；如果文件只在构建时生成，测试就依赖构建。代价是多一个生成物，用一道 CI 断言兜住：`node scripts/check-lexicon.mjs` 比对 `lexicon.json` 与 `lexicon.generated.js`，不一致就失败。**这道断言本身就是 FR-13 的验收证据。**

**为什么不上运行时 fetch**：§2 实测余量 53 KB，词表 ≈10 KB gz，hero.js 省下 5.9 KB——净增 ≈4 KB。为省 4 KB 引入一个请求 + 一个异步状态 + 破坏 `parseQuery` 的同步纯函数性质（3 个单测依赖它），不值。

### 4.5 其余交互的注入点 / Injection points

| 需求 | 改哪个文件 | 要点 |
| --- | --- | --- |
| U-05 密度 | `state.js: layoutParams()` 加 `density` 参数；`gallery.js` 读 `localStorage` | `computeEditorialRows` 的签名不动，`opts.target/maxPerRow` 已被覆盖机制支持 |
| U-04 暗色 | `style.css` 先把颜色字面量抽成 `--c-*` 变量，再加 `[data-theme="dark"]` | 工作量集中在抽取；`<meta name="color-scheme">` 与 `theme-color` 由新增的 `theme.js`（≈50 行，负责三档读写 + meta 同步）统一管。**注意 `update.js` 是照片墙的版本探针，与主题无关，别改错文件** |
| P-01 回到上次位置 | `main.js` 新增 `rememberAnchor()` / `restoreAnchor()`；`sessionStorage` | 存 `{year, month, offset}`；恢复放在 `applyFromHash` 之后、首次 `paint` 之前 |
| P-02 相册卡片 | `gallery.js: renderAlbums()` | 封面的随机要**按会话种子**（`album.name` 哈希）而非 `Math.random()`，否则每次重绘都变 |
| P-03 图片兜底 | `gallery.js: createTile()` 的 `img` 加 `error` 与 `load` 监听；CSS 加 `.tile.is-failed` | LQIP 已有（`frame.style.backgroundImage`），只需加交叉淡入的 `transition` |
| FR-09 灯箱上下文 | `lightbox.js` + 新 `month-strip.js` | 同月照片从 `state.filtered` 里按 year/month 过滤，无需新数据 |
| U-08 视频控件 | `lightbox.js` + manifest 增 `duration` | `duration` 由 processor 在转码时写；构建期不再探测 |
| U-06 随机漫游 | 新 `wander.js`（≈40 行） | 权重 `1/(岁数+1)`，一轮内用 Set 去重 |

### 4.6 构建期静态化 / Build-time static generation

`src/build/site.mjs` 已有 `DEFAULT_SITE`、`parseHeroSections`、`resolveFeatured`。V6 在这里加一步：

```
manifest 确定
   ├─ pickHeroPhoto()        → 写入 index.html 的 hero 静态块
   ├─ curateMonths()         → data/curation.<rev>.json        （规则选片，无模型）
   │     └─ 可选：为每月写一句 → 模型（失败则留空，前端不显示句子）
   ├─ buildStory()           → data/story.<rev>.json           （结构来自 state.buildStory，文案来自模型）
   └─ index 构建时按词表回填 zh（C-3）
```

**幂等性**：三个产物都以 manifest 内容 sha 为 `rev`，同输入必得同输出。模型输出按 `(rev, prompt版本)` 缓存进仓库（`src/build/cache/`），重复构建不重复计费——这既是成本控制，也是「同一 rev 产物一致」验收的实现方式。

---

## 5. 数据与契约 / Data and contracts

| 产物 | 命名 | 归属 | 缓存 | 失败降级 |
| --- | --- | --- | --- | --- |
| 索引 | `data/search-index.<rev>.json` | `album-search-publisher`（不变） | `immutable` | 英文标签仍可搜 |
| 词表 | `src/shared/lexicon.json` + 生成的 JS | **不进站点**，纯源码资产 | — | 生成失败 → 构建失败（这是源码，不该静默） |
| 策展 | `data/curation.<rev>.json` + `data/curation.json` | `album-search-publisher` 同主体扩权到 `data/curation.*` | `immutable` + 固定名短缓存 | 缺失 → 不渲染策展块 |
| 故事文案 | `data/story.<rev>.json` + `data/story.json` | 同上，`data/story.*` | 同上 | 缺失 → 现有硬编码文案 |
| manifest | 既有 | 既有 | 既有 | — |

**rev 策略三种，不要混用**：

- **索引 / 策展 / 故事**：`rev` = manifest 内容 sha 派生（跟着照片走），因为它们的正确性依赖当前照片集合。`data/*.json` 固定名是给「rev 文件还没生成」时的兜底，不是主路径。
- **词表**：**不参与 rev**。它是代码级资产（O-02 一次性入库），改了就是一次代码提交。

**IAM 影响**：`album-search-publisher` 的 policy 从 `data/search-index.*.json` 扩到 `data/{search-index,curation,story}.*.json`。仍是 `PutObject`、仍 `canDelete=false`、仍不碰 `version.json`/`manifest`/`photos`。**不新增主体**（满足不变量 3）。

**回滚**：所有文件不可变、不删除 → 回滚 = 把 `version.json` 指回上一个 rev；前端产物回滚 = CloudFront 用上一版 content-hash 目录。词表回滚 = git revert 一个 JSON 文件 + 重新构建。

---

## 6. 成本模型 / Cost model

| 项 | 计算 | 结论 |
| --- | --- | --- |
| G1 词表生成 | 一次性：≈380 个 term × 1 次批量调用 | < ¥0.01，一次性 |
| G3 故事文案 | 每次发布：≈年数 + 月数（当前语料 ≈35 次短调用） | < ¥0.01 / 次发布 |
| A 策展句子 | 同上，与 G3 合并成一次批量调用 | 合并后 ≈0 |
| 存储 | 3 个 JSON，年量级 KB，月增 <1 MB | < ¥0.01 / 月 |
| 运行时 | **0**（浏览不调模型、不请求词表） | 0 |

总量仍在 Spec 的 ≤¥15/月 之内，且**几乎全部是一次性成本**。

---

## 7. 切片与依赖 / Slices and dependencies

```
V6.0 地基 ────────────────────────────────────────────────
  T1 lexicon.json 抽取 + codegen + 一致性门禁（FR-13）
      ├─→ T2 zh 回填下移到索引构建期（C-3）
      │     └─→ T3 term 覆盖率审计：把库内实际出现的 term 全量列出，标出缺中文名的
      │           └─→ T4 补词表（模型出候选 + 一次人工审核，O-02）
      ├─→ T5 search.js 四态 + AND + unmatched（FR-03）
      │     └─→ T6 index.mjs 同步 + 双实现一致性单测（C-6）
      ├─→ T7 建议词改为索引派生（FR-03 后半）
      ├─→ T8 渲染管线增量改造（FR-02）← 独立，可并行
      └─→ T9 IME 组合期防抖 + 统一渲染入口（Q-01）← 依赖 T8
  T10 页面骨架改造（FR-01 + FR-05）← 依赖 T8、T9 的渲染入口定型
  T11 hero 静态化前移 + 删 hero 运行时（FR-01）
  T12 体积门禁脚本 + CI 接入（FR-14）← 放最后，用真实产物定基线

V6.1 体验补齐（可与 V6.0 后段并行）
  T13 颜色变量抽取（U-04 前置）
      └─→ T14 暗色三档 + 六处界面覆盖（U-04）
  T15 密度三档（U-05）
  T16 图片三兜底（P-03）
  T17 回到上次位置（P-01）
  T18 相册卡片三信息（P-02）
  T19 灯箱同月横条 + 标签 chips（FR-09）← 依赖 T4（chips 要中文名）
  T20 视频控件 + manifest duration（U-08）
  T21 上传断点续传 + 自动重试 + 直达（FR-10）

V6.2 情感与场景
  T22 年度精选块（FR-07 选片规则）← 依赖 T8
  T23 G3 故事文案（FR-06）← 与 T22 共用生成管线
  T24 「这一年」年度页（F-01）← 依赖 T22 的产物
  T25 照片墙 2.0（U-07）← 依赖 T22
  T26 随机漫游（U-06）
  T27 上传归位建议（FR-08）
  T28 Service Worker 离线（F-02）
```

**关键路径**：`T1 → T2 → T3 → T4 → T19`（中文名要审核完，灯箱 chips 才有意义）。**最长的一条**是 `T8 → T10`，它决定首页能不能动。

---

## 8. 风险登记 / Risks

| # | 风险 | 触发条件 | 处置 |
| --- | --- | --- | --- |
| R-1 | **删 HTML 节点但忘删 JS 监听** | `el()` 返回 `null`，`.addEventListener` 直接抛错 → 整个 `boot()` 挂掉，白屏 | 骨架改造强制「HTML + `main.js` + `search-ui.js` 同一个提交」；提交前跑一次本地 build + 打开页面 |
| R-2 | 增量渲染漏了「跨年追加」 | 追加批次正好跨年，导致前一年最后一行没重排、出现缺口 | `appendYear(affected)` 与 `appendNewYears()` 两条分支都要覆盖单测：构造 60/60 分页正好切在年边界的用例 |
| R-3 | 词表扩容后索引 rev 变了但 CloudFront 还在给旧索引 | 缓存 `immutable` | 索引 URL 带 rev，天然隔离；`version.json` 不缓存即可 |
| R-4 | 双实现 `scoreItem` 改漏一处 | 只改了前端或只改了服务端 | C-6 的一致性单测：同一 fixture 跑两边，断言 `total` 与 `items[].id` 全等 |
| R-5 | 暗色模式漏了某个界面 | 只改了首页 | O-07 定的是六处；验收逐屏截图，不看代码 |
| R-6 | 删除 `hero.js` 影响 V5 测试 | `src/web/test/v5-hero.test.mjs` 导入了 **11 个**导出（`normalizeHeroSections`/`autoHeroSections`/`buildHeroSections`/`preloadPlan`/`srcsetForSection`/`detectLowPower`/`viewTransitionsSupported`/`motionProfile` + 3 个常量），只有 `initHero` 和 `sectionMedia` 属于运行时 | 拆分边界很清楚：**注册表（11 个纯函数 + 3 个常量）搬进 `hero-data.js`，`initHero` 与 `sectionMedia` 随运行时一起下线**。测试只改 import 路径，**一行断言都不删**（V5 验收记录引用过它） |
| R-7 | 模型不可用导致构建失败 | 网络/配额 | 生成步骤一律 try/catch → 降级为空句子/硬编码文案，构建继续 |
| R-8 | Service Worker 缓存了已删照片 | `rev` 变更未清缓存 | 缓存 key 带 `rev`；`activate` 时清掉非当前 rev 的全部缓存 |

---

## 9. 验收挂点 / Acceptance hooks

Spec §8 的每一条都要有可执行的证据，落法如下：

| Spec 条目 | 证据形态 | 判定人 |
| --- | --- | --- |
| FR-01 首页 | 3 张截图（1440/1024/390）+ DOM 断言（无 `#featured`） | 你 |
| FR-02 增量 | `performance.measure` 输出 + 节点数单调递增断言 | 自动 |
| FR-03 四态 | 5 个查询的 `total`/`status` 表（离线跑 `search.js`） | 自动单测 |
| FR-04 中文名 | 20 张照片的中文可搜词计数 + 覆盖率报告 | 你抽查 |
| FR-05 结果可达 | `getBoundingClientRect().top` 实测值 | 自动 |
| FR-06/07/G1 | 断网下三个产物可读 + 重复构建 sha 相同 | 自动 |
| FR-13 | `check-lexicon.mjs` 通过 + 代码中无第二份 `LEXICON` 字面量 | 自动 |
| FR-14 | `check-budget.mjs` 输出 gzip 数字；LCP 发布后实测 | 自动 + 你 |
| Q-01 | IME 逐字输入时检索调用次数计数 | 自动 |
| U-04 | 6 组对比度数值 + 六处截图 | 你 |
| 其它 U/P/F | 逐条手测 + 截图 | 你 |

---

## 10. 下一步 / Next step

本文已于 2026-11-14 确认（C-1~C-6 全部采纳）。任务分解见 [`tasks.md`](./tasks.md)：28 个任务、依赖图、每条的可执行判定命令、以及 4 项阻塞（其中 B1 是唯一的外部依赖——需要一次只读拉取生产索引样本，否则 T-03/T-04 的词表只能靠猜）。
