# 个人相册 · 第三版任务分解（tasks v3）

> Spec-Driven Development · 阶段 3 / 5（Tasks）
> 状态：**执行中（P0–P5 已完成，P6 收尾）**　|　版本：v3.1　|　日期：2026-11-10
> 上游：`spec/v3/spec.md` v3.1（已确认）、`spec/v3/plan.md` v3.1（已确认）
> 说明：本文件把 plan 拆成可独立验收的任务。**编号 T-01 起，与 v1/v2 的 T 编号无关。**

---

## 0. 起点状态（开工前）

| 项 | 状态 |
| --- | --- |
| v2 站点 | 已发布到 S3 临时预览（HTTP），CloudFront 分发仍被账号验证阻塞 |
| 工作树 | 无 git 仓库；`dist/` 存在；`photos/` 25 张 JPG + 1 条 MOV |
| 依赖 | Node 22.22.2、sharp、exifr、ffmpeg/ffprobe、macOS `sips` |
| GitHub | 远端 `git@github.com:scott372199/albumn.git`；专用密钥 `~/.ssh/id_rsa_github`（RSA 3072）已生成，**公钥待添加到账号** |
| 视频素材 | `photos/2026/IMG_2265.MOV`（3840×2160、rotation −90、30.37s、164MB、含 GPS/机型/时间戳） |

---

## 1. 阶段与依赖

```
P0 仓库治理      T-01 → T-02
P1 构建层        T-03 → T-04 → T-05 → T-06 → T-07 → T-08
P2 前端骨架      T-09 → T-10
P3 栅格与媒体    T-11 → {T-12, T-13}
P4 叙事与常驻    {T-14, T-15, T-16}
P5 动效与部署    T-17 → T-18 → T-19
P6 集成与发布    T-20 → T-21 → T-22
```

关键路径：`T-01→T-02→T-03→T-04→T-05→T-06→T-07→T-08→T-09→T-10→T-11→T-13→T-14→T-15→T-16→T-17→T-19→T-20→T-21→T-22`

可并行：T-03 与 T-04；T-12 与 T-13；T-14 / T-15 / T-16（T-16 需 T-07 产出 `version.json`）；T-17 与 T-18。

**不需要你参与就能做的**：T-01 ~ T-20（全部本地，构建 + 本地 HTTP 预览）。
**需要你参与**：CP-1（加公钥）、CP-2（看视觉）、CP-3（iPad 看照片墙）、CP-4（授权推送）。

---

## 2. 任务清单

### P0 · 仓库治理

#### T-01 初始化仓库与忽略规则
- 依赖：无
- 文件：`.gitignore`
- 内容：
  1. `git init -b main`；按 plan §9.1 重写 `.gitignore`（`photos/**` 而非 `photos/*`）。
  2. 先 `git status --ignored` 确认 `photos/2026/*.JPG`、`IMG_2265.MOV`、`dist/`、`.deploy-state.json` 全在 ignore 列表里。
  3. 首个提交：`chore: 导入 v2 基线`。
- 验收：`git ls-files | grep -Ei '\.(jpg|jpeg|png|heic|heif|webp|gif|mp4|mov|m4v)$'` 输出为空；`git status --short` 干净；`git log --oneline` 恰好 1 条。
- 追溯：FR-11

#### T-02 仓库安检与 README
- 依赖：T-01
- 文件：`scripts/check-repo.mjs`、`scripts/install-hooks.mjs`、`package.json`、`README.md`
- 内容：
  1. 五类规则（媒体扩展名 / >5MB / 密钥特征 / `/Users/<name>/` 绝对路径 / `dist/` 前缀），基于 `git ls-files -z`，逐条输出 `✗ 文件: 原因`，命中即 `process.exitCode = 1`。
  2. `install-hooks.mjs` 写 `.git/hooks/pre-commit`（可重复执行，已存在则覆盖并备份为 `.bak`）。
  3. `package.json` 加 `check:repo`、`hook:install`。
  4. README：是什么、目录结构、命令表、隐私声明（照片与视频不入库、产物不含 GPS/机型/文件名）、为何不用前端框架。
- 验收：干净仓库下 `npm run check:repo` 通过；在根目录放 `test.png` 并 `git add` 后失败且退出码非 0；删除后恢复通过；`npm run hook:install` 后 `.git/hooks/pre-commit` 可执行。
- 追溯：FR-11、FR-18

### P1 · 构建层

#### T-03 站点配置扩展
- 依赖：T-01
- 文件：`src/build/site.mjs`（新）、`site.json`
- 内容：默认值收敛（title / subtitle / hero / featured / wall / story）；`hero` 支持 `"latest-landscape"`、具体 id；`featured` 支持照片 id 与 `album:<名称>`；非法值忽略并 `console.warn`，不让构建失败。
- 验收：空对象 → 全部默认；指定 `hero: "<id>"` → manifest 中 `hero` 等于该 id；`featured` 能解析出 `Set<id>`；坏 JSON 时退回默认且不崩。
- 追溯：FR-17

#### T-04 媒体识别与 Live Photo 配对
- 依赖：T-03
- 文件：`src/build/scan.mjs`
- 内容：扩展名分流 `image | video`；同目录同名 `图片+MOV` 配对为 `live`，id = `sha256(imageHash + videoHash)` 前 12 位；`photos/.albumignore` 对视频同样生效；返回 `{ type, pairedWith }`。
- 验收：当前 `photos/2026`（25 图 + 1 视频）→ 26 条、`type` 各归其位；造一对 `A.HEIC` + `A.MOV` → 1 条 `live`；`.albumignore` 写入视频名后该条消失；纯图目录的 id 与 v2 完全一致。
- 追溯：FR-12

#### T-05 三档图片与 LQIP
- 依赖：T-04
- 文件：`src/build/image.mjs`
- 内容：`thumb` 320w q70、`grid` 768w q76、`view` 2048 长边 q82、`lqip` 24w q40 base64；每档断言无 EXIF；返回 `{thumb, grid, view, lqip, ratio}`。
- 验收：26 条中每张图产出 3 个 webp；抽查 3 张 `sharp(...).metadata().exif` 为 `undefined`；`lqip` 以 `data:image/webp;base64,` 开头；`thumb < 30KB`、`view < 900KB`（2048 竖图）。
- 追溯：FR-16、FR-18

#### T-06 视频探测 / 转码 / 封面 / 断言
- 依赖：T-04
- 文件：`src/build/video.mjs`（新）
- 内容：
  1. `probeVideo()`：读宽高、`side_data_list[].rotation`、时长、是否有音轨、`creation_time` / `com.apple.quicktime.creationdate`；按旋转交换宽高，算缩放后输出尺寸（偶数）。
  2. `transcodeVideo()`：plan §3.4 的命令；`-t 30`；`crf 23`；超 20MB 用 `crf 28` 重试；仍超则 `degraded`。
  3. `makePoster()`：`-ss min(1, duration/3)` 抽帧 → sharp 出 1280w `poster.webp` + LQIP。
  4. `assertCleanVideo()`：再 probe，检查 `format.tags` / `stream.tags`，禁止 `location`、`com.apple.*`、`creation_time`、`make`、`model`、`software`；失败抛错终止构建。
- 验收（用 `IMG_2265.MOV`）：输出 `clip.mp4` 为 **1080×1920**、时长 **30.0s ±0.5**、体积 **< 20MB**；`ffprobe` 产物无上述标签；`poster.webp` 存在且无 EXIF；年月解析为 **2026-10**；`report.videoSeconds ≈ 30`。
- 追溯：FR-12、FR-18

#### T-07 媒体分发与产物编排
- 依赖：T-05、T-06
- 文件：`src/build/media.mjs`（新）、`src/build/build.mjs`
- 内容：按类型分发；`build` 流程按 plan §3.1；`web/js/` 目录哈希复制；写 `data/version.json`（`rev` = manifest 内容哈希）；报告新增 `videos / livePairs / videoSeconds / videoBytes / galleryBytesEstimate / manifestBytes`；清理 `dist/photos/<id>` 时同时清理视频目录。
- 验收：`dist/` 结构与 plan §2.1 一致；`version.json.rev` 与 manifest 文件名中的哈希相同；**二次构建全部跳过且三份哈希不变**；`report` 含上述全部字段。
- 追溯：FR-14（热更新）、FR-16

#### T-08 manifest v3
- 依赖：T-07
- 文件：`src/build/manifest.mjs`
- 内容：字段白名单；`type` / `poster` / `src` / `duration` / `lqip` / `featured`；`albums[].coverType`；顶层 `hero`；**禁止** `srcPath`/`rel`/`mtime`/`size`/`day`/`hasAudio`。
- 验收：`grep -E 'srcPath|"rel"|mtime|"size"|"day"' manifest.json` 无命中；`live` 条目同时有 `view` 与 `src`；同一输入连续两次构建 manifest 字节完全相同。
- 追溯：FR-18、FR-17

### P2 · 前端骨架

#### T-09 模块拆分与目录哈希接线
- 依赖：T-07
- 文件：`src/web/js/{main,state,data,gallery,lightbox,story,wall,motion,update,ui}.js`、`src/web/index.html`、`src/build/build.mjs`
- 内容：把 v2 的 `app.js` 能力按 plan §2.2 迁入模块；`state.js` / `data.js` 不碰 DOM，导出 `buildHash` / `parseHashString` / `computeEditorialRows` / `buildStory` / `filterPhotos`；`index.html` 引用 `assets/js.<hash>/main.js`。
- 验收：首页无 console 错误；v2 的**时间轴 / 相册 / 筛选 / 空状态 / 灯箱基础 / 分享链接 / 前进后退**全部不回归；`node -e "import('./dist/.../state.js')"` 可导入纯函数；目录哈希随任一模块改动而变。
- 追溯：FR-15

#### T-10 视觉系统与 hero
- 依赖：T-09
- 文件：`src/web/style.css`、`src/web/js/main.js`、`src/web/index.html`
- 内容：plan §7 的色板/字阶/版心/组件；hero 满幅不裁切（按比例算高度，竖图上下中性底色）；章节骨架（精选 / 时间线 / 相册 / 故事入口 / 照片墙入口 / 收尾）；导航与两个入口按钮。
- 验收：首屏照片占满容器宽度、标题在留白区且可读；375 / 768 / 1024 / 1366 四档无横向溢出；`prefers-reduced-motion` 下静态完整；hero 竖图不裁切、不拉伸。
- 追溯：FR-15、FR-17

### P3 · 栅格与媒体

#### T-11 编辑式栅格与加载
- 依赖：T-10、T-11 相关纯函数在 T-09 已导出
- 文件：`src/web/js/gallery.js`、`src/web/css`（同 style.css）、`scripts/verify.mjs`
- 内容：`computeEditorialRows` 渲染；`feature` / `strip` 两类行；`srcset`/`sizes` 按位置生成；LQIP 占位；首批 60 + 哨兵加载；筛选重建保留滚动位置。
- 验收：构造 200 组随机 ratio，断言每行 `Σwidth + gaps ≤ 容器宽 + 0.5`、行高 > 0；页面里能看到大图—小图交替；横竖图完整无裁切；滚动到底自动加载下一批；切换筛选不跳回顶部（除非内容变短）。
- 追溯：FR-15、FR-16

#### T-12 视频瓦片播放
- 依赖：T-11
- 文件：`src/web/js/gallery.js`（控制器内联）、`style.css`
- 内容：`preload="none"` + `data-src` 延迟；hover 播放（指针设备）/ 50% 可见播放（触屏）；**全局并发 1**；离开复位；`saveData` 与 `reduced-motion` 下不自动播；播放失败退 poster。
- 验收：悬停播放、移出暂停且回到首帧；同屏最多 1 个在播；始终无声；`play()` 失败无报错、显示封面；视频瓦片右下有播放标识。
- 追溯：FR-12

#### T-13 灯箱（含视频与转场）
- 依赖：T-11
- 文件：`src/web/js/lightbox.js`、`style.css`
- 内容：v2 全部能力（翻页/缩放/平移/缩略图/计数/自动播放/预加载）；视频 `controls` 自绘（播放暂停、进度、静音）；空格按类型分流；`startViewTransition` 共享元素（带降级）。
- 验收：图片能力与 v2 等价；视频有声播放、可暂停、可拖进度、可静音；空格在图片上是自动播放开关、在视频上是播放暂停；关闭后焦点回到原瓦片；不支持 View Transitions 时淡入无报错。
- 追溯：FR-12、FR-15

### P4 · 叙事与常驻

#### T-14 故事模式
- 依赖：T-13、T-09（`buildStory`）
- 文件：`src/web/js/story.js`、`style.css`
- 内容：分章（≥2 年按年，否则按月，>12 章合并相邻月）；状态机（plan §5.2）；单 timeout 链 + `remaining`；pace 三档；章节标题卡 2.2s；结束卡；键盘与手势；3 层 DOM 回收；退出恢复滚动与 hash。
- 验收：从「全部 / 相册 / 年份 / 筛选结果」进入范围正确；章节卡与结束卡出现；三档节奏明显不同；空格/←/→/↑/↓/ESC 全部生效；退出后回到原滚动位置且 hash 还原；连续播放 50 张后 DOM 中 `<img>` 不超过 3 个。
- 追溯：FR-13

#### T-15 照片墙
- 依赖：T-13
- 文件：`src/web/js/wall.js`、`style.css`
- 内容：全屏覆盖层；Wake Lock（手势申请 / `release` 重试 / 可见重申请 / 失败提示）；调度器（`dueAt` + `remaining`，`visibilitychange` 暂停恢复）；队列（On This Month → 最新 24 → 洗牌袋）；10s 默认 + 4 档；视频播完切；夜间遮罩；StandBy 时钟（分钟刷新、±1px 位移）；控制条 3s 淡出；ESC/双击退出。
- 验收：进入后自动轮播且 UI 自动隐藏；`localhost` 下 iPad 10 分钟不息屏（人工，CP-3）；22:00 后自动变暗；时钟为分钟级不闪；视频播完自动切；退出恢复原视图。
- 追溯：FR-14

#### T-16 热更新
- 依赖：T-15、T-07（`version.json`）
- 文件：`src/web/js/update.js`、`wall.js`
- 内容：可见时 600s 轮询 `version.json?_=<ts>`（`cache: 'no-store'`）；`rev` 变化 → 拉新 manifest → 计算新增 → 并入 `state.data` 与队列（不重置当前索引）；失败退避 30/60/120/300/600s，不弹 UI；跨天检测重建队列。
- 验收：模拟新增一条（改 `dist` 后本地起服务）→ 不刷新页面，30 分钟内队列里出现；断网时无报错弹窗，恢复后继续；跨天后 On This Month 队列重建。
- 追溯：FR-14

### P5 · 动效与部署

#### T-17 动效与转场打磨
- 依赖：T-11 ~ T-16
- 文件：`src/web/js/motion.js`、`style.css`
- 内容：plan §4.7 的 M1~M11；`@supports (animation-timeline: view())` 分流；IO 兜底；`prefers-reduced-motion` 全关；视差只动 `transform`；动画结束移除 `will-change`。
- 验收：Safari 26 下章节随滚动渐显、feature 有轻微视差；Safari 17/18 无视差但内容完整、无跳变；reduced-motion 下无任何位移动画；滚动 60fps 无明显掉帧（人工）。
- 追溯：FR-15（B-1/B-2）

#### T-18 部署缓存头适配
- 依赖：T-07
- 文件：`src/deploy/deploy.mjs`、`src/deploy/preview.mjs`、`src/deploy/aws.mjs`
- 内容：plan §10.1「sync 全量长缓存（带 `--delete`）→ `cp` 覆盖 `index.html` 与 `data/version.json` 为 `no-cache`」；预览脚本同结构但不带 `--delete`；保留「仅失效 `/index.html`」。
- 验收：`npm run deploy:dry` 打印的命令序列符合上述顺序；`preview.mjs` 全文仍不含 `--delete`/`put-bucket-policy`/`create-invalidation`/`create-distribution`（verify 断言）；真实预览上传后 `curl -I` 首页含 `no-cache`。
- 追溯：FR-14、v2 FR-08

#### T-19 verify 断言扩展
- 依赖：T-01 ~ T-18
- 文件：`scripts/verify.mjs`
- 内容：19 → 约 32 条（plan §10.2 的 13 条 + 原 19 条全部保留）。
- 验收：全绿；逐条「故意破坏」抽查 3 条能正确失败（例如给 manifest 塞 `day` 字段、删 `photos/**` 忽略规则、改视频转码参数去掉 `-map_metadata`）。
- 追溯：全部

### P6 · 集成与发布

#### T-20 真实素材集成验证
- 依赖：T-01 ~ T-19
- 文件：无（产出 `dist/`、`.build-report.json`）
- 内容：25 图 + 1 视频全量构建；本地 HTTP 服务（**8091**，避开 v1 遗留的 8080 与 v2 的 8090）；四档宽度人工过一遍；记录 report 数字。
- 验收：构建 0 失败；视频 1080×1920 / ≈30s / <20MB；页面能播、能进故事、能进照片墙；report 的 `videoBytes` 与 `galleryBytesEstimate` 合理。
- 追溯：全部

#### T-21 GitHub 推送
- 依赖：T-20、CP-1、CP-4
- 文件：无
- 内容：`git remote add origin git@github.com:scott372199/albumn.git`；`npm run check:repo`；按 plan §9.3 补全提交；`git push -u origin main`；`git push --tags`。
- 验收：`git ls-remote origin` 可见 `main`；远端文件列表无媒体/密钥；在临时目录 `git clone` 后 `npm i && npm run build` 成功。
- 追溯：FR-11

#### T-22 交付说明与 tag
- 依赖：T-21
- 文件：`README.md`、`spec/v3/tasks.md`（交付记录小节）
- 内容：命令表、iPad 常驻设置指引（自动锁定 / 低电量模式 / 引导式访问 / 用 Safari 标签页而非主屏图标）、已知限制（HTTP 下常亮不可用、iPad 工具栏、视频限额）、`git tag v3.0`。
- 验收：README 按图索骥能跑通；tag 存在且指向最后一个提交；交付记录写明「已验证 / 未验证（需人工）」两张清单。
- 追溯：全部

---

## 3. 用户侧检查点

| 编号 | 时机 | 需要你做什么 | 阻塞什么 |
| --- | --- | --- | --- |
| CP-1 | 现在 | 把 `~/.ssh/id_rsa_github.pub` 加到 GitHub → Settings → SSH and GPG keys；或告诉我改用 HTTPS + PAT | ✅ 已完成 |
| CP-2 | T-11 完成后 | 浏览器里看一版视觉：首屏是否够「大」、大图小图节奏是否成立、有没有想改的 | ⏳ 待你在浏览器确认 |
| CP-3 | T-15 完成后 | iPad 上用 `http://<你的Mac IP>:8091/#mode=wall` 看照片墙（常亮需 localhost 或 HTTPS，HTTP 下只验轮播/调光/时钟） | ⏳ 待你确认 |
| CP-4 | T-21 之前 | 明确同意「把代码推到公开仓库」这一次外部写操作 | ✅ 已授权并推送 |

---

## 4. 验收对照（spec §9 → 任务）

| spec §9 分组 | 覆盖任务 |
| --- | --- |
| 仓库 | T-01、T-02、T-21 |
| 视觉 | T-10、T-11、T-17、T-20（人工） |
| 视频 | T-06、T-12、T-13、T-20 |
| 故事模式 | T-14 |
| 照片墙 | T-15、T-16、CP-3 |
| 回归（v2 能力） | T-09、T-19、T-20 |
| 隐私抽查 | T-05、T-06、T-08、T-19 |

---

## 5. 明确不做（本版任务内不出现）

- 不伪造 v1→v2 的历史提交（D-05）。
- 不引入打包器、框架、动效库、Service Worker、PWA。
- 不改 CloudFront / 桶策略 / DNS（账号验证未通过）。
- 不做 `dayOfMonth`（O-15 默认只到月）。
- 不做 hero 裁切（D-01）。

---

## 6. 交付记录

### 6.1 执行状态

| 任务 | 状态 | 备注 |
| --- | --- | --- |
| T-01 初始化仓库 | ✅ | 基线提交 `a488df3` |
| T-02 仓库安检与 README | ✅ | 49 个文件通过；故意放 `test-leak.png` 能拦住 |
| T-03 站点配置扩展 | ✅ | `site.mjs`；hero 缺省 `latest-landscape` |
| T-04 媒体识别与 Live Photo | ✅ | 21 条（20 图 + 1 视频），单文件 id 与 v2 完全一致 |
| T-05 三档图片与 LQIP | ✅ | 每档断言无 EXIF；LQIP 24w q40 |
| T-06 视频转码 | ✅ | 164MB → 14.3MB / 30.0s / 1080×1920 |
| T-07 构建编排 | ✅ | 二次构建 0 上传；哈希稳定 |
| T-08 manifest v3 | ✅ | 14.6KB；字段白名单；无时间戳 |
| T-09 前端模块化 | ✅ | 10 个 ESM 模块，`assets/js.<hash>/` |
| T-10 视觉系统 | ✅ | 满幅 hero（深色舞台 + contain）、精选流、深色章节 |
| T-11 编辑式栅格 | ✅ | 按年连续排版，月份只作吸顶标签 |
| T-12 视频瓦片 | ✅ | 桌面悬停预览，全局只允许 1 个在播 |
| T-13 灯箱与转场 | ✅ | 视频、缩放平移、缩略图条、View Transitions |
| T-14 故事模式 | ✅ | 章节卡 → 逐张，进度条、节奏档位、隐藏即暂停 |
| T-15 照片墙 | ✅ | 时钟、夜间调光、Wake Lock、控制条自动隐藏 |
| T-16 热更新 | ✅ | `version.json` 轮询 + 退避 30/60/120/300/600s |
| T-17 动效打磨 | ✅ | `view()` 时间线 + IO 兜底；reduced-motion 全关 |
| T-18 部署缓存头两段式 | ✅ | 先 sync 长缓存，再 cp 覆盖入口页与版本文件 |
| T-19 verify 扩展 | ✅ | 36 项断言（原计划 32，多出 4 项） |
| T-20 真实素材集成验证 | ✅ | 本地 8091/8092 实机截图逐屏核对 |
| T-21 GitHub 推送 | ✅ | `origin main` 已推送 |
| T-22 交付说明与 tag | ✅ | 打 `v3.0` tag |

### 6.2 构建数字

| 指标 | 值 |
| --- | --- |
| 扫描 / 产出 | 21 个文件 → 21 条记录（20 图 + 1 视频） |
| 失败 / 降级 | 0 / 0 |
| 相册 | 1 个（`2026`） |
| manifest | 14.6KB |
| 视频 | 30.0s、14.3MB、1080×1920、crf 23 |
| 二次构建 | 全部跳过（约 4.7s） |
| 断言 | 36 项全过 |

### 6.3 人工验证项（已做）

- 首屏：hero 满幅、深色舞台留边、标题在照片底部压暗区，可读。
- 精选：单列居中，竖图 720 宽、横图 1200 宽；与 hero 不重复。
- 目录：大图 + 2~3 张小图交替，行能填满整宽，左边缘统一。
- 灯箱：图片不裁切、说明文字完整、缩略图条当前项高亮、视频有静音按钮。
- 故事：章节标签、进度条、控制按钮齐备，照片不裁切。
- 照片墙：全屏 contain、时钟、夜间呈琥珀色。

### 6.4 未验证项（需你确认或受环境限制）

- **屏幕常亮（Wake Lock）**：只能在本机 `localhost` 或 HTTPS 下验证，HTTP 的 S3 预览不可验。
- **iPad Safari 实机**：横屏 1024–1366 未真机看过；竖屏与手机只做了响应式推演。
- **View Transitions**：只在 Chrome 里验证过；Safari 26 上自动降级为淡入。
- ~~CloudFront 与正式域名~~：**已全部打通**（2026-11-10）。`https://photos.chenyouyi.top/` 正常，
  HTTP 自动 301 到 HTTPS，证书由 ACM 签发（Amazon RSA 2048 S21，到期 2027-05-26）。
- **Wake Lock 可以验了**：正式域名是 HTTPS，属安全上下文，照片墙的常亮在此可用。

### 6.5 提交与标签

| 项 | 值 |
| --- | --- |
| 远端 | `git@github.com:scott372199/album.git` |
| 基线 | `a488df3 chore: 导入 v2 基线` |
| 构建层 | `556eaf2 feat(build): 媒体识别、三档图片、视频转码与 manifest v3` |
| 前端 | `85e468f feat(web): 模块化前端、编辑式栅格与故事 / 照片墙模式` |
| 部署 | `2fe1e1a feat(deploy): 缓存头两段式；说明文字去重` |
| 标签 | `v3.0` |

### 6.6 线上状态（2026-11-10）

| 项 | 值 |
| --- | --- |
| CloudFront 分发 | `E2UWEFMOKOQEES`（Deployed） |
| CloudFront 域名 | `d3mvmo06veyiuk.cloudfront.net` |
| 回源 | S3 REST 端点 + OAC `EQAKQ33RBCH5M` |
| 首次上传 | 76 个对象（22MB），删除 5 个旧对象 |
| 缓存头 | 产物 `max-age=31536000, immutable`；`index.html` `no-cache`；`version.json` `no-store` |
| 正式域名 | `https://photos.chenyouyi.top/`（DNS 已生效，HTTP 301 → HTTPS） |
| 桶权限 | 已私有：Public Access Block 四项全开，网站托管已关闭，直连 S3 返回 403 |
| 部署幂等 | `sync --size-only`，无变更时上传 0 个对象 |
| 循环 | `npm run deploy` 全程约 30s，含线上自检 |

---

## 7. 收尾与下一步

**P0–P5 已完成，P6 只剩你的验收。** 代码已在 `origin/main`，标签 `v3.0`。

需要你做的三件事：

1. **CP-2 看视觉**：浏览器打开 `http://127.0.0.1:8091/`（或部署后的地址），确认首屏够不够大、大图小图节奏、精选排布。
2. **CP-3 看照片墙**：iPad 上打开 `#mode=wall`。常亮只在 `localhost` 或 HTTPS 下生效；S3 的 HTTP 预览只能验轮播 / 调光 / 时钟。
3. **决定是否发到 S3 预览**：`npm run deploy:preview` 会真实上传到 `chenyouyi` 桶（公开读、无 CDN）。需要你点头我才执行。

留给 v4 的候选（本轮未做，因为都依赖正式域名或额外素材）：

- CloudFront 分发打通后接 `photos.chenyouyi.top`，届时 Wake Lock 与 View Transitions 才能真正验收。
- 视频「按住即播」的长按预览、Live Photo 的按压播放。
- 地图 / 足迹视图（需要放宽隐私边界，只在本地生成、不写进 manifest）。
- 按标签的「主题合集」自动成册。
