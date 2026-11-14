# 个人相册 · 第六版需求规范 / Personal Album · Version 6 Specification

> Spec-Driven Development · 阶段 1 / 5（Specify） / Stage 1 / 5 (Specify)
> 状态：**已确认** / Status: **Confirmed**
> 日期 / Date: 2026-11-14
> 确认 / Confirmed: 2026-11-14，O-01~O-07 全部采纳建议后确认，进入 Plan 阶段。
> *Confirmed on 2026-11-14 after adopting all recommended resolutions for O-01~O-07; entering the Plan stage.*
> 上游 / Baseline: `album@main` @ `4d4f521`（V5 已验收）；`album-android@main`（2026-11-12）。
> *Upstream: album main at 4d4f521 (V5 accepted); album-android main (2026-11-12).*
> 需求来源 / Source: [`spec/v6/backlog.md`](./backlog.md) + 2026-11-14 需求评审（D1–D6）。
> *Source: the V6 backlog plus the 2026-11-14 requirement review.*
> 流程约束 / Process: 本文确认后才进入 Plan；`tasks.md` 打勾只代表代码入库，**是否验收只由验收矩阵决定**。
> *Only after this spec is confirmed does the Plan stage start; a checked task means code merged, and acceptance is decided solely by the acceptance matrix.*

---

## 0. 一句话

V6 不动数据底座，只动三件事：**首页从「多个模块拼在一起」变成一条时间流**；**搜索从「看起来在搜」变成「搜不到就说搜不到」**；**用构建期的生成式能力给存量照片补上「能搜的词」和「能读的句子」**。

*V6 does not touch the data foundation. It changes three things only: the homepage becomes one chronological stream instead of stacked modules; search stops pretending and admits when it cannot match; build-time generation gives existing photos searchable Chinese words and readable sentences.*

### 0.1 追溯 / Traceability

| 来源 / Origin | 落入本 Spec |
| --- | --- |
| backlog B-01 搜索结果位置 | FR-05 |
| backlog B-02 词表不透明 | FR-03 |
| backlog B-03 首页信息密度 | FR-01 |
| backlog B-04 顶部导航 | FR-01、FR-02 |
| backlog B-05 词表外返回全量 | FR-03（判定为**缺陷**，不是体验问题） |
| backlog B-06 六示例口径 | §3 非目标、§8 验收草案 |
| 决策 D1 首页方案 C | FR-01 |
| 决策 D2 hero 静态 | FR-01 |
| 决策 D3 G1 做 / G2 不做 / G3 做 | FR-04、FR-06；G2 入 §3 |
| 决策 D4 新增 A/B/C | FR-07、FR-08；FR-11 延后 |
| 决策 D5 标签人工纠正不做 | §3 |
| 决策 D6 不做 HTML 原型 | §3 |

---

## 1. 目标与成功标准 / Goals and Success Criteria

### 1.1 目标 / Goals

1. **信息架构**：一条时间流承担全部浏览叙事，首页不再靠"加区块"表达丰富度。
   *One chronological stream carries the whole browsing narrative; richness no longer comes from stacking more sections.*
2. **搜索诚实**：可搜的词变多（13 → ≥300），且搜不到时明确说"没这个词"或"库里没有"，绝不静默返回全量。
   *More searchable words, and an explicit answer when nothing matches — never a silent full-list fallback.*
3. **浏览性能**：长列表增量渲染，几千张照片滚动不掉帧。
   *Incremental rendering so thousands of photos stay smooth.*
4. **生成式能力为静态资产**：所有模型调用在构建期完成，产物落盘，浏览时零外部请求、零运行时成本。
   *All model calls happen at build time; artifacts are static, so browsing makes no external calls and costs nothing at runtime.*
5. **不改红线**：公开产物、隐私边界、无服务器/无数据库形态、≤¥15/月成本全部保持。
   *All red lines hold: public artifacts, privacy boundary, serverless/no-database shape and the ≤¥15/month target.*

### 1.2 成功标准 / Success criteria

| # | 指标 | 现状（实测/代码） | V6 目标 |
| --- | --- | --- | --- |
| S-1 | 首屏到第一张真实照片 | hero 占满首屏，照片在 2.5 屏之后 | hero 之下 0 屏内即露出时间流首月标签与首行瓦片 |
| S-2 | 顶部导航可点项 | 6 项（时间轴/相册/故事/照片墙/上传/搜索），功能重复 | ≤3 项（品牌 / 相册 / 搜索） |
| S-3 | 可发现的语义词数 | 13（`src/web/js/search.js` 的 `LEXICON`） | ≥300（目标 ≈380） |
| S-4 | 词表外查询返回全量的次数 | 每次（`显示器` → `total=48`） | 0 |
| S-5 | 第 500 张后单次追加渲染 | 全量 `replaceChildren`，O(n) 重建 | 增量追加，long task ≤50ms |
| S-6 | 浏览时外部请求（生成式） | 无 | **仍为 0** |
| S-7 | 月度成本 | ≈¥0.003（V5 实测） | ≤¥15（不新增常驻资源） |
| S-8 | JS+CSS gzip 体积 / 桌面 LCP | 无基线，无 CI 门禁 | ≤120KB（**CI 硬门禁**）/ ≤2.5s（发布后实测入矩阵），见 FR-14 |

---

## 2. 范围 / Scope

EARS 记法：**当**（事件）/ **在 … 时**（状态）/ **若**（异常）/ **必须**（shall）。
*EARS notation: WHEN (event) / WHILE (state) / IF (unwanted condition) / SHALL.*

### 2.1 首页信息架构 / Homepage information architecture

#### FR-01 时间流首页（方案 C）

**当**访客打开站点根路径时，系统**必须**渲染一条按「年 → 月」分组的时间流，顶部导航只保留品牌、相册、搜索。

- 导航收敛为 3 项；「故事」「照片墙」「上传」不再占据顶部：故事入口移到**每个年份分组末尾**（「用故事播放这一年」），照片墙、随机漫游与统计移入**页脚**，上传入口也移到**页脚**（Plan 阶段 C-5 修正：与「导航 ≤3 项」二选一，保 ≤3 项）。
- hero 由多章节自动轮播**降级为静态单图**：桌面 ≥1024px 高度 60vh，移动 50vh，使用 `dvh` 避免移动端地址栏导致的高度跳动。
- 首页**必须移除** `#featured` 独立精选区，以及两个 `.cta section--dark` 整屏区块。
- 每个年份分组末尾**必须**插入「年度精选 · 1 大 2 小」块，数据依赖 FR-07；**若**策展产物不存在，该块**不得**渲染空占位。
- 分组内时间倒序；年份之间**必须**有可见分隔与年份标签。
- **在** `prefers-reduced-motion: reduce` 时，hero 与分组进入**不得**播放过渡动画。

**验收**
- 1440×900 与 390×844 两个视口，未滚动状态下 hero 下方**必须**露出首个月份标签与首行瓦片（现状：0 张可见）。
- 顶部导航可点项 ≤3；DOM 中不存在 `#featured` 与 `.cta`。
- 桌面端从顶部到「最近 30 张全部可见」的滚动深度 ≤1.2 屏。
- 开启 reduced-motion 后无自动过渡（截图比对无中间帧）。

#### FR-05 结果可达（专注结果视图）

**当**用户提交查询时，系统**必须**切换到独立结果视图（替换时间流），使结果紧贴导航下方出现。

- 结果视图沿用既有 hash 契约 `#mode=search&q=…`，**不得**新增 hash 键名（现有契约：`mode`/`view`/`album`/`q`/`tag`/`year`/`month`/`pace`/`p`）。
- 首条结果的可视位置必须在**一行结果摘要之下**，不得再渲染在 hero 或精选之后。
- 结果视图**必须**保留年/月/标签筛选与排序。
- **当**用户清空查询、按 Esc 或点品牌时，系统**必须**回到进入搜索前的时间流位置。

**验收**
- 输入「湖水」，首条结果 `getBoundingClientRect().top ≤ 200px`（1440×900）。
- 返回后滚动位置与进入前一致（误差 ≤1 个瓦片高度）。
- 结果视图内筛选变更后，hash 与界面状态一致（可刷新还原）。

### 2.2 浏览动线与导航 / Browsing path and navigation

#### FR-02 年月导航与增量渲染

**当**用户在长流中滚动时，系统**必须**以增量追加方式渲染新瓦片，不得重建已有瓦片。

- **右侧年份索引**：年份数 ≥3 时出现，点即跳到该年首月；当前年份高亮。
- **吸顶年月标签**：滚动时置顶显示当前所在年月。
- **「回到最近」**：滚动超过 2 屏后出现在右下角。
- **必须**消除现状缺陷：`src/web/js/gallery.js` 的 `paint()` 每次 `more()` 都 `container.replaceChildren(fragment)`，即每次追加重建全部节点。
- **必须**消除现状缺陷：切换 tab 时不清空 `state.album`、不回到顶部（`src/web/js/main.js`）。

**验收**
- 索引 500 张后单次追加的最长任务 ≤50ms；容器子节点数单调递增，不出现"先清零再填充"。
- 年份数 <3 时索引隐藏。
- Tab 键可达年份索引与「回到最近」；焦点可见。
- 相册 tab 与时间轴 tab 互切后，筛选条件与滚动位置行为有明确定义且可预测。

#### P-01 回到上次位置

**当**回访访客再次打开站点时，系统**必须**恢复上次的年月锚点与月内滚动偏移，并**必须**始终提供显式「回到最近」出口。

- 记忆维度：年月锚点 + 月内偏移；存 `localStorage`，不新增请求。
- 恢复**必须**在首帧完成，不得"先渲染头部再跳转"造成闪动。
- 「回到最近」清空记忆。

**验收**：关闭再打开，落点与上次离开处同一月份；点「回到最近」回到最新一月；隐私模式下 `localStorage` 不可用时静默降级、不报错。

#### U-05 网格密度三档

**在**用户选择密度时，系统**必须**应用并持久化紧凑 ≈200px / 标准 ≈340px / 大图 ≈520px 三档瓦片宽度。

- 只影响瓦片宽度与每行数量；**不得**裁切照片、**不得**改变比例算法——`layoutParams()` 只多接受一个 density 参数，`computeEditorialRows()` 不改。
- 记忆进 `localStorage`，默认「标准」。

**验收**：三档切换后每行瓦片数正确；切换不引起滚动位置跳变；刷新后保持。

#### U-06 随机漫游

**当**用户触发「随便翻翻」时，系统**必须**跳到一张按年份加权随机的照片，并允许在灯箱内继续随机游走。

- 权重随年份衰减（越老权重越高）；一轮内不重复命中同一张。
- **不得**新增数据文件或接口（纯前端计算）。

**验收**：连续 20 次不重复；分布上老照片命中率高于线性随机；灯箱左右键可延续随机序列。

#### P-02 相册卡片补信息

**当**相册列表渲染卡片时，系统**必须**显示时间跨度、随机封面与最近更新。

- 时间跨度格式 `2024.3–2024.5`；单月相册显示单月。
- 封面从成员照片中随机选取，**同一会话内稳定**，不得每次重绘都换。
- 「最近更新」显示相对时间（如 `3 天前新增 12 张`）；无新增时只显示张数。
- 全部取自既有 manifest，零新接口。
- **若** manifest 内不存在逐条发布时间，本期**确定**降级为只显示张数（O-03 已定），**不得**为此新增写入路径；未来若要补，须按不变量 3 单独评审 prefix / IAM / 失败落点。

**验收**：320px 宽下三项信息不截断；同一卡片重复渲染封面不变；无发布时间字段时不显示"最近更新"而非显示错误值。

#### P-03 图片加载三种兜底

**若**瓦片图片加载失败，系统**必须**渲染可操作的占位卡；**在**图片解码过程中，系统**必须**从 LQIP 交叉淡入而非硬切。

- 裂图 → 占位卡「这张暂时打不开 · 重试」，最多重试 3 次（含手动）。
- LQIP：以既有 `thumb` 作占位，`grid` 解码完成后 200ms 交叉淡入；reduced-motion 下直接切换。
- 慢网：先请求 `thumb`，`grid` 到达后替换；**不得**同时并发两个大图请求。

**验收**：断网/404 模拟下占位卡出现且可重试；无白闪；Lighthouse CLS ≤0.1。

### 2.3 搜索与语义 / Search and semantics

#### FR-03 搜索诚实性

**当**查询包含词表外词汇时，系统**必须**返回 0 条结果并显式说明该词未被收录，**不得**退化为未过滤的全量返回。

- 四态**必须**可区分：① 命中；② 词已识别但库内无内容；③ 词未被收录；④ 索引未加载/降级。
- 建议词**必须**只来自当前索引的真实 vocabulary 与实际命中标签；**必须**移除 `src/web/js/search-ui.js` 中硬编码的 `EXAMPLE_QUERIES`。
- 多词查询为 **AND** 语义：`湖水 汽车` **必须**返回同时满足两者的照片（现状为 OR）。
- 未收录词**必须**在结果区顶部说明「未收录：X」，并给出 ≥5 个可替代词。

**验收**（输入为仓库内 `src/web/js/search.js`，可离线复现）

| 查询 | 现状 | 期望 |
| --- | --- | --- |
| `显示器` | `total=48`（全量假阳性） | `total=0`，状态 = 未收录 |
| `摩托车` | `total=0`，无说明 | `total=0`，状态 = 库内无内容 |
| `湖水` | `total=3` | 保持 |
| `湖水 汽车` | `total=5`（并集） | 交集，≤ 两单词命中数的较小值 |
| `2025 年的湖水` | `total=3` | 保持，且时间条件与语义条件同时生效 |

另需：索引未加载时给出「索引加载中/失败」而非空结果文案；`EXAMPLE_QUERIES` 在代码中不存在。

#### FR-04 G1 中文标签层

**当**识别产生一个标签时，系统**必须**为其附加中文主名与同义词，使每个已识别标签都能用中文搜到。

- **不改识别调用**：仍为 `DetectLabels`，`maxLabels: 30, minConfidence: 70`；**不上传任何图片**。
- 新增**离线词表层**（`EN label → 中文主名 + 同义词[]`）；未覆盖标签**必须**至少保留英文可搜并进入覆盖率报告，**不得**静默丢弃。
- 可搜词规模：从 13 提升到 ≥300（目标 ≈380）。
- 词表**必须**单一来源，前端与服务端共用同一数据文件（**FR-13**，已纳入 V6.0 范围）。
- 中文名**必须一次性审核入库**，**不得**在每次构建时由模型重新生成（O-02）；模型的产出只作为候选，人工过一遍后固化为资产。
- 中文名**必须**落进标签对象 `labels[].zh`。该字段**已在** `LABEL_FIELDS` 白名单内，本期**不需要** `ITEM_FIELDS` 变更、**不需要** bump `INDEX_VERSION`（Plan 阶段 C-1 修正）；只有未来真正新增字段时才触发白名单与版本变更（见不变量 8）。
- `zh` 的解析**必须**发生在索引构建期，不依赖识别期产物（Plan 阶段 C-3 修正）：词表更新只需重建索引，不重跑识别。

**验收**
- 抽查 20 张照片，每张可用中文检索的词 ≥10 个（现状 ≤2）。
- 覆盖率报告存在，未覆盖标签有明确清单。
- 前端与服务端读同一词表文件，差异为 0。
- 词表缺失或识别失败时，英文标签仍可搜（降级不失效）。
- 同一 `rev` 下重复构建，词表内容与中文名零变化（O-02：一次性入库，不随构建漂移）。
- 公开索引 JSON 中无白名单外字段（`validateIndexItem` 通过）。

#### Q-01 输入法组合期防抖

**在**输入法组合期（composition）内，系统**不得**触发检索与结果重绘。

- `compositionstart` → 暂停检索；`compositionend` → 立即检索一次。
- 非组合期输入防抖 150ms。
- 防抖与增量渲染**必须**共用同一渲染入口，不得各写一套（与 FR-02 同批改造）。

**验收**：用中文输入法逐字输入「湖水」，整个过程检索调用 ≤2 次（现状每次按键 ≥1 次）；输入期间无可观察的结果列表重绘。

### 2.4 生成式内容 / Generated content

#### FR-06 G3 回忆文案

**当**生成某一年的故事时，系统**必须**在构建期产出章节标题、一句话副标题与结束语，并落为静态产物。

- 生成发生在**构建期**；浏览时**不得**调用任何模型。
- 产物**必须**带 `rev` 命名 + 固定名回退双写（沿用搜索索引 `data/search-index.<rev>.json` + `data/search-index.json` 的既有约定）。
- **若**生成失败，**必须**回退到既有文案，构建**不得**失败。
- 结束语**不得**再固定为「这一段，走完了。」；文案必须与该年内容相关，不得是重复的空泛模板。

**验收**：断网状态下故事完整可播；同一 `rev` 重复构建产物内容一致（幂等）；模型不可用时构建成功且故事可读。

#### FR-07 A 自动策展

**当**某月照片数达到门槛时，系统**必须**在该月分组顶部呈现 9 张精选 + 一句生成文案。

- **选片由规则决定**（清晰度、去重/相似折叠、标签多样性、时间分散）；模型**只**负责写那一句话，**不得**决定选哪张。
- 门槛：月内照片数 <9 时不生成策展块。
- 产物静态落盘，前端只读。
- 策展块**必须**可跳过（键盘与屏幕阅读器可达「跳过本月精选」）。

**验收**：抽查 3 个月，9 张内无重复/近似重复；文案与该月内容相关；月内 <9 张时不出块；模型失败时只丢句子、保留 9 张。

#### F-01 「这一年」年度页

**当**用户打开某一年时，系统**必须**展示张数、12 个月热度条、Top-3 标签与主色，全部来自既有 manifest 与索引。

- 零新接口、零模型调用。
- 12 格**必须**固定，空月显式留白而非压缩。

**验收**：任意年份页面 2s 内可交互；空年份显示「这一年没有照片」；除 manifest 与索引外不发起其他请求。

### 2.5 上传与离线 / Upload and offline

#### FR-08 B 上传归位

**当**用户选择照片准备上传时，系统**必须**在上传前给出相册名与标签建议，且分析只在内存中完成。

- 规则为主（时间聚集、既有相册命名模式、标签重合度）；**不需要** GenAI。
- **纯内存态**：建议**不得**产生任何新写入路径、**不得**新增 S3 prefix；采纳前不落盘。
- 用户**必须**能一键忽略建议。

**验收**：12 张上传给出 1 个相册名 + ≥3 个标签建议，响应 ≤300ms；忽略建议后上传流程与现状完全一致；S3 无新增对象。

#### FR-10 上传闭环

**当**上传被中断时，系统**必须**从最后一个已完成分片续传，自动重试 2 次，并在发布后提供直达照片的入口。

- 分片 8MB（沿用 `spec/v4/tasks.md` §7 既定方案）+ 断点续传。
- 自动重试 2 次（指数退避）；仍失败时给出**分类**原因（网络 / 权限 / 文件过大 / 格式不支持 / 服务异常），**不得**暴露凭据或实现细节。
- 五态（等待/上传中/处理中/已上线/失败）保持不变，只补闭环。
- 发布完成提供「去看看」，直达 `#p=<id>`。

**验收**：8MB 以上文件中断后续传上传字节数 < 全量；模拟 2 次失败后第 3 次成功；失败原因落在五类之一；「去看看」定位该照片并打开灯箱。

#### F-02 离线可读（近 3 个月）

**在**设备离线时，系统**必须**能用缓存的 manifest 与近 3 个月缩略图完成浏览。

- Service Worker **只**缓存 manifest + 近 3 个月 `thumb`（不含 `grid`/`orig`，控制体积）。
- 缓存体积上限 **≤80MB**（O-05 已定）；超限时按「最近优先」淘汰，**不得**为凑满额度扩大缓存范围。
- **不是 PWA**：不加 Web App Manifest、不加「添加到主屏幕」、不做安装引导（README 明确要求）。
- **当** `rev` 变化时，系统**必须**使旧缓存失效，否则会看到已删除照片。

**验收**：断网后近 3 个月可浏览缩略图并打开灯箱（大图缺失有降级提示）；`rev` 变更后旧条目 100% 失效（抽查已删照片不再出现）；未注册 SW 的浏览器行为不变。

### 2.6 媒体与场景 / Media and scenes

#### FR-09 U-02 灯箱上下文

**当**灯箱打开时，系统**必须**展示同月其他照片的横向条，以及该照片的识别标签 chips。

- 标签 chips 可点即搜（进入 FR-05 结果视图）。
- 移动端（<640px）默认收起缩略图条，可展开。
- **粒度红线**：公开产物不含具体拍摄时刻，因此**只做「这个月」**，不做「这天还拍了 N 张」。见 §4 不变量 6。

**验收**：同月照片可横向滑动并有预取；点 chip 进入该标签结果视图；390px 宽下缩略图条默认不占首屏高度。

#### U-08 视频与 Live Photo

**当**用户打开视频时，系统**必须**提供时长角标、进度条与拖动、全屏、单条重播。

- 时长在**构建期**写入 manifest，前端不现场探测。
- 网格角标显示时长（如 `0:38`），不再只有 ▶。
- `poster` 优先加载。
- Live Photo：**若**尚无实况数据，本期只按视频处理，**不承诺**实况播放。

**验收**：40s 视频可拖到任意位置、可全屏、播完可重播；角标显示真实时长；无时长字段时回退 ▶。

#### U-07 照片墙 2.0

**当**照片墙启动时，用户**必须**能在四个互斥播放源中选择，且停留节奏由内容决定。

- 播放源：全部 / 精选（含 FR-07 的每月精选）/ 某一年 / 某相册，四项互斥。
- 停留节奏：视频播完再走（不硬切断）；人像比空景多停 1–2s；连拍/近似照片只播一张。
- 「精选」源读取 FR-07 静态产物。

**验收**：四个源切换后队列符合预期；视频不被中途切断；同一连拍近似照片一轮内只出现一次；精选为空时回退「全部」并提示。

**说明**：现状 `wall.js: buildQueue()` 已会混入「往年同月 + 最近 24 张 + 其余随机」，本项补的是**播放源、停留节奏、与策展联动**，不推翻既有混排。

### 2.7 视觉与可访问性 / Theme and accessibility

#### U-04 暗色模式

**在**用户选择「跟随 / 浅色 / 深色」时，系统**必须**应用并持久化该选择。

- 跟随 `prefers-color-scheme`；手动三档；存 `localStorage`。
- **覆盖范围（O-07 已定）**：浏览页、灯箱、**照片墙**、**上传面板**、故事、年度页、空状态与错误态**全部**覆盖，**不得**只改首页而留下一半亮色残留。
- **照片本身不得加滤镜、不得压暗、不得调色**（红线）。照片墙既有的夜间自动调暗是**场景行为**（亮度），与本项**主题**（配色）相互独立、都要保留；两者叠加时仍**不得**对照片像素施加滤镜。
- `color-scheme` meta 与 `theme-color` **必须**同步切换（现状写死 `<meta name="color-scheme" content="light">`）。
- 对比度：正文、年月标签、`mono` 小字均 ≥4.5:1，**必须实测**而非看图判断。
- 前置工作：`style.css` 中分散的颜色字面量需先抽为变量，这是本项主要工作量。

**验收**：三档切换后刷新保持；`color-scheme` meta 随档位变化；照片区域 CSS 无 `filter`/压暗 `opacity`；抽查 6 组前景/背景对比度全部 ≥4.5:1；六处界面（浏览 / 灯箱 / 照片墙 / 上传 / 故事 / 年度页）逐屏核对无亮色残留。

### 2.8 支撑件 / Supporting work（O-01 已定：纳入 V6）

这两条不是用户可感知的功能，但 FR-03 的四态判定与 FR-04 的 380 词都建立在它们之上；不进本轮，等于把地基留给下一版。

#### FR-13 词表单一来源

**当**前端或服务端需要可搜词时，系统**必须**从同一份词表数据读取，**不得**在代码中硬编码。

- 现状：`LEXICON` 在 `src/web/js/search.js`（13 词）与 `src/server/search/vocabulary.mjs`（服务端另一份）各存一份，必然漂移。
- 单一来源形态：一份数据文件；前端在构建期内联，服务端直接读取；两侧**不得**各自维护同义关系。
- 与 FR-04 的关系：FR-04 要把词量扩到 ≥300，若不同时收敛来源，等于**放大**漂移。

**验收**：修改词表一处后两侧同时生效（差异检测 = 0）；代码中不存在第二份 `LEXICON` 字面量；CI 有一项断言检查两侧一致。

#### FR-14 体积与性能预算进 CI

**当**构建产出前端资产时，CI **必须**校验体积与首屏性能预算，超限使构建失败。

- 预算：JS+CSS gzip ≤120KB；桌面 Lighthouse LCP ≤2.5s。
- **门禁分工（Plan 阶段 C-4 修正）**：gzip 体积是**确定性指标**，进 CI 硬门禁；LCP 依赖真实图片、CDN 与网络，CI 环境测出来没有意义，改为**每次发布后实测并记入验收矩阵**，不作为 CI 阻断条件。
- 基线由 FR-01 重建后的首页确立，**不得**沿用重建前的旧基线放水。
- 超限**必须**失败并给出超出量与主要贡献模块，不只是告警。
- 与 FR-04 的关系：词表内联会增大 bundle，需有预算兜底，否则"扩词"会悄悄吃掉首屏。

**验收**：人为超限（例如临时引入 200KB 依赖）时 CI 失败并定位模块；正常构建在预算内通过；LCP 在每次发布后实测并留档（含测试环境、网络条件、取值）。

---

## 3. 非目标 / Non-goals

以下条目**明确不做**，且不因为"顺手"而夹带进 V6 任意切片：

| 条目 | 不做的理由 |
| --- | --- |
| **U-09 浏览器上传** | 攻击面最大的一条；先把端侧闭环（FR-10）做扎实 |
| **星标 / 收藏** | 需要新的写入路径与状态管理，与本版"零新写路径"取向冲突 |
| **数据健康页** | 偏运维，信息价值不应占用浏览端首屏 |
| **F-03 存档导出（本机 zip + 静态 HTML）** | 用户已决定不做 |
| **在线签名分享链接** | 与"不改变公开浏览模型"冲突 |
| **人脸聚类 / 人物页** | 有状态 + 生物特征，与"无数据库"直接冲突，需独立隐私评审 |
| **OCR 文字检索** | 非 GenAI 范畴；可作 G1 后的搭头单议 |
| **G2 说人话搜索** | 决策 D3 明确本阶段不做 |
| **标签人工纠正** | 决策 D5：降为 V6.2 可选单点入口，不在本版范围 |
| **可点 HTML 原型** | 决策 D6 |
| 账号体系 / 数据库 / SQL / 常驻服务器 | 形态红线，见 §4 |
| 放宽 EXIF/GPS/设备/原始文件名/精确时刻脱敏 | 见 §4 不变量 1、6 |
| 重做视觉设计系统 | 沿用 V5 非目标 |
| 为凑验收往私人相册塞非个人照片 | 沿用 backlog B-06 结论 |

**延后但不否决 / Deferred, not rejected**

- **FR-11 C 相似分组**（连拍折叠 `+N`、更多类似）：方向已确认，**O-06 已定：延后到照片数 >1000 张再上**；届时用静态向量文件，不引向量库。
- **FR-12 索引体积与分片**：index gzip ≤300KB，超限按年分片。本期只需监控，不一定实现。

**曾经的延后项，本轮已转为范围（O-01）**：FR-13 词表单一来源、FR-14 体积/性能预算进 CI，见 §2.8。

---

## 4. 硬性不变量 / Hard invariants

1. 站点公开产物不含 GPS、设备序列号、原始文件名或**具体拍摄时刻**。
   *Public artifacts contain no GPS, device serial numbers, original filenames or exact capture timestamps.*
2. 识别失败不能阻塞照片上线；转码/脱敏失败不能生成坏清单条目。
   *Recognition failure must not block publication; transcode/redaction failure must not create broken manifest entries.*
3. 所有新写路径必须有明确的 prefix ownership、IAM owner 和失败落点。
   *Every new write path must have explicit prefix ownership, IAM ownership and a failure sink.*
4. 任何新指标或日志不得包含凭证、令牌、手机号或原图内容。
   *New metrics and logs must contain no credentials, tokens, phone numbers or original image content.*
5. 兼容现有 Android bridge、APK 更新链和 WebView 降级行为。
   *Existing Android bridge, APK update flow and WebView fallback behavior remain compatible.*
6. **粒度不变量（V6 新增）**：不引入"同日 / 同批次"所需的精确时间字段。任何"同一天"的体验诉求都不得以放宽本条为代价。**（O-04 已定：接受"只能做到这个月"）**
   *No field that enables same-day grouping may be introduced; same-day experiences must not be bought by relaxing this invariant.*
7. **生成式不变量（V6 新增）**：生成式能力只处理文本，不上传图片、不引入浏览时外部请求；生成失败必须降级而非失败。
   *Generative features handle text only — no image upload, no runtime external calls, and generation failure degrades instead of failing.*
8. **契约不变量（V6 新增）**：索引/标签/生成产物的新增字段必须进白名单并触发 `INDEX_VERSION` 变更；未声明字段不得进入公开 JSON。
   *New fields in the index, labels or generated artifacts must be whitelisted and bump INDEX_VERSION; undeclared fields must not reach public JSON.*
9. **单一来源不变量（V6 新增）**：前端不得硬编码可搜词表。FR-03 的四态判定与 FR-04 的规模都依赖唯一词表来源。
   *The frontend must not hardcode the searchable vocabulary; both the four-state reasoning in FR-03 and the scale target in FR-04 depend on a single source.*
10. **静态产物不变量（V6 新增）**：每个新静态产物必须有明确 prefix、`rev` 命名 + 固定名回退、以及构建失败时的降级路径。
    *Every new static artifact needs an explicit prefix, rev-based naming with a fixed-name fallback, and a build-failure degradation path.*

---

## 5. 契约与写路径影响 / Contract and write-path impact

**关键判断：V6 不需要新的 S3 prefix、新的 IAM 主体或新的常驻资源。**新增产物由既有构建/发布流程写出，复用站点桶与既有失败 sink。

| 产物 / 变更 | 用途 | 归属 | 性质 | 失败落点 |
| --- | --- | --- | --- | --- |
| `search-index` 的 `labels[].zh` 覆盖率扩容 | FR-04 | 既有 `data/` 前缀 | **仅内容变化**（字段已在白名单，不 bump `INDEX_VERSION`，不改 `ITEM_FIELDS`） | 回退英文标签仍可搜 |
| `data/lexicon.json` | FR-04 词表单一来源 | 站点静态资源 | 新增只读 | 缺失时回退现 13 词 |
| `data/curation.<rev>.json` | FR-07 每月精选 + 一句话 | 站点静态资源 | 新增，构建期产出 | 不渲染策展块 |
| `data/story.<rev>.json` | FR-06 故事文案 | 站点静态资源 | 新增，构建期产出 | 回退硬编码文案 |
| manifest 新增视频 `duration` | U-08 时长角标 | 既有 manifest | 变更（可选字段） | 回退 ▶ 角标 |
| `data/vectors.<rev>.json` | FR-11 相似分组 | 站点静态资源 | **延后** | — |

**明确不新增**：任何拍摄时刻字段、任何用户态、任何数据库、任何 Lambda 之外的常驻计算。

**Android 侧契约**：桥方法名是 `src/web/js/native.js` 中的字面量，靠 `proguard-rules.pro` 保活；A-02 若改动桥方法，必须两侧同时改并同步 `scripts/check.mjs`（8 项断言）与 `npm run verify`。

---

## 6. 分期 / Slices

| 切片 | 内容 | 为什么这样切 |
| --- | --- | --- |
| **V6.0 地基（不可拆）** | FR-01、FR-02、FR-03、FR-04、FR-05、**FR-13、FR-14**、Q-01 | 搜索三件套必须同批上线：只做 FR-04 扩词而不同时修 FR-03，假阳性会从"搜不到"变成"搜错了"，比现状更糟。FR-13 是 FR-04 的前置（否则在放大漂移）；FR-14 必须在 FR-01 落地同批建立基线，否则首页重建后体积悄悄变重。FR-02 的增量渲染是 Q-01 与长流的共同前置。 |
| **V6.1 体验补齐** | P-01、P-02、P-03、U-04、U-05、FR-09、FR-10、U-08 | 都是"用起来顺手"的层，彼此独立、可并行；U-04 依赖颜色变量化改造且按 O-07 覆盖六处界面，工作量集中在此。 |
| **V6.2 情感与场景** | FR-06、FR-07、F-01、U-06、U-07、FR-08、F-02 | 依赖 V6.0 的首页结构与词表；FR-07 与 F-01 共享同一构建产物管线。 |
| **跨仓库（独立）** | A-01 ~ A-05（`album-android`） | A-01 是崩溃修复，**不依赖任何前端改动，应优先单独发布**；A-02 需与 FR-10 协同设计桥契约。 |

---

## 7. 跨仓库说明 / Cross-repo note

`album-android` 的五项需求记在需求清单，不在本 Spec 的 FR 编号内，但与本版有两个硬连接：

1. **A-01 渲染进程兜底**（P0）：覆写 `onRenderProcessGone`，剪枝 + `destroy()` + 重建 WebView + 复位更新检查。现状缺失，渲染进程被回收时整个 App 闪退。与前端改动无关，应先行发布。
2. **A-02 系统分享直传**（P1）：Manifest 加 `ACTION_SEND`/`SEND_MULTIPLE`，`singleTask` 补 `onNewIntent`，桥新增取待处理 Uri 的方法；外部 Uri 必须立刻复制到私有目录或 `takePersistableUriPermission`。**前端复用 FR-10 的分片上传**，因此 A-02 必须在 FR-10 之后或同批。
3. A-03 更新机制（`onResume` 检查 / Wi-Fi 静默预下载 / `minVersionCode`）、A-04 返回键防误触、A-05 冷启动加载态：独立，互不阻塞。

---

## 8. 验收草案 / Draft acceptance criteria

- **首页**：两个目标视口下首屏露出时间流；导航 ≤3 项；无 `#featured`/`.cta`；静态 hero 在 reduced-motion 下无动画。
  *Homepage: the stream is visible above the fold in both target viewports; ≤3 nav items; no featured/CTA blocks; static hero without animation under reduced motion.*
- **搜索**：第五节表格五个查询全部符合期望；`EXAMPLE_QUERIES` 硬编码消失；中文输入法一次输入检索 ≤2 次。
  *Search: all five queries in the table behave as specified; hardcoded examples removed; at most two search calls per IME typing session.*
- **性能**：第 500 张后单次追加 long task ≤50ms；容器节点单调递增；Lighthouse CLS ≤0.1；JS+CSS gzip ≤120KB 且由 CI 强制。
  *Performance: no append-long-task above 50 ms after photo 500; monotonically growing DOM; CLS ≤0.1; JS+CSS gzip ≤120 KB enforced in CI.*
- **支撑件**：改词表一处后前端与服务端同时生效、代码内无第二份 `LEXICON`；CI 在人为超限时失败并定位到模块。
  *Supporting work: one edit to the lexicon changes both sides with no second LEXICON literal; CI fails and names the module when a budget is exceeded.*
- **生成式**：断网下故事、策展、年度页全部可读；同一 `rev` 重复构建幂等；模型不可用时构建成功。浏览过程外部请求数 = 0（Network 面板核对）。
  *Generation: story, curation and year page all readable offline; rebuilds are idempotent per rev; build succeeds without the model; zero external requests while browsing.*
- **隐私**：公开产物通过既有 metadata/redaction 检查；索引 JSON 无白名单外字段；日志与指标扫描无敏感字段；公开 JSON 内不存在拍摄时刻。
  *Privacy: public artifacts pass metadata/redaction checks; no out-of-whitelist fields; no sensitive fields in logs or metrics; no capture timestamps in public JSON.*
- **成本**：新增静态产物的存储与请求成本量化，总量仍 ≤¥15/月；生成式调用只在构建期，按发布次数线性。
  *Cost: storage/request cost of new artifacts quantified, total still ≤¥15/month; generative calls are build-time only and scale with releases.*
- **验收措辞（沿用 backlog B-06）**：语义搜索的验收口径为「对库内实际存在的概念可解释」，**不**要求固定的六个示例词全部命中。
  *Acceptance wording follows backlog B-06: explain ability for concepts actually present, not six fixed example terms.*

---

## 9. 已确认决策 / Confirmed decisions

2026-11-14：O-01 ~ O-07 **全部采纳建议**，本 Spec 无未决项。

| # | 决策点 | 结论 | 落点 |
| --- | --- | --- | --- |
| O-01 | FR-13 词表单一来源 / FR-14 体积与性能预算，是否作为**支撑件**纳入 V6 | **纳入**，进 V6.0 地基 | §2.8、§6 |
| O-02 | FR-04 的中文名「一次性审核入库」还是「每次构建生成」 | **一次性审核入库**；模型只出候选，人工过一遍后固化为资产 | §2.3 FR-04 |
| O-03 | P-02「最近更新」在 manifest 无发布时间时的处理 | **降级为只显示张数**，不为它新增写入路径 | §2.2 P-02 |
| O-04 | FR-09 的粒度红线 | **接受"只能做到这个月"**，不放宽不变量 6 | §4 不变量 6、§2.6 FR-09 |
| O-05 | F-02 离线缓存体积上限 | **≤80MB**，超限按「最近优先」淘汰 | §2.5 F-02 |
| O-06 | FR-11 C 相似分组是否随 V6 交付 | **延后**到照片数 >1000 张；方向保留不丢 | §3 延后项 |
| O-07 | U-04 暗色模式的覆盖范围 | **覆盖六处界面**（含照片墙、上传面板），不留亮色残留 | §2.7 U-04 |

---

## 10. 下一步 / Next step

本 Spec 已于 2026-11-14 确认（O-01~O-07 全部采纳建议）。**Plan** 阶段产出：

1. 首页方案 C 的组件拆分与状态机（含 `main.js` 的 tab/筛选缺陷修复方案）；
2. 搜索三件套的数据流：词表单一来源（FR-13）、四态判定、AND 语义、建议词生成算法；
3. 增量渲染改造方案（`gallery.js`），与 Q-01 防抖共用渲染入口的具体接口；
4. 三个构建期生成产物（lexicon / curation / story）的管线、幂等性、失败降级；
5. 契约变更清单（`INDEX_VERSION`、`ITEM_FIELDS`、manifest 字段）与原样回滚路径；
6. 词表收敛路径与 CI 门禁设计（FR-13 / FR-14 的落地方式、基线取值、超限时的失败信息）；
7. 分期依赖图与成本模型；
8. 验收矩阵草表（条目 → 证据 → 判定人）。

*This spec was confirmed on 2026-11-14 with all of O-01~O-07 adopted. The Plan stage will deliver the homepage component split and state machine, the search data flow including lexicon consolidation, the incremental rendering refactor, the three build-time generation pipelines, the contract change list with rollback, the CI budget gate design, the slice dependency graph and cost model, and a draft acceptance matrix.*

---

## 11. 修订记录 / Amendments

### 2026-11-14 Plan 阶段技术修正（C-1 ~ C-6，全部采纳）

Plan 阶段读代码后发现本文有 6 处技术假设与实际不符。以下改动已就地落进上文，记在此处便于追溯：

| # | 原文假设 | 代码实测 | 落地改动 |
| --- | --- | --- | --- |
| C-1 | 新增 `labels[].zh` 需 bump `INDEX_VERSION` | `LABEL_FIELDS` 已含 `zh`，`rekognition.mjs` 已在填 | §2.3 FR-04、§5：**不 bump、不改 `ITEM_FIELDS`** |
| C-2 | 需要 `weakLabels` 两级标签 | `minConfidence = 70`，55–70 区间根本不产出 | 取消两级标签，§5 不再列 `weakLabels` |
| C-3 | 未规定 `zh` 在哪一步解析 | 现于识别期在 Lambda 内计算 | §2.3 FR-04：**下移到索引构建期** |
| C-4 | LCP 进 CI 门禁 | CI 无真实图/CDN，指标无意义 | §1.2 S-8、§2.8 FR-14：gzip 硬门禁，LCP 发布后实测 |
| C-5 | 导航 ≤3 项 **且** 上传保持既有位置 | 上传按钮在导航内，二者互斥 | §2.1 FR-01：**上传入口移到页脚**，保 ≤3 项 |
| C-6 | 只约束词表单一来源 | `scoreItem` 前后端各一份，`parseQuery` 也是两处 | §2.8 FR-13 外，Plan §3 追加一致性单测要求 |

**未改动**：需求条目、验收口径、硬性不变量 1–5/7/9/10 均不变。不变量 8（新增字段须进白名单并触发版本变更）保留为**条件式**约束——本期恰好无需触发。
