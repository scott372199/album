#!/usr/bin/env bash
#
# 本地构建并推送处理镜像。
# 之所以还需要这个脚本：GitHub Actions 是主路径，但排查问题时需要一条
# 「不走 CI 也能推一版」的路，否则 CI 一挂就完全卡住。
#
# Builds and pushes the handler image locally. CI is the primary path; this
# exists so a broken pipeline does not block a hotfix.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}"
REGION="${AWS_REGION:-ap-southeast-1}"
REPOSITORY="${ECR_REPOSITORY:-album-processor}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${REPOSITORY}:${TAG}"

echo "→ 仓库 / repository: ${REGISTRY}/${REPOSITORY}"
echo "→ 标签 / tag:        ${TAG}"

# ECR 是 IMMUTABLE：同一个 tag 推第二次会被拒绝，这是有意的
if aws ecr describe-images --region "$REGION" --repository-name "$REPOSITORY" \
  --image-ids "imageTag=${TAG}" >/dev/null 2>&1; then
  echo "✗ 该 tag 已存在（ECR 是 IMMUTABLE）。换一个 tag，或直接用已推送的镜像。"
  exit 1
fi

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# 必须指定 linux/amd64：在 Apple Silicon 上直接 build 会产出 arm64 镜像，
# Lambda 拉起来会报 exec format error。
docker build \
  --platform linux/amd64 \
  -f "$ROOT/docker/Dockerfile" \
  -t "$IMAGE" \
  "$ROOT"

# 上线前自检：ffmpeg/ffprobe 可执行、sharp 能加载。
# 这两项缺任何一个，处理函数会在第一张图上炸掉，而那时已经很难回滚。
echo "→ 镜像自检 / smoke test"
docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$IMAGE" -c '
  set -e
  ffmpeg -version | head -1
  ffprobe -version | head -1
  node -e "const s=require(\"sharp\"); console.log(\"sharp\", s.versions.sharp, \"libvips\", s.versions.vips)"
'

docker push "$IMAGE"

echo "✓ 已推送 / pushed: ${IMAGE}"
