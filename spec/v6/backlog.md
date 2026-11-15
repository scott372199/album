# V6 产品优化 Backlog / V6 Product Optimization Backlog

> 来源 / Source：V5 验收时用户反馈（2026-11-14）。仅记录需求，方案待 V6 spec 阶段细化。
> Captured during V5 acceptance (2026-11-14). Requirements only; solutions to be
> refined in the V6 spec phase.

---

## B-01 搜索结果位置 / Search results placement

**中文 / Chinese**
搜索框在右上角，但搜索结果渲染在 hero 灯箱与精选内容之下，需要滚动多屏才能看到结果，体验差。V6 需要让搜索结果「触手可及」（例如：聚焦搜索时收起 hero/精选，或结果置顶，或进入独立结果视图）。

*English*
The search box sits top-right, but results render below the hero lightbox and
featured sections — users must scroll several screens. V6 should make results
immediately visible (e.g. collapse hero/featured on focus, pin results to the
top, or switch to a dedicated results view).

## B-02 可选关键词不透明 / Unknown search vocabulary

**中文 / Chinese**
用户不知道能搜什么词：`摩托车`（词表内但库里无此内容）、`橡皮泥`、`电脑`（词表外）都搜不到，且没有任何提示。V6 需要：搜索建议/词表提示（基于当前索引 vocabulary 与实际命中的标签）、空结果时解释「为什么没结果、有哪些词可试」。

*English*
Users have no way to discover searchable terms: `摩托车` (in vocabulary but no
such content), `橡皮泥` and `电脑` (outside the vocabulary) all fail silently.
V6 needs search suggestions / vocabulary hints (driven by the index vocabulary
and actually-hit labels) plus empty-state explanations.

## B-03 首页信息密度过高 / Homepage clutter

**中文 / Chinese**
首页同时有 hero 灯箱、时间轴、全部照片多个区块，内容太乱、层次不清。V6 需要重新规划首页信息架构（明确主视觉、明确浏览动线，各区块按需出现）。

*English*
The homepage stacks hero lightbox, timeline and the full photo grid at once —
cluttered and unlayered. V6 should re-plan the homepage information
architecture (clear primary visual, clear browsing path, sections on demand).

## B-04 顶部导航体验 / Top navigation experience

**中文 / Chinese**
顶部菜单（个人相册 / 时间轴 / 相册 / 故事 / 照片墙 / 搜索）点击后的使用体验不佳（具体交互问题待 V6 梳理：如视图切换是否丢失上下文、当前态指示、返回行为等）。

*English*
Clicking the top nav items (相册 / Timeline / Albums / Story / Wall / Search)
feels poor (exact interactions to be surveyed in V6: view-switch context loss,
active-state indication, back behaviour, etc.).

## B-05 词表外关键词静默返回全量 / Out-of-vocabulary terms return everything

**中文 / Chinese**
2026-11-14 端到端实测发现：搜索「显示器」（词表外）返回 `total=48`，即当前索引内全部
照片，且 `fromIndex=true, degraded=false`，界面上看起来像「搜中了」，实则没有做任何
语义过滤。B-02 的「词表不透明」不只是空结果体验问题，还会制造假阳性。V6 需要：
未知词显式提示「未收录」并给出可搜词建议；未知词不得退化为全量返回；空结果与
未收录词要区分开。

*English*
The 2026-11-14 end-to-end run showed that an out-of-vocabulary query (`显示器`)
returned `total=48` — the entire index — with `fromIndex=true, degraded=false`,
i.e. a silent false positive rather than a filtered result. B-02 is therefore not
only about empty states: V6 must explicitly flag unrecognised terms, suggest valid
ones, never degrade to an unfiltered full list, and distinguish "no matches" from
"term not in vocabulary".

## B-06 六示例语料覆盖与验收口径 / Six-example corpus and acceptance wording

**中文 / Chinese**
2026-11-14 用户明确「留到 V6 再优化」：`V5-ACCEPTANCE.md` blocker #1 要求六个语义示例
（含 `摩托车`、`红色衬衫`）都返回可解释结果，但私人相册里根本没有对应内容，属语料事实。
V5 只保留「脱敏派生图产出识别标签 + 可解释查询」的证据，六示例全命中作为用户批准的
例外记入 T-32。V6 需要同时处理：词表与实际标签的可见性（B-02）、未知词不返回全量（B-05）、
以及验收措辞改为「对库内实际存在的概念可解释」而非要求固定六个词。不要为了凑验收
往私人相册塞非个人照片。

*English*
On 2026-11-14 the user deferred this to V6. Blocker #1 asks for six fixed semantic
examples, but the private album simply contains no motorcycle or red-shirt photos —
a corpus fact. V5 keeps the redacted-derivative and explainable-query evidence and
records the six-example gap as a user-approved exception at T-32. V6 should align
vocabulary visibility (B-02), stop full-list false positives (B-05), and reword the
acceptance criterion around concepts actually present in the library. Never pad the
private album with unrelated stock photos just to pass a check.

## B-07 一键拉起/销毁 ≤ 60 秒 / One-click up/down within 60 seconds

**中文 / Chinese**
2026-11-15 用户明确提出性能期望：管理站的**一键拉起与一键销毁都要在 1 分钟内**完成，
作为 V6 优化点；V5 不实现，只记录目标与约束。实测基线（五次生命周期，逐层时间戳见
`spec/v5/V5-FULL-ACCEPTANCE-PLAN.md` §4.4）：拉起冷启动 **6m35s**、重复拉起 **2m24s**，
销毁 **11m44s / 11m42s**。`album-infra` PR #22 的快路径（跳过常驻层、并行 init、
关站不等 CDN 部署）预计把重复拉起降到约 1m20s、关站降到约 9m，**仍远达不到 60 秒**。

根因是**架构级**而不是编排级：ECS Express Gateway Service 的删除稳定耗时
7m58s~8m4s（占关站约 68%），创建侧 ALB / EFS 挂载点各 1~2 分钟；Terraform 只能等
AWS 控制面返回。V6 需要改变「关站 = 销毁全部运行时」这个模型，候选方向：

1. **缩容到 0 而不删除 / Scale to zero**: 用 `update-express-gateway-service
   --scaling-target` 把副本降到 0、保留服务定义；先验证 Terraform provider 是否支持、
   零副本是否仍计费、以及扩容回 1 的耗时。
2. **运行时常驻 + 只切流量 / Keep runtime, switch traffic**: CloudFront 分发已常驻
   （PR #17），关站可只把分发 disabled；计算层保留最小副本或按需唤醒。需重新评估
   每月费用与 T-31 安全边界（源站公网直连仍是已知风险）。
3. **拆掉冷启动重资源 / Drop heavy cold-start resources**: Grafana 观测栈
   （ALB + EFS + ECS service）改为按需拉起、默认不进生命周期，冷启动可再省约 2 分钟
   并省下 ALB 费用。
4. **验收口径 / Acceptance metric**: 分别记录「触发 → 站点可登录」与
   「触发 → 持续计费停止」两个 P95，两者都 ≤60s 才算达标；**不要用
   「workflow 显示 success」冒充用户可感知的时间**。

*English*
On 2026-11-15 the user set a performance target: one-click up **and** down must both
finish within 60 seconds. V5 records the goal but does not implement it. Measured
baselines: cold up 6m35s, repeat up 2m24s, down 11m44s / 11m42s. The fast path shipped
in `album-infra` PR #22 should bring repeat up to ~1m20s and down to ~9m — still far
from 60s. The bottleneck is architectural: deleting an ECS Express Gateway Service
takes 7m58s-8m4s (≈68% of shutdown), and ALB / EFS mount targets cost 1-2 minutes
on creation. V6 must move away from "shutdown = destroy all runtime": scale the
Express service to zero instead of deleting it (verify provider support, idle cost
and scale-up time), keep a minimal runtime behind the already-persistent CloudFront
distribution, and make the Grafana stack opt-in. Acceptance must measure two P95s —
trigger→site sign-in and trigger→billing stops — both ≤60s; a green workflow is not
a user-perceived timing measurement.*

---

> 处理约定 / Convention：以上七条全部推迟到 V6 spec 阶段统一定义方案与优先级，
> V5 不做任何改动。B-07 是**性能目标**，与 B-01~B-06 的产品体验项分开排期。
> *All seven are deferred to the V6 spec phase; V5 changes nothing for them.
> B-07 is a performance target and should be scheduled separately from the
> product-experience items B-01–B-06.*
