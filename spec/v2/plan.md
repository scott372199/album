# 个人相册 · 第二版技术方案（plan v2）

> Spec-Driven Development · 阶段 2 / 5（Plan）
> 状态：**已确认**（2026-11-09，进入 Tasks 阶段）　|　版本：v2.0　|　日期：2026-11-09
> 依据：`spec/v2/spec.md` v2.0（已确认）
> v1 基线：`spec/plan.md` v1.2（已封版，原地保留）

**本文只描述「怎么做」，不重复需求**。实现阶段若发现需要改需求，先回改 spec。

---

## 0. 方案一句话

保持 v1 的「Node 构建脚本 → 纯静态 `dist/` → 一条本地命令发布」骨架不变；前端在**无框架、无打包器**的前提下整体重写为 Apple 官网式浅色 / 深色章节版面，并加入不裁切网格、灯箱缩放与 URL hash 分享；部署层把「公开 S3 网站端点」换成 **CloudFront + ACM(us-east-1) + OAC 私有桶 + 自定义域名**，正式地址 `https://photos.chenyouyi.top`。

---

## 1. 技术选型

| 层 | v1 | v2 | 说明 |
| --- | --- | --- | --- |
| 构建运行时 | Node 22 | **沿用** | 本机 v22.22.2 |
| 图片处理 | sharp（重编码剥离 EXIF） | **沿用，零改动** | FR-02 不可降级，不碰 `image.mjs` |
| EXIF / 扫描 / 去重 | exifr + 内容哈希 | **沿用，零改动** | FR-01 原样保留 |
| 前端 | 原生 HTML + CSS + ES Module | **沿用选型，重写实现** | 仍无框架、无打包器、无外部 CDN 资源；保持单文件 `app.js`（见 §3.8） |
| 站点文案 | 硬编码 `SITE` 常量 | **改为根 `site.json`** | FR-10；不改变 manifest 结构 |
| 分发 | 无（直连 S3） | **CloudFront 全球分发** | FR-07 |
| 证书 | 无 | **ACM 公共证书，`us-east-1`** | CloudFront 硬性要求 |
| 源站鉴权 | 公开桶 | **OAC（sigv4 / always）** | 桶私有，仅分发可读 |
| DNS | 无 | **注册商处两条 CNAME** | 用户手动添加，脚本输出清单 |
| 部署 | AWS CLI v2 | **沿用，拆 init / deploy 两步** | 见 §6 |

**明确不引入**：Vite / Webpack / React / Vue / Tailwind / TypeScript / 外部字体 CDN / 分析脚本、CloudFront Function / Lambda@Edge / WAF、Route 53 托管区（DNS 仍在注册商）、服务器 / 数据库 / 容器、Terraform / CDK、Amplify Hosting。

**依赖不变**：`sharp`、`exifr`；前端零依赖。

---

## 2. 目录结构与配置

```
个人相册/
├── spec/
│   ├── spec.md / plan.md / tasks.md     # v1 封版基线，只读保留
│   └── v2/  spec.md / plan.md / tasks.md
├── site.json                            # 新增：{ "title": "个人相册", "subtitle": "" }
├── photos/                              # 沿用：源照片 + .albumignore + 可选 tags.csv
├── src/
│   ├── build/
│   │   ├── scan.mjs / exif.mjs / image.mjs   # 零改动
│   │   ├── manifest.mjs                      # 零改动
│   │   └── build.mjs                         # 改：读 site.json、断言换方向、report 加字段
│   ├── web/
│   │   ├── index.html                        # 重写结构
│   │   ├── style.css                         # 全量重写
│   │   └── app.js                            # 单文件重写（分节，见 §3.8）
│   └── deploy/
│       ├── config.json                       # 改：静态配置唯一真相源
│       ├── aws.mjs                           # 新增：CLI 封装 / 自检 / dry-run / 策略生成
│       ├── distribution-config.mjs           # 新增：生成 DistributionConfig JSON
│       ├── init.mjs                          # 新增：首次引导（证书 / OAC / 分发 / 桶私有化）
│       ├── deploy.mjs                        # 重写：日常一条命令
│       ├── bucket-policy.json                # 由脚本生成（OAC 模板）
│       └── iam-policy.json                   # 由脚本生成
├── .deploy-state.json                       # 新增：运行时资源 ID（gitignore）
├── .build-cache.json                        # 沿用（gitignore）
└── dist/                                    # 沿用（gitignore）
```

**`src/deploy/config.json`**（静态值，改一处即可全量替换）：

```json
{
  "bucket": "chenyouyi",
  "region": "ap-southeast-1",
  "acmRegion": "us-east-1",
  "domain": "photos.chenyouyi.top",
  "siteUrl": "https://photos.chenyouyi.top",
  "indexDocument": "index.html",
  "oacName": "chenyouyi-album-oac",
  "distributionComment": "personal-photo-album-v2"
}
```

**`.deploy-state.json`**（运行时生成，不入库）：`{ accountId, certificateArn, oacId, distributionId, distributionDomainName, dnsRecords, phase }`。资源 ID 一律运行时写回，不硬编码；脚本每次运行都会用 `describe-*` / `get-*` 复核远端状态，state 文件只是缓存。

`.gitignore` 新增两行：`.deploy-state.json`、`src/deploy/distribution-config.json`（后者为运行时生成）。`site.json` **要入库**。

---

## 3. 前端技术方案

### 3.1 版面与章节顺序

自上而下：

1. **毛玻璃 sticky 导航**：站点名 + 视图切换 + 搜索入口；`position: sticky; backdrop-filter: saturate(180%) blur(20px)`。
2. **浅色 hero**：超大无衬线主标题（`clamp(48px, 8vw, 104px)`、负字距）、副标题、一句滚动提示；大量留白。副标题为空时走兜底排版（不塌陷、不占位空白）。
3. **浅色照片区**：时间轴 / 相册视图、筛选工具条、不裁切网格。
4. **深色章节**：全宽近黑区块，承载站点叙事与统计（照片数 / 相册数 / 时间跨度），大字号数字 + 短句，光晕用纯色大面积铺陈，**不用渐变滤镜处理照片**。
5. **深色 footer**：地址信息与收尾。

深浅区块用整块背景切换（`.section--dark`），不靠堆叠分割线。桌面内容最大宽度 1440px，手机 16px 边距。

### 3.2 设计 token（`style.css` `:root`）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--paper` | `#ffffff` | 浅色区块底 |
| `--paper-2` | `#f5f5f7` | 浅色次级面 / 占位骨架 |
| `--ink` | `#1d1d1f` | 浅色主文字 |
| `--ink-2` | `#6e6e73` | 次级说明文字 |
| `--night` | `#000000` | 深色章节底 |
| `--night-ink` | `#f5f5f7` | 深色章节文字 |
| `--accent` | `#0071e3` | 链接 / 焦点 / 选中态（唯一强调色） |
| `--radius` | `18px`（卡片 / 容器） | 照片本身不用 |
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | 统一过渡曲线 |

字体栈：`-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Helvetica Neue", Arial, sans-serif`。**移除 v1 的衬线标题栈**。字号阶梯用 `clamp()` 定义 5 级（hero / section / card / body / caption），字重只用 400 与 600。

### 3.3 不裁切网格（FR-09 核心）

**方案对比**

| 方案 | 优点 | 否决理由 / 取舍 |
| --- | --- | --- |
| CSS `column-count` 瀑布流 | 实现极简、天然不裁切 | 视觉顺序为列优先，与「按年月倒序」和灯箱翻页顺序不一致，键盘 tab 顺序错乱 |
| 等高 grid + `object-fit: contain` | 改动最小 | 竖幅两侧大片留白，观感退回「素」 |
| **JS 分行 justified rows** | **DOM 顺序 = 时间顺序 = 灯箱翻页顺序；完整呈现；观感接近产品级相册** | 需要一次测量与 resize 重算 → **选定** |

**算法**（`app.js` 的 `layoutJustifiedRows()`）：

```
输入：当前月份分组的照片数组（含 photo.ratio = width/height）、容器宽 W、目标行高 H、间距 g
H：桌面 300px / 平板 220px / 手机 150px；g：18 / 14 / 10
逐张累加 sumRatio，估算行高 h = (W - (n-1)*g) / sumRatio
当 h <= H 时结算本行：行内每个 figure 设 flex-grow = ratio，height = h，img 宽高 100%
最后一行不强行拉伸，取 min(h, H)，避免单图撑满整屏
```

- 渲染时先按 `ratio` 给 `figure` 设 `aspect-ratio` 占位，JS 测量后再写成行，减少跳动。
- `ResizeObserver` 监听容器宽度变化重排行（带 100ms 防抖）。
- **降级**：JS 未执行或 `ResizeObserver` 不可用时，回退到 `grid` + `aspect-ratio` + `object-fit: contain`（不裁切，仅留白）。
- 图片仍 `loading="lazy" decoding="async"`，`alt` 沿用 v1 规则。

### 3.4 灯箱增强（FR-09）

在 v1 灯箱模块上扩展，不推翻重来：

- `zoom` 状态（`1 / 2 / 3` 循环）+ 复位；触发方式：工具栏按钮、滚轮、双击、移动端捏合；放大时图片可拖动平移（`transform: translate()`）。
- 底部**缩略图条**：渲染 `state.filtered` 的 thumb，当前项高亮并 `scrollIntoView({inline:'center'})`，点击跳转。
- 「第 N / 共 M 张」计数，与缩略图条同区。
- 切换图片时重置 zoom 与平移。
- **保留**：←/→、ESC、空格 4s 自动播放、触摸滑动、相邻预加载、焦点回到触发元素、`aria-*`。

### 3.5 URL hash 状态（FR-09 / O-07）

- 序列化：`#p=<id>`（单张）、`#view=timeline|album&album=<name>&q=<...>&tag=<...>&year=<...>&month=<...>`。
- 状态变更时 `location.hash` 赋值（产生历史记录），监听 `hashchange` 反向还原 → 满足「刷新 / 前进后退可还原」。
- `init()` 末尾解析 hash：含 `p` 则在数据加载后直接 `openLightbox(indexOf(id))`；id 不存在则回落列表并给出轻提示。
- 分享链接用 `location.href` 复制，指向 `https://` 域名，无需任何服务端重写。
- 筛选条件写 hash 时做 `encodeURIComponent`，解析时容错处理非法值。

### 3.6 动效与可访问性（FR-06）

- 渐显：`IntersectionObserver` 给 `.reveal` 加 `.is-visible`，`transform: translateY(16px) → 0` + `opacity`。
- **降级**：CSS 默认 `.reveal` 为可见；只有 JS 在 `html` 上加 `.js-anim` 后才启用初始隐藏，`prefers-reduced-motion: reduce` 时 JS 跳过 observer 且 CSS 强制可见 —— 保证 JS 失效 / 关闭动效时内容完整可用。
- 深色区块文字对比度 ≥ 4.5:1；`:focus-visible` 在深浅底上都用 `--accent` 且可见；键盘焦点顺序与 DOM 顺序一致（§3.3 选定方案的原因之一）。
- `backdrop-filter` 不可用时导航退化为不透明 `--paper` 底。

### 3.7 `index.html` 结构变化

保留 v1 的四个占位符（`__TITLE__` / `__STYLE__` / `__APP__` / `__MANIFEST__`），构建脚本改动最小。结构改为：sticky `<nav>`、`<header class="hero">`、`<main>`（工具条 + 内容区 + 深色章节）、`<footer>`、灯箱 overlay（新增 zoom 按钮 + 缩略图条容器）。加一个内联 `data:image/svg+xml` favicon 消除 `/favicon.ico` 404 噪音，**不新增文件**。

**不做** OG / Twitter 卡片、分析脚本（v2 未勾选「对外呈现与分享」方向，避免范围蔓延）。

### 3.8 为什么仍是单文件 `app.js`

v1 的 `build.mjs` 只对 `app.js` + `style.css` 两个文件做内容哈希并改写引用。拆成多个 ES module 就要引入模块图解析与路径改写（等于自建打包器），与「无打包器、产物 KB 级」的选型冲突。v2 保持单文件，内部用清晰分节（state / render / justified layout / filters / lightbox / hash router / reveal）组织，预计 600 行左右，仍可维护。

---

## 4. 构建流水线与数据契约

**沿用不变**：扫描 → 去重 → EXIF 年月 → HEIC / sharp 双档 WebP → 脱敏断言 → 增量缓存 → manifest → 内容哈希资源名 → 构建报告。图片处理与 manifest 白名单**一行都不改**（FR-02 硬要求）。

**`build.mjs` 的三处改动**：

1. `SITE` 常量改为读取根目录 `site.json`（缺省兜底 `{title:'个人相册', subtitle:''}`，文件不存在也不报错）。
2. `assertNoHttpsReferences()` → `assertNoInsecureReferences()`：v1 禁止产物出现 `https://`（HTTP 站点保守做法），v2 是 HTTPS 站点，**改为禁止 `http://` 字面量**，防止混合内容；产物仍全部使用相对路径，理论上两者都不出现。函数名与错误文案同步更新。
3. `dist/.build-report.json` 增加 `invalidation: null` 字段；部署成功后由 `deploy.mjs` 回写为 `{ executed, paths, id, status, at }`。该文件已被 `s3 sync --exclude` 排除，回写不影响线上产物、不破坏内容哈希稳定性。

**数据契约**：`manifest.<h8>.json` 结构**完全不变**（`site` / `photos[]` / `albums[]`，字段白名单不动）。`site.json` 只影响 `site.title` / `site.subtitle`，变化时 manifest 哈希自然变化 → 入口页失效后即刻生效。**仍不写入构建时间戳**。

**`npm scripts`**：

```json
{
  "samples": "node scripts/make-samples.mjs",
  "build": "node src/build/build.mjs",
  "deploy": "npm run build && node src/deploy/deploy.mjs",
  "deploy:init": "node src/deploy/init.mjs",
  "deploy:dry": "node src/deploy/deploy.mjs --dry-run"
}
```

---

## 5. AWS 资源与精确配置

### 5.1 资源清单

| 项 | 值 |
| --- | --- |
| S3 桶 | `chenyouyi`，`ap-southeast-1`，**私有**、关闭静态网站托管 |
| 源站域名 | `chenyouyi.s3.ap-southeast-1.amazonaws.com`（REST endpoint，**不是** website endpoint） |
| Block Public Access | 四项全部 `true` |
| 桶策略 | 见 §5.3，仅 CloudFront 服务主体 + `AWS:SourceArn` |
| OAC | `SigningBehavior=always`，`SigningProtocol=sigv4`，`OriginAccessControlOriginType=s3` |
| ACM 证书 | `photos.chenyouyi.top`，DNS 验证，`us-east-1`，SAN 覆盖该域名 |
| CloudFront | 全球分发；Alias = `photos.chenyouyi.top`；`SSLSupportMethod=sni-only`；`MinimumProtocolVersion=TLSv1.2_2021` |
| 正式地址 | `https://photos.chenyouyi.top` |
| 不创建 | Route 53 托管区、WAF、Lambda@Edge、CloudFront Function、Anycast 静态 IP、IAM 角色 |

> DistributionConfig 中 managed cache policy 的 ID **不硬编码**：运行时用 `aws cloudfront list-cache-policies --type managed` 查 `CachingOptimized` 的 `Id` 再填入（托管策略 ID 可能随 AWS 更新，硬编码易失效）。

### 5.2 `DistributionConfig` 关键字段

| 字段 | 值 | 理由 |
| --- | --- | --- |
| `DefaultRootObject` | `index.html` | REST 源站无 website hosting，根路径靠它返回入口页 |
| `Origins[0].DomainName` | 桶 REST endpoint | OAC 要求普通 S3 源站 |
| `Origins[0].S3OriginConfig` | `{}` + `OriginAccessControlId` | 不用 `CustomOriginConfig` |
| `Aliases` | `{Quantity:1, Items:["photos.chenyouyi.top"]}` | 证书 SAN 必须覆盖 |
| `DefaultCacheBehavior.ViewerProtocolPolicy` | `redirect-to-https` | O-04 |
| `DefaultCacheBehavior.CachePolicyId` | 运行时查 CachingOptimized | 内容哈希资源长缓存 |
| `Compress` | `true` | HTML/CSS/JS 压缩（WebP 不再压缩） |
| `ViewerCertificate` | ACM ARN + `sni-only` + `TLSv1.2_2021` | 证书必须在 `us-east-1` |
| `CustomErrorResponses` | **不配置** | 见 §5.6 |
| `Enabled` / `HttpVersion` | `true` / `http2and3` | — |

### 5.3 桶策略（OAC 模板，脚本动态生成）

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::chenyouyi/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::156487532333:distribution/<DISTRIBUTION_ID>"
      }
    }
  }]
}
```

`accountId` 由 `aws sts get-caller-identity` 运行时取得，`distributionId` 由创建分发的返回值取得，均不硬编码。该策略**覆盖** v1 的 `Principal:"*"` 公开读策略。

### 5.4 DNS 记录清单（`init.mjs` 输出，用户在注册商添加）

| # | 类型 | 名称 | 值 | 来源 |
| --- | --- | --- | --- | --- |
| 1 | CNAME | `_<hash>.chenyouyi.top.` | `_<hash>.acm-validations.aws.` | `aws acm describe-certificate` 的 `DomainValidationOptions[].ResourceRecord` |
| 2 | CNAME | `photos.chenyouyi.top.` | `<d111111abcdef8>.cloudfront.net.` | `create-distribution` 返回的 `DomainName` |

> 记录 1 必须先加并等证书签发，才能创建带 Alias 的分发；记录 2 在分发创建后才能拿到值。因此首次引导**天然分两轮**，见 §6.1。子域可直接 CNAME（O-01 选子域的原因）；若改根域需 Route 53 Alias 或 Anycast 静态 IP。

### 5.5 缓存策略与失效（FR-08 / O-10）

- 全站单一 cache behavior + managed `CachingOptimized`：带内容哈希的图片 / JS / CSS / manifest 长缓存，`s3 sync --delete` 删掉的旧对象不再被引用，无需失效。
- **每次日常部署执行一次** `aws cloudfront create-invalidation --distribution-id <id> --paths /index.html`，因为入口页引用新的 manifest 文件名，不失效访客会读到旧清单。
- 不额外给 `/index.html` 加独立 cache behavior（保持 O-10 的最小改动）；若验收出现清单更新滞后，再评估改为 CachingDisabled behavior。
- CloudFront 每月前 1000 个失效路径免费；每次仅 1 个路径，低频发布不会触及计费。

### 5.6 为什么只配 `DefaultRootObject`、不配 `CustomErrorResponses`

v2 用 URL hash 表达所有状态（O-07），浏览器地址始终是 `/`，刷新请求的也是 `/`，`DefaultRootObject` 足以返回 `index.html`。若把 403/404 统一映射为 `/index.html` 200，会让**缺失的图片 / JS 也返回 HTML**，掩盖真实故障、干扰验收排查。因此选择不映射：不存在的资源正常返回错误，分享链接与刷新仍正常工作。

---

## 6. 部署流程

### 6.1 首次引导 `npm run deploy:init`（收敛式状态机，不阻塞等待）

脚本每次运行先复核远端状态，自动推进到「能推进的最远一步」，遇到需要用户操作就打印清单并退出；用户操作完**重跑同一条命令**继续。

| Phase | 条件 | 动作 |
| --- | --- | --- |
| A · 证书 | state 无 `certificateArn` | `aws acm request-certificate --domain-name photos.chenyouyi.top --validation-method DNS --region us-east-1` → `describe-certificate` 取 `ResourceRecord` → **输出 DNS 记录 1** → 写入 state → 退出 |
| B · 等签发 | 有 ARN，`Certificate.Status != ISSUED` | `aws acm wait certificate-validated` 或状态轮询；未签发则提示「请先在 DNS 添加记录 1，生效后重跑本命令」并退出 |
| C · 基础设施 | `Status == ISSUED`，state 无 `distributionId` | 创建 OAC → 查 managed cache policy ID → 生成 `distribution-config.json` → `aws cloudfront create-distribution --distribution-config file://...` → 写入 state → **输出 DNS 记录 2** |
| D · 收紧桶 | 有 `distributionId` | `get-caller-identity` 取账号 → 生成并 `put-bucket-policy`（OAC 模板）→ `put-public-access-block` 四项 `true` → `delete-bucket-website` → 提示「v1 HTTP 端点已下线」 |
| E · 等分发 | `Distribution.Status == InProgress` | 提示「分发部署中，稍后重跑本命令或执行 `npm run deploy`」，**不阻塞挂起** |
| F · 就绪 | `Status == Deployed` | 输出正式地址 `https://photos.chenyouyi.top`，提示执行 `npm run deploy` 上传产物 |

> **切换顺序很关键**：先创建分发（此时桶仍是 v1 的公开状态，OAC 签名请求可正常回源），**再**收紧桶策略与 Block Public Access。反过来会让 CloudFront 在配置完成前拿到 403，造成线上短暂不可用。回滚只需把 v1 的公开桶策略与 website hosting 重新写回。

所有步骤支持 `--dry-run`：只打印完整命令序列与将要输出的 DNS 清单，**不接触 AWS**。

### 6.2 日常发布 `npm run deploy`（spec FR-07 的「一条命令」）

`npm run build` → `node src/deploy/deploy.mjs` 依次执行：

1. 自检 `aws --version`、`aws sts get-caller-identity`；从 state / 远端取 `distributionId`，缺失则明确提示先跑 `npm run deploy:init`。
2. `aws s3 sync dist/ s3://chenyouyi/ --region ap-southeast-1 --delete --exclude '.build-report.json'`（执行前打印将删除对象数）。
3. `aws cloudfront create-invalidation --distribution-id <id> --paths /index.html`。
4. 回写 `dist/.build-report.json` 的 `invalidation` 字段（不上传该文件）。
5. 输出：新增 / 跳过 / 删除统计、失效 ID、`https://photos.chenyouyi.top`。

`--dry-run` 打印以上命令序列，不做任何 AWS 调用。

### 6.3 幂等与共用模块

- `aws.mjs` 封装 `run(args, {allowFail})`、`selfCheck()`、`generatePolicies(state)`、`printDnsRecords()`；所有 AWS 调用统一走它，便于 dry-run 与错误处理。
- 证书 / OAC / 分发均**先查后建**（`list-certificates` / `list-origin-access-controls` / `list-distributions` + comment 匹配），重复运行不产生重复资源与重复计费。
- 若需更新分发，走 `get-distribution-config` 取 `ETag` → `update-distribution --if-match <ETag>`，避免并发覆盖。

### 6.4 临时预览通道 `npm run deploy:preview`（实施补充，2026-11-09）

CloudFront 账号验证等待期间，为在线查看 v2 效果新增的**过渡命令**；不改变 §5 / §6.1 / §6.2 的正式架构（详见 spec §11.5）。实现在 `src/deploy/preview.mjs`：

| 命令 | 行为 |
| --- | --- |
| `npm run deploy:preview` | `npm run build` → 备份线上 `index.html` → `aws s3 sync dist/ s3://chenyouyi/ --region ap-southeast-1 --exclude '.build-report.json'` |
| `npm run deploy:preview:dry` | 只打印计划，不接触 AWS |
| `npm run deploy:preview:rollback` | 从 `.rollback-v1/index.html` 恢复 v1 入口页 |

**刻意不做的四件事**（`scripts/verify.mjs` 已加断言守住，防止误改）：

1. **不加 `--delete`**：v1 的 `assets/app.<旧哈希>.js` / `style.<旧哈希>.css` 留在桶里，回滚后 v1 立即可用。
2. 不做 CloudFront 缓存失效（此时还没有分发）。
3. 不改桶策略 / Block Public Access / website hosting，不动 OAC。
4. 不绑定域名，不写 `.deploy-state.json`（正式引导的状态机不受污染）。

备份只写一次：`.rollback-v1/index.html` 已存在时跳过，避免重复运行把 v2 首页当成「v1 备份」覆盖、导致回滚失效；该目录已加入 `.gitignore`。

**过渡期与正式站点的行为差异**：S3 website hosting 沿用 v1 的 `ErrorDocument: index.html`，缺失资源返回 200 + 首页 HTML；正式 CloudFront 按 §5.6 不配 `CustomErrorResponses`，缺失资源为 403/404。首页响应头也没有 `Cache-Control`（浏览器可能缓存旧首页，验证时建议无痕窗口或强制刷新）。因此临时预览**只能验视觉与交互，不能替代 §9 上线验收**。

账号验证通过后：`npm run deploy:init -- --skip-lock`（复用已有 OAC、创建分发、输出 DNS 记录 2）→ 用户加记录 2 → 重跑不带开关的 `npm run deploy:init` 完成 Phase D → `npm run deploy`（`--delete` 清掉 v1 遗留对象并失效 `/index.html`）→ T-17 验收。

---

## 7. IAM 最小权限（本地部署凭证）

在 v1 S3 三条 Statement 上调整并新增三组（`src/deploy/iam-policy.json` 由脚本生成）：

| Sid | Action | Resource |
| --- | --- | --- |
| `BucketConfig` | `s3:HeadBucket, GetBucketLocation, PutBucketPolicy, GetBucketPolicy, DeleteBucketWebsite, PutPublicAccessBlock, GetPublicAccessBlock, ListBucket` | `arn:aws:s3:::chenyouyi` |
| `Objects` | `s3:PutObject, GetObject, DeleteObject` | `arn:aws:s3:::chenyouyi/*` |
| `AcmCertificate` | `acm:RequestCertificate, DescribeCertificate, ListCertificates` | `*` |
| `AcmManaged` | `acm:ListTagsForCertificate`（可选） | `*` |
| `CloudFrontSetup` | `cloudfront:CreateDistribution, GetDistribution, GetDistributionConfig, UpdateDistribution, ListDistributions, CreateInvalidation, GetInvalidation, CreateOriginAccessControl, GetOriginAccessControl, ListOriginAccessControls, ListCachePolicies, TagResource` | `*` |
| `CloudFrontRead` | `cloudfront:ListDistributions` 已在上一组覆盖 | `*` |

- **移除** v1 的 `s3:CreateBucket`（桶已存在）、`PutBucketWebsite / GetBucketWebsite`（改用 `DeleteBucketWebsite`）。
- ACM / CloudFront 的资源级权限基本不受支持，只能 `Resource: "*"`，与 v1 `s3:CreateBucket` 同理。
- `s3:ListBucket` 是给部署者跑 `s3 sync` 用的；**桶策略里不含 `s3:ListBucket`**，公众仍无法枚举。
- `acm:*` 命令固定带 `--region us-east-1`；CloudFront 为全球服务不带区域。
- 凭证仍由用户在本地 `aws configure` / `aws configure sso` 配置，脚本不读取、不存储、不输出密钥。

---

## 8. 成本（粗估，实际以 AWS 定价页与账单为准）

| 项 | 估算 |
| --- | --- |
| S3 存储 / PUT | ≈ ¥0.5 / 月，与 v1 持平 |
| CloudFront 请求 + 出站 | 有长期免费额度，低频访问预计 ¥0~几元 / 月 |
| CloudFront 缓存失效 | 每次 1 个路径，月 1000 路径内免费 |
| ACM 公共证书 | ¥0 |
| DNS | 注册商已有，无 Route 53 托管区费用 |
| 域名 | 已持有 |
| **合计** | **预计仍在 ¥15/月上限内**，且比 v1 多了 CDN 加速与 HTTPS |

> 主要变化：v1 是「S3 直接出站」，v2 是「CloudFront 出站」，单价口径不同；上线后按账单记录一个月实测值，与 spec §5 对照。

---

## 9. 需求 → 实现追溯

| spec v2 条款 | 落地位置 |
| --- | --- |
| FR-01 输入 / 去重 / 时间兜底 | `scan.mjs` / `exif.mjs`（零改动） |
| FR-02 脱敏 + 私有桶加固 | `image.mjs` / `manifest.mjs`（零改动）+ `init.mjs` 桶策略与 PAB |
| FR-03 时间轴 / 相册 | `app.js` 分组渲染 + §3.3 网格 |
| FR-04 搜索筛选 | `app.js` 内存过滤 + hash 同步 |
| FR-05 灯箱基础 | `app.js` lightbox 分节（沿用 v1 逻辑） |
| FR-06 Apple 风格视觉 | `style.css` 全量重写 + `index.html` 结构 + §3.6 动效 |
| FR-07 HTTPS / 域名 / OAC | `init.mjs` + `distribution-config.mjs` + `config.json` + §5 |
| FR-08 更新与缓存失效 | `deploy.mjs` + `build.mjs` report 字段 + §5.5 |
| FR-09 不裁切 / 灯箱增强 / 分享状态 | `app.js` justified rows / lightbox / hash router |
| FR-10 站点文案 | 根 `site.json` + `build.mjs` |
| §7 用户侧 DNS 操作 | `init.mjs` Phase A / C 输出记录清单 |
| §9 上线验收 | `tasks.md` 的验收任务 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 证书 DNS 验证卡住 | 收敛式状态机：输出精确记录清单后退出，重跑即续；不挂起等待 |
| 忘记证书必须在 `us-east-1` | `config.json` 单列 `acmRegion`，所有 ACM 调用强制带该参数；dry-run 可核对 |
| 桶收紧顺序错误导致线上 403 | §6.1 固定「先分发、后收紧」，并给出回滚步骤 |
| 新照片发布后访客看不到 | `deploy.mjs` 把 invalidation 设为**必须成功**步骤，失败即非零退出并在报告标红 |
| 缺资源被错误映射成首页 | §5.6 明确不配 `CustomErrorResponses` |
| 分发创建 / 更新传播慢 | Phase E 只提示不阻塞；验收以 `Status == Deployed` 为准 |
| managed cache policy ID 变化 | 运行时查询，不硬编码 |
| 内地访客跨境速度不确定 | spec §11.3 已接受；上线记录实测值与 v1 的 0.18s 对照 |
| justified rows 引起布局跳动或卡顿 | `aspect-ratio` 预占位 + `ResizeObserver` 防抖 + 无 JS 降级；几百张规模卡顿列为已知限制（不做虚拟列表） |
| URL hash 与筛选状态互相打架 | 统一一处 `serializeState()` / `restoreState()`，非法值容错回落全量 |
| `s3 sync --delete` 误删 | 沿用 v1：执行前打印将删除对象数；桶专用 |
| 公开桶下线后 v1 地址仍被分享 | 交付说明写明地址迁移；不保留跳转（O-08） |

---

## 11. 本地验证（不需要 AWS 凭证 / 不需要 DNS）

- `npm run build`：检查 `dist/` 结构、manifest 字段白名单、抽查 3 张图无 EXIF、产物**无 `http://` 引用**、`site.json` 改动能反映到 manifest、`invalidation` 字段初始为 `null`。
- `python3 -m http.server 8080 -d dist`：桌面 1440 / 平板 768 / 手机 375 逐项验证深浅章节、hero、不裁切网格（横竖幅各一）、筛选组合、空状态、灯箱键盘 / 缩放 / 缩略图条、hash 分享链接在新窗口与刷新下还原、前进后退、reduced-motion 下动效关闭、键盘焦点顺序、无横向溢出。
- `npm run deploy:dry` 与 `node src/deploy/init.mjs --dry-run`：核对完整命令序列、区域参数（`ap-southeast-1` / `us-east-1`）、OAC 桶策略 JSON、两条 DNS 记录清单，**不接触 AWS**。
- 纯函数校验：`scripts/verify.mjs` 对 justified rows 分行、hash 序列化 / 反序列化做断言（可选但建议）。
- 二次 `npm run build` 应全部 skipped，`index.html` 与 manifest 哈希稳定。

---

## 12. 下一步

**本文为待确认稿，确认前不写 `tasks.md`、不改动任何代码。**

请重点确认：§3.3 不裁切网格选 justified rows（而非 CSS 瀑布流）、§3.8 保持单文件 `app.js`、§5.6 不配 `CustomErrorResponses`、§6.1 首次引导采用「收敛式状态机、重跑续跑」而非一次阻塞等待、§7 IAM 权限范围。

确认后进入 **Tasks 阶段**：产出 `spec/v2/tasks.md`，按依赖顺序拆解任务，每项含依赖 / 文件 / 内容 / 验收标准 / 追溯条款，并标出需要你操作 DNS 的任务；写完再次停下等确认。
