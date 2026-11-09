# 个人相册 · 第三版技术方案（plan v3）

> Spec-Driven Development · 阶段 2 / 5（Plan）
> 状态：**已确认**（2026-11-09；§15 五项按建议默认执行）　|　版本：v3.1　|　日期：2026-11-09
> 上游：`spec/v3/spec.md` v3.1（已确认）
> 本文回答「怎么做」：模块划分、算法、参数、协议、降级路径。凡 spec 已锁定的需求，本文只做实现映射，不改需求。

---

## 1. 技术总览与不变量

### 1.1 不变量（v3 不得突破）

1. **纯静态**：产物只有 HTML / CSS / JS / 图片 / 视频 / JSON；无服务端、无数据库、无边缘函数。
2. **构建时脱敏**：产物中不存在原始文件名、路径、GPS、设备标识、拍摄具体时刻；视频与照片同级。
3. **照片不裁切、不滤镜、不加边框**：任何版式都必须用「容器适配画面」，不允许 `object-fit: cover` 裁掉画面内容（唯一例外见 §4.3 的 hero 说明）。
4. **前端零依赖**：不引入框架、动效库、外部 CDN 字体；所有能力用原生 API + 渐进增强。
5. **一条命令**：构建与发布仍是 `npm run build` / `npm run deploy`，新增媒体类型不增加手工步骤。
6. **manifest 内容稳定**：不写入时间戳，否则内容哈希每次变化，增量上传失效。

### 1.2 技术栈增量

| 能力 | 选型 | 理由 |
| --- | --- | --- |
| 视频转码 | 本机 `ffmpeg` / `ffprobe`（已在 `/usr/local/bin`） | 零 npm 依赖；能精确控制元数据、旋转、码率 |
| 视频探测 | `ffprobe -print_format json` | 拿宽高、旋转、时长、音轨、`creation_time` |
| 图片三档 + 占位 | 现有 `sharp` | 已用于剥离 EXIF，扩展档位成本最低 |
| 前端模块化 | 原生 ESM + **目录级哈希**（§4.1） | 不引打包器，同时保证缓存可失效 |
| 动效 | CSS 滚动驱动（`animation-timeline: view()`）+ IntersectionObserver 兜底 | Safari 26+ 原生；旧版降级 |
| 转场 | View Transitions API（`document.startViewTransition`） | 一条 API 换「高级感」，不支持则淡入 |
| 屏幕常亮 | Screen Wake Lock | 唯一标准方案；受限条件见 §6.2 |
| 热更新 | `data/version.json` 轮询 + 已哈希 manifest | 不刷新页面即可并入新内容 |

### 1.3 明确不引入

打包器（Vite/Rollup）、框架、GSAP/Framer、Service Worker、PWA、HLS、WebGL、CSS-in-JS、TypeScript。

---

## 2. 目录与模块结构

### 2.1 新增 / 变化的文件

```
src/
  build/
    build.mjs          [改] 编排：媒体类型分支、三档、version.json、web 目录复制
    scan.mjs           [改] 识别视频扩展名；Live Photo 配对；返回 media 类型
    exif.mjs           [不变]
    image.mjs          [改] 三档图 + LQIP（保留脱敏断言）
    video.mjs          [新] ffprobe 探测 / ffmpeg 转码 / 封面 / 脱敏断言
    media.mjs          [新] 统一入口：按类型分发到 image.mjs / video.mjs
    manifest.mjs       [改] v3 字段（type / duration / poster / src / lqip / featured）
    site.mjs           [新] site.json 读取与默认值收敛、featured 解析
  web/
    index.html         [改] 结构：hero / 章节骨架 / 故事层 / 照片墙层
    style.css          [改] 视觉系统 + 各模块样式（仍单文件）
    js/
      main.js          [新] 启动、路由、视图切换
      state.js         [新] 状态 + hash 编解码（沿用 v2 纯函数并扩展）
      data.js          [新] manifest 载入、索引、筛选、分章
      gallery.js       [新] 编辑式栅格渲染 + 分批 + 图片档位
      lightbox.js      [新] 图片/视频灯箱、缩放、缩略图条
      story.js         [新] 故事模式播放器
      wall.js          [新] 照片墙模式
      motion.js        [新] 渐显、视差兜底、View Transitions 封装
      update.js        [新] version.json 轮询与热更新
      ui.js            [新] DOM 助手、toast、时间格式化
scripts/
  check-repo.mjs       [新] 仓库安检
  install-hooks.mjs    [新] 可选：写入 .git/hooks/pre-commit
  make-samples.mjs     [改] 增加合成短视频样例（无真实素材时跑通链路）
  verify.mjs           [改] 19 → 约 32 条断言
spec/v3/               [已存在] spec.md / plan.md / tasks.md
README.md              [新]
```

### 2.2 依赖方向（禁止反向引用）

```
main.js → state.js, data.js, gallery.js, lightbox.js, story.js, wall.js, update.js, ui.js
gallery.js → ui.js, motion.js, media(播放控制内联)
lightbox.js → ui.js, motion.js
story.js → ui.js
wall.js → ui.js, update.js(仅取版本)
state.js / data.js / ui.js → 无本地依赖（保持可单测）
```

`state.js` 与 `data.js` 不触碰 DOM，保持纯函数，便于 Node 直接 import 做断言（沿用 v2 的 `buildHash` / `parseHashString` 已导出的做法）。

---

## 3. 构建流水线

### 3.1 流程

```
scanPhotos
  ├─ 图片 → readTakenAt(年月) → processImage（三档 + LQIP）
  └─ 视频 → probeVideo（宽高/旋转/时长/音轨/creation_time）
              → 取年月（creation_time 缺失回退 mtime）
              → transcodeVideo（H.264 + 清元数据 + faststart）
              → extractPoster（sharp 出 poster.webp + LQIP）
  → buildManifest（字段白名单）
  → 写 data/manifest.<hash>.json
  → 写 data/version.json（{rev, manifest, counts}）
  → 复制 web：index.html（占位替换）、style.css、js/ 目录哈希
  → assertNoInsecureReferences（遍历全部文本产物）
  → 清理陈旧 photos/<id>
  → 写 .build-cache.json / .build-report.json
```

### 3.2 媒体识别与 Live Photo 配对

- 图片：`.jpg .jpeg .png .heic .heif .webp`（沿用）；动图 `.gif` 与动画 WebP 走「动效」分支（§3.4）。
- 视频：`.mp4 .mov .m4v`。
- **Live Photo 配对（O-10 开启）**：同一目录、同名不同扩展（`IMAGE_EXT + VIDEO_EXT`）视为一条内容。
  - 主内容 = 图片，动效 = 视频；manifest 里 `type: "live"`，同时带 `view`（静图）与 `src`（短片）+ `poster`。
  - `id = sha256(imageHash + videoHash).slice(0,12)`，任一变化都会换 id，避免缓存串味。
  - 配对失败（只有一侧）则各自独立成条，不报错。
- 去重仍按内容哈希；`photos/.albumignore` 对视频同样生效。

### 3.3 图片三档 + LQIP

| 档 | 参数 | 用途 |
| --- | --- | --- |
| `thumb.webp` | 宽 320、`withoutEnlargement`、q 70 | 手机小图、灯箱缩略图条 |
| `grid.webp` | 宽 768、q 76 | 平板/桌面的小图与大图 |
| `view.webp` | 长边 2048、`fit: inside`、q 82 | 灯箱、照片墙、hero |
| `lqip` | 24px 宽、q 40、base64 内联 | 占位，先糊后清 |

- 全部 `sharp().rotate()` 后重编码，**不调用 `.withMetadata()`**；每档都断言 `metadata().exif === undefined`。
- `ratio = width / height`（旋转后），保留 4 位小数，写入 manifest 用于占位与排版。
- `sizes` 与 `srcset` 由前端按栅格位置生成（§4.4），构建只保证三档存在。

### 3.4 视频转码（精确参数）

```bash
# 1) 探测
ffprobe -v error -print_format json -show_format -show_streams input.mov

# 2) 转码（最长边 1920、≤30s、清元数据、faststart）
ffmpeg -y -hide_banner -loglevel error \
  -i input.mov \
  -t 30 \
  -map_metadata -1 -map_chapters -1 -fflags +bitexact \
  -vf "scale=W:H:flags=lanczos,fps=fps=30" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -crf 23 -preset medium -g 60 \
  -movflags +faststart \
  -c:a aac -b:a 96k -ar 44100 -ac 2 \
  output.mp4

# 无音轨时：把 -c:a ... 换成 -an

# 3) 封面（取 min(1s, duration/3) 处，PNG 中间文件 → sharp 转 webp）
ffmpeg -y -ss 1 -i output.mp4 -frames:v 1 -f image2 frame.png
```

- **W / H 由 JS 计算**：读 `ffprobe` 的宽高与 `side_data_list[].rotation`；旋转 90/270 时交换宽高；再按「最长边 1920、偶数对齐」缩放。
- **`creation_time` 必须在转码前读取**（`format.tags.creation_time` 或 `stream.tags`），只取年 / 月；缺失回退文件 mtime，并写入构建报告。
- **体积兜底**：`crf 23` 后若 > 20MB，用 `crf 28` 重编一次；仍超则丢弃视频、只保留封面按静图处理，报告标记 `degraded`。
- **脱敏断言（必须执行）**：对 `output.mp4` 再跑一次 `ffprobe -print_format json`，检查
  - `format.tags` 不含 `location` / `com.apple.quicktime.*` / `creation_time`
  - 各 stream 的 `tags` 不含 `make` / `model` / `handler_name`（`handler_name` 允许 `VideoHandler`）
  - 断言通过才写入 dist；失败即抛错中止构建。
- **动图（GIF / 动画 WebP）**：尝试 `ffmpeg -i a.gif -movflags +faststart -pix_fmt yuv420p -vf "fps=20,scale=..."` 转 mp4；失败则原样复制为 `anim.webp` / `anim.gif` 并标 `type: "animation"`（仍算动效，前端按静音循环 `<img>` 或 `<video>` 播放）。

**实测样本（`photos/2026/IMG_2265.MOV`，2026-11-09 探测）**

| 项 | 实测值 | 对实现的影响 |
| --- | --- | --- |
| 体积 / 时长 | 164MB / 30.37s | 超过 30s → 截到 30s；源文件不入库 |
| 分辨率 / 旋转 | 3840×2160 + `rotation: -90` | 自动旋转后实际是 **2160×3840 竖屏**；缩放必须按旋转后的宽高算，最长边 1920 → 输出 1080×1920 |
| 帧率 / 码率 | 30fps / 45Mbps | 转码后预计 8~15MB（crf 23），降幅一个数量级 |
| 音轨 | AAC，存在 | 保留音轨，网格与照片墙静音播放 |
| 元数据 | `location.ISO6709 = +26.0658+119.2813`、`make=Apple`、`model=iPhone 15 Pro`、`software=26.2.1`、`creation_time` | **GPS、机型、系统版本、完整时间戳全都有**；这正是 §3.4 脱敏断言要拦下的内容，也是 v3 视频必须走转码而不是直传的直接理由 |

> 该样本同时验证了「先读时间、后清元数据」的必要性：转码前必须从 `com.apple.quicktime.creationdate` 取到 2026-10，否则排序信息会被一起抹掉。

### 3.5 manifest v3（字段白名单）

```json
{
  "site": { "title": "个人相册", "subtitle": "" },
  "hero": "<photo id>",
  "photos": [
    {
      "id": "0efe65e6e198",
      "type": "image",
      "album": "2026",
      "year": 2026,
      "month": 5,
      "tags": ["2026", "旅行"],
      "title": "",
      "caption": "",
      "ratio": 1.5,
      "thumb": "photos/<id>/thumb.webp",
      "grid": "photos/<id>/grid.webp",
      "view": "photos/<id>/view.webp",
      "lqip": "data:image/webp;base64,....",
      "featured": false
    },
    {
      "id": "a1b2c3d4e5f6",
      "type": "video",
      "album": "2026",
      "year": 2026,
      "month": 5,
      "tags": ["2026"],
      "ratio": 0.5625,
      "poster": "photos/<id>/poster.webp",
      "src": "photos/<id>/clip.mp4",
      "duration": 12.4,
      "lqip": "data:image/webp;base64,....",
      "featured": false
    }
  ],
  "albums": [{ "name": "2026", "count": 12, "cover": "<id>", "coverType": "video" }]
}
```

- **禁止出现**：`srcPath`、`rel`、原始文件名、`size`、`mtime`、具体日/时/分、GPS、设备型号、`hasAudio`。
- `type`：`image` | `video` | `live` | `animation`。
- `live` 同时有 `view` 与 `src`；`animation` 只有 `src`（或 `anim.*`）。
- `featured` 由 `site.json.featured` 或 `photos/tags.csv` 中 `featured` 标签决定。
- 排序：`year desc → month desc → id asc`（沿用 v2，保证稳定）。

### 3.6 增量缓存

`.build-cache.json` v3 结构：

```json
{ "version": 3, "items": { "<id>": { "v": 3, "type": "image", "thumb": {}, "grid": {}, "view": {}, "lqip": "..." } } }
```

- 复用条件：`entry.v === 3` 且三档文件都存在。
- **升级即失效**：v2 缓存 `version: 2`，v3 首次构建会全量重跑（一次性成本，20 张照片约 10 秒）。
- 视频额外记录 `sourceBytes`，避免「同名不同内容」被误复用（id 已是内容哈希，属双保险）。

### 3.7 构建报告新增字段

```json
{
  "photos": 20, "videos": 2, "livePairs": 1, "animations": 0, "degraded": [],
  "videoSeconds": 26.4, "videoBytes": 7340032,
  "galleryBytesEstimate": 52428800,
  "manifestBytes": 18234
}
```

`galleryBytesEstimate` = 一次轮播（全部条目）所需字节，用于回答「照片墙一天要跑多少流量」。

---

## 4. 前端架构

### 4.1 模块加载：目录级哈希

不做 import 重写、不做打包器。做法：

1. 计算 `js/` 下全部文件内容的合并哈希 `h`。
2. 复制到 `dist/assets/js.<h>/`，**保持相对路径不变**（`./state.js` 在目录内自然解析）。
3. `index.html` 里写 `<script type="module" src="assets/js.<h>/main.js">`。

好处：任一模块改动 → 目录名变化 → 全链路失效；未改动时目录名稳定 → 长缓存有效。代价：改一个文件会让所有模块重新下载，但总量只有几十 KB。

### 4.2 状态与 URL

`state`（沿用 v2 结构并扩展）：

```js
{
  view: 'timeline' | 'album',
  album, q, tag, year, month,
  filtered: [],
  mode: null | 'story' | 'wall',
  lightbox: { index, zoom, panX, panY, ... },
  story: { index, chapter, pace, paused },
  wall: { index, interval, clock, night },
}
```

hash 扩展（保持 v2 兼容）：

| 字段 | 含义 |
| --- | --- |
| `view` / `album` / `q` / `tag` / `year` / `month` / `p` | 沿用 v2 |
| `mode=story` | 进入故事模式；范围由当前筛选 + `album` 决定 |
| `mode=wall` | 进入照片墙 |
| `pace` | `slow` / `normal` / `fast`（仅 story） |

- 进入 story / wall：`history.pushState`；退出：`replaceState` 回原 hash 并恢复 `scrollY`。
- `popstate` / `hashchange` 仍用 `lastAppliedHash` 去重（v2 机制不变）。
- `state.js` 保持纯函数：`buildHash(snapshot)` / `parseHashString(raw, snapshot)`，Node 可直接断言。

### 4.3 编辑式栅格（核心算法）

目标：**大图—小图交替的节奏**，且任何情况下不裁切。不做瀑布流（高度不可控），不做等高均质（v2 的病根）。

**行模型**：整页不是「列」，而是一串「行」，每行两种类型：

- `feature`：整行 1 张，宽度 = 容器宽，高度 = `clamp(containerWidth / ratio, minH, maxH)`，画面 `object-fit: contain`，多余空间用中性底色，左右居中。
- `strip`：整行 2~3 张，行高由总宽度反解，使每张正好填满 `width / ratio`，**紧密无缝**（v2 justified 的核心优势）。

**节奏规则（决定哪些进 feature）**：

1. 章节首项必为 `feature`。
2. `featured === true` 的条目必为 `feature`。
3. 视频条目优先进入 `feature`（动的东西值得大）。
4. 其余每 `6` 项插入一个 `feature`（`featureEvery`，可按断点调）。

**伪代码**：

```js
export function computeEditorialRows(items, width, opts) {
  const { gap, target, maxPerRow, featureMin, featureMax, featureEvery } = opts;
  const rows = [];
  let i = 0;
  let sinceFeature = 0;

  while (i < items.length) {
    const mustFeature =
      sinceFeature >= featureEvery ||
      items[i].featured === true ||
      (items[i].type !== 'image' && sinceFeature >= 2);

    if (mustFeature || i === 0) {
      const h = clamp(width / items[i].ratio, featureMin, featureMax);
      rows.push({ type: 'feature', items: [items[i]], height: h });
      i += 1;
      sinceFeature = 0;
      continue;
    }

    // 贪心塞满一行：加到行高 <= target 或达到 maxPerRow
    const picked = [];
    let sumRatio = 0;
    while (i < items.length && picked.length < maxPerRow) {
      const cand = items[i];
      const isFeatureCand =
        cand.featured === true || sinceFeature + picked.length >= featureEvery;
      if (picked.length > 0 && isFeatureCand) break;
      if (picked.length > 0 && cand.type === 'video') break;
      picked.push(cand);
      sumRatio += cand.ratio;
      i += 1;
      const h = (width - gap * (picked.length - 1)) / sumRatio;
      if (h <= target) break;
    }

    const h = (width - gap * (picked.length - 1)) / sumRatio;
    if (picked.length === 1) {
      // 单张独占一行：按 feature 处理，避免超高
      rows.push({ type: 'feature', items: picked, height: clamp(h, featureMin, featureMax) });
      sinceFeature = 0;
    } else {
      rows.push({ type: 'strip', items: picked, height: h });
      sinceFeature += picked.length;
    }
  }
  return rows;
}
```

**断点参数**：

| 断点 | 容器宽上限 | gap | target | maxPerRow | featureMin/Max | featureEvery |
| --- | --- | --- | --- | --- | --- | --- |
| ≥1200（桌面） | 1520 | 20 | 340 | 3 | 320 / 780 | 6 |
| 1024–1199（平板横） | 100%−56 | 16 | 300 | 3 | 280 / 700 | 6 |
| 768–1023（平板竖） | 100%−48 | 14 | 260 | 2 | 240 / 620 | 5 |
| <768（手机） | 100%−32 | 10 | 200 | 2 | 180 / 520 | 4 |

- 输出为纯函数，Node 断言：总高度单调、无横向溢出（每行 `sum(width) + gaps <= width + 0.5`）、ratio 全部保留。
- 渲染时每行的图用 `style.height = px`，图片 `width:100%; height:100%; object-fit: contain`（feature）或 `contain`（strip 已精确等比，`contain` 与 `cover` 等价，仍用 `contain` 守底线）。

### 4.4 图片加载

- `thumb` / `grid` / `view` 三档，`srcset` 按位置生成：
  - strip 项：`srcset="thumb 320w, grid 768w"`，`sizes="(max-width:768px) 45vw, (max-width:1200px) 30vw, 460px"`
  - feature 项：`srcset="grid 768w, view 2048w"`，`sizes="100vw"`
  - 灯箱/照片墙：直接用 `view`
- 占位：`background-image: url(<lqip>)` + `background-size: cover`（占位层可以 cover，它只是色块，不是照片展示），图片加载完成加 `.is-loaded` 淡入。
- 分批：首批 60 条，之后每批 60；哨兵元素 `IntersectionObserver`（`rootMargin: 800px`）触发。
- 筛选变化：只重建内容区，保留滚动位置（若当前滚动位置超出现有高度则回到顶部）。

### 4.5 视频控制器（并发预算）

- 网格中的视频元素：`<video muted playsinline loop preload="none" poster="...">`，`data-src` 延迟到临近视口才 `src=`。
- **触发**：
  - 有 hover 能力（`matchMedia('(hover: hover)')`）：指针进入播放、离开暂停并 `currentTime = 0`。
  - 触屏：条目 ≥50% 可见且页面可见时播放；**同一时刻最多 1 个**在播（全局预算），新的抢占用旧的。
- **禁止**：任何情况下不得带声自动播放；不得在 `prefers-reduced-data`（若支持）或 `navigator.connection.saveData` 为真时自动播。
- 灯箱内：`controls` 自绘（播放/暂停、进度、静音、全屏按钮按能力出现），点击画面切换播放。
- 播放失败（`play()` reject）：退回 poster 静态展示，不重试轰炸。

### 4.6 灯箱（v2 能力 + 视频）

| 能力 | v2 | v3 |
| --- | --- | --- |
| 键盘 | ←/→/ESC/空格 | 同左；空格按媒体类型分流（图片=自动播放开关，视频=播放/暂停） |
| 触摸 | 左右滑翻页 | 同左；视频上滑动不拦截进度条区域 |
| 缩放 | 1→2→3 + 平移 | 同左；**视频不参与缩放** |
| 缩略图条 | 有 | 有，视频缩略图带小三角标识 |
| 计数 | 第 N / 共 M | 同左 |
| 预加载 | 相邻 2 张 | 同左；视频预加载 `metadata` 而非整段 |

### 4.7 动效清单

| # | 效果 | 实现 | 时长/曲线 | 降级 |
| --- | --- | --- | --- | --- |
| M1 | hero 入场 | `opacity` + `scale(1.03→1)` | 1200ms `cubic-bezier(.22,1,.36,1)` | reduced-motion 关闭 |
| M2 | hero 缓慢推拉 | CSS animation `scale(1→1.05)` 30s alternate | — | 关闭；离屏暂停（IO） |
| M3 | 章节渐显 | `animation-timeline: view()`，`animation-range: entry 0% cover 25%` | 线性随滚动 | `@supports` 不命中 → IO 加 class |
| M4 | 视差 | `translateY(-4%→4%)`，绑定 `scroll()` | 线性 | 不命中即不动 |
| M5 | 错峰入场 | `animation-delay: calc(var(--i) * 40ms)`，仅首批 | 600ms | reduced-motion 全显 |
| M6 | 磁贴 hover | `scale(1.015)` + 轻微上移 | 400ms | 触摸设备不触发 |
| M7 | 网格→灯箱 | View Transitions，`view-transition-name: ph-<id>` | 默认 350ms | 无 API → 淡入 |
| M8 | 章节标题位移 | `translateY(16px)` + `opacity`，随滚动 | 线性 | 同 M3 |
| M9 | 故事转场 | Ken Burns（`scale`/`translate`，8~12s）+ 双层交叉淡入 | 900ms | reduced-motion → 硬切 |
| M10 | 照片墙切换 | 交叉淡入 1200ms + 极慢推拉 | 1200ms | reduced-motion → 硬切 |
| M11 | 导航毛玻璃加深 | `animation-timeline: scroll(root)` 控制 `background` 透明度 | 线性 | JS 滚动阈值切 class |

统一约束：只动 `transform` / `opacity`（`background` 透明度属合成友好项）；`will-change` 仅在动画期间加，结束移除；`prefers-reduced-motion: reduce` 时 M1/M2/M3/M4/M5/M8/M9/M10 全部关闭，内容立即可见。

### 4.8 View Transitions 接入

```js
async function openWithTransition(tileEl, photo) {
  if (!document.startViewTransition || REDUCED) return openLightbox(photo);
  tileEl.style.viewTransitionName = `ph-${photo.id}`;
  const t = document.startViewTransition(() => {
    openLightbox(photo);
    // 灯箱 img 同步设置同名，形成共享元素
  });
  await t.finished;
  tileEl.style.viewTransitionName = '';
}
```

- 同名元素同一时刻只能有一个；翻页时清掉上一张的名字。
- 关闭灯箱的反向过渡同理；`view-transition-name` 必须在 `::view-transition` 伪元素样式里指定 `object-fit: contain`，避免过渡中变形。

---

## 5. 故事模式

### 5.1 数据准备

```js
function buildStory(list, opts) {
  const years = new Set(list.map(p => p.year));
  const byYear = years.size >= 2;
  // 章节键：年份 或（单年时）月份
  // 章内按时间升序（叙事感），跨章按时间升序
  return chapters; // [{ key, label, items, coverId }]
}
```

- 标题卡文案：`2026` + 副行 `12 张`；单年模式用 `2026 · 五月`。
- 章节数 > 12 时合并相邻月（避免章节过碎）。

### 5.2 状态机

```
idle ──enter──▶ prepare ──ok──▶ chapterCard ──2.2s──▶ slide
                   │                                    │
                   └──fail──▶ idle(toast)               ├─slideEnd──▶ slide(next)
                                                        ├─chapterEnd─▶ chapterCard
                                                        ├─pause──▶ paused ─resume─▶ slide
                                                        ├─lastSlide─▶ endCard
                                                        └─esc──▶ idle(restore)
```

- 计时用单一 `setTimeout` 链 + `remaining` 记录；`visibilitychange` 隐藏即暂停，回到前台恢复（不自动续播超过 5 秒的间隔）。
- 切歌（pace）时按新节奏重算当前张剩余时间，不重置进度。

### 5.3 单张时长

```
base = { slow: 7000, normal: 5200, fast: 3600 }[pace]
dur  = base
     + (photo.ratio < 0.9 ? 600 : 0)        // 竖图多给一点时间看
     + (hasCaption ? 800 : 0)
视频：dur = min(duration*1000, 30000)，且不小于 2500
```

### 5.4 渲染与内存

- DOM 只保留 3 层：`prev` / `current` / `next`（`next` 预加载图片，不显示）。
- 每次切换后把 `prev` 的 `src` 清空并移除节点，避免几十张大图堆积。
- `keydown` 绑在 `document`，进入时记录 `lastFocus`，退出还焦。
- 退出恢复：`scrollY` + hash + 焦点 + 播放状态。

---

## 6. 照片墙模式

### 6.1 生命周期

```
enter(gesture)
  ├─ 申请 Wake Lock
  ├─ 请求全屏（能力探测，失败忽略）
  ├─ 构建播放队列（On This Month → 最新 → 洗牌）
  ├─ 启动调度器
  └─ 启动版本轮询

running
  ├─ tick → 播放下一条（图片：定时；视频：ended 或超时）
  ├─ visibilitychange → hidden: 暂停调度 / visible: 恢复 + 重申请 Wake Lock + 立即轮询
  ├─ 本地跨天 → 重建 On This Month 队列
  └─ 版本变更 → 增量并入队列（不打断当前）

exit(esc/dblclick)
  ├─ 释放 Wake Lock
  ├─ 停轮询
  └─ 恢复普通视图与滚动位置
```

### 6.2 Wake Lock

```js
const wl = { sentinel: null, want: false };
async function acquire() {
  if (!('wakeLock' in navigator)) return 'unsupported';
  try {
    wl.sentinel = await navigator.wakeLock.request('screen');
    wl.sentinel.addEventListener('release', () => {
      wl.sentinel = null;
      if (wl.want && document.visibilityState === 'visible') setTimeout(acquire, 1000);
    });
    return 'ok';
  } catch (e) { return e.name; }
}
```

- 只在**用户手势**（点击「照片墙」按钮）内首次调用。
- `visibilitychange → visible` 时若 `want` 则重新申请。
- 失败/不支持：控制条显示一行提示「当前环境无法保持常亮」，并给出 iPad 设置路径与「用 Safari 标签页打开（不要用主屏图标）」的说明。
- **不**申请 `screen` 以外类型；不轮询申请（避免被判定滥用）。

### 6.3 调度器

```js
let timer = null, dueAt = 0, remaining = 0;
function schedule(ms) { dueAt = performance.now() + ms; timer = setTimeout(next, ms); }
function onHidden() { if (timer) { remaining = Math.max(0, dueAt - performance.now()); clearTimeout(timer); timer = null; } }
function onVisible() { if (!timer && remaining > 0) schedule(Math.max(remaining, 800)); }
```

- 间隔默认 10000ms（可选 5/10/20/30s）。
- 视频：`play()` 成功后由 `ended` 触发下一张；`play()` 失败则 4000ms 后切。
- 单条最长停留 45s（防止异常视频卡住）。

### 6.4 队列与 On This Month

```js
function buildWallQueue(list, now) {
  const sameMonth = list.filter(p => p.month === now.getMonth() + 1 && p.year < now.getFullYear());
  const recent = list.slice(0, 24);
  const rest = shuffle(list.filter(p => !sameMonth.includes(p) && !recent.includes(p)));
  return [...take(sameMonth, 8), ...recent, ...rest];  // 去重后返回
}
```

- 用「洗牌袋」避免短期重复：一轮播完才重洗。
- 跨天检测：每 60s 比较 `toDateString()`，变化则重建队列并在下一次切换时生效。
- 队列更新（新照片）插入到当前位置之后，不重置 `index`。

### 6.5 热更新协议

```
GET data/version.json?_=<ts>   (cache: 'no-store')
→ { rev, manifest, counts }
rev 与 current 不同 → GET <manifest>（哈希文件名，可长缓存）
→ 计算新增 id → 并入 state.data 与队列 → 更新 albums/filters
```

- 轮询：可见时每 600s；失败退避 30s→60s→120s→300s→600s；成功重置。
- 失败**不弹任何 UI**，仅在控制条状态点显示极小的「离线」标识。
- `version.json` 由构建产出，部署时单独以 `no-cache` 上传（§10.1）。

### 6.6 展示细节

- 布局：`position: fixed; inset: 0`；图片 `object-fit: contain`；背景近黑（`#000`）。
- 时钟：`clamp(48px, 9vw, 160px)` 数字 + 日期小字；每 5 分钟做 ±1px 位移（防烧屏），文字对比度 ≤ 0.72 白，不抢画面。
- 夜间（22:00–07:00）：叠加 `rgba(0,0,0,.45)`，时钟透明度降到 0.5；可在控制条临时关闭（内存态，不持久化）。
- 控制条：底部 64px，3 秒无操作淡出，轻触唤出；含 上一张 / 播放暂停 / 间隔 / 时钟 / 夜间 / 退出。
- 视频：`muted playsinline`，`loop=false`；播完切下一张。

### 6.7 已知不能做

- iPad Safari 不支持元素级全屏时，浏览器工具栏会保留：用 `position: fixed` 覆盖可视区 + 提示「引导式访问可获得更沉浸的效果」。
- 不能阻止系统级锁屏，只能靠 Wake Lock + 系统设置。

---

## 7. 视觉系统

### 7.1 色板（沿用 v2 + 3 个新变量）

```
--paper #ffffff      --paper-2 #f5f5f7
--ink #1d1d1f        --ink-2 #6e6e73      --ink-3 #a1a1a6   [新]
--night #000000      --night-ink #f5f5f7  --night-ink-2 #86868b
--accent #0071e3
--scrim rgba(0,0,0,.34)                     [新] hero 文字承托
--placeholder #e8e8ed                       [新] 图片占位底色
```

### 7.2 字阶（clamp，与 v2 一致）

```
--fs-display clamp(44px, 8.4vw, 112px)   hero
--fs-section clamp(30px, 4.6vw, 60px)    章节
--fs-card    clamp(20px, 2.4vw, 30px)
--fs-lead    clamp(16px, 1.9vw, 21px)
--fs-body    15px
--fs-caption 12px
--tracking-tight -0.045em
```

### 7.3 版心与留白

- 版心 `max-width: 1520px`，桌面左右 40px；章节上下间距 `clamp(72px, 9vw, 140px)`。
- 深浅章节整块切换，不画分割线；深色块前后各留 `clamp(80px, 12vw, 180px)`。

### 7.4 页面分镜（自上而下）

| # | 区块 | 内容 | 关键观感 |
| --- | --- | --- | --- |
| 1 | Hero | 一张满幅照片 + 站名 + 一句副标题 + 向下提示 | 照片占满首屏，标题压在画面留白处，入场缓慢推近 |
| 2 | 精选 | 2~4 张编辑式大图，交错左右，配一句短文案 | 「这是一本画册」的第一印象 |
| 3 | 时间线 | 年份大标题 + 该年编辑式栅格（大图锚点 + 小图） | 滚动中照片尺寸有变化，不枯燥 |
| 4 | 相册 | 相册卡片（封面可为视频） | 入口清晰 |
| 5 | 故事入口 | 深色全宽条，一句「播放这段回忆」 | 明暗转折，给出下一步动作 |
| 6 | 照片墙入口 | 深色，提示「放在桌上，让它自己放」 | 场景化文案 |
| 7 | 收尾 | 统计（张数 / 相册 / 年份跨度）+ 隐私说明 | 克制的结束 |

### 7.5 组件

- 磁贴：无边框、圆角 14px（容器圆角，非照片裁切）、hover 轻微上浮。
- 播放标识：右下角 28px 半透明圆形 + 三角，距边 10px。
- 章节头：`序号 / 年份 / 张数`，序号用 `font-variant-numeric: tabular-nums`。
- 按钮：胶囊形、`1px` 描边、hover 变强调色（沿用 v2）。

---

## 8. 性能预算与测量

| 指标 | 预算 | 测量方式 |
| --- | --- | --- |
| 入口 HTML | ≤ 12KB | 构建后 `wc -c` |
| JS 总量（未压缩） | ≤ 220KB，gzip ≤ 60KB | 构建报告 + `gzip -c | wc -c` |
| CSS | ≤ 40KB，gzip ≤ 10KB | 同上 |
| manifest（100 张） | ≤ 120KB | 构建报告 |
| 首屏请求 | ≤ 8 个（HTML/CSS/JS/manifest/hero/3 图） | DevTools |
| LCP | < 2.5s（CDN 命中） | 人工测 3 次取中位 |
| 照片墙内存 | 8 小时增长 < 60MB | Safari 时间线人工抽样 |
| 并发在播视频 | ≤ 1（网格）/ 1（照片墙） | 代码断言 + 人工 |

`scripts/verify.mjs` 只能验证**结构**（文件存在、字段白名单、体积阈值），真实性能与动效必须人工在浏览器确认——这一点在 tasks 的验收项里明确标注。

---

## 9. 仓库与工程治理

### 9.1 `.gitignore`（v3 全文，替换现有）

```gitignore
# 依赖与构建产物
node_modules/
dist/
.build-cache.json
.build-report.json

# 运行时状态与凭据（绝不入库）
.deploy-state.json
src/deploy/distribution-config.json
src/deploy/iam-policy.json
.env
.env.*
*.pem
*.key
.rollback-*/

# 源素材：照片与视频一律不入库
photos/**
!photos/.gitkeep
!photos/tags.csv
!photos/.albumignore

# 系统与编辑器
.DS_Store
*.log
.idea/
.vscode/
```

> `photos/**` 比 v2 的 `photos/*` 更严：连子目录里的内容也拦住，避免漏网。

### 9.2 `npm run check:repo`

规则（任一命中即非零退出）：

| 规则 | 判据 |
| --- | --- |
| 媒体文件 | 扩展名 ∈ `{jpg,jpeg,png,heic,heif,webp,gif,mp4,mov,m4v,avif}` |
| 大文件 | > 5MB（`git ls-files -s` 拿不到大小 → 用 `stat`） |
| 疑似密钥 | `AKIA[0-9A-Z]{16}`、`BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY`、`aws_secret_access_key`、`ghp_[A-Za-z0-9]{20,}`、`sk-[A-Za-z0-9]{20,}` |
| 绝对路径 | 文本中出现 `/Users/<name>/` |
| 构建产物 | 路径以 `dist/` 开头 |

实现：`git ls-files -z` 取全部已跟踪文件（含暂存），逐个按扩展名/大小/文本内容判定；输出 `✗ 文件: 原因` 清单。

`package.json` 新增两个脚本：

```json
{ "check:repo": "node scripts/check-repo.mjs", "hook:install": "node scripts/install-hooks.mjs" }
```

`hook:install` 写入 `.git/hooks/pre-commit`（调用 `check:repo`），属本地行为、不入库；不装也不影响功能，只是少一道自动闸门。

### 9.3 提交计划

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `chore: 导入 v2 基线` | 当前工作树（不含照片/产物/状态） |
| 2 | `docs(spec): v3 需求与技术方案` | `spec/v3/*.md` |
| 3 | `chore(repo): gitignore、安检脚本、README` | §9.1 / §9.2 |
| 4 | `feat(build): 媒体识别、三档图片与 LQIP` | scan / image / manifest |
| 5 | `feat(build): 视频转码与脱敏校验` | video / media / build |
| 6 | `feat(web): 模块化与版式骨架` | js/ 拆分、目录哈希、hero |
| 7 | `feat(web): 编辑式栅格与图片档位` | gallery |
| 8 | `feat(web): 视频预览与灯箱播放` | lightbox / 控制器 |
| 9 | `feat(web): 故事模式` | story |
| 10 | `feat(web): 照片墙与热更新` | wall / update |
| 11 | `feat(web): 动效与共享元素转场` | motion / css |
| 12 | `chore: 验收与文档收尾` | verify 扩展、README、tag `v3.0` |

### 9.4 GitHub 步骤（需要用户配合）

1. 用户创建空仓库 `personal-photo-album`，**公开**，不勾选 README / .gitignore / license。
2. 本地 `git remote add origin git@github.com:<账号>/personal-photo-album.git`（或 HTTPS + PAT）。
3. 推送前跑 `npm run check:repo`，人工再看一次 `git status`。
4. `git push -u origin main`，然后 `git push --tags`。
5. 若 SSH 未绑定：`ssh -T git@github.com` 报 `Permission denied` → 引导用户把 `~/.ssh/id_rsa.pub` 加到 GitHub。

> 推送是外部写操作，**执行前会单独向用户确认**。

---

## 10. 部署适配（不改架构，只改缓存头）

### 10.1 两段式上传

```bash
# 1) 全量同步：一律长缓存（哈希资源本就不变，入口文件随后单独覆盖）
aws s3 sync dist/ s3://chenyouyi/ --region ap-southeast-1 --delete \
  --exclude ".build-report.json" \
  --cache-control "public, max-age=31536000, immutable"

# 2) 入口与版本文件：用 cp 强制覆盖为不缓存（sync 改不了已有对象的 Cache-Control）
aws s3 cp dist/index.html s3://chenyouyi/index.html \
  --region ap-southeast-1 --cache-control "no-cache, max-age=0, must-revalidate"
aws s3 cp dist/data/version.json s3://chenyouyi/data/version.json \
  --region ap-southeast-1 --cache-control "no-cache, max-age=0, must-revalidate"
```

- 顺序不能反：先 `sync` 后 `cp`。若第一段用 `--exclude` 排除入口文件，`--delete` 会把它当成「源站不存在」而删掉（AWS CLI 的 exclude 会影响删除判定），所以这里不排除、只用 `cp` 覆盖缓存头。
- `sync` 只比较大小/时间，改缓存头不会重传，所以入口文件必须用 `cp`。
- 预览脚本 `preview.mjs` 同样改为「sync（不带 `--delete`）+ 两个 `cp`」，护栏不变，verify 断言继续保留。
- 正式 `deploy.mjs` 保留 `--delete` 与「仅失效 `/index.html`」；v3 不新增失效目标。

### 10.2 `verify.mjs` 断言扩展

沿用 19 条，新增约 13 条：

1. `js/` 目录哈希存在且 `index.html` 引用一致
2. manifest 无 `srcPath|rel|mtime|size|day` 字段
3. 图片条目必有 `thumb|grid|view|lqip`；视频条目必有 `poster|src|duration`
4. `lqip` 必须是 `data:image/` 前缀
5. `data/version.json` 的 `rev` 与 manifest 文件名哈希一致
6. `computeEditorialRows` 行宽不溢出（构造 100 组随机 ratio）
7. `buildHash`/`parseHashString` 对 `mode=story|wall` 往返一致
8. `check:repo` 脚本存在且规则表含 5 类
9. `.gitignore` 含 `photos/**` 与 `.deploy-state.json`
10. `wall.js` 含 `wakeLock` 与 `visibilitychange`
11. `story.js` 含 pace 三档常量
12. 视频转码参数含 `-map_metadata -1`
13. deploy/preview 脚本含两段式 `cache-control`

---

## 11. 兼容性与渐进增强矩阵

| 能力 | Safari 26（iPad 目标） | Safari 17–18 | Chrome/Edge 最新 | 不支持时 |
| --- | --- | --- | --- | --- |
| CSS 滚动驱动动效 | 支持 | 忽略属性 | 支持 | IO 加 class，内容完整 |
| View Transitions | 支持 | 18+ 同文档支持 | 支持 | 淡入 |
| AVIF | 支持（不做） | — | — | — |
| Wake Lock | 支持（HTTPS） | 16.4+ 支持 | 支持 | 提示 + 系统设置 |
| `100svh` | 支持 | 15.4+ | 支持 | 退 `vh` |
| `object-fit: contain` | 支持 | 支持 | 支持 | — |
| `srcset/sizes` | 支持 | 支持 | 支持 | 单档兜底 |

视觉降级的底线：**任何一条不生效，页面仍必须能看完所有照片、能用灯箱、能进故事与照片墙**（只是少一点动效）。

---

## 12. 需求追溯

| 需求 | 设计落点 | 主要验证 |
| --- | --- | --- |
| FR-11 Git | §9.1 / §9.2 / §9.3 / §9.4 | `check:repo`、干净克隆构建 |
| FR-12 短视频 | §3.2 / §3.4 / §3.5 / §4.4 / §4.5 | 转码产物 ffprobe 无元数据、网格预览 |
| FR-13 故事 | §5.1–§5.4 | 章节/节奏/键盘/退出恢复 |
| FR-14 照片墙 | §6.1–§6.7 | 8 小时、热更新、常亮、调光 |
| FR-15 视觉 | §4.3 / §4.7 / §7 | 大图小图节奏、不裁切、动效降级 |
| FR-16 性能 | §3.3 / §4.4 / §8 | 体积预算、分批、srcset |
| FR-17 配置 | §3.5 `site.json` 扩展 | 无配置也能构建、hero 可指定 |
| FR-18 隐私 | §3.4 / §3.5 / §9.2 | 字段白名单、视频断言、仓库安检 |

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| ffmpeg 转码在用户机器上过慢 | 构建时间长 | `preset medium`、单条 ≤30s、增量缓存；必要时降到 `veryfast` |
| 视频自动播放被阻止 | 网格无预览 | 失败退 poster；不重试 |
| Wake Lock 被系统释放 | 屏幕熄灭 | `release` 监听 + 可见时重申请 + 提示系统设置 |
| 照片墙长期运行内存增长 | 卡顿/崩溃 | 只保留 3 层 DOM；视频用完即 `load()` 重置；定时清理 |
| View Transitions 在低端机掉帧 | 观感差 | 只在 `matchMedia('(prefers-reduced-motion: no-preference)')` + `deviceMemory > 4` 时启用 |
| manifest 因 LQIP 变大 | 首屏变慢 | LQIP 24px q40；超过 200KB 时降为 16px |
| 目录哈希导致全量重下 | 缓存利用率低 | JS 总量 ≤60KB gzip，可接受 |
| 公开仓库暴露架构 | 信息暴露 | 不含凭证；README 明示；可随时转私有 |
| 视频让流量涨 | 成本 | 单条限额 + 网格只预览 + 报告给出总量 |

---

## 14. 实施顺序（供 tasks.md 展开）

```
P0 仓库治理（gitignore / check:repo / README）        ← 最先，保证后面每次提交都干净
P1 构建层（媒体识别 / 三档图 / LQIP / manifest v3）    ← 无前端依赖，可先跑通产物
P2 视频层（probe / 转码 / 封面 / 断言）
P3 前端骨架（模块化 / 目录哈希 / hero / 视觉系统）
P4 栅格与加载（编辑式行 / srcset / 分批）
P5 灯箱与视频播放
P6 故事模式
P7 照片墙与热更新
P8 动效与转场
P9 集成验证（verify 扩展 + 人工验收）
P10 GitHub 推送与交付说明
```

依赖：P1→P2 可并行于 P3；P4 依赖 P3；P5 依赖 P4；P6/P7 依赖 P4；P8 依赖 P4–P7；P9 最后。

---

## 15. 已确认的取舍（2026-11-09）

用户未逐项否决，按建议默认执行，记录在此以免后续反复：

| 编号 | 议题 | 结论 |
| --- | --- | --- |
| D-01 | hero 是否破例 `cover` | **不破例**。满幅宽度 + 按比例算高度，竖图上下留中性底色；「不裁切」优先级高于「铺满」 |
| D-02 | JS 模块化方式 | **目录级哈希** `assets/js.<hash>/`，约 60KB gzip，可接受 |
| D-03 | 视频画质 | **crf 23**、最长边 1920、30fps、AAC 96k |
| D-04 | 照片墙默认间隔 | **10 秒**，控制条可切 5/10/20/30 |
| D-05 | 提交历史 | **不伪造** v1→v2 逐次提交；`v2 基线` 一个起点 + v3 分阶段提交 + 末尾 `v3.0` tag |
| D-06 | iPad 型号 | 用户「随意」→ 按 **iPad 横屏 1024–1366** 为主，向下兼容竖屏与手机；不承诺像素级完美适配 |

**补充信息（2026-11-09 用户提供）**

- GitHub 远端：`git@github.com:scott372199/albumn.git`（注意仓库名是 `albumn`）。
- 已生成专用密钥 `~/.ssh/id_rsa_github`（RSA 3072，无口令），`~/.ssh/config` 已为 `github.com` 指定该 key；公钥待用户添加到 GitHub 账号 `scott372199`。
- 视频素材已就位：`photos/2026/IMG_2265.MOV`（见 §3.4 实测样本）。

→ 进入 **Tasks 阶段**：产出 `spec/v3/tasks.md`。
