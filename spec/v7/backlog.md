# V7 产品优化 Backlog / V7 Product Optimization Backlog

> 来源 / Source：V6 第二～四轮验收（2026-11-16）中与产品方向有关的讨论，以及 V6 收尾时
> 明确结转的遗留项。仅记录需求与证据，**方案待 V7 spec 阶段细化**；未定案前不要照着某一条
> 直接写代码。/ Captured during V6 acceptance rounds 2–4 and the V6 closure carry-over;
> requirements and evidence only, solutions to be refined in the V7 spec phase.
>
> 状态 / Status：V6 已于 2026-11-16 收尾（见 [`spec/v6/V6-ACCEPTANCE.md`](../v6/V6-ACCEPTANCE.md)），
> 本文件是下一迭代的**唯一需求入口**。B-01~B-06 之间没有优先级顺序，B-05、B-06 对用户日常
> 使用的影响最大。
>
> **2026-11-16 更新 / Superseded**：B-01~B-06 已全部落入 [`spec.md`](./spec.md) v1.0 的 FR 编号（追溯表见其 §0.1）。
> 此后**需求以 `spec.md` 为准**，本文件转为历史入口，不再单独维护；新的诉求请先写进 spec 的开放问题，不要在本文追加条目。
> *All six items now live in spec v1.0; the spec is authoritative from here on.*

---

## B-01 人物时间线 / Per-person timelines

**中文 / Chinese**
相册里目前有 39 张光识别出「人物」。长辈真正想看的是「这孩子一年一年怎么长大的」，
而不是「这个月有几张照片」。V7 需要：把人物（先只做主角一人，不给所有人建档案）
从「可搜的标签」升级为「可翻的时间线」——按人物筛选后，用同一条时间轴连续展示，
并在时间轴上加年龄刻度（复用手写的月龄文案），让人一屏之内看见「长大」这件事。

**约束 / Constraint**：不做人脸建档、不做人物命名与合并；识别结果里没有姓名，
就不要假装有。 / No face enrolment, no naming or merging of people: if the
recognition output has no names, do not pretend it does.

*English*
39 photos currently resolve to the `person` label. Grandparents want "how did he
grow, year by year", not "how many photos this month". V7 should upgrade a person
from a searchable tag to a browsable timeline, reusing the month-age labels.

---

## B-02 成长里程碑 / Growth milestones and yearbook export

**中文 / Chinese**
现在的「一句话」是按月说的，但成长不是均匀发生的：第一次走路、第一次自己吃饭、
第一次站着拍照，这些瞬间才值得被单独记住。V7 需要：① 里程碑层，允许为某几张
照片标注「第一次……」，在时间轴上打点并在结束语里点名；② 年度纪念册导出，把
选定年份的时间轴 + 每月一句 + 里程碑排成一份可打印的 PDF，能让长辈存下来、
发出去。导出要**离线可生成**，不依赖云端渲染。

*English*
Monthly lines are uniform, but growth is not: first steps, first self-fed meal.
V7 needs a milestone layer plus a printable yearbook export (offline, no cloud
rendering).

---

## B-03 V6 遗留：标签与文案的收尾 / Leftovers from V6

**中文 / Chinese**
本轮修掉了 124 条「中文名其实是英文」的标签，但仍剩 6 个词只有英文：
`fitness`、`pilates`、`sport`、`cyan`、`herbal`、`herbs`。它们要么进词表补中文名，
要么判定为「不值得展示」而不再作为可点标签出现——两者选一，不要留着。
另外生产环境的 `story.json` / `curation.json` 里 `sentence` 全是 `null`
（构建机没有模型凭证），所以章节卡与结束语走的是派生逻辑；V7 需要把文案生成
接进发布流水线，或者在明确「就用派生文案」之后把生成路径删掉。

*English*
Six English-only labels remain (`fitness`, `pilates`, `sport`, `cyan`, `herbal`,
`herbs`); and every generated `sentence` is `null` in production because the build
has no model credentials — either wire generation into the pipeline or delete it.

---

## B-04 V6 遗留：体积预算的真实解法 / The real fix for the JS budget

**中文 / Chinese**
本轮把 JS+CSS 预算从 128 KB 上调到 132 KB（第二次上调）才把「生长刻度」装进去。
预算门禁量的是**含注释的源码**，注释占了不小比例。真实解法是构建期剥注释再量，
这样预算约束的是「发给用户的字节」，而不是「写在仓库里的字节」。再继续上调预算
只会让门禁变成摆设。

*English*
The budget was raised again (128 → 132 KB) to fit the growth-scale work. The gate
measures source *including comments*; the real fix is to strip comments at build
time so the budget constrains what users download.

---

## B-05 「相册」到底是什么 / What an album even is

**中文 / Chinese**
用户原话：「相册里面 2026 和未分类，我发现对相册的定义很模糊，这个相册的定义有什么用？
我在上传时要我填相册，其实我是不知道选什么相册的，它能帮助我怎么管理这个站点？有其他
更好的办法，不要让我选上传什么相册。」

现状（2026-11-16 线上）：`albums = [{2026: 51}, {未分类: 2}]`。原因是——
- 上传页「放进哪个相册」默认填**当前年份**（`src/web/js/upload.js:180`），所以绝大多数照片
  落在 `2026`；服务端兜底写 `未分类`（`src/server/processor/derive.mjs:43`），那 2 张就是
  兜底的结果。
- 索引又把 `album` 塞进 `tags`，于是「标签」栏也变成 `[相册名, 年份]`（这条已在 V6 第二轮
  用 `usefulTags()` 处理掉：不够两个有效值就整栏隐藏）。
- 结论：**「相册」现在只是「年份」的副本**，外加一个「未分类」垃圾桶。它不承担任何
  「管理」职责，却在上传时向用户要一次决策——这次决策是纯粹的成本。

**待讨论的三个方向（不要再叠第四种）**
1. **去掉它**：上传不再问相册，导航里不再有「相册」入口，`album` 字段只留在数据里不对外
   表达。代价＝以后想做策展要重新设计。
2. **改成自动分组**：不让人填，按拍摄时间的连续性自动切段（「11 月 · 周末出门」），名字由
   时间与地点生成，不可手改。
3. **保留但设门槛**：沿用 V6 已确立的规则——**有效值不足两个就整栏隐藏**；只有用户真的
   建了 ≥2 个具名相册时才出现。等于「默认看不见，需要时再用」。

倾向：短期按 1 收掉上传的决策成本，同时保留 3 的隐藏规则作为过渡；2 留给「策展」这个
V8 话题。**在定下来之前，不要再往上传表单里加任何需要用户思考的字段。**

*English*
Albums are currently just a copy of the year (`2026`: 51, `未分类`: 2 — the upload form
defaults to the current year and the server falls back to `未分类`), so the upload page
asks the user to make a decision that carries no information. Either drop the concept,
generate groups automatically, or keep it but hide it until two real named albums exist.

---

## B-06 「每月一句话」的语感 / The voice of the monthly line

**中文 / Chinese**
用户原话：「src/web/js/family.json 这里每句话都很生硬。」——说得对，而且能说清为什么生硬：

现在这 9 句都是**记录者的口吻**，写的是「我拍了什么 / 数据为什么是这样」，不是「孩子身上
发生了什么」。长辈要读的是孩子，不是拍摄日志。

| 现在（记录者） | 问题 | 讨论候选（看孩子） |
|---|---|---|
| 第一次注意到，他的头发变长了 | 「第一次注意到」是观察者的动作 | 头发长到能扎起来了 |
| 整月只留下一张，正是他笑的那张 | 在解释数据为什么少 | 这个月只拍了一张，正好在笑 |
| 拍得最多，还多了个小女孩 | 统计口吻 | 这个月最热闹，还多了个一起玩的小伙伴 |
| 第一次拍到他端着自己的碗 | 仍然是「拍到了」 | 会自己端着碗吃饭了，端得很稳 |

**可以写进规矩的判据**（V7 定稿时用来自检，比「读起来温不温柔」可执行）：
1. 主语优先是孩子，其次是他身上的东西；**不出现拍摄者**（我/拍到/注意到/记录）。
2. 不解释数据（张数多少、为什么只有一张）——那是产品指标，不是生活。
3. 一句话只放一个具体动作或一个具体物件，不放形容词堆砌。
4. 长度仍受卡片排版限制（现在 10–26 字）：温柔不等于长。
5. 允许留白与平淡。真实的一句「这个月没拍什么」，比一句抒情更可信。

*English*
All nine lines are written from the photographer's point of view ("first time I noticed",
"took the most this month") — they narrate the shooting log, not the child. V7 should
rewrite them with the child as the subject, and adopt the five checks above so the voice
does not drift back into ad copy.

