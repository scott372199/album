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
| T-07 | 建议词改为索引派生 | V6.0 | T-05 | FR-03 | **done(代码)** |
| T-08 | 增量渲染管线 | V6.0 | — | FR-02 | **done(代码)** |
| T-09 | IME 防抖 + 统一渲染入口 | V6.0 | T-08 | Q-01 | **done(代码)** |
| T-10 | 页面骨架改造 | V6.0 | T-08、T-09 | FR-01、FR-05 | **done(代码)** |
| T-11 | hero 静态化 + 拆分注册表 | V6.0 | T-10 | FR-01 | **done(代码)** |
| T-12 | 体积门禁 | V6.0 | T-10、T-11 | FR-14 | **done(代码)** |
| T-13 | 颜色变量抽取 | V6.1 | — | U-04 | **done(代码)** |
| T-14 | 主题三档 + 暗色六处 | V6.1 | T-13、T-10 | U-04 | **done(代码)** |
| T-15 | 网格密度三档 | V6.1 | T-08 | U-05 | **done(代码)** |
| T-16 | 图片加载三兜底 | V6.1 | T-08 | P-03 | **done(代码)** |
| T-17 | 回到上次位置 | V6.1 | T-10 | P-01 | **done(代码)** |
| T-18 | 相册卡片三信息 | V6.1 | T-10 | P-02 | **done(代码)** |
| T-19 | 灯箱同月横条 + 标签 chips | V6.1 | T-04、T-10 | FR-09 | **done(代码)** |
| T-20 | 视频控件 + manifest `duration` | V6.1 | T-10 | U-08 | **done(代码)** |
| T-21 | 上传断点续传与闭环 | V6.1 | — | FR-10 | **done(代码，待真机验收)** |
| T-22 | 每月策展产物与前端块 | V6.2 | T-10 | FR-07 | **done(代码，待真实语料验收)** |
| T-23 | 故事文案构建期生成 | V6.2 | T-22 | FR-06 | **done(代码)** |
| T-24 | 「这一年」年度页 | V6.2 | T-22 | F-01 | **done(代码)** |
| T-25 | 照片墙 2.0 | V6.2 | T-22 | U-07 | **done(代码)** |
| T-26 | 随机漫游 | V6.2 | T-10 | U-06 | **done(代码)** |
| T-27 | 上传归位建议 | V6.2 | T-21 | FR-08 | **done(代码)** |
| T-28 | 离线可读（Service Worker） | V6.2 | T-10 | F-02 | **done(代码，待真机验收)** |

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

**改动**：`~ src/web/js/search.js`（新增 `deriveSuggestions`）、`~ src/web/js/search-ui.js`、`~ src/web/js/main.js`、`~ src/web/js/state.js`、`~ src/web/test/v5-search.test.mjs`、`+ src/web/test/v6-suggestions.test.mjs`

**做法**：`deriveSuggestions(index, { limit: 10 })`——来源 `items[].labels[].term` 实际频次；按「覆盖率黄金区间 8%–60%」排序（太高=太泛，太低=长尾）；无中文名的 term 不入选；排除已在查询里的词。`suggestionsFor(input, pool)` 退化为纯过滤。**删除 `EXAMPLE_QUERIES`。**

> 与计划的偏差：原计划在 `src/server/search/vocabulary.mjs` 里也导出一份建议词构造。**没做**——服务端从不产生建议词，多加一份没人调用的实现只会凭空多一个漂移面。建议词是纯客户端的 UI 装饰，派生逻辑留在 `search.js`，由 `v6-suggestions.test.mjs` 正面测试。

**完成判定**：`grep -rn "EXAMPLE_QUERIES" src/` 为空；索引为空时不抛错、回退到年份 chip；同一个索引两次调用结果稳定（可复现）。

**实际结果（2026-11-14）**：

- `grep -rn "EXAMPLE_QUERIES" src/` → 空。✓
- `+ src/web/test/v6-suggestions.test.mjs`，6 条用例，核心不变量是**「每条建议点进去都能搜到照片」**——合成 fixture 与真实语料各测一遍。
- 真实语料派生结果：`棕色、黑色、头、脸、男孩、男性、小孩、蓝色、衬衫、绿色、红色、黄色`（12 条全部非空）。
  旧硬编码列表里的 **`摩托车` 在这批照片里 0 张**——点一下就是空结果，用户会以为是自己用错。这就是必须派生的直接理由。
- 覆盖率高/低两端都被剔除：`grey`(34/47=72%)、`person`(33/47=70%) 太泛，长尾单词太窄。

⚠️ **一个诚实的负面结果**：我试过按「结果集重叠」做多样性去重，想让顶部的头/脸/男孩/男性/小孩 不指向同一批照片。**在真实语料上失败并已撤掉**：`brown` 出现在 34 张有标签照片中的 28 张，其余候选与它重叠 73%–88%，任何阈值都把 12 条候选筛成 1 条。这批语料本身就是单一人物照簇，真要分组得有语义信号（人脸聚类），而 V6 明确不做。结论写进了 `search.js` 的注释，避免以后有人再走一遍。

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

**实施结果**（`ff8334a`）：静态检查通过——`dist/index.html` 共 105 个 id、**0 个重复**，13 个必需 id 齐全，`#featured` / `.tabs` / `#story-cta` / `#wall-cta` 全部消失，`<section>/<footer>/<main>` 标签配平，`el()` 引用的 id 全部存在（即 verify 第三组断言）。品牌按钮、`#nav-albums`、`data-story-year` 事件委托、`mode='search'` 的 `applyView()` 分支均已落地。浏览器四件事（1440 首屏露出首个月份标签、`#featured` 为 null、导航三项、相册根→品牌回时间流）由用户在 `127.0.0.1:5188` 预览中确认，控制台零错误。

---

### T-11 hero 静态化 + 拆分注册表 〔FR-01〕

**改动**：`+ src/web/js/hero-data.js`、`- src/web/js/hero.js`、`~ src/build/site.mjs`、`~ src/web/test/v5-hero.test.mjs`（只改 import 路径）

**做法**：`hero.js` 里 11 个纯函数 + 3 个常量搬进 `hero-data.js`（构建期用它选图）；`initHero` / `sectionMedia` 随运行时一起下线；`build.mjs` 把选中的单张图写进 `index.html` 的 hero 块（桌面 60vh / 移动 50vh，`dvh`），点击行为退化为链接到 `#p=<id>`。

**完成判定**：禁用 JS 后首屏 hero 图仍可见（LCP 不等 JS）；`src/web/js/hero.js` 不存在；`v5-hero.test.mjs` 9 个用例全绿且**未删断言**；gzip 减少 ≈5.9 KB。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| `src/web/js/hero.js` 不存在 | ✅ `git mv` 到 `hero-data.js`，全仓 `grep hero.js` 零命中 |
| `v5-hero.test.mjs` 未删断言 | ✅ 11 个用例（不是 9 个）全绿，**只改了 import 路径一行** |
| gzip 减少 ≈5.9 KB | ✅ **86.7 → 81.0 KB（−5.7 KB，−6.6%）**，19 个文件 |
| 禁用 JS 首屏仍可见 | ✅ 见下（图与文案都在 HTML 里，无脚本依赖） |

分项（gzip 字节）：`hero.js` 整模块 −5 886、`gallery.js` −358（删掉死代码 `renderFeatured`）、`style.css` +11、`main.js` +约 100（注释换来的）。另有 1 637 B 来自把 `hero-data.js` 移出浏览器产物。

**与任务书的偏差（4 处，均已在代码注释里说明理由）**

1. **图不从 `index.html` 注入，而是固定名 `data/hero.webp`。** 任务书说「`build.mjs` 把选中的单张图写进 index.html 的 hero 块」。但 web 目标是「只发代码、不发内容」的（deploy-web.yml 明确不同步 `data/`），构建期根本不知道线上有哪张照片；把 URL 写进 HTML 也意味着首屏图只在重新部署时才更新。改成：HTML 静态写 `<img src="data/hero.webp">`，**处理函数在每次发布后把选中的那张拷成这个固定名**（`src/server/processor/hero.mjs`），构建期（`--target=all`）也补一份供本地预览。收益是无 JS 可见 + 永远是最新首图 + web 构建不需要知道照片；代价是新增一条发布写路径（前缀仍限定在 `data/`，且 best-effort 永不阻塞发布）。
2. **`hero-data.js` 不进浏览器产物。** 它现在只被构建期 import，跟着拷进 `assets/` 会被体积门禁计入却永远不会被请求。`build.mjs` 新增 `BUILD_ONLY_MODULES` 白名单把它挡在产物外（少 1 637 B）。
3. **点击不写死 `#p=<id>`。** 构建期不知道 id（原因同上）。HTML 里静态写 `href="#catalog"`（无 JS 时点了滚到时间流，真的能用），有 JS 时才由 `main.js` 升级成 `#p=<首图 id>`——复用既有 `#p=` 键，**不新增 hash 键**。
4. **纯函数是 8 个 + 4 个常量，不是「11 + 3」。** 任务书把 `sectionMedia` 也算进去了，但它按原文要随运行时下线，下线的同时就删了；硬凑数只会留一个没人调用的函数。

**首屏高度**：桌面 `60vh / 60dvh`、移动 `50vh / 50dvh`（`min-height` 340px / 240px，`max-height` 900px）。照片仍是 `object-fit: contain`（D-01 不裁切），所以在很宽的屏幕上横图左右会留出底色带——这是「定高 + 不裁切」的必然结果，不是回归（V5 的 `92vh` 上限同样会留）。若希望铺满，只能裁切，需先改 D-01。

**新增/变更文件**：`+ hero-data.js`（192 行，纯逻辑）、`− hero.js`、`+ src/server/processor/hero.mjs`（选图 + 写固定名，含可注入 `io` 便于单测）、`+ src/server/test/v6-hero.test.mjs`（13 用例）、`~ build.mjs`、`~ processor/handler.mjs`（`commitManifest` 带回合并后的清单、发布后刷首图、失效路径加 `/data/hero.webp`）、`~ index.html`、`~ main.js`、`~ style.css`、`~ gallery.js`、`~ data.js`、`~ v5-hero.test.mjs`。

---

### T-12 体积门禁 〔FR-14 / C-4〕

**改动**：`+ scripts/check-budget.mjs`、`~ package.json`（`verify` 串联）、`~ .github/workflows/deploy-web.yml`（构建后加一步）

**做法**：对构建产物目录下所有 `.js`/`.css` 求 gzip 之和；>128 KB 则 exit 1 并列出 top-5 贡献文件与各自增量。**LCP 不进 CI**（C-4）——改为发布后手工实测，结果写进验收矩阵。

**完成判定**：临时引入 200 KB 依赖 → CI 失败且指出模块；正常构建通过并打印真实数字。

**门禁里唯一的例外，已确认（2026-11-15，按建议值批准）**：桶根的 `sw.js` 不计入首屏预算。Service Worker 是浏览器**后台**取的，不阻塞首屏也不参与 LCP，不支持 SW 的浏览器一个字节都不下；把它算进首屏预算等于让「离线能力」和「首屏体积」互相挤占，而这两件事的优化方向不同。其余 `.js`/`.css` 一律照算，没有第二个例外（`dist/assets/**` 里的每一份都在算内）。

**预算于 2026-11-15 由 120 KB 上调到 128 KB（用户决定）**：这条门禁量的是 `dist/` 里**未压缩的源码、含注释**，而本仓库构建不剥注释。于是 T-22/T-23 两次都演成「删自己的便利导出、压自己的注释」来挤回预算——被砍掉的恰好是解释「为什么这么写」的部分，这不是门禁该优化的方向。真正要守的是首屏字节数，不是注释字数。上调后余量约 8 KB。同时保留了另一条路（构建时剥注释）作为将来真正的解法：**它不改变门禁含义，只改变被量的东西**，需要时再做。

---

### T-13 颜色变量抽取 〔U-04 前置〕

**改动**：`~ src/web/style.css`

**做法**：把散落颜色字面量抽成 `--c-bg / --c-surface / --c-text / --c-text-dim / --c-line / --c-accent` 等变量。**只做抽取，不改视觉。**

**完成判定**：抽取前后同一页面截图与 V5 逐像素对比无差异（或肉眼零差）；CSS 声明区内不再有裸色值。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| CSS 声明区内无裸色值 | ✅ `:root` 以外 **0 处**（65 个色值 / 137 次出现全部收敛） |
| 前后视觉无差异 | ✅ **把变量全部解析成字面量后逐字比对，34 000+ 字符完全一致**，唯一一处差异是下面那个 bug 修复 |
| 主题只改一层 | ✅ 34 个 `--c-*` 语义令牌 + 14 个 V5 旧名别名（旧名只是别名，历史规则不用改） |

**没有浏览器也能证明「零视觉变化」**：把新旧两份 CSS 的 `:root` 各自解析成字典，递归替换掉所有 `var(--x)`（含别名链），归一化 `#fff → #ffffff`、`rgba(255,255,255,0.16)` 与 `rgb(255 255 255 / 0.16)` 两种写法，去掉注释与空白，然后逐字比较。结果 34 576 个字符完全相同——这比截图像素对比更强：像素对比会被抗锯齿和滚动位置干扰，字符串对比不会。

**顺带修掉一个真 bug**：`.tile-error`（T-16 加的）引用了**不存在的** `--ink-dim`。CSS 里未定义的自定义属性会让整条声明在计算值阶段失效、回退到继承值——肉眼看不出来，但状态色没了。已改成 `--c-text-dim`，并加了一条自检把这个类问题永久锁死。

**令牌分层**（T-14 只覆盖第一、二层）
1. **语义色**（16 个）：`--c-bg / -bg-elevated / -surface / -surface-hover / -surface-raised / -text / -text-dim / -text-mute / -line / -line-soft / -accent / -accent-strong / -ok / -warn-text / -warn-border / -danger`。
2. **毛玻璃与浮层底**（5 个）：导航三档、吸顶月份条、搜索面板。它们挡在内容前面，换主题必须跟着翻。
3. **深色固定层**（9 个）：全屏看图、故事、照片墙是「黑盒子」，三档主题里都不变——`--c-night / -night-2 / -night-text / -night-clock / -night-clock-soft / -stage / -stage-top / -toast / -wall-bar`。
4. **叠加基色**（4 个）：`--c-on-rgb: 255 255 255` / `--c-off-rgb: 0 0 0`，配合使用处 `rgb(var(--c-on-rgb) / 0.16)` 写法——照片之上那 30 多种白色透明度不再各自写死一个 `rgba()`，但透明度仍留在原地，读代码时还知道那个 16% 是哪来的。

**代价与新增**：CSS gzip 10.7 → 11.7 KB（+1.0 KB，令牌表与注释），总产物 80.9 → 81.8 KB，预算 120 KB 仍有 38 KB 余量。新增 `src/web/test/v6-css-tokens.test.mjs`（5 条）：变量必须定义（或自带兜底）、声明区禁裸色、语义层覆盖六个面、深色固定层不得指向会变的层、旧名别名仍在。已用两次缺陷注入确认它会红（删一个 `--c-danger`、在 `.tile` 里写一个 `#123456`），还原后 5/5 绿。

---

### T-14 主题三档 + 暗色六处 〔U-04 / O-07〕

**改动**：`+ src/web/js/theme.js`、`~ src/web/style.css`、`~ src/web/index.html`、`~ src/web/js/main.js`

**做法**：`theme.js`（≈50 行）负责三档（跟随/浅/深）读写 + `data-theme` 属性 + `<meta name="color-scheme">` 与 `theme-color` 同步。**注意 `update.js` 是照片墙的版本探针，与主题无关，别改错文件。** 覆盖六处：浏览页、灯箱、照片墙、上传面板、故事、年度页。

**完成判定**：三档切换刷新后保持；meta 随档位变化；照片区域 CSS 无 `filter` / 压暗 `opacity`；6 组前景/背景对比度 ≥4.5:1（实测数值留档）；六处逐屏截图无亮色残留。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 三档切换刷新后保持 | ✅ `localStorage['album.theme']`，回到「跟随」时**删除**该键（留着就把系统偏好钉死了） |
| meta 随档位变化 | ✅ `data-theme` + `style.color-scheme` + `<meta name=color-scheme>` + `<meta name=theme-color>` 四处一起写 |
| 照片区域无 filter / 压暗 | ✅ 全仓 CSS 无 `filter`，无 `object-fit: cover`（verify 原有断言继续守着） |
| 8 组对比度 ≥4.5:1 | ✅ 见下表，**由单测实时计算**，不是手抄 |
| 六处无亮色残留 | ✅ 比截图更强的做法，见下 |

**对比度实测**（WCAG 相对亮度公式，`src/web/test/v6-theme.test.mjs` 每次跑都重算）

| 前景 / 背景 | 浅色 | 深色 |
| --- | --- | --- |
| `--c-text` / `--c-bg` | 16.83 | 15.87 |
| `--c-text-dim` / `--c-bg` | 5.07 | 7.92 |
| `--c-text-mute` / `--c-bg` | 5.29 | 5.31 |
| `--c-text` / `--c-surface` | 15.05 | 14.41 |
| `--c-accent` / `--c-bg` | 4.70 | 7.17 |
| `--c-danger` / `--c-surface` | 4.86 | 7.42 |
| `--c-ok` / `--c-surface` | 4.75 | 7.50 |
| `--c-warn-text` / `--c-surface` | 4.85 | 8.54 |

任务书要求 6 组，这里做了 8 组（多测了正文/次级/弱化三档文字与两个状态色）。**为了达标改了两个浅色**：`--c-ok` #2f9e5f → #237a49（原 3.04，不达标）、`--c-text-mute` #86868b → #6b6b71（原 3.62，不达标）。这两处是 T-13「零视觉变化」之后的**有意改动**，原因只有一条：原来的值读不清。

**「六处无亮色残留」的可执行版本**：截不了图，但可以证明得更硬。T-13 已经把规则体里的裸色值清零，于是深色下是否会有浅色残留，等价于「深色档有没有覆盖每一个会翻的令牌」。单测 `每个会翻的语义令牌在深色档都有值` 就是这条：列出 `:root` 里所有 `--c-*`，减去 13 个「深色固定层」（看图/故事/照片墙/stage/叠加基色——它们本来就是黑的），剩下的每一个都必须在 `:root[data-theme="dark"]` 里出现，多写一个固定层也算错。新增语义令牌忘了配深色值，这条立刻红。

**六处的实际做法**：浏览页（底色/卡片/输入框/导航三档毛玻璃/吸顶月份条/页脚）、灯箱、照片墙、上传面板（`.upload-panel` 用 `--paper`，别名指向 `--c-bg` 自动跟着翻）、故事——这四处本来就是全屏黑盒子，深色固定层不动它们；年度页（年份分组与「用故事播放这一年」按钮）走语义色。所以真正需要深色值的是浏览页与上传面板，其余靠「不动即正确」。

**首屏闪白**：`<head>` 里加了一段同步脚本，在首次绘制前就把 `data-theme` 写上。它会重复 `theme.js` 的 `decide()` 判断（读同一个 localStorage 键、同一个媒体查询）——这是**唯一**允许重复的逻辑，理由是首次绘制前模块还没加载；两处不一致会表现为「深色用户刷新后闪一下白」，所以两边都写了对照注释。存储被禁用时 `try/catch` 兜住，退回浅色。

**切换入口放在页脚**（`#theme-toggle`，三档循环「跟随系统 → 浅色 → 深色」），不占导航——T-10 定过「导航可点项 ≤3」。按钮上写的是「现在是什么档」而不是「点一下会变成什么」：跟随档下后者没法描述。

**新增/变更**：`+ src/web/js/theme.js`（约 190 行，含 5 个纯函数与可注入 DOM 的 `applyTheme`/`initTheme`）、`+ src/web/test/v6-theme.test.mjs`（15 条）、`~ style.css`（深色档 22 个变量 + `color-scheme`）、`~ index.html`（引导脚本 + 页脚按钮）、`~ main.js`（主题在 `boot()` 之前装好，清单加载失败也能换主题）。产物 81.8 → 85.9 KB gzip，预算 120 KB。

**已知限制**：禁用 JS 时只有浅色（`data-theme` 需要脚本写）。这是刻意的取舍——纯 CSS 方案要写两份深色变量（`@media` 一份 + `[data-theme]` 一份），而本站不用 JS 也看不了照片流。

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

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 同月可横滑并预取 | ✅ `overflow-x: auto` + `scroll-snap`；当前张 `scrollIntoView`；左右各 2 张预取 `view` |
| 点 chip 进入该标签结果视图 | ✅ `#mode=search&q=<zh>`，复用既有 hash 键，**不新增** |
| 390 px 默认收起 | ✅ 断点 640，窄屏 `data-collapsed="true"`，只留一行「本月 N 张 · 展开」 |
| 不出现「这天拍了 N 张」 | ✅ 只有年月聚合，文案是「本月 N 张」；单测里没有日级字段可用 |

**一处与任务书的偏差**：任务书说「同月照片从 `state.filtered` 过滤」。实际从**灯箱当前列表**过滤（`list`）。在时间流/搜索结果下两者是同一批对象，但在**漫游**模式下列表是随机序列——按 `state.filtered` 取会出现「横条里有这张，点了跳不动」的条目。判定标准是「点了必须真的换一张」，所以取更近的那个集合。单测 `横条的每一张都在当前列表里` 就是钉这条。

**chips 的来源**：清单里没有 `labels`（它们在 `data/search-index.json`），所以 `main.js` 传一个 `labelsFor(photo)` 回调进灯箱，从 `state.search.index.items` 里取该照片的 `labels`。索引还没加载完时返回空数组——横条照常显示，只是暂时没有 chips，不阻塞任何路径。

**预取为什么要排除视频**：视频要整段拖，预取一个 `view.webp` 对播放没有帮助，白占带宽。`prefetchTargets` 跳过 `type` 为 video/live 的条目，也跳过没有 `view`/`grid` 的（降级失败的条目）。

**新增**：`+ src/web/js/month-strip.js`（约 200 行，7 个纯函数 + 1 个装配函数）、`+ src/web/test/v6-month-strip.test.mjs`（16 条，含手写假 DOM 的 3 条装配测试）、`~ lightbox.js`（`show()` 末尾接横条）、`~ index.html`（`#lb-month` 容器）、`~ style.css`（横条与 chips 样式，颜色全部走「照片之上的白」叠加基色）、`~ main.js`（`labelsFor` 与 `onChip`）。产物 85.9 → 91.3 KB gzip。

**顺手修的一个 bug**（由装配测试发现）：点击「展开」只改了容器属性，`aria-expanded` 与按钮文字要等下一次渲染才更新——屏幕阅读器会一直念「已折叠」。改成 `paintToggle()` 一处写三个地方。

---

### T-20 视频控件 + manifest `duration` 〔U-08〕 **done(代码)**

**改动**：`~ src/server/processor/handler.mjs`（转码时写入 `duration`）、`~ src/server/manifest*.mjs`（字段放行）、`~ src/web/js/lightbox.js`、`~ src/web/js/gallery.js`（角标）

⚠️ 现状核查：manifest 与 processor 里**没有任何视频时长字段**（只有日志里的 `durationMs`），所以这是**新增字段**，不是消费既有数据。历史视频需要一次回填——回填方式（重跑转码 / 读既有转码产物元数据）在任务开工前定。

**完成判定**：40 s 视频可拖到任意位置、可全屏、播完可重播；网格角标显示真实时长；无 `duration` 时回退 `▶`；manifest 断言：新增字段不含任何拍摄时刻信息（不变量 1）。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 可拖到任意位置 / 可全屏 | ✅ `#lb-video` 换成原生 `controls`（保留 `playsinline`）；进度、全屏、音量全部交给浏览器 |
| 播完可重播 | ✅ `ended` 不再自动翻页，弹「重新播放」；只有开着「自动播放」时才连播下一张 |
| 网格角标显示真实时长 | ✅ `▶ 0:34` 胶囊 + `tabular-nums`；时长同时进 `aria-label`（「视频 34 秒」） |
| 无 `duration` 回退 `▶` | ✅ 缺失或 0（降级视频）都退成 `.is-plain` 圆点，**不渲染 0:00** |
| 不含拍摄时刻 | ✅ `v6-video-duration.test.mjs`：字段表即白名单 + 记录里不出现带时分的时间串 |

**现状核查有一处结论反了，先说清楚**：任务书说「manifest 与 processor 里没有任何视频时长字段」。实测**两侧都早就写了**——`src/build/video.mjs` → `src/build/manifest.mjs`，以及 `processor/video.mjs` → `videoRecord()`；`story.js` / `wall.js` 也一直在拿 `photo.duration` 排时长。所以 T-20 真正缺的不是字段，是**口径与展示**：

1. **口径**：原来写 `Number(duration.toFixed(2))`，`30.02` 与 `30.03` 这种浮点差会让清单哈希飘、把客户端缓存白白废掉，而前端只显示到秒。现在统一走 `publicDuration()`：整数秒、`<=0` 视为未知、不足 1 秒向上取 1、按上限封顶。**构建期与 Lambda 共用同一份实现**（`build/video.mjs` 直接 import），两侧不会出现「本地 30.02 / 服务端 30」。
2. **展示**：网格角标、灯箱元信息、`aria-label` 三处都走 `src/web/js/duration.js`，一个地方决定「不知道就不显示」。
3. **控件**：`ended` 由「自动跳下一张」改成「给重播按钮」。

**回填问题的结论：不需要回填，有实测为证。** 拉当前线上清单（`rev=a75ad99f29dd`，47 条）逐条核对：**13 条视频全部带 `duration`**，值分别是 `30 / 30 / 22 / 29.07 / 30 / 19.03 / 30 / 30 / 15.04 / 30 / 2.18 / 10.1 / 30`——注意其中 5 条是两位小数，正是「口径没统一」的现场证据，前端 `formatDuration` 对它们取整显示（`29.07 → 0:29`），下一次重处理就会写成整数。唯一没有 `duration` 的是**降级成静图**的条目，它们本来就按静图渲染，角标退成 ▶ 是对的。所以不做批量重转码。

**一处行为变更，已确认（2026-11-15，按建议值批准）**：以前视频播完会自动翻到下一张。现在默认停在原地并显示「重新播放」，理由是原生控件此刻正在显示重播按钮，直接跳走等于把人刚看到一半的片子抽走；想要连播的，开「自动播放」即可，那条路径保持原样（`playTimer` 在，`ended` 仍会 `navigate(1, { wrap: true })`）。

**键盘让位**：焦点在原生控件上时，方向键与空格归视频（拖进度、播放暂停），不再被灯箱抢去翻页——否则键盘用户永远没法快进。`Escape` 仍能关门。

**新增**：`+ src/server/processor/record.mjs`（`imageRecord` / `videoRecord` 从 handler 抽出，附字段白名单表）、`+ src/web/js/duration.js`（5 个纯函数）、`+ src/server/test/v6-video-duration.test.mjs`（10 条）、`+ src/web/test/v6-duration.test.mjs`（13 条，含 2 条标记层断言）。产物 91.3 → 93.8 KB gzip（22 个文件，预算 120 KB）。

**为什么把记录构造抽出去**：这是公开产物的最后一道闸，凡是不能出站的东西都在这里被丢掉。抽成纯函数后，可以直接对着字段表断言「这条记录里一个时刻字符串都没有」，而不是靠人眼逐字段检查。`imageRecord` 一起搬走，避免两个构造器分裂在两处。

---

### T-21 上传断点续传与闭环 〔FR-10〕 **done(代码，待真机验收)**

**改动**：`~ src/web/js/upload.js`、`~ src/web/js/upload-state.js`
**做法**：8 MB 分片（沿用 v4 方案）+ 断点续传；自动重试 2 次（指数退避）；失败原因归为五类（网络 / 权限 / 文件过大 / 格式不支持 / 服务异常）；完成后「去看看」直达 `#p=<id>`。
**完成判定**：8 MB 以上文件中断后续传字节数 < 全量；模拟 2 次失败后第 3 次成功；失败文案不泄露 URL/状态码/对象 key；「去看看」定位并打开灯箱。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 续传字节数 < 全量 | ✅ 40 MB / 8 MB 五分片、已传 3 片时只剩 2 片 = 16 MB；`remainingParts` / `bytesForParts` 单测钉住 |
| 两次失败后第三次成功 | ✅ 沿用 v4 的 `withRetry`（3 次重试、指数退避 1.2 / 3.5 / 8 s），分片级重试不会从头再来 |
| 失败文案不泄露 | ✅ 五类标签由 `classifyFailure` 决定，单测断言文案里没有地址、状态码、对象 key、文件名 |
| 「去看看」定位 | ✅ 新增按钮，按内容哈希前 12 位算出 ID，等它出现在清单里（4 轮 × 2.5 s）再跳 `#p=<id>` |

**续传的真实边界，必须说清楚**：服务端每次 `/upload-url` 都 `CreateMultipartUpload`，**uploadId 是新的**，旧 etag 对新 uploadId 无效。所以：

- 做到了：**同一次签名有效期内**的续传。重试时若预签名还没过期（留 1 分钟余量，14 分钟内有效），不再重新取地址，已拿过 etag 的分片直接跳过。
- 没做到：**刷新页面之后**的续传。那需要服务端 `ListParts` 复用 uploadId，属于接口改动，不在本任务范围。界面上不承诺，也没假装能做到。

这一点是本次任务最有价值的发现：原来「重试 = 从头再传」的根因不在重试逻辑，而在**重试时又重新取了一次地址**。

**「去看看」为什么不需要新接口**：处理函数用 `sha.slice(0, 12)` 当照片 ID，客户端本来就算得出这个哈希（上传前要发给服务端校验）。所以按钮只是「等清单里出现这个 ID」，然后复用既有的 `#p=` 深链。单测里有一条直接读 `handler.mjs` 断言两侧规则是同一条 `slice(0, 12)`。

**五类失败的分类依据是「用户能做什么」**，不是异常长相：网络（换网络/稍后）、权限（重新登录）、太大（换小文件）、格式（先导出 JPEG）、服务（等一会儿）。认不出的状态码一律归「服务」——不能把系统的毛病说成用户的错。

**一处顺带的限制**：体积门禁现在把根目录 `sw.js` 排除在外。它不是首屏渲染的一部分（浏览器后台取，不支持 SW 的浏览器根本不下载），算进来只会让「离线能力」和「首屏体积」互相挤占。其余 `.js`/`.css` 一律照算，没有第二个例外。

**新增**：`~ upload-state.js`（五类分类 + 续传纯函数 + `photoIdFor`）、`~ upload.js`（签名复用、分片续传、`goSee`）、`~ index.html`（`#upload-open`）、`+ src/web/test/v6-upload-resume.test.mjs`（9 条）、`~ scripts/check-budget.mjs`（排除根 `sw.js`）。产物 115.0 KB gzip（25 个文件，预算 120 KB）。

---

### T-22 每月策展产物与前端块 〔FR-07〕 **done(代码，待真实语料验收)**

**改动**：`+ src/server/curation/rules.mjs`（原 `src/build/curation.mjs`，见「产物上线」一节）、`+ src/server/curation/llm.mjs`（原 `src/build/llm.mjs`）、`+ src/server/curation/publish.mjs`、`+ src/build/curation-artifact.mjs`、`+ src/web/js/curation.js`、`~ src/build/build.mjs`、`~ src/server/processor/recognition.mjs`、`~ spec/v5/contracts/v5-contracts.json`、`~ src/web/js/gallery.js`、`~ src/web/js/main.js`、`~ src/web/js/ui.js`、`~ src/web/style.css`
**做法**：规则选片（清晰度 / 去重折叠 / 标签多样性 / 时间分散），月内 <9 张不生成；产物 `data/curation.<rev>.json` + `data/curation.json`；前端在月份分组顶部渲染 9 张 + 一句话，可跳过（键盘可达「跳过本月精选」）。
**完成判定**：抽查 3 个月无近似重复；<9 张不出块；产物缺失时不留空占位；同一 `rev` 重复构建 sha 相同。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 抽查 3 个月无近似重复 | ⚠️ **只能抽 1 个月**：当前 47 个条目里 9 月只有 5 张画面（另 4 条视频）、11 月 10 张，只有 11 月过门槛。11 月那 9 张互不同指纹，落选的那张 `ef48c040cdd6` 的 11 个识别词**全部**已被选中覆盖（重合率 1.00）——去重与多样性两条规则都真的在起作用 |
| <9 张不出块 | ✅ 8 张 → 无块；9 个条目里 4 条视频（5 张画面）→ 无块；9 张画面但折叠后只剩 8 张 → 也无块 |
| 产物缺失时不留空占位 | ✅ 前端 `createMonthPicks` 在「没有产物 / id 对不上清单 / 筛选后不足 3 张」三种情况下都返回 `null`，一个节点都不建 |
| 同一 `rev` 重复构建 sha 相同 | ✅ 单测连跑两次写同一 rev，两份文件逐字节相等；`foldNearDuplicates` + 贪心选片都是全序（分数 → 码点 id），把输入打乱后结果 id 序列完全相同 |

**改动用 `build.mjs` 而不是 `site.mjs`**：`site.mjs` 只解析 `site.json`（hero / featured / 口径配置），策展需要的是 manifest 的 `rev` 与照片数组，这些在 `build.mjs` 里才有。硬塞进 `site.mjs` 会让一个「读配置」的模块开始依赖照片集合。

**「清晰度」是代理，不是像素指标**：公开清单里没有分辨率，也不该为选片把分辨率加进清单（那是为了内部排序而扩大公开面）。改用**识别置信度**当代理——模糊、过暗、失焦的片子，识别器给不出高置信标签。实测 18 个不同取值、区间 0.856–1.000，是有分层的间接量。没有索引时这一项为 0，规则退化但不报错。

**「标签多样性」必须读索引，不能读 `manifest.tags`**：实测 47 张里每张的 `tags` 只有一个（年份），拿它算多样性等于没算。索引里每张平均 11.49 个 label，这才是可用的信号。这条是本次最值钱的一个发现。

**「时间分散」在当前数据上做不了，所以不做假动作**：公开产物里最细的时间就是「月」（不变量 6 禁止日级粒度），月内没有可分散的时间轴。规则退到「同一相册连续出现降权」，并且**只在月内真有多个相册时才启用**——单相册时那个惩罚对每张都是同一个常数，改不了顺序却会污染日志里的分数。

**产物命名按 spec 来，顺手纠正 T-25 的临时名**：T-25 当时写的是 `data/curated.json`（我自己起的名），spec §5 与 plan §4.6 都写 `data/curation.json`。本次统一到 spec 的名字，T-25 的 `loadPicks()` 改成共用同一份产物，一行没多写——「精选」源在产物一出现就自动可用。

**门槛只数「画面」**：视频没有识别标签，选片规则对它无话可说，所以 9 条里含 4 条视频的 9 月不算「照片达到门槛」。这不是把视频排除在时间流之外，只是它不进策展块。

**模型角色收窄到「写一句话」**：选片 100% 由规则决定（FR-07 原文），模型只拿到「几张 + 出现过的中文词」，句子过筛（含数字、网址、套话一律丢弃），失败只丢句子。凭据从 `ALBUM_LLM_ENDPOINT/KEY/MODEL` 读，缺一个就当作没有配置；输出按 `(rev, prompt 版本)` 缓存进 `src/build/cache/`，同一 rev 不重复计费。**CI 里没有凭据是常态**，所以这条路径的「降级」不是兜底，是主路径之一，单测直接覆盖（假 fetch：成功、非 2xx、坏 JSON、断网、缓存命中五种）。

**产物上线（补做，2026-11-15）**：原先它只在 `--target=all` 的本地构建里写进 `dist/`，线上根本没有这个文件。接上之后有三件事值得记下来，因为**两处原以为要改的地方其实不用改**：

1. **模块搬家，而不是改 Dockerfile**：镜像只 `COPY src/server/`，规则住在 `src/build/` 就永远进不了镜像。所以把规则与文案搬到 `src/server/curation/`（`rules.mjs` / `llm.mjs` / `story.mjs`），`src/build/*` 只剩「写进 `dist/data/`」这一层并 `export *` 转手。原以为要动 `Dockerfile`，实际不需要——新文件都在 `COPY` 覆盖的目录里。搬家当场暴露了一个隐患：`rules.mjs` 原本 `import { isMotion } from '../web/js/wall-source.js'`，反向依赖前端。删掉后在自己文件里按类型字面量重写，语义也收窄了（`wall-source#isMotion` 还要求有 `src`）。
2. **IAM 不需要动**：读 `album-infra` 确认处理器角色的 `WriteArtifacts` 已经是 `s3:PutObject/GetObject/DeleteObject` on `site_bucket/*`，`data/curation.*` 与 `data/story.*` 天然覆盖。契约里的 `album-search-publisher` 是**代码层主体名**，不是独立 AWS 角色。
3. **契约要动，但不 bump `version`**：`s3PrefixOwnership` 加两条（写者同上、`canDelete=false`），`iamBoundaries['album-search-publisher']` 扩成三条路径。**没有改 `version`**——`INDEX_VERSION = CONTRACT.version`，一 bump 前端 `search.js` 里写死的 `v5.1.0` 就对不上，索引会整份被拒。这是本次最容易踩的坑。

**写在索引之后、包在 try 里**：`publishRecognition` 写完 `data/search-index.*` 再调发布器，失败只记 `artifacts.failed` 并继续返回 `rev`——索引已经落盘，产物只是下一层装饰。模型调用有 15 s **总时限**（`SENTENCE_BUDGET_MS`）：这一步跑在处理函数里，唯一不能发生的就是「为了几句文案把函数跑超时」，超时即退回派生文案。

**线上措辞：默认派生，可开、且密钥不落地**。处理函数的 environment 里默认没有 `ALBUM_LLM_*`，`llmConfig()` 返回 null，精选与故事按派生文案产出——这是**默认状态，也是一个合法终态**（FR-07 本来就要求选片与措辞不被模型绑架）。要开就有两条凭据来源，优先级明确：

- `ALBUM_LLM_KEY`（明文，本地/构建期用）；
- `ALBUM_LLM_KEY_PARAM`（**只给 SSM 参数路径**，线上用）：`createWriter` 在第一次真正要发请求时才去 `lib/params.mjs` 取，进程内缓存 5 分钟；取不到就当作没接模型，不发请求、不抛错。

选后者是因为**环境变量是低密级数据**——控制台和 `GetFunctionConfiguration` 都能明文读到。于是密钥只存在于 SSM SecureString 里：不进 git、不进 tfvars、不进 Terraform state（Terraform 压根不创建这个参数，只授予读路径）、不进日志、不进前端产物（key 只在 `src/server/` 里被读，镜像只 COPY 那一层）。IAM 是一条独立策略，`ssm:GetParameter` 精确到单个参数 ARN + `kms:Decrypt`，不配就整条不存在。运维步骤写在 `album-infra` README §4a。

**动态 import 是刻意的**：`llm.mjs` 里那次 `await import('../lib/params.mjs')` 只在真的要取凭据时才执行，所以本地构建与全部测试都不需要 AWS SDK——把「构建期能用」和「线上能取密钥」放进同一个文件，代价不能是让本地多一个运行依赖。

**新用例两条**（`v6-artifact-publish.test.mjs`）：密钥只按路径取一次、只出现在 `Authorization` 头，URL/body/日志里都没有；取不到凭据时不发请求、不抛错、日志不含密钥。

**verify 拦下了我一次**：「9 宫格用 `object-fit: cover` 更整齐」被门禁挡下（D-01 不裁切）。改成沿用 `contain`，格子底色与卡片同色，留边看不出来。门禁在这里是对的：裁切是产品级决定，不该由某个块的版式需要悄悄推翻。

**体积**：加完第一版是 120.3 KB，超预算 268 B。`check-budget.mjs` 与预算值都是共享契约，当时我没动它，改的是自己的代码：删掉三个只有测试在用的便利导出（`picksFor` / `blockKey` / `sentenceText`）、把两段过长的块注释收紧。最终 **119.6 KB / 120.0 KB（26 个文件）**。**（后来你决定把预算提到 128 KB，见 T-12。）**

**新增**：`+ src/server/curation/rules.mjs`（33 个导出，纯函数）、`+ src/server/curation/llm.mjs`（可注入 fetch 的文案写入器）、`+ src/server/curation/publish.mjs`（白名单 key + 双写 + 15 s 时限）、`+ src/build/curation-artifact.mjs`（构建期落盘）、`+ src/web/js/curation.js`（取数与索引，不碰 DOM）、`+ src/server/test/v6-curation.test.mjs`（30 条）、`+ src/server/test/v6-artifact-publish.test.mjs`（13 条）、`+ src/web/test/v6-curation-block.test.mjs`（13 条）。

---

### T-23 故事文案构建期生成 〔FR-06〕 **done(代码)**

**改动**：`+ src/server/curation/story.mjs`、`+ src/build/story.mjs`（构建期落盘）、`~ src/build/build.mjs`、`~ src/web/js/story.js`、`~ src/web/js/data.js`、`~ src/web/index.html`
**做法**：章节标题 + 一句话副标题 + 结束语；产物 `data/story.<rev>.json` + `data/story.json`；生成失败 → 现有硬编码文案；结束语不再是「这一段，走完了。」。
**完成判定**：断网可完整播放；同 `rev` 幂等；模型不可用时构建成功且故事可读。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 断网可完整播放 | ✅ 故事只要清单就够播；文案产物是**追加**的，拿不到就用派生文案（每章自带词），不存在「等文案而卡住」的路径 |
| 同 `rev` 幂等 | ✅ 章节按 key 码点序规整后写盘；单测把章节数组倒过来重算，产物逐字节相同（这条当场抓到一个真 bug，见下） |
| 模型不可用时构建成功且故事可读 | ✅ 无凭据 → 派生文案；实测产物 9 章全部有标题与副标题，结束语 `2026 年 1 月 到 11 月，共 47 张` |

**分组必须与播放器同源**：产物与运行时必须用同一套分组——两边各写一套，「产物里的章在播放时对不上」这类错最难查，而且只在某个月份的边界上出现。同理，章是按 key 匹配的，所以带筛选播放时对得上的章有文案、其余退回「年份 + N 张」，不会错位。

**「同源」的落实方式后来变了，理由值得记**：最初是构建期直接 `import buildStory()`（一个物理函数，两边不可能不同）。产物要上线时这条路断了——镜像只 `COPY src/server/`，前端只拷 `src/web/js/`，任何一端 import 另一端都是死路。所以现在是**两份实现 + 一条逐键比对用例**：`src/server/curation/story.mjs#chaptersOf()` 复刻分组，`v6-artifact-publish.test.mjs` 拿 `chaptersOf()` 与 `buildStory()` 在「空 / 单年多个月 / 跨年 / 输入倒序」四种输入上比 key、比 label、比每章的 id 集合。共享物理路径只是「不容易错」，一条会红的用例才是「错了会被发现」。

**幂等测试抓到的真 bug**：`derivedEnding` 原先用**入参顺序**的首末章，而章节数组写盘前会按 key 排序。于是把同样的章节倒过来喂进去，产物里的结束语变成「2026 到 2025」——同一 rev 两份产物不一样。改成用排序后的数组算。这条要是没测，线上只会表现为「偶尔结束语是反的」。

**真实语料暴露的第二个问题：副标题混进了英文词**。第一版跑出来是「4 张 · **brown、grey**」「15 张 · grey、**person**」——词表（T-04，rev `86b1eb418dfab759`）没覆盖到的标签，索引里的 `zh` 就是英文 term 本身。中文卡片里混英文词比少一个词更糟，所以 `topWords` 现在只收含汉字的词（与 `year-page.js` / `upload-suggest.js` 的 CJK 过滤同一条纪律）。过滤后同一份语料变成「4 张 · 黑色、交通工具」「15 张 · 蓝色、衬衫」。**顺带说明：这不是文案的问题，是词表覆盖率的问题**，T-04 的验收抽查也该看到这个现象。

**结束语按语料形状走**：一章 → `2026，共 9 张`；同年按月分章 → `2026 年 1 月 到 11 月，共 47 张`（不重复写年份，第一版写成「2026 · 1 月 到 2026 · 11 月」，读着别扭）；跨年 → `2025 到 2026，共 47 张`。三种都由数据算，所以模型不可用时也不会掉回套话。

**「这一段，走完了。」从静态 HTML 里删掉了**：`index.html` 那个 `<h2>` 现在是空的 `<h2 id="story-end-title">`，运行时填入。JSON 关掉时故事本来就播不了，所以没有「空标题」的可达状态；单测直接断言这句套话在 HTML 与 `story.js` 里都不存在。

**与 T-22 合用一个加载器**：`data.js#loadArtifact(name, { rev, version })` 承担「先 rev 版、再固定名、版本对不上就不要」这套约定，策展与故事文案都走它，`curation.js` 里原来那段地址拼装因此删掉（顺带省了约 1 KB 体积）。两个产物**各拉一次批量调用**而没有合并成一次——合并要把两套事实塞进同一个请求再靠 key 前缀拆回来，省下的只是一次 HTTP。

**产物上线（补做，2026-11-15）**：与 T-22 同一处缺口、同一次补齐——`publishArtifacts()` 在写完搜索索引后写 `data/story.<rev>.json` + `data/story.json`，与精选共用一次模型调用、同一个 rev。细节见 T-22 的「产物上线」一节（模块搬家、IAM 不用改、契约不 bump `version`、15 s 总时限）。线上现状：产物存在、章节与副标题按派生文案生成，模型措辞待凭据。

**故事比精选多一条纪律**：没有照片也照写（空章节 + 空结束语）。精选「凑不齐 9 张就不写」是因为空产物只会让线上多一个要解释的对象；故事不同——它随时可能被打开，留一份「什么都没有」的产物，前端那条读取路径平时就是通的，真出问题时在本地就能看见，而不是等到某天上线才第一次执行。

**体积**：本次改的是已在包里的 `story.js` / `data.js`，加完是 120.7 KB（超 708 B）。做法仍是改自己的代码而不是动预算：抽公共加载器、删三个仅测试用的便利导出、把注释压到「一句结论 + 一句理由」。现在 **119.8 KB / 120.0 KB**。连续两个任务都靠压注释过关，说明该改的是门禁而不是注释——**你随后决定把预算提到 128 KB**（见 T-12），于是这两处不再需要还债。

**新增**：`+ src/server/curation/story.mjs`（10 个导出，服务端分组与文案）、`+ src/build/story.mjs`（构建期落盘，`export *` 转手）、`+ src/server/test/v6-story.test.mjs`（15 条）、`+ src/web/test/v6-story-copy.test.mjs`（7 条）；`~ src/web/js/data.js`（`loadArtifact`）、`~ src/web/js/story.js`（`applyStoryCopy` / `chapterLine` / `endingLine` / `paintCard`）。

---

### T-24 「这一年」年度页 〔F-01〕 **done(代码)**

**改动**：`~ src/web/js/main.js`（新增 `mode='year'`？**不新增 hash 键**，用 `view=year` + `year=`）、`+ src/web/js/year-page.js`
**完成判定**：张数、12 格热度条（空月留白不压缩）、Top-3 标签、主色；2 s 内可交互；除 manifest 与索引外无其他请求；空年份显示「这一年没有照片」。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 张数 | ✅ 标题下写「47 张 · 视频 13 条 · 9 个月有照片（照片 34 张）」 |
| 12 格热度条，空月留白不压缩 | ✅ `grid-template-columns: repeat(12, …)` 写死 12 列；空月格子仍在、`disabled`、柱子高度 0 |
| Top-3 标签 | ✅ 线上真实数据：衬衫 18 / 交通工具 3 / 汽车 3 |
| 主色 | ✅ 线上真实数据：灰色 · 34 张（带色块） |
| 2 s 内可交互 | ✅ 纯同步计算，不 await 任何东西；页面上没有一张照片 |
| 除清单与索引外无其他请求 | ✅ 页面结构里没有任何 `<img>`；索引缺失时只是没有标签与主色 |
| 空年份 | ✅ 「这一年没有照片」，热度条与出口一起藏起来 |

**不新增 hash 键**：`view=year` + `year=2026`。`view` 和 `year` 都是既有键，`parseHashString` 的允许列表里加了 `'year'` 一个值；单测直接跑 `parseHashString` → `buildHash` 往返，断言 `#view=year&year=2026`。

**12 格为什么必须写死**：按「有照片的月份」生成格子，等于让读者自己去数空白，「2 月一张都没有」这个事实就被悄悄抹掉了。热度分 4 档，只改柱子透明度、不引入第二套颜色——四档要能一眼分开，又不想多四种色。

**主色取的是颜色词，不是像素**：索引的 `items[].colors` 里混着非颜色词（线上实测有 `urban`），所以过一遍 `COLOR_TERMS` 白名单。**没有颜色数据时返回 `null`，不编一个默认色**——编了就变成「这一年是灰色的」这种听起来像结论的假话。色板 11 个色落在 `--sw-*` 前缀下，不进 `--c-*` 那层：`--c-*` 的含义是「跟着主题翻」，而红色在深色主题里也得是红的，只靠一圈内阴影保住边界。

**标签只收有中文的**：索引里 `labels[].zh` 在词表没覆盖时会退回英文原词（线上 `person` 就是这样），把它当中文标题摆出来显得像没做完。所以过滤掉不含汉字的标签；颜色标签也不算——颜色已经在主色那一栏占位了。排序不用 `localeCompare`（ICU 差异会翻车），同票按码位。

**入口**：相册根目录下多了一条年份条（年份来自清单，新照片进来不用改配置），点年份进年度页；年度页里点月份 → 时间流 + `year&month`，点标签 → 搜索，点「看这一年的照片」→ 时间流 + `year`。「返回」在年度页时回时间流而不是回相册根目录——它本来就不在相册里。

**新增**：`+ src/web/js/year-page.js`（6 个纯函数 + 1 个装配 + 1 个年份条渲染）、`+ src/web/test/v6-year-page.test.mjs`（20 条，含 6 条假 DOM 装配测试）。产物 93.8 → 100.6 KB gzip（23 个文件，预算 120 KB）。

---

### T-25 照片墙 2.0 〔U-07〕 **done(代码)**

**改动**：`~ src/web/js/wall.js`、`~ src/web/index.html`（播放源选择）
**做法**：四源互斥（全部 / 精选 / 某年 / 某相册）；视频播完再走；人像比空景多停 1–2 s；连拍近似只播一张；精选源读 T-22 产物。
**完成判定**：四源切换队列正确；视频不被中途切断；一轮内近似照片只出现一次；精选为空回退「全部」并提示。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 四源切换队列正确 | ✅ `sourcePool()` 是唯一的池子，下游队列/去重/停留时长全在这份数组上算；单测逐源断言 id 序列 |
| 视频不被中途切断 | ✅ 视频的 `dwellMs` 返回 **0**（含义就是「不排等时器」），改由 `ended` 推进 + 45 秒安全上限 |
| 一轮内近似照片只出现一次 | ✅ `dedupeBurst()` 按 `lqip` 指纹合并，队列单测断言 `a-dup` 不出现 |
| 精选为空回退全部并提示 | ✅ `fallback: true` + `reason`，界面给「精选还没生成，先放全部」 |

**发现并修掉的一个真问题**：以前视频也走 `interval` 定时器，`schedule(durationFor(photo))` 同时还有 `ended → next()` 两条推进路径。间隔比片长短时，片子会在放到一半被切走；两条路径还会互相追尾导致连跳两张。现在视频只等 `ended`，定时器降级成 45 秒兜底（另有 `error` 监听，拉不下来直接走下一张）。

**四源用一只下拉，不用四个控件**：`全部 / 精选 / 2026 年 / 海边 …` 都在这一个 `<select>` 里，互斥是**结构上的**——选中的值解析成一个源对象，池子只从它来。选项由照片现算（`sourceOptions`），新相册新年份进来时下拉框自己长出来，不用改配置。控制条为此加了 `flex-wrap`：多了这个字段后窄屏会顶出屏幕。

**「精选」读 T-22 的产物，产物还没有就回退**：契约是 `data/curation.json` 里的 `{ picks: ["id", …] }`（T-22 落地时按 spec §5 统一了文件名，原先这里写的 `data/curated.json` 是我临时起的名），**只在用户真的选到「精选」时才拉这一次**（不选就不发请求）。T-22 尚未实现，所以现在恒为 404 → 空数组 → 回退全部并提示。判据「精选为空回退全部并提示」在产物出现之前就已经成立，出现之后不需要改一行前端。

**连拍近似用 lqip 当指纹**：`lqip` 是 24 px 的缩略指纹，两张几乎一样的连拍会给出同一串。判据弱，所以**只在 lqip 存在时才合并**（长度 < 32 视为没有）；缺 lqip 的条目一律保留——宁可多播一张，也不把不同照片误删。跨月相同 lqip 不合并（纯色卡之类会撞指纹）。

**人像多停 1.5 秒**：判据是语义索引里有没有 `person` / `people` 标签（`portraitIds`）。索引不可用时集合为空，退化成统一停留——不是错误，只是没有额外信息。

**新增**：`+ src/web/js/wall-source.js`（10 个纯函数）、`+ src/web/test/v6-wall-source.test.mjs`（18 条）、`~ wall.js`（队列改走源池、`timerFor` 取代 `durationFor`、下拉框装配、`error` 兜底）、`~ main.js`（`portraits` 与 `loadPicks`）、`~ index.html`（`#wall-source`）、`~ style.css`（控制条折行、长相册名截断）。产物 100.6 → 106.2 KB gzip（24 个文件，预算 120 KB）。

---

### T-26 随机漫游 〔U-06〕

**改动**：`+ src/web/js/wander.js`（≈40 行）、`~ src/web/js/main.js`
**完成判定**：连续 20 次不重复；权重 `1/(岁数+1)`，老照片命中率高于线性随机；灯箱左右键延续随机序列；零新数据。

---

### T-27 上传归位建议 〔FR-08〕 **done(代码)**

**改动**：`~ src/web/js/upload.js`（选中照片后）
**做法**：规则为主（时间聚集、既有相册命名模式、标签重合度），**纯内存态**，不新增写路径。
**完成判定**：12 张给出 1 个相册名 + ≥3 个标签建议，≤300 ms；忽略后流程与现状一致；S3 无新增对象。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 12 张给 1 个相册名 + ≥3 个标签 | ✅ 单测用 12 个文件跑满这条断言 |
| ≤300 ms | ✅ 索引撑到 2000 条，5 轮平均耗时由测试断言 < 300 ms |
| 忽略后流程与现状一致 | ✅ 「不用了」只是关掉面板，后面走的还是 v4 那条上传路径，一行没改 |
| S3 无新增对象 | ✅ 模块源码里不许出现 `fetch(` / `XMLHttpRequest` / `sendBeacon` / `presign` / `PUT`（测试直接读源码断言） |

**时间信号用的是 `lastModified`，不是拍摄时间**：前端拿不到 EXIF（HEIC 尤其拿不到），所以这里只把文件时间当**「同批」的聚集信号**——从相机一次导出的照片 mtime 通常挨得很近。真正的年月仍由服务端从元数据判定，所以这个猜测**永远不会成为事实来源**。有单测钉住「按 UTC+8 换算」：`2026-10-31T20:00Z` 的文件要算成 11 月，和 `resolveYearMonth` 一个约定。

**相册名的三条规则**：① 这批照片的月份有现成相册就复用（`reuse-existing`）；② 否则按既有相册的命名写法造名字——先认 `2026 年 11 月` / `2026 年` / `2026-11` / `2026` 四种模式，免得相册列表里混进一种陌生写法；③ 一条线索都没有就退回年份，**也就是上传面板原本的默认值**，所以最差情况不比现在差。

**标签给的是信息，不是开关**：服务端把「相册名 + 年份」写成标签，识别标签也在服务端生成，前端没有任何写入口。所以标签建议的用法是**帮用户判断相册名起得对不对**——相册名本身会变成一个标签，起得含糊，以后就搜不出来。面板上写明「相册名会成为一个标签」，采纳按钮只改相册名这一件事，不新增写路径。

**什么时候不打扰**：用户自己动过相册名（`input` 事件）之后就不再建议；只选一张照片不建议；相册名与标签都没新意时 `weak: true`，面板不弹。面板关掉 / 按 Esc 也会把挂起的 Promise 结掉——否则上传会停在那里等一个永远不会来的点击。

**新增**：`+ src/web/js/upload-suggest.js`（7 个纯函数）、`+ src/web/test/v6-upload-suggest.test.mjs`（18 条）、`~ upload.js`（建议面板与闸门、`getLibrary` 注入）、`~ main.js`（注入相册名与索引读取器）、`~ index.html`（`#upload-suggest` 卡片）、`~ style.css`。产物 106.2 → 111.0 KB gzip（25 个文件，预算 120 KB）。

---

### T-28 离线可读 〔F-02〕 **done(代码，待真机验收)**

**改动**：`+ src/web/sw.js`、`~ src/build/build.mjs`（注册）
**做法**：只缓存 manifest + 近 3 个月 `thumb`；上限 ≤80 MB，超限「最近优先」淘汰；**不是 PWA**（不加 Web App Manifest、不做安装引导）；缓存 key 带 `rev`，`activate` 清非当前 rev。
**完成判定**：断网后近 3 个月可浏览缩略图并开灯箱（大图缺失有降级提示）；`rev` 变更后已删照片 100% 不再出现（抽查）；未注册 SW 的浏览器行为不变。

**实施结果**

| 判据 | 实测 |
| --- | --- |
| 断网后近 3 个月可浏览缩略图 | ✅ 只缓存 `thumb.webp`；`activate` 时按清单预热近三个月（本月 + 前两个月） |
| 大图缺失有降级提示 | ✅ 灯箱 `error` → 退到 `thumb`，说明行追加「离线，只有缩略图」 |
| `rev` 变更后已删照片不再出现 | ✅ 缓存名带 rev，`activate` 清掉其它 rev 整套；清单本身网络优先，删掉的照片连条目都不在了 |
| 上限 ≤80 MB、最近优先淘汰 | ✅ 超 80 MB 从最老插入的删到 85%；单测构造 90 MB 场景断言只删最老那条、最新那条必须留 |
| 未注册 SW 的浏览器行为不变 | ✅ 只在 https 下注册，失败静默；SW 对跨域请求（预签名上传）一律放过 |

**这张卡动了共享契约，已确认（2026-11-15，按建议值批准）**：`.github/workflows/deploy-web.yml` 原来只发布 `assets/` 与 `index.html`，`sw.js` 根本不会被上传。而 Service Worker **必须落在桶根**才有全站作用域——放进 `assets/sw.js` 只能控制 `/assets/` 下的请求，导航请求轮不到它，离线就是空的。所以加了一段「上传 sw.js 到桶根 + 失效 `/sw.js`」（`no-cache, must-revalidate`）。这是本任务唯一碰发布流程的改动。

**为什么不是 PWA**：没有 Web App Manifest、没有 `beforeinstallprompt`、没有推送。单测直接断言源码里不许出现这几个词——离线能力和「装成应用」是两件事，混在一起就会有人开始问为什么没有图标。

**为什么只缓存 thumb**：一张 `view.webp` 是 200–400 KB，一段 `clip.mp4` 能到 20 MB。缓存它们等于拿用户的存储做赌注，而离线场景真正需要的是「能翻、能认出来是哪张」。大图缺失时灯箱自己降级并说明，而不是显示一张糊图让人以为画质坏了。

**测试怎么做到的**：`v6-offline.test.mjs` 用 `vm` 给一个假 `self` / `caches` / `fetch`，**直接加载要上线的那份 `sw.js`**，断言 `strategyFor` 的分流、`recentThumbs` 的取舍、`evict` 的淘汰顺序、`cacheName` 带 rev。写一份镜像实现来测只会测到镜像。

**新增**：`+ src/web/sw.js`（约 250 行，含一个只给测试用的 `self.__albumSw` 钩子）、`+ src/web/test/v6-offline.test.mjs`（12 条）、`~ build.mjs`（产出 `dist/sw.js`）、`~ main.js`（https 下注册，失败静默）、`~ lightbox.js`（大图失败降级 + 提示）、`~ .github/workflows/deploy-web.yml`（**需审核**）。产物 111.0 → 116.1 KB gzip（26 个文件，预算 120 KB；SW 也计入了体积，没有开后门）。

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

---

## 7. 本轮实施记录（2026-11-15，分支 `feat/v6-t09-t28`）

> 本节点只记「做了什么、量到什么」，**不判定需求达成**。达成与否仍按 §6 回到验收矩阵逐条对照。

### T-09 IME 防抖 + 统一渲染入口 〔Q-01〕— done(代码)

`+ src/web/js/search-ui.js` 内的纯调度器 `createQueryScheduler`，`~ src/web/test/v6-query-debounce.test.mjs`（8 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 组合期不查 | 0 次 | `compositionstart` 后连发 `hu` / `hu shui` 均不提交；`compositionend('湖水')` 提交 1 次 | ✅ |
| 连打 10 个字符 | 1 次渲染 | 提交 1 次，值为最后一个字符 | ✅ |
| 组合结束立刻查 | 不再等防抖 | 立即提交，且不会补一次防抖查询（共 1 次） | ✅ |
| 与 `refresh()` 同一入口 | 不另开路径 | 提交回调就是 `onQuery` → `refresh()` | ✅ |

**顺带修的一处**：`syncControlValues()` 原来无条件用 `state.q` 回写输入框。查询改为防抖后 `state.q` 会滞后 150 ms，任何一次 refresh（例如索引加载完成）都会把用户刚打的字擦掉。现在输入框处于焦点时不回写。

**一处计划外的边界**：回车改为 `flush()` + 关闭面板；`event.isComposing` 为真时不拦（输入法还在选字，回车是选字不是提交）。

### T-12 体积门禁 〔FR-14 / C-4〕— done(代码)

`+ scripts/check-budget.mjs`、`+ scripts/lib/budget.mjs`、`~ package.json`、`~ .github/workflows/deploy-web.yml`、`~ .gitignore`、`+ src/server/test/v6-budget.test.mjs`（8 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 正常构建 | 通过并打印真实数字 | **79.0 KB / 120 KB**（18 个文件，余量 41.0 KB） | ✅ |
| 塞一个 200 KB 量级依赖 | 失败且指出模块 | 塞入 140 KB 不可压缩文件 → 退出码 **1**，指出它占 **51.5%**，报「超出 42.7 KB」 | ✅ |
| 边界 | 恰好等于预算算通过 | 单测钉住「= 预算通过、+1 字节失败」 | ✅ |

> ⚠️ **与任务书的一处偏差**：原文写「`~ package.json`（`verify` 串联）」，**没有照做**。
> `npm run verify` 在干净检出上跑（CI 里也在构建之前），那时 `dist/` 根本不存在，
> 串进去会让每一次干净检出直接变红。改为挂到 `deploy-web.yml` 的「构建之后」一步。
> 这是本轮**唯一改动工作流文件**的地方，请重点看。
>
> 另外：`.budget-baseline.json` 写在工作区用于报增量，已进 `.gitignore`——基线是机器本地的，进仓库会让增量永远显示 +0。

### T-15 网格密度三档 〔U-05〕— done(代码)

`~ src/web/js/state.js`（`layoutParams(width, density)` + `DENSITY` / `normalizeDensity`）、`~ src/web/js/gallery.js`（`setDensity`）、`~ src/web/index.html`、`~ src/web/js/main.js`、`+ src/web/test/v6-density.test.mjs`（6 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 三档目标行宽 | 200 / 340 / 520 | 一致 | ✅ |
| 不裁切 | 瓦片宽高比 = 照片比例 | 任意档位、每一张瓦片都断言 `width/height === ratio` | ✅ |
| 并排行填满 | 宽度和 + gap = 容器宽 | 三档全部误差 < 0.001 px | ✅ |
| 刷新后保持 | `localStorage` | `album.density`，读写包 try（隐私模式静默降级） | ✅ |
| 未知档位 | 不抛错 | 落回 `standard` | ✅ |

**取舍**：密度只改 `target`，不动 `maxPerRow`——动 `maxPerRow` 会让「大图」档在窄屏变成一列，那不是密度而是另一个视图。

### T-16 图片加载三兜底 〔P-03〕— done(代码)

`~ src/web/js/gallery.js`（`attachImageFallback` / `showTileError`）、`~ src/web/style.css`。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 失败兜底 | 「这张暂时打不开 · 重试」 | 按 view→grid→thumb→poster 换源，最多 3 次后出占位卡 | ✅ 代码 |
| 可重试 | ≤3 次 | 重试按钮从首选源重来，成功后自动清掉占位 | ✅ 代码 |
| 不误触灯箱 | 点重试不打开大图 | `preventDefault` + `stopPropagation` | ✅ 代码 |
| LQIP 交叉淡入 | 200 ms、无白闪 | 过渡从 0.55 s 收到 **0.2 s**，LQIP 铺在 `tile-frame` 底层 | ✅ 代码 |
| CLS | ≤0.1 | 占位卡 `position:absolute; inset:0`，格子尺寸不变 | ✅ 代码 |
| reduced-motion | 直接切换 | 既有全局 `transition-duration: 0.01ms` 覆盖 | ✅ 代码 |

> `404 / 断网模拟` 这一条**没有在浏览器里跑过**——本轮没有浏览器可用，只做了代码路径推演。留作人工验收项。

### T-17 回到上次位置 〔P-01〕— done(代码)

`+ src/web/js/anchor.js`、`~ src/web/js/main.js`、`~ src/web/js/gallery.js`（月份节点 `data-month`）、`~ src/web/index.html`、`~ src/web/style.css`、`+ src/web/test/v6-anchor.test.mjs`（8 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 落点同月 | 关闭再开落在同一个月 | 存 `{year, month}`，启动时按 `.year-group[data-year] .month[data-month]` 定位 | ✅ 代码 |
| 无「先顶部再跳」 | 不闪 | `history.scrollRestoration = 'manual'`，恢复在首帧 paint 之后同步执行 | ✅ 代码 |
| 隐私模式 | 静默降级 | 读写全包 try，读不到就当没有记忆 | ✅ |
| 清空记忆 | 「回到最近」 | 悬浮按钮只在有记忆时出现，点它清 key + 回顶部 | ✅ 代码 |

**取舍**：只存年月，不存像素。像素在照片增删 / 密度切换 / 窗口变宽后必然指错位置，年月是内容锚点。只在「纯时间流」里记——筛选结果与相册页不记，否则记忆会指向用户平时回不去的位置。

### T-18 相册卡片三信息 〔P-02 / O-03〕— done(代码)

`~ src/web/js/state.js`（`hashOf` / `formatAlbumSpan` / `albumSummary`）、`~ src/web/js/gallery.js`（`renderAlbums`）、`~ src/web/style.css`、`+ src/web/test/v6-album-cards.test.mjs`（9 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 时间跨度 | `2024.3–2024.5` | 单月只写一个；跨年两端带年 | ✅ |
| 封面确定性 | 重复渲染不变 | 相册名 FNV-1a 取模；同一名字 5 次渲染结果一致 | ✅ |
| 封面分布 | 不是「永远第一张」 | 12 个名字选出 ≥8 种不同封面 | ✅ |
| 无发布时间 | 不出错误值 | 只显示「N 张 · 跨度」，不编「最近更新」（O-03） | ✅ |

### T-26 随机漫游 〔U-06〕— done(代码)

`+ src/web/js/wander.js`、`~ src/web/js/main.js`、`~ src/web/index.html`、`+ src/web/test/v6-wander.test.mjs`（9 条）。

| 判定项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 一轮不重复 | 连续 20 次不重复 | 20 个 id 互不相同；整轮覆盖全部且各一次 | ✅ |
| 权重公式 | `1/(岁数+1)` | 今年 1.0、去年 0.5、五年前 1/6、十年前 1/11 | ✅ 照原文 |
| 同种子可复现 | 序列固定 | 同种子 deepEqual，换种子不同 | ✅ |
| 零新数据 | — | 只用 manifest 里已有的 `year` | ✅ |

> **已知矛盾，按用户决定如实保留**：原文公式 `1/(岁数+1)` 与同节验收条件「老照片命中率**高于**线性随机」方向相反。合成夹具（今年 60 张 + 五年前 20 张）实测老照片只占 **7.7%**，而线性随机是 25%。
> 2026-11-15 用户决定：**照原计划实现、上线，用真实上传的老照片验收**——合成夹具说服不了任何人，公式方向该由真实语料的分布决定。
> 因此代码保留 `1/(岁数+1)`，测试改为「量出并钉住公式的可观测后果」，不再宣称「老照片更常出现」。若线上验收发现老照片出不来，改的是公式（权重取 `岁数+1` 或改成年份分桶等权），不是测试。

**接线方式**：漫游序列直接当作灯箱的列表，左右键沿随机序列走；关灯箱时把 `state.filtered` 还回去，否则之后点瓦片的下标会对不上。

### 本轮未做（T-13、T-14、T-19~T-25、T-27、T-28）

停在这里的原因不是时间，是**验收方式**：

- **T-13 / T-14（暗色）** 的验收是「截图无亮色残留 + 6 组对比度实测」，本质是视觉判定。
- **T-19 / T-20 / T-21 / T-24 / T-25 / T-27** 依赖 T-10 的新骨架或需要真机（上传中断、视频拖拽）。
- **T-22 / T-23** 依赖 B3（模型凭据），只能做降级分支；**T-28** 的验收是「断网后近 3 个月可浏览」，必须真机。

> **更新（同日稍后）**：T-10 与 T-11 已完成。原先把它们留在这里的理由是「骨架重写没有浏览器就无法验证，失败形态是整站白屏」。后来在 `127.0.0.1:5188` 起了一个真实预览（dist 产物 + 线上清单 + `/photos/*` 302 到 CloudFront），**用户已确认 T-10 的四件事与控制台零错误**，于是按原铁律把 HTML/JS/CSS 放在**同一个提交**里一次改完，并补了静态自检（id 唯一性、必需 id 齐全、`el()` 引用闭合）。T-11 之后同一条预览也换成了静态首屏。

建议顺序：先验收订单里的 8 项 → 合 PR → 再做 T-13 / T-14 → 其余。
