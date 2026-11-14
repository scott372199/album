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

---

> 处理约定 / Convention：以上四条全部推迟到 V6 spec 阶段统一定义方案与优先级，
> V5 不做任何改动。All four are deferred to the V6 spec phase; V5 makes no
> changes for them.
