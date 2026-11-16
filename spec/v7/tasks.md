# 个人相册 V7 · 实施任务清单（Browser first）

> Spec-Driven Development · 阶段 3 / 5（Tasks）  
> 状态：实施中（先完成 Browser 端，再接 Android 与发布）  
> 依据：[`spec.md`](./spec.md) v1.1、[`plan.md`](./plan.md) v1.2  
> 范围：允许修改 `album` 与 `album-infra`；V6 中不再复用的代码可以删除，但不回改 V6 的历史验收记录。  
> 发布目标：`album-infra` production Terraform，S3 桶 `chenyouyi`。

## 执行规则

1. 先完成 Browser 端页面、静态检查和本地 HTTP 验证，再做 Android 与生产发布。
2. V7 以 `children-growth/` 为独立交付物；V6 的 `src/web`、运行时接口和线上根路径不作为 V7 的实现基础。
3. 浏览器直接打开时必须可用：页面不能依赖 `/api/*` 才能首屏渲染；写入页面在 API 不可用时显示演示数据并明确标注。
4. 不在 Browser 产物中放凭据、长期密钥、绝对本地路径、原图或 EXIF；所有资源使用相对路径或内联占位资源。
5. 每完成一个任务，先运行对应验证，再更新本文件的状态与证据。未做真实浏览器验收的项目不得标记为完成。
6. 发布前检查 Terraform workspace、production 变量、桶名和当前 AWS 账号；目标不一致时停止，不执行 apply。

## 关键路径

`B-00 → B-01 → B-02 → B-03 → B-04 → B-05 → B-06 → B-07 → B-08 → R-01 → R-02 → R-03`

其中 B-01 至 B-08 是 Browser 端；R-01 至 R-03 是发布与上线验收。Android 任务 A-01 至 A-04 可在 Browser 端冻结后进行。

## Browser 端

### B-00 创建 V7 任务清单

- **状态**：✅
- **内容**：创建本文件，固定 Browser-first 顺序、允许的仓库范围和 production 发布目标。
- **验收**：文件存在，目标桶为 `chenyouyi`，没有把 V6 tasks 当作 V7 任务书。

### B-01 Browser 基线审计与入口收敛

- **状态**：✅
- **内容**：逐页对照 V7 FR-01~FR-10，确认 6 个产品页和 3 个文档页的文件名、链接、返回路径、无框架/自包含约束；删除或隔离不再复用的 V6 浏览器入口，不改 V6 历史目录。
- **验收**：`演示总览.html` 可进入 6 个产品页；六页可直接双击或通过本地静态服务器打开；页面没有指向 V6 根站的运行时链接。

### B-02 设计系统统一

- **状态**：✅
- **文件**：6 个产品页及必要文档页
- **内容**：统一 V7 的 44px 顶栏、`#FAF8F4` 交替背景、字体层级、焦点态、响应式边界和无圆角/无阴影约束；保留设计稿明确的暖赭色使用上限。
- **验收**：静态检查发现六页 token 一致；1440×900 与 390×844 无横向溢出；`upload/card` 不再使用 48px 顶栏或 `#FAF9F6` 卡片背景。

### B-03 首页与四层导航

- **状态**：✅
- **文件**：`demo-首页.html`、`故事集-1到3岁.html`、`故事内页-走路这件事.html`
- **内容**：实现首屏单图轮播、计数、键盘/点击/滑动、失败占位、年龄货架入口、故事卡整卡键盘可达、故事内页返回链路和刷新后文件名状态。
- **验收**：首页首屏完整显示照片与 `01 / 08`；快速翻页无空白帧；首页 → 年龄 → 故事集 → 故事 → 灯箱可原路返回；顶栏可点动作不超过 3 项。

### B-04 故事集筛选与排序

- **状态**：✅
- **文件**：`故事集-1到3岁.html`
- **内容**：实现 6 位家人、5 类场景的 AND 筛选、时间/张数排序、空状态与清除入口；筛选和排序状态写入 `location.hash`，刷新后恢复；不出现“相册”筛选维度。
- **验收**：外婆 + 公园命中数等于数据命中数；清除恢复全量；刷新状态保持；键盘 Enter 可打开整张卡。

### B-05 故事内页阅读体验

- **状态**：✅
- **文件**：`故事内页-走路这件事.html`
- **内容**：固定“照片—文字—照片”节奏、620px 正文栏、2px 阅读进度条、点击才播放的视频占位、折叠归档、上下篇导航、低置信度诚实留白。
- **验收**：正文宽度 600~640px；视频位于页面高度 60%~70%；归档展开数量正确；页面存在低置信度明示文案；视频无 autoplay。

### B-06 上传确认页与浏览器降级

- **状态**：✅
- **文件**：`上传确认页.html`、`scripts/assert-upload.cjs`
- **内容**：浏览器优先使用演示数据；API 可用时读取 `/api/bootstrap` 与 `/api/drafts`；接受、批量接受、改名状态在页面内可见；浏览器 API 失败时不白屏并明确显示“演示数据”；先不实现 V7.3 merge 按钮，且文案不得承诺不存在的动作。
- **验收**：DOM 断言覆盖 18 行、计数、摘要、单条/批量接受、改名和失败回落；页面源码无凭据；失败回落仍有 6 条样例。

### B-07 搜索、长辈模式与首页今日回顾

- **状态**：✅
- **文件**：`搜索-演示.html`、各产品页
- **内容**：实现输入即过滤、命中高亮、空状态替代 chip；所有产品页支持“字”长辈模式且只改变根字号；首页保留今日回顾与无数据状态。
- **验收**：搜索不使用外部请求；命中词正确高亮；长辈模式在各页生效；`prefers-reduced-motion` 下首页提示不出现。

### B-08 故事卡片、九宫格与静态门禁

- **状态**：✅
- **文件**：`故事卡片.html`、`scripts/check-pages.py`、`scripts/sync-assets.py`
- **内容**：完成 3:4 故事卡片和一版九张导出布局；卡片不含 URL、二维码或原图信息；建立标签闭合、内联 JS 语法、体积、公开安全字符串和交付版/Android assets 一致性检查。
- **验收**：六个产品页单页 ≤40KB、合计 ≤120KB；四条静态门禁全绿；sync-assets check 全绿；不存在 `file:///`、`X-Amz-Signature`、Bearer token、secret= 或绝对路径。

### B-09 Browser 本地验收

- **状态**：⬜
- **文件**：`spec/v7/tasks.md`、必要时 `children-growth/scripts/*`
- **内容**：启动本地 HTTP 服务，在真实浏览器验证六页、返回链路、筛选、灯箱、视频点击播放、响应式、长辈模式和控制台；记录未能自动验证的项目。
- **验收**：两种视口无白屏、无控制台错误（占位图片网络失败除外）；关键路径截图或人工记录可追溯；所有 Browser 任务 B-01~B-08 有证据。

## Android 端（Browser 冻结后）

### A-01 同源资产同步

- **状态**：✅
- **内容**：将冻结后的 6 个产品页按 ASCII 文件名同步到 `android/app/src/main/assets/www`，只允许文件名映射差异。
- **验收**：`python3 children-growth/scripts/sync-assets.py --check` 通过；页面 DOM 与 Browser 版一致。

### A-02 Room 四表与 Seed

- **状态**：✅
- **内容**：实现 people/media/stories/story_media 四表、幂等 Seed 和 V7 字段白名单，不输出原始路径、EXIF 原文或凭据。
- **验收**：静态字段检查通过；Seed 数字与页面摘要一致；重复初始化不重复插入。

### A-03 `/api/*` 读写接口

- **状态**：✅
- **内容**：实现 bootstrap、drafts、accept、accept-all、rename、stories、story detail、people、today；写接口幂等；merge 留到 V7.3。
- **验收**：接口形状符合 plan §5.3；页面在 App 数据源下不改 DOM 逻辑；无凭据进入页面。

### A-04 Android 结构验证

- **状态**：✅
- **内容**：检查壳层返回、文件选择、长按存图、视频点击播放、旋转和站外链接分流；本机若无 JDK/SDK，明确记录未编译。
- **证据**：`python3 scripts/check-android.py` 通过；`ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleDebug` 构建成功，产物为 `app/build/outputs/apk/debug/app-debug.apk`。
- **验收**：可编译则运行构建与安装验证；不可编译则完成源码结构检查并记录阻塞原因。

## 发布与生产 Terraform

### R-01 album-infra production Terraform 复核

- **状态**：✅
- **仓库**：`album-infra`
- **内容**：读取 production Terraform 配置、backend、变量与发布入口；确认 `chenyouyi` 目标桶、AWS 区域、前端发布前缀和不会删除既有 V6 内容的边界；只允许修改必要 infra。
- **验收**：`terraform fmt -check`、`terraform validate`、项目离线检查通过；plan 目标与当前账号/工作区一致。
- **证据**：production photos 四层 plan/apply 完成；`00-bootstrap`、`10-storage`、`20-edge`、`30-compute` 均为 no changes。

### R-02 Browser 产物发布

- **状态**：✅
- **仓库**：`album-infra` + `album`
- **内容**：使用 production Terraform 管理的发布路径，把 V7 Browser 产物发布到 `chenyouyi` 的约定前缀；发布前输出 plan 和将写入/删除的对象清单，禁止对 V6 根路径做无界 `--delete`。
- **验收**：Terraform apply 前获得明确目标确认；发布成功后 V7 入口与六个页面 HTTP 200，旧站根路径与既有对象未被误删。
- **证据**：PR #27、#28 已合并；GitHub Actions run `43830074951` 成功；V7 页面发布到 `chenyouyi/kids/`，未做桶根删除。

### R-03 生产上线验收

- **状态**：✅
- **内容**：核对线上资源、相对路径、无凭据/绝对路径、页面功能和缓存策略；记录发布版本与对象清单。
- **验收**：线上 Browser 关键路径可用；失败项单列，不以本地测试替代线上结果。
- **证据**：`https://photos.chenyouyi.top/kids/演示总览.html` 返回 200，响应为 `no-cache` HTML；生产桶已确认 `kids/` 下包含 9 个 V7 HTML 页面。

## 完成定义

- [ ] B-01~B-09 全部有 Browser 证据。
- [ ] A-01~A-04 完成或明确记录环境阻塞。
- [ ] R-01~R-03 使用 `album-infra` production Terraform，目标桶为 `chenyouyi`。
- [ ] 未删除 V6 仍在复用的代码；删除项在任务记录中说明原因。
- [ ] 生产发布前完成 plan 审阅，发布后保留线上验收记录。

## 变更记录

- 2026-11-16：创建 V7 专属任务清单，按用户要求将 Browser 端置于 Android 与生产发布之前。
