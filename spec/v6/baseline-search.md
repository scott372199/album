# V6 检索现状实测基线 / Measured search baseline

> 2026-11-14，用 `album@main` 的 `src/web/js/search.js` 直接跑**生产索引**
> （`s3://chenyouyi/data/search-index.json`，47 条 item / 34 张有标签，`INDEX_VERSION=v5.1.0`）。
> 语料与代码都是真实的，不是合成夹具。
>
> *Measured against the production index with the repo's own search module.*

---

## 1. 查询实测 / Query behaviour

| 查询 | `total` | 解析出的 term | 判定 |
| --- | --- | --- | --- |
| `灰色` | **47** | `[]` | ❌ 全量假阳性（库里 34 张被识别成 `grey`，却搜不到） |
| `显示器` | **47** | `[]` | ❌ 全量假阳性 |
| `小孩` | **47** | `[]` | ❌ 全量假阳性（`child` 24 张、`boy` 24 张，却搜不到） |
| `人物` | **47** | `[]` | ❌ 全量假阳性（`person` 33 张） |
| `湖水` | 2 | `["lake"]` | ✅ 命中 |
| `衬衫` | 18 | `["shirt"]` | ✅ 命中 |
| `汽车` | 3 | `["car"]` | ✅ 命中 |
| `湖水 汽车` | **5** | `["lake","car"]` | ❌ 并集（`lake` 2 张 + `car` 3 张 = 5；交集应为 0） |
| `2025 年` | 0 | `[]` | ✅ 空（语料无 2025 年照片） |

**结论：现状不是「搜不到」，是「很自信地搜错」。** 词表外查询返回全量，界面显示 47 张，
`fromIndex=true, degraded=false`，用户看不出任何异常。

---

## 2. 标签中文名覆盖 / Chinese-name coverage

审计报告见 [`term-audit.md`](./term-audit.md)。

| 指标 | 值 |
| --- | --- |
| distinct term | **118** |
| 有**真中文名** | **12** |
| 缺中文名（`zh` 是英文占位） | **106**（占 89.8%） |

**根因不是没做识别，而是两层同时断**：

1. `zhForTerm(term)` 的兜底是 `TERM_ZH[term] || term` —— 查不到中文名时**把英文 term 回填进 `zh`**，
   于是"有没有中文名"这件事在数据上永远为真，掩盖了 106 个词根本没中文名。
2. 即使有中文名，前端 `LEXICON` 只认 13 个中文词，用户想搜的词大多不在里面。

12 个有真中文名的 term（含张数）：
`black` 25 · `blue` 22 · `shirt` 18 · `green` 13 · `red` 12 · `yellow` 12 ·
`car` 3 · `transportation` 3 · `white` 3 · `lake` 2 · `nature` 1 · `outdoors` 1

**三个高价值缺口**：`grey`(34 张)、`brown`(28 张)、`pink`(7 张) 都被识别出来了，
但没有中文名 → 「灰色 / 棕色 / 粉色」三个最常用的颜色词全部搜不到。

---

## 3. V5 六示例的结论被证实 / B-06 confirmed

`摩托车`、`山峰`、`蓝天` 三个词**在 106 个 term 之外**——不是词表缺，是**语料里真没有**。
这与 `spec/v6/backlog.md` B-06 的判断一致：私人相册没有对应内容，属于事实，
不应该为凑验收往库里塞非个人照片。

---

## 4. 对 V6 的两个直接修正 / Impact

1. **FR-04 的工作量集中在「106 个词补中文名」**，不在识别侧。识别已经足够细
   （47 张照片产出 118 个不同 term），缺的是命名层。
2. **`zh` 不能再用「非空」判断有没有中文名**。`term-audit.md` 的判定已改为
   「含汉字且不等于 term」，PM 与技术看同一份数字，避免再被占位值骗一次。

---

## 5. 复现方式 / Reproduce

```bash
aws s3 cp s3://chenyouyi/data/search-index.json data/   # data/ 已在 .gitignore
node scripts/audit-terms.mjs --out spec/v6/term-audit.md
```

查询实测的脚本见本次提交说明；它只用 `parseQuery` + `runSearch`，不触网、不碰 DOM。
