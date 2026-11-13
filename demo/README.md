# demo · V5 本地成品演示 / V5 local product demo

两个入口 / Two entry points:

## 1. 静态交互预览 / static interactive preview

`v5-preview.html`：Apple 式导航、hero 轮播、中文搜索演示、六域管理台、观测指标与日志流、构建状态。
纯单文件、零依赖，直接打开即可。
*A single self-contained file — open it directly.*

## 2. 可运行演示 / runnable demo（真实服务 / real services）

```bash
./demo/run-demo.sh       # 一键启动三件套并自检 / start all three and probe
./demo/run-demo.sh stop  # 全部停止 / stop everything
```

| 服务 / Service | 地址 / URL | 说明 / Notes |
| --- | --- | --- |
| 相册站点 / album site | http://127.0.0.1:8091 | `dist/` 静态构建（hero registry + 搜索 UI） |
| 管理站 API / mgmt API | http://127.0.0.1:8095 | Spring Boot，fixture profile，日志在 `demo/.logs/api.log` |
| 管理站前端 / mgmt web | http://127.0.0.1:5173 | Vite dev server，`/api` 已代理到 8095 |

管理站登录 / management sign-in：`admin` / `auditor` / `viewer`，共享口令
`album-mgmt-demo`——先用 auditor 体验 403 与审计记录，再用 admin 看全部七域。
*Try auditor first for 403s and audit entries, then admin for all seven domains.*

要求 / requirements：Node 22+、Java 21、（可选 Docker：`../album-mgmt/docker-compose.yml`
可容器化一键演示）。全部本地 fixture，零云依赖。
*Node 22+, Java 21; optional Docker compose lives in album-mgmt. Fixture only.*
