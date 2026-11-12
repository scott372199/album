# 文档索引 / Documentation Index

这个目录只放**当前有效的系统说明**。历史过程（为什么当初这么决定、哪一步踩了什么坑）在
`spec/vN/`，那是有日期的记录，不回改。

*This directory holds the current description of the system. History — why a decision was made
and what broke along the way — lives in `spec/vN/`, dated and frozen.*

---

## 三份正文 / The three documents

| 文档 / Doc | 回答什么问题 / Question it answers |
| --- | --- |
| [01-architecture.md](01-architecture.md) | **用了什么**：前端、安卓壳、AWS 十来个服务、GitHub 的能力、Terraform 四层，以及每处「为什么不用那个更常见的方案」 |
| [02-flows.md](02-flows.md) | **怎么连起来**：看一张照片、传一张照片、传一个视频、发前端、发镜像、改基础设施、发 APK —— 每条流的时序、契约、失败分支 |
| [03-security.md](03-security.md) | **凭什么安全**：威胁模型、七道边界（身份/权限/上传/内容/网络/供应链/仓库）、泄露演练、残余风险、自检清单 |

*Architecture = what is used. Flows = how it fits together. Security = why it holds.*

---

## 按角色读 / Read by role

| 你是 / You are | 顺序 / Order | 大约 / Time |
| --- | --- | --- |
| 第一次接触这个项目 | 01 §1 全景 → 02 §1~§3（读 + 传）→ 03 §1 威胁模型 | 25 分钟 |
| 要改前端 | 01 §2 → 02 §6 → 02 附录 A | 15 分钟 |
| 要改服务端 | 01 §4.4~4.6 → 02 §7 → 03 §4 | 20 分钟 |
| 要改基础设施 | 01 §6 → 02 §8 → 03 §2、§8 | 30 分钟 |
| 要排查线上问题 | 02 附录 A → 02 §11 失败矩阵 → 03 §11 自检 | 10 分钟起 |
| 要重建一套 | 03 §11 → 01 §6 → 02 §8 | 1 小时 |

*Pick the row that matches you; the rightmost column is how long the read takes.*

---

## 一分钟地图 / The map in one minute

```
手机 / iPad ──▶ CloudFront(OAC) ──▶ S3 站点桶（入口页、assets、清单、照片）
                                        ▲
App 选图 ──▶ API Gateway ──▶ album-auth ─┤ 预签名
                │                        │
                └──▶ 直传 ──▶ S3 源桶 ──┴─ S3 事件 ──▶ album-processor ──▶ 写产物 + 改清单 + 删原图

GitHub Actions ──OIDC──▶ 三个 IAM 角色 ──▶ ECR / S3 / CloudFront
Terraform 四层 ──▶ 00-bootstrap → 10-storage → 20-edge → 30-compute
```

四条写路径互不重叠：发布流水线写 `assets/` 与 `index.html`，处理函数写 `photos/` 与 `data/`，
本机脚本写 `apk/`，Terraform 只管资源不管内容。

*Four write paths that never overlap: the deploy writes `assets/` and `index.html`, the
processor writes `photos/` and `data/`, the local script writes `apk/`, and Terraform manages
resources but never content.*

---

## 数字速查 / Numbers worth remembering

| 项 / Item | 值 / Value |
| --- | --- |
| 结构断言 | `npm run verify` — 38 项 |
| 单测 | `npm test` — 64 项 |
| 仓库安检 | `npm run check:repo` — 81 个文件 |
| 离线基础设施断言 | `album-infra` 的 `make check` — 58 项 |
| 照片端到端 | 约 22 秒 |
| 视频端到端 | 约 28 秒（16s 素材，函数本身 26s） |
| 分片大小 / 阈值 | 8MB / >16MB 走分段 |
| 预签名有效期 | 15 分钟 |
| 令牌 | 访问 1 小时 / 刷新 7 天 |
| STS 凭证 | 1 小时（JWT 本身 5 分钟） |
| 图片三档 | 320 / 768 / 2048 长边，webp |
| 视频 | H.264 1080p（短边）/ ≤30s / crf23 |
| 镜像 | 262MB，ECR 留 2 份 |
| 月成本 | 实测 $0.003（一年外推约 $0.09/月） |

*The numbers that come up in every conversation; if one changes, change it here first.*

---

## 与旧文档的关系 / Relation to older docs

| 旧文档 / Old doc | 现状 / Status |
| --- | --- |
| `docs/cicd-architecture.md` | **已并入本目录并删除**：OIDC/角色/state/Secrets 进 03 §2、§3、§8；三条流水线进 02 §6~§8；排错表与术语表进 02 附录 |
| `spec/v1` ~ `spec/v3` | 历史迭代，冻结 |
| `spec/v4/{spec,plan,tasks}.md` | v4 的需求、方案与执行记录；**过程记录**，不再作为系统说明维护 |
| 根目录 `README.md` | 入口与速查；细节一律指向本目录 |

*The old CI/CD document was absorbed into these three files and removed; spec/ stays as a dated
record; the root README is now only an entry point.*
