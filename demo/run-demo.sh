#!/usr/bin/env bash
###############################################################################
# V5 本地成品演示 · 一键启动 / V5 local product demo · one-command launcher
#
# 用法 / usage:
#   ./demo/run-demo.sh          启动三件套并自检 / start all three pieces and probe
#   ./demo/run-demo.sh stop     停止全部 / stop everything
#
# 组件 / pieces:
#   1. 相册站点静态构建 / album static build      → http://127.0.0.1:8091
#   2. 管理站 API（Spring Boot）/ mgmt API       → http://127.0.0.1:8095
#   3. 管理站前端（Vite）/ mgmt web              → http://127.0.0.1:5173
#
# 全部是本地进程、本地 fixture 数据，零云依赖；停止时一并清理。
# Everything runs locally on fixture data with zero cloud dependencies; stop
# cleans up all children.
#
# 注意 / note: 本机若有 SERVER__PORT 环境变量，会干扰 Spring 端口绑定
# （宽松绑定会把它映射成 server.port），脚本显式用 --server.port 覆盖。
# A stray SERVER__PORT env var maps to server.port via relaxed binding, so the
# script always pins the port explicitly.
###############################################################################

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MGMT="$ROOT/../album-mgmt"
LOG_DIR="$ROOT/demo/.logs"
PID_FILE="$ROOT/demo/.demo.pids"
mkdir -p "$LOG_DIR"

PORTS_SITE=8091
PORTS_API=8095
PORTS_WEB=5173

have() { command -v "$1" >/dev/null 2>&1; }

stop_all() {
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # 兜底清理残留监听 / best-effort cleanup of leftovers
  for port in $PORTS_SITE $PORTS_API $PORTS_WEB; do
    pid=$(lsof -tnP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  echo "演示已停止 / demo stopped"
  exit 0
fi

# ── 0. 前置检查 / preflight ─────────────────────────────────────
[ -d "$MGMT" ] || { echo "✗ 缺少 $MGMT（album-mgmt 仓库应与 album 同级） / missing sibling repo"; exit 1; }
have node || { echo "✗ 需要 node / node required"; exit 1; }
have java || { echo "✗ 需要 java 21 / java 21 required"; exit 1; }

# ── 1. 相册站点静态构建 / album static build ────────────────────
echo "▸ [1/3] 构建相册站点 / building album web…"
if [ ! -f "$ROOT/dist/index.html" ] || [ "$ROOT/src/web/index.html" -nt "$ROOT/dist/index.html" ]; then
  (cd "$ROOT" && npm run build:web) > "$LOG_DIR/build.log" 2>&1
  echo "  构建完成 / built"
else
  echo "  dist 已是最新 / dist up to date"
fi

# ── 2. 管理站 API / mgmt API ────────────────────────────────────
echo "▸ [2/3] 启动管理站 API / starting mgmt API on :${PORTS_API}…"
(cd "$MGMT" && MGMT_JWT_SECRET="${MGMT_JWT_SECRET:-local-demo-secret}" \
  ./gradlew :app:bootRun --console=plain --args="--server.port=${PORTS_API}" \
  > "$LOG_DIR/api.log" 2>&1 &)

# ── 3. 管理站前端 / mgmt web ────────────────────────────────────
echo "▸ [3/3] 启动管理站前端 / starting mgmt web on :${PORTS_WEB}…"
(cd "$MGMT/web" && MGMT_API_TARGET="http://127.0.0.1:${PORTS_API}" \
  ./node_modules/.bin/vite --port "$PORTS_WEB" --strictPort --host 127.0.0.1 \
  > "$LOG_DIR/web.log" 2>&1 &)

# 静态站点服务器 / static server for the album site
(cd "$ROOT/dist" && python3 -m http.server "$PORTS_SITE" --bind 127.0.0.1 \
  > "$LOG_DIR/site.log" 2>&1 &)

# ── 自检 / probes ───────────────────────────────────────────────
echo "▸ 等待并自检 / waiting and probing…"
probe() { # name url tries
  local name="$1" url="$2" tries="${3:-40}" i=0 code=""
  while [ "$i" -lt "$tries" ]; do
    code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -m 3 "$url" 2>/dev/null || true)
    if [ "$code" = "200" ]; then echo "  ✅ $name → $url"; return 0; fi
    i=$((i + 1)); sleep 2
  done
  echo "  ❌ $name 未就绪 / not ready（日志见 demo/.logs/）"
  return 1
}

failed=0
probe "相册站点 / album site" "http://127.0.0.1:${PORTS_SITE}/" || failed=1
probe "管理站 API / mgmt API" "http://127.0.0.1:${PORTS_API}/api/v1/health" || failed=1
probe "管理站前端 / mgmt web" "http://127.0.0.1:${PORTS_WEB}/" || failed=1

if [ "$failed" = "0" ]; then
  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  V5 本地演示已就绪 / V5 local demo is up"
  echo "    相册站点 / album site:  http://127.0.0.1:${PORTS_SITE}/"
  echo "    管理站 / management:    http://127.0.0.1:${PORTS_WEB}/"
  echo "      登录 / sign in:  admin · album-mgmt-demo（auditor / viewer 体验 RBAC）"
  echo "    停止全部 / stop all:    ./demo/run-demo.sh stop"
  echo "══════════════════════════════════════════════════════"
fi
exit $failed
