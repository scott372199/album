# 个人相册 · 第二版任务清单（tasks v2）

> Spec-Driven Development · 阶段 3 / 5（Tasks）
> 状态：**已确认**（2026-11-09，进入 Implement 阶段）　|　版本：v2.0　|　日期：2026-11-09
> 依据：`spec/v2/spec.md` v2.0、`spec/v2/plan.md` v2.0（均已确认）
> v1 基线：`spec/tasks.md` v1.2（已封版，原地保留）

**规则**：任务按依赖顺序编号，每项可独立验证；勾选即代表该项验收通过。**编号从 T-01 重新起算，与 v1 的 T-01~T-18 无关。** 实现中若发现需求问题，先回改 spec，不就地变更范围（沿用 v1 变更控制）。

---

## 0. 总览与分工

| 阶段 | 任务 | 需要 AWS 凭证 | 需要 DNS 操作 | 谁执行 |
| --- | --- | --- | --- | --- |
| P0 配置骨架 | T-01 | 否 | 否 | 我 |
| P1 构建层 | T-02 | 否 | 否 | 我 |
| P2 前端视觉 | T-03 ~ T-07 | 否 | 否 | 我 |
| P3 部署层 | T-08 ~ T-11 | 否（仅 dry-run） | 否 | 我 |
| P4 本地集成验证 | T-12 | 否 | 否 | 我 |
| P5 首次引导 | T-13 | 否 | **是** | **你** |
| P5 首次引导 | T-14 | 是 | 否 | 我 |
| P5 DNS 指向 | T-15 | 否 | **是** | **你** |
| P5 上线与验收 | T-16 ~ T-18 | 是 | 否 | 我 |

**关键路径**：T-01 → T-02 → T-03 → T-04 → T-12 → T-13 → T-14 → T-15 → T-16 → T-17 → T-18。

**可并行**：T-08 → {T-09 → T-10, T-11} 整条部署链可与 P2 前端链并行；T-05 / T-06 / T-07 在 T-04 之后可并行。

> **T-01 ~ T-12 完全不需要 AWS 凭证，也不需要 DNS**：全部可用 `--dry-run` 与本地 HTTP server 验证。用户侧只有 **T-13、T-15** 两次在注册商添加 CNAME。真正接触 AWS 资源从 T-14 开始，届时我会先给出精确记录清单并再确认一次。

---

## P0 · 配置骨架

### T-01 配置、站点文案与脚本骨架

- **依赖**：无
- **文件**：`src/deploy/config.json`（扩展）、`site.json`（新增）、`.gitignore`、`package.json`、新建 `src/deploy/{aws,distribution-config,init}.mjs` 占位
- **内容**：按 plan §2 落地目录结构；`config.json` 改为 8 字段静态配置（bucket / region / acmRegion / domain / siteUrl / indexDocument / oacName / distributionComment）；根 `site.json` 填 `{ "title": "个人相册", "subtitle": "" }`；`.gitignore` 增加 `.deploy-state.json` 与 `src/deploy/distribution-config.json`；`package.json` 的 version 升为 `2.0.0`、scripts 增加 `deploy:init` / `deploy:dry`
- **验收**：① `config.json` 无 v1 的 `websiteEndpoint` / `errorDocument` 残留 ② `site.json` 存在且入库（不被 gitignore 排除）③ `npm run` 能列出 5 个脚本 ④ `.gitignore` 含两个新条目 ⑤ `node -e` 读取 config 不报错
- **追溯**：plan §1 §2 §4、FR-10

---

## P1 · 构建层改造

### T-02 `build.mjs` 三处改动

- **依赖**：T-01
- **文件**：`src/build/build.mjs`
- **内容**：① 硬编码 `SITE` 常量改为读根 `site.json`，文件缺失时兜底默认且不报错 ② `assertNoHttpsReferences()` 改名 `assertNoInsecureReferences()`，断言从禁止 `https://` 改为**禁止 `http://`**（HTTPS 页防混合内容），错误文案同步 ③ `dist/.build-report.json` 增加 `invalidation: null` 字段。**`scan.mjs` / `exif.mjs` / `image.mjs` / `manifest.mjs` 一行不改**
- **验收**：① 改 `site.json.title` 后 manifest 的 `site.title` 变化且 manifest 哈希变化 ② 产物中 0 处 `http://` ③ report 的 `invalidation === null` ④ 连续两次 `npm run build` 第二次全部 skipped、`index.html` 与 manifest 哈希稳定 ⑤ 抽查 3 张 WebP 无 EXIF、manifest 无原始文件名 / GPS / 序列号
- **追溯**：FR-02（不降级）、FR-08、FR-10、plan §4

---

## P2 · 前端视觉重构

### T-03 `index.html` 结构与 `style.css` 全量重写

- **依赖**：T-02
- **文件**：`src/web/index.html`、`src/web/style.css`
- **内容**：按 plan §3.1 §3.2 §3.7 落地——毛玻璃 sticky nav、浅色 hero（超大无衬线标题 + 副标题兜底排版）、浅色照片区、**深色全宽章节**（统计叙事）、深色 footer、灯箱容器（新增 zoom 按钮 + 缩略图条占位）；保留四个占位符；内联 data URI favicon；`:root` 设计 token（paper / ink / night / accent / radius / ease / 5 级 clamp 字号）；响应式 4 / 3 / 2 列容器宽度；`:focus-visible`、`prefers-reduced-motion`、`backdrop-filter` 降级；**照片本身不加边框 / 圆角 / 滤镜**
- **验收**：① 静态打开无样式错乱、深浅章节层次分明 ② 1440 / 768 / 375px 均无横向溢出 ③ 页面无 `http://` / `https://` 外链资源、无 CDN 引用 ④ 副标题为空时 hero 不塌陷 ⑤ `prefers-reduced-motion: reduce` 下无内容被初始隐藏 ⑥ 深浅区块文字对比度 ≥ 4.5:1
- **追溯**：FR-06、plan §3.1 §3.2 §3.7

### T-04 不裁切 justified rows 网格与时间轴 / 相册视图

- **依赖**：T-03
- **文件**：`src/web/app.js`（基础骨架 + 布局分节）
- **内容**：加载 manifest、按年 → 月倒序分组、相册卡片与进入单相册（沿用 v1 逻辑）；按 plan §3.3 实现 `layoutJustifiedRows()`：按 `ratio` 累加分行、行高 H 桌面 300 / 平板 220 / 手机 150、`flex-grow = ratio`、末行不拉伸；`ResizeObserver` + 100ms 防抖重排；渲染前用 `aspect-ratio` 预占位；无 JS / 无 ResizeObserver 降级为 grid + `object-fit: contain`；图片继续 `loading="lazy" decoding="async"` + alt
- **验收**：① 横幅与竖幅各抽 1 张，画面完整、**无裁切**、无变形 ② DOM 顺序与 manifest 顺序、灯箱翻页顺序三者一致 ③ 改变视口宽度后重排正确、无重叠无溢出 ④ 图片加载过程中布局不跳动 ⑤ 禁用 JS 时降级布局仍可见且不裁切 ⑥ 时间轴分组数量与视图切换往返无状态错乱
- **追溯**：FR-03、FR-09、plan §3.3

### T-05 搜索筛选与 URL hash 状态路由

- **依赖**：T-04
- **文件**：`src/web/app.js`
- **内容**：沿用 v1 的关键词 / 标签 / 年月组合 AND 过滤与空状态；实现统一的 `serializeState()` / `restoreState()`，格式 `#p=<id>` 与 `#view=...&album=...&q=...&tag=...&year=...&month=...`；`encodeURIComponent` 与非法值容错；监听 `hashchange` 还原；`init()` 末尾解析 hash 落地；复制分享链接用 `location.href`
- **验收**：① 单条件与三条件组合命中正确 ② 无结果空状态与清除筛选正常 ③ 新窗口打开分享链接、刷新、浏览器前进后退均能还原视图 / 筛选 / 单张照片 ④ 非法 hash（不存在的 id、非数字年月）回落全量且不报错 ⑤ 筛选结果集与灯箱翻页范围一致
- **追溯**：FR-04、FR-09、plan §3.5、O-07

### T-06 灯箱增强

- **依赖**：T-04
- **文件**：`src/web/app.js`（lightbox 分节）
- **内容**：**保留 v1 全部能力**（←/→、ESC、空格 4s 自动播放、触摸滑动、相邻预加载、焦点回到触发元素、`aria-*`）；新增 zoom 状态 1/2/3 循环 + 复位（按钮 / 滚轮 / 双击 / 捏合）、放大后拖动平移、底部缩略图条（当前项高亮并居中、点击跳转）、「第 N / 共 M 张」计数、切换图片时重置 zoom 与平移；灯箱打开 / 关闭与 hash 中的 `p` 同步
- **验收**：① v1 四项键盘操作与移动端滑动全部仍生效 ② 缩放 / 复位 / 平移生效且切换图片后归位 ③ 缩略图条当前项居中、点击跳转正确 ④ 计数与筛选结果集一致 ⑤ 焦点回到触发元素 ⑥ 直接带 `#p=<id>` 打开站点即落到对应照片
- **追溯**：FR-05、FR-09、plan §3.4

### T-07 滚动动效与可访问性收尾

- **依赖**：T-03（可与 T-04 ~ T-06 并行）
- **文件**：`src/web/app.js`、`src/web/style.css`
- **内容**：`IntersectionObserver` 给 `.reveal` 加 `.is-visible`；CSS 默认可见，只有 JS 在 `html` 加 `.js-anim` 后才启用初始隐藏；`prefers-reduced-motion: reduce` 时 JS 跳过 observer 且 CSS 强制可见；键盘焦点顺序与 DOM 顺序一致；深色区块焦点环可见；`backdrop-filter` 不可用时导航退化为不透明浅底
- **验收**：① 关闭动效 / 禁用 JS 时所有内容完整可用 ② 渐显不影响图片懒加载与筛选结果即时渲染 ③ Tab 顺序与视觉顺序一致、焦点环在深浅底均可见 ④ 三类视口下动效无抖动、无横向溢出
- **追溯**：FR-06、FR-09、plan §3.6

---

## P3 · 部署层改造

### T-08 `aws.mjs` 共用模块与策略生成

- **依赖**：T-01
- **文件**：`src/deploy/aws.mjs`、`src/deploy/bucket-policy.json`、`src/deploy/iam-policy.json`（后两者由脚本生成）
- **内容**：封装 `run(args,{allowFail})`、`selfCheck()`（`aws --version` + `sts get-caller-identity`）、dry-run 拦截、`generatePolicies(state)`、`printDnsRecords()`；按 plan §5.3 生成 **OAC 桶策略**（Principal `cloudfront.amazonaws.com` + `AWS:SourceArn`，**不得出现 `Principal: "*"`**）；按 plan §7 生成 IAM 最小权限（新增 ACM / CloudFront 两组，移除 `s3:CreateBucket` 与 Put/GetBucketWebsite）
- **验收**：① 两个策略 JSON 语法合法 ② 桶策略含 `cloudfront.amazonaws.com` 与 `AWS:SourceArn`、无公开读、无 `s3:ListBucket` ③ IAM 含 ACM / CloudFront 权限且 `Resource: "*"` ④ `--dry-run` 不产生任何 AWS 调用 ⑤ 无凭证时给出清晰指引而非崩溃
- **追溯**：FR-02、FR-07、plan §5.3 §7

### T-09 `distribution-config.mjs`

- **依赖**：T-08
- **文件**：`src/deploy/distribution-config.mjs`、运行时生成的 `src/deploy/distribution-config.json`
- **内容**：按 plan §5.2 生成完整 `DistributionConfig`：`DefaultRootObject=index.html`、普通 S3 REST 源站 + `OriginAccessControlId`、`Aliases`、`ViewerProtocolPolicy=redirect-to-https`、`Compress=true`、ACM 证书 + `sni-only` + `TLSv1.2_2021`、`HttpVersion=http2and3`；managed `CachingOptimized` 的 ID **运行时用 `aws cloudfront list-cache-policies --type managed` 查询**，不硬编码；**明确不生成 `CustomErrorResponses`**
- **验收**：① 生成的 JSON 可被 `JSON.parse` 且字段齐全 ② 不含 `CustomErrorResponses` ③ 不含 `s3-website` 字样（源站不是 website endpoint）④ 区域参数正确（ACM 相关固定 `us-east-1`）⑤ CloudFront CLI 无原生 dry-run，本任务只做本地结构断言，真实创建留到 T-14 验证
- **追溯**：FR-07、plan §5.1 §5.2 §5.6

### T-10 `init.mjs` 首次引导（收敛式状态机）

- **依赖**：T-08、T-09
- **文件**：`src/deploy/init.mjs`、`.deploy-state.json`（运行时生成）
- **内容**：按 plan §6.1 实现 Phase A~F 收敛式状态机：每次运行先复核远端状态 → 自动推进到最远可推进的一步 → 遇到需用户操作就打印精确 DNS 记录清单并退出，重跑续跑；Phase A 申请 ACM 证书（`--region us-east-1`）并输出记录 1；Phase C 创建 OAC → 查 cache policy ID → 创建分发并输出记录 2；Phase D **按「先分发、后收紧」顺序** put-bucket-policy（OAC 模板）、put-public-access-block 四项 true、delete-bucket-website；Phase E 分发 InProgress 时只提示不阻塞；Phase F 输出正式地址。证书 / OAC / 分发均**先查后建**保证幂等；`.deploy-state.json` 记录 accountId / certificateArn / oacId / distributionId / distributionDomainName / dnsRecords / phase
- **验收**：① `--dry-run` 打印完整命令序列与两条 DNS 记录清单、不接触 AWS ② 所有 ACM 命令带 `--region us-east-1`，S3 命令带 `--region ap-southeast-1` ③ 同一命令重复执行不创建重复资源 ④ Phase D 顺序与 plan §6.1 完全一致 ⑤ 输出中无 v1 的 website endpoint 作为访问地址
- **追溯**：FR-07、§7 用户侧操作、plan §6.1 §6.3

### T-11 `deploy.mjs` 日常发布

- **依赖**：T-08
- **文件**：`src/deploy/deploy.mjs`（重写）
- **内容**：按 plan §6.2 依次：自检 → 从 state / 远端取 `distributionId`（缺失提示先跑 `deploy:init`）→ `aws s3 sync dist/ s3://<bucket>/ --region <region> --delete --exclude '.build-report.json'`（执行前打印将删除对象数）→ `aws cloudfront create-invalidation --distribution-id <id> --paths /index.html`（**失败即非零退出**）→ 回写 `dist/.build-report.json` 的 `invalidation` 字段 → 输出新增 / 跳过 / 删除统计、失效 ID、`https://photos.chenyouyi.top`
- **验收**：① `--dry-run` 命令序列与 plan §6.2 一致且不接触 AWS ② report 的 `invalidation` 从 `null` 变为含 `executed / paths / id / status` 的对象 ③ `s3 sync` 排除 `.build-report.json` ④ 模拟失效失败时进程非零退出并给出明确错误 ⑤ 输出地址来自 `config.json`，无硬编码 URL
- **追溯**：FR-07、FR-08、plan §5.5 §6.2

---

## P4 · 本地集成验证

### T-12 本地端到端验证（不接触 AWS）

- **依赖**：T-02 ~ T-07、T-10、T-11
- **文件**：必要时新增 `scripts/verify.mjs`
- **内容**：`npm run build` → `python3 -m http.server 8080 -d dist` → 逐项走 plan §11：三档视口的深浅章节 / hero / 不裁切网格（横竖幅各一）/ 组合筛选与空状态 / 灯箱键盘 + 缩放 + 缩略图条 / hash 分享在新窗口与刷新下还原 / 前进后退 / reduced-motion / 焦点顺序 / 无横向溢出；抽查 3 张产物无 EXIF、manifest 无敏感字段、产物无 `http://`；`deploy:dry` 与 `init.mjs --dry-run` 核对命令序列与两条 DNS 记录；二次构建全部 skipped；`verify.mjs` 对 justified rows 分行与 hash 序列化 / 反序列化做纯函数断言
- **验收**：plan §11 全部通过，问题清零，输出一份本地验证结果摘要（含首屏体积）
- **追溯**：spec §9 中不依赖线上环境的部分、plan §11

---

## P5 · 首次引导与上线

### T-13 【用户侧 · 第 1 次 DNS】添加证书验证 CNAME

- **依赖**：T-12、T-14 的 Phase A 输出
- **执行**：**你**（我会给出精确的名称 / 类型 / 值，并再次确认，不代你登录注册商）
- **内容**：在 `chenyouyi.top` 的 DNS 添加 `init.mjs` Phase A 输出的 ACM 验证 CNAME 记录
- **验收**：① 记录已添加 ② `aws acm describe-certificate --region us-east-1` 的 `Status` 变为 `ISSUED`
- **追溯**：spec §7、plan §5.4 记录 1

### T-14 首次引导：证书 / OAC / 分发 / 桶私有化

- **依赖**：T-10、T-13
- **执行**：我（一条 `npm run deploy:init`，按 Phase 推进，必要时重跑）
- **内容**：推进到 Phase F：证书签发、创建 OAC 与 CloudFront 分发、按「先分发后收紧」把桶改私有并关闭 website hosting、输出 **DNS 记录 2**（`photos.chenyouyi.top` → `<id>.cloudfront.net`）；分发 `Status == Deployed`
- **验收**：① 证书 `ISSUED` 且位于 `us-east-1` ② 分发配置与 plan §5.2 一致、无 CustomErrorResponses ③ Block Public Access 四项 true、桶策略仅 OAC ④ `delete-bucket-website` 已执行、匿名列举与直连对象均 403 ⑤ 输出 DNS 记录 2 且值正确 ⑥ 过程中 CloudFront 回源无 403
- **追溯**：FR-02、FR-07、plan §6.1

### T-15 【用户侧 · 第 2 次 DNS】添加站点 CNAME

- **依赖**：T-14
- **执行**：**你**
- **内容**：在 DNS 添加 `photos.chenyouyi.top` → `<distribution>.cloudfront.net` 的 CNAME
- **验收**：① `dig` / `nslookup` 解析到 CloudFront 域名 ② `https://photos.chenyouyi.top` 的 TLS 握手证书覆盖该域名
- **追溯**：spec §7、plan §5.4 记录 2

### T-16 首次部署与基本连通性

- **依赖**：T-15
- **执行**：我，一条 `npm run deploy`
- **内容**：构建 → 上传 `dist/` → 失效 `/index.html` → 输出正式地址；先用 CloudFront 默认域名验证 HTTPS 与回源，再用正式域名验证
- **验收**：① 正式域名返回 200、证书有效无「不安全」提示 ② `http://` 跳转到 `https://` ③ 首页 / JS / CSS / manifest / WebP 全部 200 且 Content-Type 正确 ④ `dist/.build-report.json` 的 invalidation 已回写 ⑤ v1 HTTP S3 端点已失效
- **追溯**：spec §9 前 6 项、plan §6.2

### T-17 上线验收（spec v2 §9 逐项）

- **依赖**：T-16
- **执行**：我，逐项核对并输出验收报告
- **内容**：按 spec §9 的 19 项清单逐条验证——HTTPS / 跳转 / 无混合内容 / 证书区域 / 桶私有与匿名 403 / 桶策略 SourceArn / v1 地址失效 / Apple 风格视觉 / reduced-motion / 不裁切 / 时间轴相册与筛选 / 灯箱全部交互 / 分享链接还原 / 抽查 3 张线上图片无 GPS 与序列号 / 新增 1 张照片重跑一条命令（旧照片跳过 + 线上可见 + 失效已执行）/ 三档响应式与对比度 / 首屏实测性能与 v1 的 0.18s 对照 / 成本口径
- **验收**：spec §9 全部勾选；未通过项单独列出并给修复方案，不带病交付
- **追溯**：spec §9、plan §10

### T-18 地址迁移与交付说明

- **依赖**：T-17
- **执行**：我
- **文件**：交付说明（写在本文「交付记录」小节，不新增独立 md 文件）
- **内容**：写明 v1 HTTP 端点已下线、正式地址唯一；日常新增照片流程（放进 `photos/` → `npm run deploy`）；两条 DNS 记录必须保持有效、ACM 托管续期说明；IAM 最小权限策略路径；已知限制（跨境访问、几百张规模、站点仍完全公开、CDN 传播延迟）；成本记录口径
- **验收**：① 说明可在无上下文时独立照做 ② 明确不含 v1 的 website endpoint 作为可用地址 ③ 已知限制与 spec §11.3 / §11.4 一致
- **追溯**：O-08、spec §11、plan §10

---

## 实现进度（2026-11-09，Implement 阶段）

| 任务 | 状态 | 验证结果 |
| --- | --- | --- |
| T-01 配置骨架 | 完成 | `config.json` 8 字段、`site.json`、`.gitignore` 两项、5 个 npm scripts 齐备 |
| T-02 构建层 | 完成 | 改标题后清单变 `fbe95f28`、恢复后回到 `18a0c16c`；产物 0 处 `http://`；`invalidation: null`；二次构建 20 张全跳过；3 张 WebP 无 EXIF |
| T-03 页面与样式 | 完成 | 结构 / CSS token 断言通过；用户已打开本地预览确认视觉与响应式 |
| T-04 不裁切网格 | 完成 | `computeRows` 4 项断言通过（顺序、不溢出、等比分配、非法 ratio 兜底）；预览确认无裁切 |
| T-05 搜索与 hash 路由 | 完成 | 往返、非法值容错、空 hash 3 项断言通过 |
| T-06 灯箱增强 | 完成 | DOM id 完整性检查通过；用户预览确认 |
| T-07 动效与可访问性 | 完成 | CSS 含 `prefers-reduced-motion`、`:focus-visible`、`is-fallback` 降级；用户预览确认 |
| T-08 `aws.mjs` 与策略 | 完成 | 桶策略仅 OAC + `AWS:SourceArn`、无公开读；IAM 含 ACM / CloudFront、移除建桶与 website 权限 |
| T-09 分发配置 | 完成 | 7 项字段断言通过；`CustomErrorResponses.Quantity = 0`；源站无 `s3-website` |
| T-10 `init.mjs` | 完成 | `--dry-run` 打印 12 条命令与 2 条 DNS 记录；ACM 固定 `us-east-1`、S3 固定 `ap-southeast-1` |
| T-11 `deploy.mjs` | 完成 | `--dry-run` 序列与 plan §6.2 一致；失效失败即非零退出；report 回写逻辑就位 |
| T-12 本地端到端 | 完成（见下方限制） | 17 项断言 + HTTP 全 200 + 3 张 WebP 无 EXIF + 哈希稳定 |
| T-13 DNS 记录 1 | 完成 | 用户已添加验证 CNAME，ACM 证书状态 `ISSUED`，`dig` 已核实 |
| T-14 首次引导 | **等待账号验证** | 用户已提 AWS Support case；证书 / OAC 免费保留、v1 正常；验证通过后重跑 `npm run deploy:init -- --skip-lock` 即可幂等续上 |
| **T-14a 临时 S3 预览** | **完成** | 见下方「T-14a」与「临时预览部署记录」：v2 前端已上线到 S3 HTTP 端点，44 个对象同步完成、新旧资源全 200、回滚备份逐字节校验通过 |
| T-15 DNS 记录 2 | 待开始 | — |
| T-16 首次部署 | 待开始 | — |
| T-17 上线验收 | 待开始 | — |
| T-18 交付说明 | 待开始 | — |

### 本地验证结果摘要（2026-11-09）

- **结构验证**：`node scripts/verify.mjs` 共 17 项断言全部通过（分行算法 4、hash 往返 3、前端结构 3、产物与 manifest 3、部署配置 4）。
- **构建**：`npm run build` 扫描 25 / 忽略 5 / 产出 20，`新增 0 / 跳过 20 / 失败 0`；连续两次构建 `app.d46cc601.js`、`style.83edcde3.css`、`manifest.18a0c16c.json` 哈希稳定。
- **站点文案**：`site.json` 改为「测试标题 / 测试副标题」后 manifest 正确反映且哈希变化，恢复后哈希回到原值。
- **脱敏**：抽查 3 张 `view.webp`（1599×1999 / 2048×1536 / 1536×2048）均无 EXIF。
- **无混合内容**：`dist/` 的 HTML / JS / CSS / manifest 共 0 处 `http://`。
- **HTTP 可达性**：本地临时服务下首页、JS、CSS、manifest、6 个图片资源全部 200 且 Content-Type 正确；缺失资源返回 404（未映射为首页）。
- **dry-run**：`init.mjs --dry-run` 与 `npm run deploy:dry` 均不接触 AWS，命令序列与 plan §6 一致。

> **浏览器验证说明（2026-11-09 更新）**：当前环境没有浏览器自动化工具，T-03 ~ T-07 完成静态结构与纯函数验证后，已由用户打开本地预览确认视觉与交互「没问题」。这属于人工确认而非自动化回归，T-17 上线验收时仍需在正式域名下复核三档响应式、键盘 / 触摸、缩放平移、缩略图跳转与 reduced-motion。

### 首次引导记录（2026-11-09）

- **Phase A 完成**：ACM 公共证书在 `us-east-1` 申请成功，域名 `photos.chenyouyi.top`，状态 `PENDING_VALIDATION`，ARN 记录在 `.deploy-state.json`（已 gitignore）。
- **DNS 记录 1（证书验证，待用户添加）**
  - 类型：`CNAME`
  - 名称：`_4ffeb349d1f62c4865d1eaa1ad647bf0.photos.chenyouyi.top.`
  - 值：`_2f9ccd64e7ed7bc07efba54fe171b7f2.wzccmgtwzk.acm-validations.aws.`
- **DNS 记录 2**：待 Phase C 创建 CloudFront 分发后才有目标值。
- 此阶段**未创建分发、未改桶策略、未关闭 website hosting**，v1 的 HTTP 站点照常运行。
- **记录 1 已由用户添加并生效**：证书状态转为 `ISSUED`，`dig` 解析返回正确的 ACM 验证值。
- **Phase C 受阻（2026-11-09 21:55）**：OAC `EQAKQ33RBCH5M` 已创建；`create-distribution` 返回 `AccessDenied: Your account must be verified before you can add new CloudFront resources`，属**账号级风控**，不是配置错误，需用户联系 AWS Support 验证账号。**分发未创建、桶未收紧、v1 首页仍 HTTP 200**。验证通过后重跑 `npm run deploy:init -- --skip-lock` 即可幂等续上（OAC 会复用）。
- **本轮修掉两个实现缺陷**：① AWS 托管缓存策略实际名为 `Managed-CachingOptimized`（带前缀），已改为兼容匹配；② `S3OriginConfig` 必须显式带 `OriginAccessIdentity: ''`，误写的 `OriginReadTimeout` 已移除，并补进 `verify.mjs` 断言防回归。
- **新增 `--skip-lock` 开关**：先创建分发、输出记录 2，等 DNS 生效后再收紧桶，避免「v1 下线 → 记录 2 生效」之间出现站点不可用的空窗；不带开关时默认行为不变。
- **DNS 记录 2 尚未产生**（目标值来自 `create-distribution` 返回值）。
- **用户决策（2026-11-09）**：选择「提 AWS Support case，验证后继续」。项目进入**等待态**，不再执行任何 AWS 写操作；v1 站点保持运行，证书与 OAC 保留（免费）。验证通过后重跑 `npm run deploy:init -- --skip-lock` 即可从断点续上，`findExistingOac()` 会复用已有 OAC。
  - **后续修订**：见下方 T-14a —— 用户提交工单后明确允许「其他内容先 implement，先用 S3 域名测试网站效果」。等待态的边界因此收窄为 **CloudFront / HTTPS / 自定义域名冻结**，S3 临时预览写入已获授权。

### 实施路径调整 · T-14a 临时 S3 预览部署（2026-11-09）

> 用户原话：「我已提交工单，其他内容可以先 implement，到时候先用 s3 的域名来测试网站效果。等到 cloudfront 工单 validation 成功后再绑定 https 和自定义域名。」
>
> **性质：上线节奏调整，不是需求变更。** spec FR-01 ~ FR-10、§9 上线验收清单、正式地址 `https://photos.chenyouyi.top` 全部不变；按「变更控制」无需重新确认 spec / plan，仅在 `spec/v2/spec.md` §11.5 与 `spec/v2/plan.md` §6.4 补注记。

- **依赖**：T-01 ~ T-12、T-13；**不依赖 T-14 的 CloudFront 分发**（这正是解耦点）
- **文件**：新增 `src/deploy/preview.mjs`；`package.json` 加 `deploy:preview` / `deploy:preview:dry` / `deploy:preview:rollback`；`.gitignore` 加 `.rollback-v1/`；`scripts/verify.mjs` 加 2 条护栏断言；spec §11.5、plan §6.4 注记
- **内容**：`npm run build` → 备份线上 `index.html` 到 `.rollback-v1/`（已存在则跳过，保留最初 v1 版本）→ `aws s3 sync dist/ s3://chenyouyi/ --region ap-southeast-1 --exclude '.build-report.json'`，**不带 `--delete`**；提供 `--dry-run` 与 `--rollback` 两种模式。**刻意不做** CloudFront 缓存失效 / 桶策略变更 / Block Public Access / 关闭 website hosting / 绑定域名 / 写 `.deploy-state.json`
- **验收**：① 备份与上传前线上 v1 首页逐字节一致 ② 临时地址返回 v2 首页（4714 bytes，引用 `app.d46cc601.js` / `style.83edcde3.css`）③ v2 的 JS / CSS / manifest / 抽查 4 张 WebP 全 200 且 Content-Type 正确 ④ v1 旧 JS / CSS 仍 200（回滚可用）⑤ 二次 `sync --dryrun` 无待上传对象 ⑥ 17 + 2 项结构断言全过 ⑦ 桶策略 / website hosting / CloudFront 未被改动
- **追溯**：spec §11.5、plan §6.4、FR-07（正式架构不变）

### 临时预览部署记录（2026-11-09 22:33）

- **临时地址（仅过渡期，不是交付地址）**：`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`
- 上传前线上 v1 首页：HTTP 200、2688 bytes，引用 `app.d52478aa.js` / `style.2d087a7a.css` / `data/manifest.18a0c16c.json`。
- 备份 `.rollback-v1/index.html`（2688 bytes）与上传前线上首页 **diff 无差异**，回滚真实可用：`npm run deploy:preview:rollback`。
- 本次 `sync` 实际上传 4 个对象（`aws s3api list-objects-v2` 按 `LastModified` 核实，均为 14:33:37 UTC）：`index.html`（4714 B）、`assets/app.d46cc601.js`（23617 B）、`assets/style.83edcde3.css`（14562 B）、`data/manifest.18a0c16c.json`（3993 B）。40 张 WebP 内容未变全部跳过；**未删除任何对象**，v1 旧 JS / CSS 仍留在桶里。v1 与 v2 的 manifest 文件名同为 `18a0c16c`（照片数据未变），因本地 mtime 更新而被重写，内容一致。
- 线上复核：首页 HTTP 200 / 4714 bytes / `Content-Type: text/html`；`app.d46cc601.js` → `text/javascript`、`style.83edcde3.css` → `text/css`、`data/manifest.18a0c16c.json` → `application/json`；抽查 2 组 `thumb.webp` / `view.webp` → `image/webp` 全 200；v1 旧 JS / CSS 也仍 200。
- 线上 JS / CSS 内容抽查确认是 v2：`computeRows` / `layoutJustifiedRows` / `buildHash` / `zoom` / `lb-thumbs` 与 `--night` / `--accent` / `backdrop-filter` / `prefers-reduced-motion` 均在；manifest 为 20 张照片 / 1 个相册 / `site.title = 个人相册`。
- `aws s3 sync --dryrun` 复核输出为空 → 44 个对象（排除 `.build-report.json`）全部同步到位。
- **已知差异（不得据此判 §9 通过）**：S3 website hosting 沿用 v1 的 `ErrorDocument: index.html`，缺失资源返回 200 + 首页 HTML；首页无 `Cache-Control` 响应头，浏览器可能缓存旧首页，验证建议用无痕窗口或强制刷新。正式 CloudFront 按 plan §5.6 不配 `CustomErrorResponses`。
- **未改动**：CloudFront 分发仍未创建（账号验证中）、桶仍公开、website hosting 仍启用、DNS 记录 2 未生成、`.deploy-state.json` 无 `distributionId`。HTTPS / 自定义域名继续冻结。
- **下一步**：用户在线看 v2 效果 → 等 AWS Support 验证通过 → `npm run deploy:init -- --skip-lock` → 输出记录 2 → 用户加记录 2 → 重跑不带开关的 init 完成 Phase D → `npm run deploy`（`--delete` 会清掉 v1 遗留对象）→ T-17 验收。

---

## 交付记录

_（T-18 完成后填写：正式地址、DNS 记录、验收摘要、已知限制、使用说明）_

---

## 完成定义（Definition of Done）

- [ ] T-01 ~ T-18 全部完成
- [ ] `spec/v2/spec.md` §9 上线验收清单全部通过
- [ ] 交付：可重复执行的一条构建发布命令、两条 DNS 记录说明、**HTTPS 正式地址**、IAM 最小权限策略、v1 地址迁移说明、已知限制清单
- [ ] 真实照片放入 `photos/` 后一条命令可重新发布，构建报告可见缓存失效结果
- [ ] 桶已私有、website hosting 已关闭，代码中无 `s3-website` 作为访问地址、无公开读策略残留
- [ ] 验收报告记录首屏实测性能与成本口径

---

## 变更控制

实现中若需改动需求（例如加回明暗主题切换、引入虚拟列表、改用 Amplify、绑定根域、恢复 v1 HTTP 地址），**先回改 `spec/v2/spec.md` 并重新确认**，再更新 plan 与本清单，不直接在代码里偏离。
