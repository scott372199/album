# 个人相册 · 任务清单（tasks）

> Spec-Driven Development · 阶段 3 / 5（Tasks）
> 状态：✅ 已确认（2026-11-09，进入 Implement 阶段）　|　版本：v1.2　|　日期：2026-11-09
> 依据：`spec/spec.md` v0.5、`spec/plan.md` v1.2
> **v1.2 变更**：桶名改为 `chenyouyi`，访问地址 `http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`；T-13 / T-16 / T-17 / T-18 的验收值同步。

**规则**：任务按依赖顺序编号，每项可独立验证；勾选即代表该项验收通过。实现中若发现需求问题，先回改 spec，不就地变更范围。编号沿用 v1.0 以便追溯，实际执行顺序见「关键路径」。

---

## 0. 总览与分工

| 阶段 | 任务 | 需要 AWS 凭证 | 谁执行 |
| --- | --- | --- | --- |
| P0 骨架 | T-01 | 否 | 我 |
| P1 构建流水线 | T-02 ~ T-07 | 否 | 我 |
| P2 前端 | T-08 ~ T-11 | 否 | 我 |
| P3 本地集成验证 | T-12 | 否 | 我 |
| P4 部署与上线 | T-13、T-14、T-16、T-17、T-18 | 部分 | 我 |
| P4 用户侧操作 | **T-15** | — | **你** |

**关键路径**：T-01 → T-02 → T-04 → T-06 → T-08 → T-12 → T-13 → T-15 → T-17 → T-18。
T-03 / T-05 可与 T-04 并行开发；T-09 / T-10 / T-11 在 T-08 之后可并行；**T-16 与 T-15 可并行**。

> **T-01 到 T-14、T-16 完全不需要 AWS 凭证**，我可以用脚本生成的样例照片先把站点做完并在本地跑通。用户侧只剩 **T-15**：在自己的终端装 AWS CLI 并配置凭证。不再有任何 DNS / 域名 / 备案操作。

---

## P0 · 项目骨架

### T-01 初始化项目与依赖

- **依赖**：无
- **文件**：`package.json`、`package-lock.json`、`.gitignore`、`src/**`、`photos/.gitkeep`
- **内容**：建立 plan §2 的目录结构；`npm install sharp exifr`；配置 `build` / `deploy` / `samples` 脚本；gitignore 排除 `dist/`、`.build-cache.json`、`node_modules/`、`photos/` 内容
- **验收**：① `npm ls --depth=0` 只有 sharp 与 exifr ② 目录结构与 plan §2 一致 ③ `npm run` 能列出三个脚本
- **追溯**：plan §1 §2

---

## P1 · 构建流水线

### T-02 扫描、去重与相册归属

- **依赖**：T-01
- **文件**：`src/build/scan.mjs`
- **内容**：递归扫描 `photos/`，过滤 `.jpg/.jpeg/.png/.heic/.webp`，忽略隐藏文件与 `tags.csv`；一级子目录名 = 相册，根目录归「未分类」；源文件内容 SHA-256 前 12 位作 ID；相同内容合并
- **验收**：① 含 2 个内容相同、文件名不同的样例时只产出 1 个 ID ② 相册名与目录结构一致 ③ 非支持格式被忽略
- **追溯**：FR-01、plan §3.1~3.2

### T-03 EXIF 年月读取与兜底

- **依赖**：T-02
- **文件**：`src/build/exif.mjs`
- **内容**：`exifr` 读 `DateTimeOriginal`，**只保留 year / month**；缺失时用文件 mtime 兜底并标记 `timeFallback`；绝不输出日、时刻、时区、GPS、机身信息
- **验收**：① 有 EXIF 样例得到正确年月 ② 无 EXIF 样例得到年月且被标记 ③ 输出对象中不存在日期时间字符串或 GPS 字段
- **追溯**：FR-01、FR-02、US-04

### T-04 图片双档输出与脱敏

- **依赖**：T-02
- **文件**：`src/build/image.mjs`
- **内容**：HEIC 先用 `sips -s format jpeg` 转临时 JPEG；`sharp` 生成 `thumb.webp`（320w，q72）与 `view.webp`（最长边 2048，q82），输出到 `dist/photos/<id>/`；**不调用 `.withMetadata()`**；临时文件清理；对产物用 `sharp.metadata()` 断言无 EXIF 块
- **验收**：① 两档尺寸符合 ② 产物 `metadata.exif` 为空 ③ HEIC 样例能正常转换 ④ 原始文件不被修改
- **追溯**：FR-02、plan §3.4~3.6、spec §8 抽查项

### T-05 manifest 与 albums 生成

- **依赖**：T-02、T-03
- **文件**：`src/build/manifest.mjs`
- **内容**：按 plan §4 的字段白名单生成 `dist/data/manifest.json`；计算 `ratio`；汇总 `albums`（count、cover 取最新一张）；支持可选 `photos/tags.csv`（标签 / 标题 / 说明）；无 tags.csv 时用目录名 + 年月生成基础标签
- **验收**：① manifest 中不含原始文件名、源路径、GPS、序列号、具体拍摄时刻 ② albums 计数与照片数一致 ③ 提供 tags.csv 时标签正确合并
- **追溯**：FR-02、FR-03、FR-04、plan §4

### T-06 构建编排、内容哈希、增量缓存与报告

- **依赖**：T-03、T-04、T-05
- **文件**：`src/build/build.mjs`、`.build-cache.json`、`dist/.build-report.json`
- **内容**：串联全流程；拷贝 `src/web/*` 到 `dist/`；对 `app.js` / `style.css` / `manifest.json` 加内容哈希并改写 `index.html` 引用；`.build-cache.json` 实现增量跳过；输出 新增 / 跳过 / 失败 / 无 EXIF 清单；扫描产物断言无 `https://` 资源引用
- **验收**：① `npm run build` 成功产出完整 `dist/` ② 二次运行日志显示全部 skipped ③ 报告计数与实际一致 ④ `grep -r "https://" dist/` 无命中
- **追溯**：FR-08、US-04、plan §3.7~3.10、spec §11.2

### T-07 样例照片生成器

- **依赖**：T-01
- **文件**：`scripts/make-samples.mjs`
- **内容**：生成 12~20 张不同尺寸的纯色 / 渐变 JPEG + PNG，分散到 2~3 个相册子目录，跨越多个年月，其中 1~2 张故意去掉 EXIF；写入 `photos/`
- **验收**：① 生成的样例能跑通 `npm run build` ② 时间轴出现多个年月分组 ③ 兜底项出现在构建报告
- **追溯**：plan §11 本地验证、US-04
- **注意**：仅用于开发验证，交付前清空 `photos/` 中的样例或改为可开关的生成脚本

---

## P2 · 前端

### T-08 页面骨架与浅色杂志风样式

- **依赖**：T-06
- **文件**：`src/web/index.html`、`src/web/style.css`
- **内容**：header（站点标题 / 简介）、视图切换、搜索栏、内容区、灯箱容器；CSS 按 plan §5 定义配色 / 字体 / 网格（桌面 4 / 平板 3 / 手机 2）、`aspect-ratio` 占位、`:focus-visible`、无外链
- **验收**：① 静态打开无样式错乱 ② 桌面与 375px 宽度下均无横向溢出 ③ 页面内无任何 `https://` 引用
- **追溯**：FR-06、plan §5

### T-09 时间轴与相册视图

- **依赖**：T-08
- **文件**：`src/web/app.js`
- **内容**：加载 manifest；按 year → month 倒序分组，月份标题 sticky，每组显示张数；相册视图卡片网格并可进入单相册；图片懒加载 + 异步解码；alt 用 title 或「相册名 · 年月」
- **验收**：① 分组顺序与数量正确 ② 时间轴 / 相册切换往返无状态错乱 ③ 图片加载过程中布局不跳动
- **追溯**：FR-03、US-05、US-06

### T-10 搜索与组合筛选

- **依赖**：T-09
- **文件**：`src/web/app.js`
- **内容**：关键词（标题 / 说明 / 标签，忽略大小写）+ 标签 chips + 年 / 月下拉，三者 AND 实时过滤；无结果空状态与清除按钮；筛选状态与视图切换保持一致
- **验收**：① 单条件与三条件组合命中正确 ② 无结果时空状态出现 ③ 清除后恢复全量
- **追溯**：FR-04、US-07

### T-11 灯箱与幻灯片

- **依赖**：T-09
- **文件**：`src/web/app.js`
- **内容**：全屏 overlay；←/→ 翻页、空格切换 4s 自动播放、ESC 退出、触摸滑动；预加载前后各一张 `view.webp`；焦点管理与 `aria-*`；筛选结果集内翻页而非全量
- **验收**：① 键盘四项操作全部生效 ② 移动端滑动翻页生效 ③ 自动播放间隔约 4s 且可暂停 ④ 焦点回到触发元素
- **追溯**：FR-05、FR-06、US-08

---

## P3 · 本地集成验证

### T-12 本地端到端验证

- **依赖**：T-06 ~ T-11
- **文件**：无新增（必要时补 `scripts/verify.mjs`）
- **内容**：`npm run build` → `python3 -m http.server 8080 -d dist` → 逐项检查：时间轴 / 相册 / 搜索组合 / 灯箱 / 响应式；抽查 3 张产物图片无 EXIF；确认 manifest 无敏感字段；确认产物无 `https://` 引用；二次构建全跳过；记录首屏体积
- **验收**：plan §11 全部通过，问题清零；输出一份本地验证结果摘要
- **追溯**：spec §8 中可不依赖线上环境的部分、plan §11

---

## P4 · 部署与上线

### T-13 部署脚本与桶策略（含 dry-run）

- **依赖**：T-12
- **文件**：`src/deploy/deploy.mjs`、`src/deploy/config.json`、`src/deploy/bucket-policy.json`
- **内容**：桶名 / 区域 / endpoint 集中在 `config.json`；自检 `aws --version` 与 `aws sts get-caller-identity`；`head-bucket` 检查桶名占用（403 立即中止）；依次 create-bucket、put-public-access-block（四项 false）、put-bucket-policy、put-bucket-website、`s3 sync --delete`；执行前打印将删除对象数；输出 **website endpoint 访问地址**；提供 `--dry-run` 只打印命令序列不执行
- **验收**：① `--dry-run` 输出的命令序列与 plan §6 完全一致 ② 桶策略 JSON 合法且只含 `s3:GetObject` ③ 无凭证时给出清晰指引而非崩溃 ④ **输出中不含 CNAME 或自定义域名**
- **追溯**：FR-07、plan §6 §10

### T-14 IAM 最小权限与凭证准备指引

- **依赖**：T-13
- **文件**：`src/deploy/iam-policy.json`、交付说明中的配置步骤
- **内容**：落地 plan §7 的三条 Statement 策略（由 `config.json` 生成 ARN）；写明 `aws configure` / `aws configure sso` 步骤、区域 `ap-southeast-1`、「密钥不写入项目文件」约定；**明确不再需要任何 DNS / CNAME / 备案操作**
- **验收**：① 策略 JSON 通过语法校验 ② `s3:CreateBucket` 确在 `Resource: "*"` 的独立 Statement ③ 指引可在无上下文时独立照做
- **追溯**：plan §7、spec §6

### T-15 安装 AWS CLI 与本地凭证配置 【唯一需要你参与的任务】

- **依赖**：T-14
- **执行**：**你**（我会先给出命令并再次征求同意，不擅自安装系统工具、不接触密钥）
- **内容**：`brew install awscli`；在自己的终端运行 `aws configure` 或 `aws configure sso`
- **验收**：① `aws --version` 成功 ② `aws sts get-caller-identity --region ap-southeast-1` 返回账号信息

### T-16 访问地址核对（无自定义域名残留） 【v1.1 改写】

- **依赖**：T-13（可与 T-15 并行）
- **执行**：我
- **文件**：全项目代码与脚本
- **内容**：核对所有访问地址均为 S3 website endpoint；确认代码中不存在把 `http://chenyouyi` 当作独立站点 URL 的引用（该字符串仅可作为桶名出现）、不存在 CNAME / DNS / 备案相关配置；输出最终访问地址供交付
- **验收**：① 全项目 URL 引用均为 `*.s3-website-ap-southeast-1.amazonaws.com` 形式 ② `npm run deploy -- --dry-run` 输出不含自定义域名或 CNAME ③ 最终地址与 plan §6 一致
- **追溯**：spec v0.4 FR-07、§5 Out of Scope

### T-17 首次部署到 S3

- **依赖**：T-15、T-16
- **执行**：我，一条 `npm run deploy`
- **内容**：建桶、配置公开读与网站托管、上传 `dist/`；输出 website endpoint
- **验收**：① 桶位于 `ap-southeast-1` ② **website endpoint 直接访问返回 200** ③ Block Public Access 四项 false、桶策略只放 GetObject ④ 部署日志无错误、输出地址正确

### T-18 上线验收（spec v0.4 §8 逐项）

- **依赖**：T-17
- **执行**：我，逐项核对并输出验收报告
- **内容**：`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com` 可访问；资源无混合内容；静态网站托管已启用；时间轴 / 相册 / 搜索 / 灯箱 / 移动端；抽查 3 张线上图片无 GPS / 序列号 / 原始文件名；桶列举返回 403；新增 1 张照片重跑命令后线上可见且旧照片未重复处理；记录首屏实测性能
- **验收**：spec §8 清单全部勾选，未通过项单独列出并给修复方案

---

## 实现进度（2026-11-09，Implement 阶段）

| 任务 | 状态 | 验证结果 |
| --- | --- | --- |
| T-01 项目骨架 | ✅ | 目录与脚本齐备，sharp + exifr 安装成功 |
| T-02 扫描去重 | ✅ | 16 张样例，相册归属正确 |
| T-03 EXIF 年月 | ✅ | 4 张读到 DateTimeOriginal，12 张 mtime 兜底 |
| T-04 图片与脱敏 | ✅ | 双档 WebP，抽查 3 张无 EXIF |
| T-05 manifest | ✅ | 字段白名单通过，无原始文件名 / GPS / 机身信息 |
| T-06 编排与增量 | ✅ | 二次构建 16 张全部跳过；内容哈希资源名 |
| T-07 样例生成器 | ✅ | 3 个相册 / 16 张 / 10 个年月分组 |
| T-08 页面与样式 | ✅ | 浅色杂志风，响应式 4 / 3 / 2 列 |
| T-09 时间轴与相册 | ✅ | 按年月分组、视图切换 |
| T-10 搜索筛选 | ✅ | 关键词 / 标签 / 年月组合 AND |
| T-11 灯箱幻灯片 | ✅ | 键盘 / 触摸 / 4s 自动播放 / 相邻预加载 |
| T-12 本地端到端 | ✅ | HTTP 全部 200；JS 语法检查通过；无 https 引用 |
| T-13 部署脚本 | ✅ | `--dry-run` 命令序列与 plan §6 一致；桶策略已生成 |
| T-14 IAM 与指引 | ✅ | `iam-policy.json` 已生成 |
| T-15 装 CLI + 配凭证 | ✅ | 用户完成：AWS CLI 2.39.6，账号 `156487532333` 凭证有效 |
| T-16 域名残留核对 | ✅ | 代码 / 脚本 / 产物中无自定义域名、DNS、CNAME 残留 |
| T-17 首次部署 | ✅ | 桶 `chenyouyi` 在 `ap-southeast-1`，36 个对象，website endpoint 返回 200 |
| T-18 上线验收 | ✅ | 见下方验收记录 |

**T-18 上线验收记录（2026-11-09）· `http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`**

| spec §8 项 | 结果 |
| --- | --- |
| 端点可访问返回 200 | ✅ |
| 资源无混合内容（首页 0 处 `https://`） | ✅ |
| 桶区域 `ap-southeast-1` + 静态网站托管启用 | ✅ |
| 时间轴 / 相册 / 搜索 / 灯箱 / 移动端 | ✅ 本地浏览器验证；线上 JS / CSS / 清单 / 图片全部 200 |
| 抽查 3 张线上图片无 EXIF、无敏感字段 | ✅ |
| 桶策略只放 `s3:GetObject`，匿名列举 403 | ✅ |
| 手机与桌面布局 | ✅ CSS 响应式 4 / 3 / 2 列（本地预览） |
| 新增 1 张照片重跑命令、线上可见且旧照片不重复处理 | ⚠️ 以本地等价验证覆盖：二次构建 16 张全跳过、内容哈希稳定；未在线上单独新增演示 |
| 记录首屏实测性能 | ✅ 首页 0.16s / 清单 0.16s / 首屏缩略图 0.19s（本机直连新加坡） |

### 正式发布（2026-11-09 晚，真实照片）

- 用户把真实照片放进 `photos/2026`（25 张 JPG / 58MB），其中混入 5 张开发样例渐变图 `IMG_0001~0005.jpg`。
- 按用户选择采用**非破坏性排除**：新增 `photos/.albumignore` 列出 5 个相对路径；`scan.mjs` 支持按相对路径 / 目录前缀 / 文件名忽略，`build.mjs` 构建报告新增 `ignored` 字段；`plan.md` §3 与 `.gitignore` 同步。**未删除、未移动用户任何照片文件**。
- 构建结果：扫描 25 / 忽略 5 / 产出 20，全部命中增量缓存（新增 0 / 跳过 20），清理 5 个旧样例产物目录。3 张无 EXIF 拍摄时间的照片按文件 mtime 兜底并列入报告。
- 同步预览：上传 44 个对象、删除 33 个旧对象；执行后线上对象数 44。
- 线上验收：清单 `manifest.18a0c16c.json` 含 20 张、相册 `2026`、年月全部落在 2026-01~2026-11；旧样例图与旧清单对象返回 404；抽查 3 张线上图片无 EXIF；首页 0 处 `https://`；匿名列举 403；首页 0.18s。

> 以后新增照片：放进 `photos/2026`（或新建一级子目录作为新相册）→ 跑 `npm run deploy`。不想让某个文件进入站点，把它加进 `photos/.albumignore` 即可。

## 完成定义（Definition of Done）

- [x] T-01 ~ T-18 全部完成
- [x] `spec/spec.md` v0.5 §8 上线验收清单通过（第 8 项以本地等价验证覆盖）
- [x] 交付：可重复执行的一条构建发布命令、`photos/` 使用说明、**S3 website endpoint 访问地址**、IAM 最小权限策略、已知限制说明
- [x] 真实照片可放入 `photos/` 后一条命令重新发布
- [x] 项目中无任何自有域名 / DNS / CNAME / 备案相关残留

## 变更控制

实现中若需改动需求（例如恢复 HTTPS、绑定自定义域名、加原图下载、改视觉风格），**先回改 `spec/spec.md` 并重新确认**，再更新 plan 与本清单，不直接在代码里偏离。
