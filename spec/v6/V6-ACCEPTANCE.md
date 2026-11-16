# V6 Acceptance Matrix / V6 验收矩阵

> 本文是 V6 的放行依据。**能力不因为「有函数、有夹具、有单测」就算做到，要有生产证据。**
> `tasks.md` 的 ✅ 只表示「代码已入库」；判定只看这里。
>
> *This document is the release gate. A capability is not accepted because a
> function, fixture or unit test exists; it needs production evidence.*

> **2026-11-16 迭代收尾 / Iteration closure**：用户完成四轮生产验收并决定
> **V6 迭代收尾结束**。本矩阵**不改写为 fully accepted**：未取得生产证据的条目、
> 以及用户明确「放到 V7 再讨论」的需求，一律按**已批准的例外**结转，逐条列在文末
> 「收尾与结转 / Closure and carry-over」。「迭代关闭」与「release gate 全部满足」
> 是两件事。
>
> *On 2026-11-16 the user closed the V6 iteration after four acceptance rounds. This
> matrix is NOT rewritten as fully accepted: items lacking production evidence, and
> requirements the user explicitly deferred to V7, are carried over as approved
> exceptions. Closing an iteration is not the same as satisfying the release gate.*

---

## 1. 上线事实 / What actually shipped

四轮修复，全部经由「分支 → PR → 合并 → `deploy-web` → 线上复验」，没有一次直接推 `main`。

| 轮次 | PR | 合并后 `main` | 前端 bundle | 内容 |
| --- | --- | --- | --- | --- |
| 首轮上线 | #21 | `6080d78` | — | 首屏裂图兜底、上传入口回导航、搜索条搬进内容列 |
| 第二轮 | #22 / #23 | `139355a` | `assets/js.4b60a671` | 上传不清空选择器；标签/建议词可搜、密度生效、标签栏去重 |
| 第三轮 | #24 | `05ff37a` | `assets/js.fbde53e4` | 生长刻度：生日、月龄、每月一句话 |
| 第四轮 | #25 | `afbaeba` | `assets/js.fcb1f2a2` | 相册卡片点了不重画目录 |

- CloudFront 失效记录：第二轮 `IW90BDIY7W29ON4P5OCAIBFRN`、第四轮 `ICDI2FWBUE4RKON9K05GE99NQK`。
- 镜像 tag `139355a37e9e` 经 `album-infra` PR #25 上过生产（plan `0/2/0`，apply 成功）。
  **之后两轮是纯前端改动，镜像未动**——`docker/Dockerfile` 只 `COPY src/server/`，不含前端产物。
- 线上现状（2026-11-16 09:3x 取）：`data/version.json` → `rev=ec9f4e370dcf`，53 张（40 图 / 13 视频）、
  2 个相册；`index.html`、`data/search-index.json`、`sw.js` 均 200。

## 2. 成功标准 / Success criteria

判定口径：**Pass**＝有生产或 CI 证据；**Partial**＝代码就位但缺证据；**Carried**＝结转 V7。

| # | 指标 | V6 目标 | 判定 | 证据 / 缺口 |
| --- | --- | --- | --- | --- |
| S-1 | 首屏到第一张真实照片 | hero 之下 0 屏内露出时间流首月标签与首行瓦片 | **Partial** | hero 高度 60vh（桌面）/ 50vh（移动），搜索条已移到 hero 之后，结构上首屏内应露出月份标签与首行瓦片。**未做两个目标视口的实测截图**。 |
| S-2 | 顶部导航可点项 | ≤3 | **Pass** | 现为 3 项：品牌 / 相册 / 上传。「时间轴」tab 已删，搜索框搬进内容列。结构用例见 `v6-template-entries.test.mjs`。 |
| S-3 | 可发现的语义词数 | ≥300 | **Pass** | `npm run check:lexicon`：rev `53f472bff8351b97`，126 个 term、**319 个可搜中文词**，服务端与前端产物逐字节相同。 |
| S-4 | 词表外查询返回全量的次数 | 0 | **Pass** | `parseQuery` 对未收录词返回 `unmatched` 而不是全量；用例 `v6-label-searchable.test.mjs`（`大象` 仍未收录、仍不返回全量）。 |
| S-5 | 第 500 张后单次追加渲染 | 增量追加，long task ≤50ms | **Partial** | `catalog.update()` 已改增量追加、节点单调递增（`v6-catalog-append.test.mjs`）。**线上 53 张，够不到 500 张的真实场景，long task 未测**。 |
| S-6 | 浏览时外部请求（生成式） | 仍为 0 | **Pass** | 所有模型调用在构建期完成，产物落盘；`v6-offline.test.mjs`。 |
| S-7 | 月度成本 | ≤¥15（不新增常驻资源） | **Pass** | V6 未新增常驻资源；新增产物为 KB 级静态文件（索引、故事、策展、`family.json`），随既有 S3/CloudFront 计费。沿用 V5 实测口径（≈¥0.003/月）。 |
| S-8 | JS+CSS 体积 / 桌面 LCP | ≤132 KB（CI 硬门禁）/ ≤2.5s | **Partial** | 体积：CI 实测 **130.2 / 132.0 KB**，余 1.8 KB，超限即失败。LCP：**未实测**（CI 环境没有真实图片与 CDN，测出来是假的，见 `plan.md` C-4）。 |

## 3. 验收草案逐条 / Draft acceptance criteria

| 条目 | 判定 | 说明 |
| --- | --- | --- |
| 首页 | **Partial** | 导航 3 项已达成、`#featured`/`.cta` 已无、reduced-motion 下无动画；两视口首屏露出缺截图。 |
| 搜索 | **Pass** | 五个查询符合期望；`EXAMPLE_QUERIES` 硬编码已消失；IME 一次输入 ≤2 次检索（`v6-query-debounce.test.mjs`）。第二轮线上复验：84 个可点标签词 **0 死链**，12 条建议词全部有结果。 |
| 性能 | **Partial** | 增量追加与 DOM 单调有据；CLS 与 long task 未在真实语料上测量。 |
| 支撑件 | **Pass** | 词表只有一份来源 `src/shared/lexicon.json`，前后端产物由 `gen-lexicon.mjs` 生成并逐字节比对；预算超限 CI 失败并列出 top-5 模块。 |
| 生成式 | **Partial** | 断网可读（无运行时请求）成立；但生产 `story.json` / `curation.json` 的 `sentence` **全为 `null`**——构建机没有模型凭据，章节卡与结束语实际走的是手写文案 + 派生逻辑。同一 `rev` 重复构建幂等、模型不可用时构建成功，均有据。 |
| 隐私 | **Pass** | `npm run check:repo`：198 个文件，无媒体、密钥、大文件或绝对路径；公开 JSON 内不含拍摄时刻；索引只含白名单字段。 |
| 成本 | **Pass** | 见 S-7。 |
| 验收措辞 | **Pass** | 语义搜索的验收口径为「对库内实际存在的概念可解释」，不要求固定六个示例词全部命中（沿用 backlog B-06）。 |

## 4. 门禁（2026-11-16 收尾时实测）/ Gates at closure

```
npm test            → 565 项，全绿（0 fail / 0 skip）
npm run test:bare   → 565 项，0 fail（2 skip：依赖 node_modules 的用例）
npm run verify      → 42 项断言全部通过
npm run check:repo  → 198 文件通过
npm run check:budget→ 130.2 / 132.0 KB，余 1.8 KB
npm run check:lexicon→ rev 53f472bff8351b97｜126 term｜319 可搜中文词｜产物 2 份逐字节相同
```

## 5. 收尾与结转 / Closure and carry-over

**收尾判定**：V6 迭代关闭。理由是同一条主线（时间流 / 搜索诚实 / 构建期生成）已在生产可验收，
四轮反馈的**缺陷类**问题全部修复并有回归用例；剩下的是**缺证据**与**产品方向未定**两类，
按已批准的例外结转。

### 5.1 缺生产证据（结转，不阻断收尾）

1. 两个目标视口的首屏截图（S-1）、CLS 与 500 张以上的 long task（S-5、S-8 后半）。
2. 桌面 LCP 实测 —— 每次发布后手工测量并回填本表，不进 CI。
3. 真实语料上的生成式产物（`sentence` 全 `null`）：要么把文案生成接进发布流水线，要么
   明确「就用派生文案」后把生成路径删掉（见 V7 B-03）。
4. 安卓真机的离线可读（`sw.js`）与上传选择器复验。

### 5.2 结转 V7 的需求（用户明确要求「放到 V7 再讨论」）

| 编号 | 需求 | 一句话 |
| --- | --- | --- |
| B-01 | 人物时间线 | 39 张 `person` 从「可点的标签」升级为可翻的时间轴，轴上带年龄刻度 |
| B-02 | 成长里程碑 + 年度纪念册 | 标注「第一次……」，导出可打印 PDF（离线生成） |
| B-03 | 标签与文案收尾 | 6 个只有英文名的标签；`sentence` 全 `null` 的生成路径 |
| B-04 | 体积预算的真实解法 | 构建期剥注释再量，而不是继续上调预算 |
| B-05 | 「相册」到底是什么 | 上传不该向用户要一次没有信息量的决策；三个方向已列出 |
| B-06 | 「每月一句话」的语感 | 现在是「记录者口吻」写拍摄日志，不是写孩子；四组对照 + 五条判据 |

详见 [`spec/v7/backlog.md`](../v7/backlog.md)。

### 5.3 结转到 V7 一并清理的债

- `album` 字段既当相册名又进 `tags`，两处语义重复（B-05 定案时一起收）。
- 预算两次上调（120 → 128 → 132 KB）都是**用宽松换功能**，B-04 是唯一正解。
