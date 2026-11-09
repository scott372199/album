# 个人相册（personal-photo-album）

一个纯静态的私人照片站点：本地一条命令，把 `photos/` 里的照片与短视频重新编码、剥离全部元数据，
生成时间轴 / 相册 / 故事模式 / 照片墙页面，再同步到 S3（经 CloudFront 对外）。

- **没有后端**：Node 只在本地构建时运行，产物是普通静态文件。
- **没有框架**：原生 HTML / CSS / ES Module，前端零运行时依赖。
- **隐私优先**：只发布重新编码后的展示图与短片；GPS、机型、序列号、原始文件名、精确拍摄时刻都不出本机。

## v3 有什么

| 能力 | 说明 |
| --- | --- |
| 短视频 | `.mp4/.mov/.m4v` 转 1080p H.264，最长 30s；同目录同名 `图片+MOV` 自动配成 Live Photo |
| 编辑式栅格 | 大图与 2~3 张小图交替，按年连续排版，月份只作吸顶标签；照片一律不裁切 |
| 故事模式 | 按年分章，章节卡 → 逐张推进，可调速、可暂停，切走自动暂停 |
| 照片墙 | 全屏常驻轮播 + 时钟 + 夜间调光 + 屏幕常亮（需 HTTPS 或 localhost） |
| 热更新 | 常驻页面每 10 分钟问一次 `data/version.json`，有新版只换内容不刷新页面 |
| 直接链接 | `#p=<照片id>` 开灯箱、`#mode=story` 进故事、`#mode=wall` 进照片墙 |
| 三档图 | `thumb` 320w / `grid` 768w / `view` 2048w，另带 24px LQIP 先糊后清 |

## 目录

```
photos/            源照片与视频（gitignore，不入库）
  2026/            一级子目录 = 一个相册
  tags.csv         可选的标题 / 标签覆盖
  .albumignore     排除规则
src/
  build/           扫描、读 EXIF、图片三档、视频转码、manifest
  web/             页面源码（index.html / style.css / js/）
  deploy/          AWS 部署脚本与配置模板
scripts/           样例生成、结构验证、仓库安检
spec/              需求与设计文档（v1 / v2 / v3）
dist/              构建产物（gitignore）
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run samples` | 生成几张测试图片，验证管线是否通 |
| `npm run build` | 扫描 `photos/` → 产出 `dist/` |
| `npm run verify` | 结构断言（不连网、不碰 AWS） |
| `npm run check:repo` | 仓库安检：媒体 / 密钥 / 大文件 / 绝对路径 |
| `npm run hook:install` | 安装本地 pre-commit 钩子（可选） |
| `npm run deploy:preview` | 构建并同步到 S3 预览地址（不带 `--delete`） |
| `npm run deploy` | 构建 → 同步（含 `--delete`）→ 失效入口页 |

部署需要本机已配置 AWS CLI 凭证；脚本不会读取或写入任何密钥到仓库。

## 为什么不把照片放进仓库

1. 照片是**最私密**的资产，一旦推上远端就无法收回（fork / 缓存 / 镜像）。
2. 仓库要能被干净克隆后独立构建，而源素材属于「数据」而不是「代码」。
3. `npm run check:repo` 会在提交前拦下任何图片、视频、>5MB 文件与疑似密钥。

## 隐私边界

- 构建时重编码即剥离 EXIF；视频转码前先取年月用于排序，再清除容器与流上的全部元数据。
- manifest 只包含展示所需字段（id / 相册 / 年月 / 比例 / 路径 / 可选标题标签）。
- 站点本身是公开的：私有桶与私有仓库都**不是访问控制**，真正的防线是构建时脱敏。

## 部署状态

站点域名与 HTTPS 走 CloudFront + ACM；在账号验证完成前，用 S3 静态网站端点做临时预览。
细节见 `spec/v3/plan.md` §10 与 `spec/v2/spec.md` §11。
