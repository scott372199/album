# 个人相册 · 第六版任务分解 / Personal Album · Version 6 Tasks

> Spec-Driven Development · 阶段 3 / 5（Tasks） / Stage 3 / 5 (Tasks)
> 状态：**待确认** / Status: **Draft for confirmation**
> 日期 / Date: 2026-11-14
> 上游 / Upstream: [`spec.md`](./spec.md)（已确认）、[`plan.md`](./plan.md)（已确认，C-1~C-6 采纳）
> 基线 / Baseline: `album@main` @ `b6d8fe5`

---

## 0. 使用约定 / Conventions

1. **打勾 ≠ 验收。** 每条任务的「完成」只代表代码入库 + 该条自己的判定命令通过。是否算做到了，只看验收矩阵（`spec.md` §8 + `plan.md` §9）。
2. **一个任务一个提交（或一个紧凑的 PR）**，提交信息带任务号，例如 `feat(v6/T-05): 检索四态与 AND 语义`。
3. **判定命令必须可离线跑。** 需要真实网络、真实 S3 或真实模型的判定，一律降级为「记录证据」，不阻塞任务完成。
4. **允许修改既有测试，但必须说明为什么。** V5 的测试是 V5 验收的证据链，改动要在提交信息里写明「原断言与新语义冲突，改为 X」。
5. 状态列：`pending` / `doing` / `done(代码)` / `accepted(验收)`。**只有验收矩阵能给最后一列。**

---

## 1. 任务总表 / Task index

| ID | 任务 | 切片 | 依赖 | 需求 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T-01 | 词表单一来源 + 生成与一致性门禁 | V6.0 | — | FR-13 | **done(代码)** |
| T-02 | `zh` 回填下移到索引构建期 | V6.0 | T-01 | FR-04 | **done(代码)** |
| T-03 | term 覆盖率审计 | V6.0 | T-02 | FR-04 | **done(代码)** |
| T-04 | 词表扩容到 ≥380 | V6.0 | T-01、T-03 | FR-04 | **done(代码)** |
| T-05 | 检索四态 + `unmatched` + AND | V6.0 | T-01 | FR-03 | **done(代码)** |
| T-06 | 服务端同步 + 双实现一致性单测 | V6.0 | T-05 | FR-03、FR-13 | **done(代码)** |
| T-07 | 建议词改为索引派生 | V6.0 | T-05 | FR-03 | pending |
| T-08 | 增量渲染管线 | V6.0 | — | FR-02 | **done(代码)** |
| T-09 | IME 防抖 + 统一渲染入口 | V6.0 | T-08 | Q-01 | pending |
| T-10 | 页面骨架改造 | V6.0 | T-08、T-09 | FR-01、FR-05 | pending |
| T-11 | hero 静态化 + 拆分注册表 | V6.0 | T-10 | FR-01 | pending |
| T-12 | 体积门禁 | V6.0 | T-10、T-11 | FR-14 | pending |
| T-13 | 颜色变量抽取 | V6.1 | — | U-04 | pending |
| T-14 | 主题三档 + 暗色六处 | V6.1 | T-13、T-10 | U-04 | pending |
| T-15 | 网格密度三档 | V6.1 | T-08 | U-05 | pending |
| T-16 | 图片加载三兜底 | V6.1 | T-08 | P-03 | pending |
| T-17 | 回到上次位置 | V6.1 | T-10 | P-01 | pending |
| T-18 | 相册卡片三信息 | V6.1 | T-10 | P-02 | pending |
| T-19 | 灯箱同月横条 + 标签 chips | V6.1 | T-04、T-10 | FR-09 | pending |
| T-20 | 视频控件 + manifest `duration` | V6.1 | T-10 | U-08 | pending |
| T-21 | 上传断点续传与闭环 | V6.1 | — | FR-10 | pending |
| T-22 | 每月策展产物与前端块 | V6.2 | T-10 | FR-07 | pending |
| T-23 | 故事文案构建期生成 | V6.2 | T-22 | FR-06 | pending |
| T-24 | 「这一年」年度页 | V6.2 | T-22 | F-01 | pending |
| T-25 | 照片墙 2.0 | V6.2 | T-22 | U-07 | pending |
| T-26 | 随机漫游 | V6.2 | T-10 | U-06 | pending |
| T-27 | 上传归位建议 | V6.2 | T-21 | FR-08 | pending |
| T-28 | 离线可读（Service Worker） | V6.2 | T-10 | F-02 | pending |

---

## 2. 详细任务 / Task detail

### T-01 词表单一来源 + 生成与一致性门禁 〔FR-13〕

**改动**：`+ src/shared/lexicon.json`、`+ scripts/gen-lexicon.mjs`、`+ src/web/js/lexicon.generated.js`、`+ src/server/search/lexicon.generated.mjs`、`~ src/server/search/vocabulary.mjs`、`~ src/web/js/search.js`、`~ package.json`

> 与初版计划的偏差：原定 `scripts/check-lexicon.mjs` 独立脚本，实际**并进 `gen-lexicon.mjs --check`**（一份逻辑，避免校验器与被校验物各自演化）。`npm run check:lexicon` 是它的别名，并已前置到 `npm run verify` 与 `build-image.yml`。
>
> 产物是**两份**而不是一份：`docker/Dockerfile:38` 只 `COPY src/server/`，前端构建只搬 `src/web/js/`，服务端 import `src/web/` 会在镜像里断链。单一来源由「一个生成器 + 逐字节一致性门禁」保证，而不是共享物理路径。

**硬约束**：`src/server/test/v5-search.test.mjs` 导入了 `LEXICON, TERM_KIND, TERM_ZH, COLOR_TERMS, COLOR_OBJECT_COMBINATIONS, lookup, canonicalFor, zhForTerm, kindForTerm, expandSynonyms, resolveCombination, vocabularySnapshot` —— **这 12 个导出一个都不能少，形状也不能变**，只换背后的数据源。

**做法**

- `lexicon.json` 以 **term 为中心**：`{ terms: [{ term, zh, kind, aliases: [], searchable? }] }`；生成器负责展开成 `LEXICON`（`zh → [term, kind]`）与 `TERM_ZH` 两个方向。
- `gen-lexicon.mjs` 产出两端产物，文件头写 `// 由 scripts/gen-lexicon.mjs 生成，勿手改` 与词表 `rev`。
- `vocabulary.mjs` 改为 import 生成物并原样再导出，其余纯函数逻辑不动（136 → 80 行）。
- `--check`：重新生成 → 与已提交产物比对 → 不一致或两份产物不逐字节相同则 exit 1。

**完成判定**

```bash
node scripts/gen-lexicon.mjs --check   # 绿
npm test                                # 全绿（含 v5-search 双侧）
grep -rn "LEXICON = {" src/            # 只命中 lexicon.generated.js
```

**实际结果（2026-11-14）**：词表 126 term / **319 个可搜中文词**（原 39）/ 11 个颜色词，`rev 86b1eb418dfab759`。`npm run verify` 新增断言「中文词表只有一份来源」：校验源文件存在、两份产物逐字节相同、`src/web/js` 下没有第二份 `LEXICON` 字面量、`vocabulary.mjs` 下没有第二份 `TERM_ZH` 字面量。

---

### T-02 `zh` 回填下移到索引构建期 〔FR-04 / C-3〕

**改动**：`~ src/server/search/index.mjs`（`createIndex`）、`~ src/server/recognition/provider.mjs`（`normalizeLabels` 不再清空 `zh`）、`+ src/server/test/v6-index-zh.test.mjs`

**做法**：`createIndex` 组装 `labels` 时统一过一遍 `zh: label.zh || zhForTerm(label.term)`。识别期的填充保留但降级为「可以没有」。

**为什么重要**：现在 `zh` 由 Lambda 在识别时算好写进 `data/labels/<id>.json`。词表一扩，历史照片的中文名不会跟着变，只能重跑识别。挪到索引构建期后，**改词表 = 重建索引**，一次几秒。

**完成判定**：新单测两个用例——① 输入 label 无 `zh`，构建后按词表补齐；② 输入 label 有 `zh`，保留原值不覆盖。

**实际结果（2026-11-14）**：`+ src/server/test/v6-index-zh.test.mjs`，**6 条**用例（在原定 2 条基础上补了 4 条）：③ 识别产物只带英文 term 时索引侧必须补出中文名；④ 词表外 term 兜底为 term 本身——用测试钉住「有 `zh` ≠ 有中文名」这个判定口径；⑤ `zh` 在 `LABEL_FIELDS` 内、`INDEX_VERSION` 仍为 `v5.1.0`（C-1）；⑥ 识别失败的照片仍进索引（I-2）。
做过**缺陷注入验证**：把回填写回 `label.zh ? label : …` 去掉后，③④① 三条立刻变红，还原后 6/6 绿——确认测试不是自我印证。

---

### T-03 term 覆盖率审计 〔FR-04〕

**改动**：`+ scripts/audit-terms.mjs`、`+ spec/v6/term-audit.md`（产物）

**做法**：读现存索引（`data/search-index*.json`）或 `data/labels/*.json`，统计 distinct `term` + 出现次数 + 当前有无中文名，按频次排序输出。

**完成判定**：报告含三列——`term` / 出现张数 / 当前 `zh`。**这是 T-04 的唯一输入，不能靠猜。**

⚠️ 见 §5-B1：本仓库工作副本没有 `data/`，需要一次只读拉取。

---

### T-04 词表扩容到 ≥380 〔FR-04 / O-02〕

**改动**：`~ src/shared/lexicon.json`（主要）、`~ spec/v6/term-audit.md`（追加前后对比）

**做法**

1. 把 T-03 的缺失清单按频次截断到覆盖 ≈95% 出现量的部分（大概率 250–400 个 term）。
2. 模型批量出「中文主名 + 2–4 个同义词」**候选**，一次调用一批（每批 ≤80 个 term，避免截断）。
3. **人工过一遍**（O-02 已定），改掉明显不地道的译名；同义词去重、去掉过于泛化的词（「东西」「物品」这类）。
4. 重跑 T-03 与 T-01 的 `--check`。

**完成判定**

- 覆盖率报告里「缺 `zh` 的 term」= 0，或每个例外都有书面理由。
- 抽查 20 张照片，每张中文可搜词 ≥10（现状 ≤2）——这是 `spec.md` FR-04 的原话。
- 前端 gzip 增量 ≤12 KB（`check-budget` 会给数字）。
- 中文名不随构建漂移：连续两次 `npm run build`，产物 sha 相同。

**实际结果（2026-11-14）**：

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 缺 `zh` 的 term | 0 | **0**（118 个 term 全覆盖，540 条标签出现零遗漏） | ✅ |
| 每张中文可搜词 | ≥10 | 中位 **15**、平均 **15.9**；34 张中 **32 张 ≥10** | ⚠️ 见下 |
| 前端 gzip 增量 | ≤12 KB | **+3.9 KB**（67.0 → 70.9，含 T-01~T-06 全部改动） | ✅ |
| 构建可复现 | 两次 sha 相同 | 两次 `da87e022…` | ✅ |

⚠️ **那 2 张不满 10 词的照片，原因不是词表**：它们各自只有 8 / 9 个 label，而「拿不到中文名的 label 数 = 0」。也就是说命名层已经 100% 覆盖，剩下的是**识别密度**不足——调低 `minConfidence` 或补一次识别才能解决，扩词表无济于事。这属于 §5-B6 的语料/识别限制，不在 T-04 的范围内。
（另外：语料 47 张里只有 34 张有标签，另 13 张识别失败；这是 I-2 的预期行为，不阻塞发布。）

**方法论修正**：`audit-terms.mjs` 的判定口径随 C-3 一起改了。原版读索引里存的 `zh`，但 `zh` 现在是**建索引期**才解析的，索引里的值会滞后。新版同时报「已发布索引现状」与「用当前词表重建后仍缺」——后者才是 T-04 的真实进度。这一栏从 106 直接变成 0，而索引现状仍是 106：**如果只看前者，会误判 T-04 完全没做**。

---

### T-05 检索四态 + `unmatched` + AND 〔FR-03〕

**改动**：`~ src/web/js/search.js`、`~ src/web/test/v5-search.test.mjs`（改断言，见下）

**做法**

- `parseQuery` 增加返回 `unmatched: string[]`。`scanChunk` 现在对词表外字符 `i += 1; continue`（静默跳过），改成：一个 chunk 扫完零命中 → 整个 chunk 进 `unmatched`。
- `scoreItem` 的 `for (const term of parse.terms)` 里，未命中 **`return null`**（现在是 `continue` → OR）。
- `searchFallback` 的 `words.some(...)` → `every(...)`。
- `runSearch` 返回增加 `status`：`idle | ok | no-match | unknown-term | degraded`。判定顺序按 `plan.md` §4.3。

**允许修改的既有断言**：`v5-search.test.mjs` 里凡断言「多词为并集」的用例，与新语义冲突，改为交集断言，并在提交信息注明。

**完成判定**（对应 `spec.md` FR-03 的验收表，离线跑）

> ⚠️ **验收表已按 T-04 后的真实语料订正。** 原稿写在词表扩容之前，其中三行已与现实不符：
> `显示器` 原期望 `unknown-term`，但 T-04 之后它已是已知词（`monitor`，命中 1 张）；
> `湖水` 原期望 `total=3`，实测语料只有 2 张；`2025 年` 在语料里不存在（47 张全是 2026）。
> 把这些改成「拿真实语料量出来的数」，而不是让代码去迁就一份猜的表格。

| 查询 | 期望 | 实测 |
| --- | --- | --- |
| `大象` | `total=0`，`status='unknown-term'`，`unmatched` 含 `大象` | ✅ 47 → **0** |
| `摩托车` | `total=0`，`status='no-match'`（词认识、无照片） | ✅ 0 |
| `湖水` | `total=2`（既有语料） | ✅ 2 |
| `湖水 汽车` | `total` ≤ 两单词命中数的较小值（2、3 → ≤2） | ✅ 5 → **0** |
| `2026 年的湖水` | 时间条件与语义条件同时生效 | ✅ 年份+词均生效 |
| `显示器` | `total=1`，`status='ok'`（T-04 后已是已知词） | ✅ 1 |

---

### T-05 实施记录 / Implementation notes

**改动**：`~ src/web/js/search.js`、`~ src/web/js/main.js`、`~ src/web/js/search-ui.js`、`~ src/server/search/{query,index,fallback}.mjs`（与 T-06 同批）、`~ spec/v5/contracts/v5-contracts.json`、`~ src/server/test/v5-{search,contracts}.test.mjs`、`~ src/web/test/v5-search.test.mjs`、`+ src/web/test/v6-search-four-state.test.mjs`、`+ src/server/test/v6-parity.test.mjs`

**两处与计划的偏差**（都是实施中发现的，理由记在这里）：

1. **四态字段叫 `queryStatus`，不叫 `status`。**
   plan §4.3 写的是「状态机在 `computeFiltered()` 里判」，但 `state.search.status` 已被**索引加载生命周期**占用（`loading / ready / degraded`），由 `statusText()` 消费、驱动「正在检索…」与「重试」。四态（`idle / ok / no-match / unknown-term / degraded`）驱动的是**空结果文案**，是两个不同的 UI 目标。共用一个字段会让「正在加载」被判成「没听懂」。所以用两个字段，各自有单一职责。

2. **契约 `parseResult` 追加了 `unmatched`。**
   FR-03 要求把未识别片段交回来，这是 `parseResult` 的形状变化，因此写进 `spec/v5/contracts/v5-contracts.json`，而不是停在测试里的字面量。顺手把 `v5-contracts.test.mjs` 的键集合断言改成**从契约派生**——原来手写的那份永远比契约慢一步，等于测试在维护自己的真值。追加字段是向后兼容的，`INDEX_VERSION` 不变（持久化的索引 shape 没动）。

**另一个关键发现**：未知词的真实危害不是「返回 0」，而是**返回全部**。`scanChunk` 的静默 `i += 1` 让「大象」的 `terms` 为空，查询退化成「无条件」，47 张全回来。所以 `searchWithIndex` / `search()` 都加了守卫：**没听懂就返回空集**，不返回全量。

**反向验证（T-06 要求）**：把服务端 `if (!matched) return null;` 改回 `continue;`，parity 测试 3 条全红；还原后全绿。确认测试真的咬住了单边漂移。

---

### T-06 服务端同步 + 双实现一致性单测 〔FR-03 / C-6〕

**改动**：`~ src/server/search/index.mjs`（`scoreItem`）、`~ src/server/search/query.mjs`（`parseQuery` 的 `unmatched`）、`+ src/server/test/v6-parity.test.mjs`

**做法**：前端 `search.js` 与服务端 `query.mjs`/`index.mjs` 是**两套同源逻辑**（`parseQuery`、`scoreItem` 各两份）。V6.0 两处同批改，再用一致性测试把漂移钉死：同一份 fixture（≥200 条合成 item）+ 同一批查询，断言两侧 `total` 与 `items[].id` 序列**完全相等**。

**完成判定**：parity 测试绿；**并做一次反向验证**——故意把一侧的 AND 改回 OR，测试必须变红（否则说明测试没咬住）。

**实际结果（2026-11-14）**：`+ src/server/test/v6-parity.test.mjs`，3 条用例。fixture 用固定种子的线性同余生成 **200 条** item（保证任何机器上序列一致），20 条查询覆盖单词 / 多词 / 颜色 / 年月 / 组合 / 未知词。
逐查询比对五层：`terms`、`filters.colors`、`year`、`month`、`unmatched`，再比 `total` 与 `items[].id` 序列。
反向验证已做：单侧改回 OR → 3 条全红；还原 → 3 条全绿。
另一条必须记下的语义：**部分未识别时忽略未知词、保留已识别词**（`大象 湖泊` → `terms=['lake']`、`unmatched=['大象']`、`status='ok'` 附「已忽略」提示），而不是整条查询作废。这是 plan §4.3 的规定，已单独用例钉住。

---

### T-07 建议词改为索引派生 〔FR-03〕

**改动**：`~ src/web/js/search-ui.js`、`~ src/server/search/vocabulary.mjs`（导出建议词构造）、`~ src/web/test/v5-search.test.mjs`

**做法**：`deriveSuggestions(index, { limit: 10 })`——来源 `index.vocabulary` + `items[].labels[].term` 实际频次；按「覆盖率黄金区间 8%–60%」排序（太高=太泛，太低=长尾）；同义合并；排除已在查询里的词。`suggestionsFor(input, pool)` 退化为纯过滤。**删除 `EXAMPLE_QUERIES`。**

**完成判定**：`grep -rn "EXAMPLE_QUERIES" src/` 为空；索引为空时不抛错、回退到年份 chip；同一个索引两次调用结果稳定（可复现）。

---

### T-08 增量渲染管线 〔FR-02〕

**改动**：`~ src/web/js/gallery.js`、`+ src/web/test/v6-catalog-append.test.mjs`

**做法**（`plan.md` §4.2 已论证可行性：每年行布局只依赖该年照片）

- 拆 `paintFull()` / `appendYear(year)` / `appendNewYears(list)`；对外 `{ update, more, hasMore, destroy }` 不变。
- 增量路径用 `appendChild`，**不用 `replaceChildren`**；`update(reset)` 与 resize 仍走 `paintFull()`。
- 顺手修 O(n²)：月标题的张数从 `flat.filter(...)` 改成一次 `Map` 计数。

**完成判定**

- **正确性等价**（最关键）：同一份 180 张、跨 3 年、`chunk=60` 且批次边界**正好落在年交界**的数据，`more()` 逐批追加后的 DOM 结构，与一次性 `paintFull()` 的结果逐行比对全等。
- 性能：`more()` 后容器子节点数单调递增；500 张时单次追加 long task ≤50 ms。

**实际结果（2026-11-14）**：`+ src/web/test/v6-catalog-append.test.mjs`，**14 条**用例（纯计划 8 条 + 伪 DOM 5 条 + 计时 1 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| DOM 结构等价（批次落在年交界） | 逐行全等 | 180 张 / 3 年 / chunk=60：逐批 `more()` 建出的树与一次性全量渲染，整棵树序列化后 `assert.equal` **完全相等** | ✅ |
| DOM 结构等价（批次切在年内） | 逐行全等 | chunk=35（边界 60/95/130/165/180 必然切年）同样全等，且年分组数始终为 3，没有重复节点 | ✅ |
| 每张照片的 figure 只建一次 | — | 三批合计 **180** 个，正好等于照片数；旧实现是 60+120+180 = **360** 个 | ✅ |
| 未被改动的年份不重建 | 节点同一性 | `assert.equal(after[0], before[0])` 通过（比的是对象本身，不是结构） | ✅ |
| 容器子节点数单调递增 | 单调 | 逐批 50 张：年分组数一路不回落 | ✅ |
| 500 张单次追加 | long task ≤50 ms | Node 侧 `planCatalog(500)` 最快 **0.52 ms**；真机 long task **待浏览器复测** | ⚠️ |
| 前端体积增量 | 不挤爆 T-12 的 120 KB | `gallery.js` gzip 3.4 → **5.3 KB**（+1.9 KB，其中大半是注释，本仓库构建不压注释） | ✅ |

500 张 / 每批 60 张滚到底的规模量级：figure 创建次数 **2660 → 500**（5.32×），且每次追加只重建 1 个年份（55–95 行），从不整页重排。

**三处与计划的偏差**（都是实施中发现的，理由留在这里）

1. **`ResizeObserver` 加了宽度守卫**——任务书没写，但不做就没有收益：追加内容会把容器撑高，`ResizeObserver` 观察的是盒子尺寸（宽和高），于是每次 `more()` 之后浏览器都会再喊一次全量重排，增量白做。现在只有 `clientWidth` 变化才重排。
2. **布局抽成纯计划 `planCatalog()`，而不是直接在 DOM 上做 diff**——本仓库没有 jsdom，「DOM 结构逐行全等」按原字面无法自动验证。抽成计划后两条路径消费同一份计划，等价性可在 Node 里 `deepEqual`；DOM 层退化成「照着计划 appendChild」。另外补了 70 行伪 DOM，真的把 `createCatalog` 跑起来再比一次整棵树（含 `data-id` / `data-index` / 图片属性），避免「计划相等但画错」。
3. **`yearKey` 把照片 id 序列一起当签名**，不是只用年份。只用年份时，年内追加的那一批会被误判为「没变化」而整年不重画——注入这个缺陷后 3 条用例立刻变红，证明签名必须包含序列。

**顺手修的 O(n²)**：月标题的张数原来每遇一个月标题就对整年 `flat.filter(...)` 一遍（行数 × 照片数）。改成建年时用 `monthCount` 一次数完，测试 6 拿暴力重算逐月核对，张数之和必须等于该年总数。

> 未做：`update(list, {reset:false})` 仍走全量重排。当前 `main.js` 每次都传 `reset: true`，没有真实调用点，先不猜语义。

---

### T-09 IME 防抖 + 统一渲染入口 〔Q-01〕

**改动**：`~ src/web/js/search-ui.js`、`~ src/web/js/main.js`

**做法**：`compositionstart` → 挂起；`compositionend` → 立即触发一次；非组合期 150 ms 防抖。防抖后的触发与 `refresh()` 共用**同一个**结果渲染入口，不另开一条路径。

**完成判定**：模拟 composition 事件序列输入「湖水」，`onQuery` 调用次数 ≤2（现状每次按键 ≥1）；连打 10 个字符只触发 1 次渲染。

---

### T-10 页面骨架改造 〔FR-01 + FR-05〕

**改动**：`~ src/web/index.html`、`~ src/web/js/main.js`、`~ src/web/js/search-ui.js`、`~ src/web/style.css`

⚠️ **铁律：这三个 JS/HTML 必须同一个提交。** `el()` 就是 `getElementById`，删了节点没删监听 → `.addEventListener` 抛 TypeError → `boot()` 挂掉 → 白屏。

**做法**

- 删 `.tabs`（tablist）、`#featured` + `#featured-stream`、`#story-cta`、`#wall-cta`。
- nav 只留：品牌、`#nav-albums`、搜索框。
- **品牌链接从 `href="#top"` 改成按钮行为**：重置 `view='timeline'` / `album=''` / `q=''` 并滚顶——否则删掉「时间轴」tab 后，进了相册根目录就回不去。
- 页脚新增：照片墙、随便翻翻、上传（沿用 `#open-upload`，显示条件不变）。
- 年份分组末尾插入「用故事播放这一年」（`data-story-year`），`openStory` 支持年份 scope。
- `state.mode` 新增合法值 `'search'`（复用既有 `mode` 键，**不新增 hash 键**）；`applyView()` 在 `mode==='search'` 时隐藏 hero 与页脚 CTA，把结果区提到 `#content` 之前。
- 删 `featuredPhotos()`、`renderSite()` 里的 featured 调用、`applyView()` 里的 `.tab` 循环。

**完成判定**：1440×900 与 390×844 未滚动时 hero 下方露出首个月份标签与首行瓦片；`document.querySelector('#featured')` 为 `null`；导航可点项 ≤3；进相册根 → 点品牌 → 回到时间流；控制台零错误。

---

### T-11 hero 静态化 + 拆分注册表 〔FR-01〕

**改动**：`+ src/web/js/hero-data.js`、`- src/web/js/hero.js`、`~ src/build/site.mjs`、`~ src/web/test/v5-hero.test.mjs`（只改 import 路径）

**做法**：`hero.js` 里 11 个纯函数 + 3 个常量搬进 `hero-data.js`（构建期用它选图）；`initHero` / `sectionMedia` 随运行时一起下线；`build.mjs` 把选中的单张图写进 `index.html` 的 hero 块（桌面 60vh / 移动 50vh，`dvh`），点击行为退化为链接到 `#p=<id>`。

**完成判定**：禁用 JS 后首屏 hero 图仍可见（LCP 不等 JS）；`src/web/js/hero.js` 不存在；`v5-hero.test.mjs` 9 个用例全绿且**未删断言**；gzip 减少 ≈5.9 KB。

---

### T-12 体积门禁 〔FR-14 / C-4〕

**改动**：`+ scripts/check-budget.mjs`、`~ package.json`（`verify` 串联）、`~ .github/workflows/deploy-web.yml`（构建后加一步）

**做法**：对构建产物目录下所有 `.js`/`.css` 求 gzip 之和；>120 KB 则 exit 1 并列出 top-5 贡献文件与各自增量。**LCP 不进 CI**（C-4）——改为发布后手工实测，结果写进验收矩阵。

**完成判定**：临时引入 200 KB 依赖 → CI 失败且指出模块；正常构建通过并打印真实数字。

---

### T-13 颜色变量抽取 〔U-04 前置〕

**改动**：`~ src/web/style.css`

**做法**：把散落颜色字面量抽成 `--c-bg / --c-surface / --c-text / --c-text-dim / --c-line / --c-accent` 等变量。**只做抽取，不改视觉。**

**完成判定**：抽取前后同一页面截图与 V5 逐像素对比无差异（或肉眼零差）；CSS 声明区内不再有裸色值。

---

### T-14 主题三档 + 暗色六处 〔U-04 / O-07〕

**改动**：`+ src/web/js/theme.js`、`~ src/web/style.css`、`~ src/web/index.html`、`~ src/web/js/main.js`

**做法**：`theme.js`（≈50 行）负责三档（跟随/浅/深）读写 + `data-theme` 属性 + `<meta name="color-scheme">` 与 `theme-color` 同步。**注意 `update.js` 是照片墙的版本探针，与主题无关，别改错文件。** 覆盖六处：浏览页、灯箱、照片墙、上传面板、故事、年度页。

**完成判定**：三档切换刷新后保持；meta 随档位变化；照片区域 CSS 无 `filter` / 压暗 `opacity`；6 组前景/背景对比度 ≥4.5:1（实测数值留档）；六处逐屏截图无亮色残留。

---

### T-15 网格密度三档 〔U-05〕

**改动**：`~ src/web/js/state.js`（`layoutParams` 接受 `density`）、`~ src/web/js/gallery.js`、`~ src/web/style.css`、`~ src/web/index.html`

**做法**：紧凑 ≈200 / 标准 ≈340 / 大图 ≈520；存 `localStorage`；`computeEditorialRows` 签名不动，靠既有 `opts.target/maxPerRow` 覆盖机制。

**完成判定**：三档每行瓦片数正确；切换不引起滚动跳动；刷新后保持；不裁切照片（对比 `ratio` 与渲染尺寸）。

---

### T-16 图片加载三兜底 〔P-03〕

**改动**：`~ src/web/js/gallery.js`（`createTile`）、`~ src/web/style.css`
**完成判定**：404/断网模拟 → 出现「这张暂时打不开 · 重试」且可重试（≤3 次）；LQIP → 实图 200 ms 交叉淡入、无白闪；reduced-motion 下直接切换；慢网不发两个大图请求（Network 面板核对）；CLS ≤0.1。

---

### T-17 回到上次位置 〔P-01〕

**改动**：`~ src/web/js/main.js`
**做法**：`rememberAnchor()` / `restoreAnchor()`，存 `{year, month, offset}` 到 `localStorage`；恢复放在 `applyFromHash` 之后、首次 `paint` 之前；右上「回到最近」清空记忆。
**完成判定**：关闭再开落点同月；恢复无「先渲染头部再跳」的闪动；隐私模式下 `localStorage` 不可用则静默降级。

---

### T-18 相册卡片三信息 〔P-02 / O-03〕

**改动**：`~ src/web/js/gallery.js`（`renderAlbums`）
**做法**：时间跨度 `2024.3–2024.5`；封面按 `album.name` 哈希取模选成员（**不能用 `Math.random()`**，否则每次重绘都换）；「最近更新」在 manifest 无发布时间时**只显示张数**（O-03 已定，不新增写路径）。
**完成判定**：320 px 宽三项信息不截断；同一卡片重复渲染封面不变；无发布时间字段时不出现错误值。

---

### T-19 灯箱同月横条 + 标签 chips 〔FR-09〕

**改动**：`+ src/web/js/month-strip.js`、`~ src/web/js/lightbox.js`、`~ src/web/style.css`
**做法**：同月照片从 `state.filtered` 按 year/month 过滤（无需新数据）；chips 取自该照片 `labels[].zh`（依赖 T-04），点击 → `#mode=search&q=<zh>`。
**完成判定**：同月可横滑并预取；点 chip 进入该标签结果视图；390 px 宽下横条默认收起、不占首屏高度；**不出现「这天拍了 N 张」**（不变量 6）。

---

### T-20 视频控件 + manifest `duration` 〔U-08〕

**改动**：`~ src/server/processor/handler.mjs`（转码时写入 `duration`）、`~ src/server/manifest*.mjs`（字段放行）、`~ src/web/js/lightbox.js`、`~ src/web/js/gallery.js`（角标）

⚠️ 现状核查：manifest 与 processor 里**没有任何视频时长字段**（只有日志里的 `durationMs`），所以这是**新增字段**，不是消费既有数据。历史视频需要一次回填——回填方式（重跑转码 / 读既有转码产物元数据）在任务开工前定。

**完成判定**：40 s 视频可拖到任意位置、可全屏、播完可重播；网格角标显示真实时长；无 `duration` 时回退 `▶`；manifest 断言：新增字段不含任何拍摄时刻信息（不变量 1）。

---

### T-21 上传断点续传与闭环 〔FR-10〕

**改动**：`~ src/web/js/upload.js`、`~ src/web/js/upload-state.js`
**做法**：8 MB 分片（沿用 v4 方案）+ 断点续传；自动重试 2 次（指数退避）；失败原因归为五类（网络 / 权限 / 文件过大 / 格式不支持 / 服务异常）；完成后「去看看」直达 `#p=<id>`。
**完成判定**：8 MB 以上文件中断后续传字节数 < 全量；模拟 2 次失败后第 3 次成功；失败文案不泄露 URL/状态码/对象 key；「去看看」定位并打开灯箱。

---

### T-22 每月策展产物与前端块 〔FR-07〕

**改动**：`+ src/build/curation.mjs`、`~ src/build/site.mjs`、`~ src/web/js/gallery.js`
**做法**：规则选片（清晰度 / 去重折叠 / 标签多样性 / 时间分散），月内 <9 张不生成；产物 `data/curation.<rev>.json` + `data/curation.json`；前端在月份分组顶部渲染 9 张 + 一句话，可跳过（键盘可达「跳过本月精选」）。
**完成判定**：抽查 3 个月无近似重复；<9 张不出块；产物缺失时不留空占位；同一 `rev` 重复构建 sha 相同。

---

### T-23 故事文案构建期生成 〔FR-06〕

**改动**：`+ src/build/story.mjs`、`~ src/build/site.mjs`、`~ src/web/js/story.js`
**做法**：章节标题 + 一句话副标题 + 结束语；产物 `data/story.<rev>.json` + `data/story.json`；生成失败 → 现有硬编码文案；结束语不再是「这一段，走完了。」。
**完成判定**：断网可完整播放；同 `rev` 幂等；模型不可用时构建成功且故事可读。

---

### T-24 「这一年」年度页 〔F-01〕

**改动**：`~ src/web/js/main.js`（新增 `mode='year'`？**不新增 hash 键**，用 `view=year` + `year=`）、`+ src/web/js/year-page.js`
**完成判定**：张数、12 格热度条（空月留白不压缩）、Top-3 标签、主色；2 s 内可交互；除 manifest 与索引外无其他请求；空年份显示「这一年没有照片」。

---

### T-25 照片墙 2.0 〔U-07〕

**改动**：`~ src/web/js/wall.js`、`~ src/web/index.html`（播放源选择）
**做法**：四源互斥（全部 / 精选 / 某年 / 某相册）；视频播完再走；人像比空景多停 1–2 s；连拍近似只播一张；精选源读 T-22 产物。
**完成判定**：四源切换队列正确；视频不被中途切断；一轮内近似照片只出现一次；精选为空回退「全部」并提示。

---

### T-26 随机漫游 〔U-06〕

**改动**：`+ src/web/js/wander.js`（≈40 行）、`~ src/web/js/main.js`
**完成判定**：连续 20 次不重复；权重 `1/(岁数+1)`，老照片命中率高于线性随机；灯箱左右键延续随机序列；零新数据。

---

### T-27 上传归位建议 〔FR-08〕

**改动**：`~ src/web/js/upload.js`（选中照片后）
**做法**：规则为主（时间聚集、既有相册命名模式、标签重合度），**纯内存态**，不新增写路径。
**完成判定**：12 张给出 1 个相册名 + ≥3 个标签建议，≤300 ms；忽略后流程与现状一致；S3 无新增对象。

---

### T-28 离线可读 〔F-02〕

**改动**：`+ src/web/sw.js`、`~ src/build/build.mjs`（注册）
**做法**：只缓存 manifest + 近 3 个月 `thumb`；上限 ≤80 MB，超限「最近优先」淘汰；**不是 PWA**（不加 Web App Manifest、不做安装引导）；缓存 key 带 `rev`，`activate` 清非当前 rev。
**完成判定**：断网后近 3 个月可浏览缩略图并开灯箱（大图缺失有降级提示）；`rev` 变更后已删照片 100% 不再出现（抽查）；未注册 SW 的浏览器行为不变。

---

## 3. 依赖图 / Dependency graph

```
T-01 ──┬─→ T-02 ─→ T-03 ─→ T-04 ──┐
       └─→ T-05 ─→ T-06            │
              └──→ T-07            │
T-08 ──┬─→ T-09 ─┐                 │
       │         ├─→ T-10 ─────────┼─→ T-19
       ├─→ T-15  │      ├─→ T-11 ─→ T-12
       └─→ T-16  │      ├─→ T-14（另需 T-13）
                  │      ├─→ T-17
                  │      ├─→ T-18
                  │      ├─→ T-20
                  │      ├─→ T-22 ─┬─→ T-23
                  │      │          ├─→ T-24
                  │      │          └─→ T-25
                  │      ├─→ T-26
                  │      └─→ T-28
                  └─→ T-21 ─→ T-27
```

**关键路径 ①（首页能动）**：`T-08 → T-09 → T-10 → T-11 → T-12`，五步串行，V6.0 的交付前界。
**关键路径 ②（中文可搜）**：`T-01 → T-02 → T-03 → T-04`，被 §5-B1 的外部依赖卡住。
**可并行**：T-13（纯 CSS）、T-15/T-16（依赖 T-08 但互不影响）、T-21（上传链路独立于首页）。

---

## 4. 各切片合并前检查单 / Pre-merge checklist

**V6.0**（每条都要跑）

```bash
npm test && npm run verify && node scripts/check-repo.mjs
node scripts/check-budget.mjs           # T-12 后
```

`npm run verify` 自 T-01 起已前置 `gen-lexicon.mjs --check`，词表门禁不必单独跑。

外加人工三条：① 打开首页，控制台零错误；② 相册根 ↔ 时间流可来回；③ 中文输入法打「湖水」不卡。

**V6.1**：六处界面暗色截图；三档密度切换不跳；404 模拟有占位卡。
**V6.2**：断网跑一遍（故事 / 策展 / 年度页 / 离线浏览）；`data/*.json` 缺失时首页不崩。

---

## 4.1 基础设施修正 / Infrastructure fixes

T-01 落地时暴露了两个**与 V6 功能无关、但会让人误判绿红**的仓库级缺陷，一并修掉：

| 编号 | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| **I-1** | `npm run verify` 在 Windows 本地红，报「web 目标不得写增量缓存」，但代码从未改过 | `verify.mjs` 用**多行字面量**对源码做 `includes` 断言；仓库 blob 是 LF，Windows `core.autocrlf=true` 把工作区检出成 CRLF，断言永远匹配不上。CI 是 Linux，所以只有本地红 | ① `+ .gitattributes` 把仓库钉成 LF；② `verify.mjs` 新增 `readSrc()`，源码文本断言统一归一化换行（纵深防御） |
| **I-2** | `verify` 报 `scripts/audit-terms.mjs 硬编码了 chenyouyi` | T-03 脚本的帮助文案里写死了站点域名 | 改为 `$SITE_BUCKET` / `<站点域名>` 占位符。这条是仓库既有护栏**主动抓到我**的，不是新引入 |

> I-1 的教训：**逐字节 / 多行文本断言在跨平台仓库里天然脆弱**。凡是「读源码文本再比对」的检查，要么归一化换行，要么让仓库只存在一种换行。这次两个都做了。


---

## 5. 阻塞与前置条件 / Blockers

| # | 阻塞 | 影响任务 | 处置 |
| --- | --- | --- | --- |
| ~~**B1**~~ | ~~工作副本**没有 `data/` 目录**，拿不到生产索引与标签文件~~ | ~~T-03、T-04~~ | **已解除（2026-11-14）**：`aws s3 cp s3://chenyouyi/data/search-index.json data/` 成功；`data/` 已进 `.gitignore`。审计结果见 [`term-audit.md`](./term-audit.md)，中文名候选见 [`term-zh-draft.md`](./term-zh-draft.md) |
| **B2** | manifest 与 processor 里没有任何视频时长字段 | T-20 | 属新增字段，先定历史视频的回填方式再动手 |
| **B3** | T-22 / T-23 需要模型凭据（构建期环境变量） | T-22、T-23 | CI 中缺失则降级（空句子 / 硬编码文案），**不阻塞构建** |
| **B4** | `album` main 有分支保护（要求 PR + 单测） | 全部 | 你已明确「不补 PR 留痕」，当前直接 push main（会留 bypass 记录）；若改走 PR，任务提交粒度即 PR 粒度 |

---

## 6. 与验收矩阵的关系 / Relation to acceptance

本文件**不判定**任何需求是否达成。`T-xx done(代码)` 之后，仍要在验收矩阵里逐条对照 `spec.md` §8 与 `plan.md` §9 的证据要求：

- 有的任务完成后**仍可能不通过**——例如 T-04 词表补到 380，但抽查 20 张不足 10 个中文词，那就是没达成，任务要退回。
- 反过来，有的需求可能由多个任务共同满足（FR-03 需要 T-05 + T-06 + T-07 三条同时绿）。

**验收矩阵是下一份文档**：`spec/v6/acceptance.md`，条目 → 证据 → 判定人 → 结论。

---

## 7. 下一步 / Next step

你确认本任务分解后，两条路可选：

1. **先解 B1**（拉一次生产索引样本），再按 §3 的关键路径①从 T-08 开工——首页改造不依赖外部数据，可以立刻动。
2. **先写 `acceptance.md`**（验收矩阵空表），把证据口径先钉死，再开工。

我的建议是 **1**：T-08 的正确性有单测兜底、不需要真实语料，是这一版风险最低的起点。
