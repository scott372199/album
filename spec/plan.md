# 个人相册 · 技术方案（plan）

> Spec-Driven Development · 阶段 2 / 5（Plan）
> 状态：✅ 已确认（2026-11-09，进入 Implement 阶段）　|　版本：v1.2　|　日期：2026-11-09
> 依据：`spec/spec.md` v0.5（已确认）
> **v1.2 变更**：桶名改为 `chenyouyi`，访问地址 `http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`；所有 ARN / 命令由 `src/deploy/config.json` 驱动。

**本文只描述「怎么做」，不重复需求**。实现阶段若发现需要改需求，先回改 spec。

---

## 0. 方案一句话

Node 脚本把 `photos/` 加工成完全静态的 `dist/`（WebP 双档图片 + manifest.json + 无框架前端），一条命令同步到 `ap-southeast-1` 的公开 S3 静态网站桶，直接通过 AWS 提供的 website endpoint 访问：`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`。全程无服务器、无 CDN、无证书、无自有域名、无 DNS 配置、无数据库。

---

## 1. 技术选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 脚本运行时 | Node.js 22（本机 v22.22.2，npm 10.9.7） | 构建与部署脚本统一语言 |
| 前端 | 原生 HTML + CSS + ES Module JS，**无框架、无打包器** | 功能规模小；产物 KB 级、首屏快、无运行时依赖、无需构建工具链 |
| 图片处理 | `sharp`（npm） | 重新编码即剥离 EXIF（**不调用 `.withMetadata()`**），一次生成缩略图与展示图，输出 WebP |
| HEIC 解码 | macOS `sips` 先转临时 JPEG（本机 `/usr/bin/sips` 已验证可用） | sharp 预编译二进制通常不含 HEIC 解码；`sips` 是 macOS 原生、零额外依赖 |
| EXIF 读取 | `exifr`（npm，纯 JS） | 只读取 `DateTimeOriginal` 与宽高，轻量 |
| 部署 | AWS CLI v2（`aws s3` + `aws s3api`） | 已确认方案：装 CLI + 用户在本地配置凭证 |
| 托管 | S3 静态网站（`ap-southeast-1`），HTTP，直连 website endpoint | spec v0.4 |

**依赖**（`package.json`）：`sharp`、`exifr`。前端零依赖。

**明确不引入**：Vite/Webpack、React、Vue、Tailwind、TypeScript、Terraform/CDK、CloudFront、ACM、Route 53、Lambda、ALB、数据库、**自有域名与任何 DNS 记录**。

---

## 2. 目录结构

```
个人相册/
├── spec/
│   ├── spec.md              # v0.4
│   ├── plan.md              # 本文 v1.1
│   └── tasks.md             # v1.1
├── photos/                  # 源照片（用户放入，脚本只读，绝不改动）
│   ├── <相册名>/*.jpg|png|heic|webp
│   └── tags.csv             # 可选：标签 / 标题 / 说明
├── src/
│   ├── build/
│   │   ├── build.mjs        # 主流程编排 + 构建报告
│   │   ├── scan.mjs         # 扫描、去重、相册归属
│   │   ├── exif.mjs         # 拍摄年月读取与兜底
│   │   ├── image.mjs        # HEIC 转换 + sharp 双档输出 + 脱敏校验
│   │   └── manifest.mjs     # manifest / albums 生成
│   ├── deploy/
│   │   ├── deploy.mjs       # 自检 → 建桶 → 配置 → 同步 → 输出
│   │   ├── bucket-policy.json
│   │   └── iam-policy.json
│   └── web/
│       ├── index.html
│       ├── style.css
│       └── app.js
├── scripts/
│   └── make-samples.mjs     # 样例照片生成器
├── dist/                    # 构建产物（gitignore）
├── .build-cache.json        # 增量缓存（gitignore）
├── .gitignore
├── package.json
└── package-lock.json
```

---

## 3. 构建流水线（`npm run build`）

1. **扫描**：递归 `photos/`，取 `.jpg/.jpeg/.png/.heic/.webp`（忽略隐藏文件与 `tags.csv`）。一级子目录名 = 相册；根目录照片归入「未分类」。`photos/.albumignore` 可列出要跳过的相对路径、目录前缀或纯文件名（`#` 为注释），**不改动源文件**；被忽略项计入构建报告。
2. **去重 & ID**：源文件内容 SHA-256 前 12 位作 `id`；相同内容只处理一次（FR-01）。
3. **时间**：`exifr` 读 `DateTimeOriginal` → **只保留 `year` / `month`**；缺失则用文件 mtime 兜底并记入报告（US-04）。不保留具体日、时刻、时区、GPS、机身信息（FR-02）。
4. **HEIC**：`sips -s format jpeg <in> --out <tmp>` 转临时 JPEG，再交 sharp；临时文件用完即删。
5. **双档输出**（sharp，**不调用 `.withMetadata()`**）：
   - `thumb.webp`：宽 320px，quality 72
   - `view.webp`：最长边 2048px，quality 82
   - 输出到 `dist/photos/<id>/`，路径天然带内容哈希 ⇒ 满足 FR-08
6. **脱敏校验**：对产物用 `sharp.metadata()` 断言 EXIF 块不存在，抽查结果写入构建报告。
7. **增量**：`.build-cache.json` 记录 `id → {thumb, view, mtime}`；命中且产物存在则跳过（US-03）。
8. **manifest**：生成 `dist/data/manifest.json`（字段见 §4）与专辑汇总。
9. **前端资源**：拷贝 `src/web/*` 到 `dist/`；对 `app.js` / `style.css` / `manifest.json` 计算内容哈希并改名（`app.<h8>.js` 等），改写 `index.html` 引用。
10. **构建报告**：控制台输出 新增 / 跳过 / 失败 / 无 EXIF 清单，并写 `dist/.build-report.json`。

> **硬性约定**：所有产物资源使用**相对路径**（`./assets/...`、`./photos/...`），不出现 `https://` 或绝对域名，避免 HTTP 页面的混合内容拦截（spec §11.2）。

---

## 4. 数据契约

`dist/data/manifest.<h8>.json`：

```json
{
  "site": { "title": "个人相册", "subtitle": "" },
  "photos": [
    {
      "id": "a1b2c3d4e5f6",
      "album": "2024-京都",
      "year": 2024,
      "month": 4,
      "tags": ["2024-京都", "旅行"],
      "title": "",
      "caption": "",
      "ratio": 1.3333,
      "thumb": "photos/a1b2c3d4e5f6/thumb.webp",
      "view": "photos/a1b2c3d4e5f6/view.webp"
    }
  ],
  "albums": [{ "name": "2024-京都", "count": 42, "cover": "a1b2c3d4e5f6" }]
}
```

**字段白名单之外一律不写入**：原始文件名、源路径、GPS、机身 / 镜头序列号、软件信息、具体拍摄时刻、EXIF 原文，以及构建时间戳（会让内容哈希每次都变，破坏 FR-08 的增量跳过）。manifest 内容只在照片数据变化时变化。

`tags.csv` 可选，列：`id 或 相对路径, tags(用 | 分隔), title, caption`。不提供时标签由子目录名 + 年月自动生成。

`ratio` 用于网格占位（FR-03），避免图片加载时布局跳动。

---

## 5. 前端设计

- **单页** `index.html`：header（标题 / 简介）、视图切换（时间轴 / 相册）、搜索栏、内容区、灯箱 overlay。
- **浅色杂志风** `style.css`：底色 `#FAF9F6`、正文 `#2B2B2B`、衬线标题（`Georgia, "Songti SC", "Noto Serif SC", serif`）、正文无衬线、1px 分割线 `#E5E2DB`、大量留白、CSS Grid 规整列（桌面 4 / 平板 3 / 手机 2）。图片不加边框、圆角、滤镜。
- **时间轴**（FR-03）：按 `year` 倒序 → `month` 倒序，月份标题 sticky，每组显示张数；`aspect-ratio` 占位 + `loading="lazy"` + `decoding="async"`。
- **相册视图**：相册卡片网格 → 进入单个相册后仍按年月分组。
- **搜索**（FR-04）：关键词（标题 / 说明 / 标签，忽略大小写）+ 标签 chips + 年 / 月下拉，三者 AND、输入即渲染（几百条纯内存过滤，无需索引）；无结果空状态 + 清除按钮。
- **灯箱**（FR-05）：全屏 overlay；←/→ 翻页、空格切换 4s 自动播放、ESC 退出、触摸滑动；预加载前后各一张 `view.webp`；焦点管理与 `aria-*`。
- **可访问性**（FR-06）：alt（title 或「相册名 · 年月」）、键盘可达、`:focus-visible`、文字对比度。
- **无外链**：不引用 CDN 字体 / JS，全部本地文件。

---

## 6. AWS 资源与精确配置（v1.1）

| 项 | 值 |
| --- | --- |
| 区域 | `ap-southeast-1`（新加坡） |
| 桶名 | `chenyouyi`（沿用；**不再要求与域名一致**，仍须合法且全局唯一） |
| 静态网站 | IndexDocument / ErrorDocument 均为 `index.html` |
| Website endpoint | `http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com` |
| **访问地址** | **同上，即 S3 网站端点** |
| Block Public Access | 四项全部 `false`（否则公开读策略会被拦截） |
| 桶策略 | Principal `*`，仅 `s3:GetObject`；**不含 `s3:ListBucket`** |
| 自有域名 | `chenyouyi.top` **不使用**；无需 DNS 记录、无需 CNAME、无需备案 |
| 不创建 | CloudFront、ACM 证书、Route 53 托管区 / 记录集、Lambda、ALB、IAM 角色 |

> endpoint 格式已核对 [AWS General Reference](https://docs.aws.amazon.com/general/latest/gr/s3.html)：`ap-southeast-1` 使用**连字符**形式 `s3-website-ap-southeast-1.amazonaws.com`，协议仅 HTTP（该区 Hosted Zone ID `Z3O0J2DXBE1FTB`，本方案不用）。注意部分第三方资料误写成点号形式，部署脚本以官方值为准。
>
> **v1.1**：不再有 CNAME 与 Host 头路由，因此桶名可自由选取；沿用 `chenyouyi` 只为减少改动。桶名集中定义在 `src/deploy/config.json`，改一处即可全量替换。

**桶策略**（`src/deploy/bucket-policy.json`）：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadForStaticWebsite",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::chenyouyi/*"
  }]
}
```

**部署命令序列**（`src/deploy/deploy.mjs` 依次执行，均带 `--region ap-southeast-1`）：

1. `aws s3api head-bucket --bucket chenyouyi` → 检查桶名是否被他人占用；若返回 403（存在但不属于本账号）**立即中止并报告**，由你决定是否改选一个合法桶名（v1.1 起不再受域名约束）。
2. `aws s3api create-bucket --bucket <bucket> --create-bucket-configuration LocationConstraint=ap-southeast-1`
3. `aws s3api put-public-access-block` → 四项 `false`
4. `aws s3api put-bucket-policy --policy file://src/deploy/bucket-policy.json`
5. `aws s3 website s3://<bucket>/ --index-document index.html --error-document index.html`
6. `aws s3 sync dist/ s3://<bucket>/ --delete`
   - `--delete` 会清除桶内非本次产物的对象；该桶专用于本站点，可接受；执行前打印将删除的对象数。
7. 输出 **website endpoint 访问地址**与上传 / 删除统计（**不再输出 CNAME 目标**）。

**一条命令**：`npm run deploy` = `npm run build` + `node src/deploy/deploy.mjs`。
本地预览：`npm run build` 后 `python3 -m http.server 8080 -d dist`。

---

## 7. IAM 最小权限（给本地部署凭证）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCreateBucket",
      "Effect": "Allow",
      "Action": ["s3:CreateBucket"],
      "Resource": "*"
    },
    {
      "Sid": "BucketConfig",
      "Effect": "Allow",
      "Action": [
        "s3:HeadBucket", "s3:GetBucketLocation",
        "s3:PutBucketWebsite", "s3:GetBucketWebsite",
        "s3:PutBucketPolicy", "s3:GetBucketPolicy",
        "s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock",
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::chenyouyi"
    },
    {
      "Sid": "Objects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::chenyouyi/*"
    }
  ]
}
```

- `s3:CreateBucket` 是账户级操作，只能配 `"Resource": "*"`，单独一条 Statement。
- `s3:ListBucket` 是**给部署者**跑 `s3 sync` 用的，与桶策略中对公众禁止列举不冲突。
- 凭证由用户在本地 `aws configure` / `aws configure sso` 配置；脚本只调用 CLI，不读取、不存储、不输出密钥。
- **v1.1**：若桶名更换，需同步替换以上三条 Statement 的 ARN（由 `src/deploy/config.json` 统一驱动生成）。

---

## 8. 成本明细（粗估）

| 项 | 估算 |
| --- | --- |
| S3 Standard 存储（<2GB，`ap-southeast-1`） | ≈ ¥0.4 / 月 |
| PUT 请求（首次千级，之后仅增量） | 一次性 ≈ ¥0.1 |
| GET 请求 + 数据传出 | 低频访问约 ¥1~5 / 月，随访问量线性增长 |
| CloudFront / ACM / 服务器 / 域名 | ¥0（不使用） |
| **合计** | **约 ¥2~6 / 月**，远低于 spec 的 ≤¥15/月 上限 |

> 单价按 S3 常见公开定价粗估，实际以 AWS 定价页与账单为准。S3 直接出站单价高于经 CDN 分发；若日后访问量显著增大，成本可能反超 CDN 方案（spec §11.3）。

---

## 9. 需求 → 实现追溯

| spec 条款 | 落地位置 |
| --- | --- |
| FR-01 输入 / 去重 / 时间兜底 | `scan.mjs` + `exif.mjs` |
| FR-02 脱敏 | `image.mjs`（sharp 重编码）+ `manifest.mjs` 字段白名单 + 产物断言 |
| FR-03 时间轴 / 相册 / 占位 | manifest 的 `year`/`month`/`ratio` + `app.js` 分组 + `style.css` aspect-ratio |
| FR-04 搜索筛选 | `app.js` 内存过滤 + 筛选 UI |
| FR-05 灯箱 / 幻灯片 | `app.js` lightbox 模块 |
| FR-06 视觉 / 可访问性 | `style.css` + `app.js` 焦点管理 |
| FR-07 部署（v0.4 起直连 S3 端点） | `deploy.mjs` + `config.json` + §6 配置 |
| FR-08 增量 / 无缓存 | `.build-cache.json` + 内容哈希文件名 + `s3 sync --delete` |
| US-04 构建报告 | `build.mjs` + `dist/.build-report.json` |
| §8 上线验收 | `tasks.md` T-18 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 桶名 `chenyouyi` 已被占用 | 部署第 1 步 `head-bucket` 检查，403 即中止；v1.1 起可自由改选合法桶名，不再受域名约束 |
| 公开桶被枚举 | 桶策略只放 `s3:GetObject`、禁止 `s3:ListBucket`；验收时验证列举返回 403 |
| EXIF 残留 | sharp 重编码 + 产物 metadata 断言 + 上线抽查 3 张 |
| 混合内容 / 浏览器自动升级 HTTPS | 全部相对路径、无 `https://` 资源；已知限制写入交付说明 |
| 无 CDN 导致速度不确定 | WebP 双档 + 懒加载 + 相邻预加载；上线记录实测值 |
| `s3 sync --delete` 误删 | 桶专用；执行前打印将删除的对象清单与数量 |
| HEIC 依赖 macOS `sips` | 缺失时构建报错并给明确提示；跨平台需换 libheif（列为后续项） |
| AWS CLI / 凭证缺失 | 部署脚本先自检 `aws --version` 与 `aws sts get-caller-identity`，失败则输出安装与 `aws configure` 指引；**不代用户写密钥** |
| `photos/` 为空 | 生成示例占位页并提示，不直接报错；便于先跑通全流程 |
| S3 端点 URL 长、不便分享 | 已知限制；日后若域名备案通过，按 spec §11.3 重开流程绑定自定义域名 |

---

## 11. 本地验证（不需要 AWS 凭证）

- `npm run build` → 检查 `dist/` 结构、manifest 字段、抽查图片无 EXIF、确认无 `https://` 资源引用。
- `python3 -m http.server 8080 -d dist` → 浏览器验证时间轴、相册切换、搜索组合、灯箱键盘 / 触摸、移动端布局。
- `npm run deploy -- --dry-run` → 在不接触 AWS 的前提下核对完整命令序列。
- 用脚本生成少量纯色样例图跑通全流程，**不需要用户先提供真实照片，也不需要 AWS 凭证**。

---

## 12. 下一步

`spec/tasks.md` 已同步为 v1.1。确认 v0.4 spec 与本文后进入 **Implement 阶段**：按 tasks 从 T-01 起逐项实现，完成本地验证后再部署，并按 `spec/spec.md` §8 做上线验收。
