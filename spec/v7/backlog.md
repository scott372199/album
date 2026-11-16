# V7 产品优化 Backlog / V7 Product Optimization Backlog

> 来源 / Source：V6 第二轮验收（2026-11-16）中与产品方向有关的讨论。仅记录需求，
> 方案待 V7 spec 阶段细化。 / Captured during V6 round-2 acceptance; requirements
> only, solutions to be refined in the V7 spec phase.

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
