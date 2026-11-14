# 单一镜像，两个入口：auth 与 processor 共用它，靠 image_config.command 区分。
# One image, two entrypoints; `image_config.command` picks the handler.
#
# 构建上下文是仓库根目录 / build context is the repo root:
#   docker build -f docker/Dockerfile -t album-processor:dev .
#
# 为什么基础镜像是 bookworm-slim 而不是 AWS 官方的 Lambda 基础镜像：
# 官方镜像是 AL2023，仓库里没有 ffmpeg，装它得自己找静态二进制；而
# Debian bookworm 的 `apt install ffmpeg` 是一条确定可行、可复现的路径。
# 代价是得自己实现 runtime client——已经写在 src/server/runtime.mjs 里，
# 只有几十行，比维护一份原生编译的 aws-lambda-ric 稳当。
#
# Why bookworm-slim instead of the official Lambda base: the official image is
# AL2023, which has no ffmpeg package, so you would be hunting static binaries.
# Debian bookworm's `apt install ffmpeg` is reproducible. The price is owning the
# runtime client — done in src/server/runtime.mjs in a few dozen lines, which
# beats maintaining a natively compiled aws-lambda-ric.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    LAMBDA_TASK_ROOT=/var/task \
    # 容器里不要留 pip/npm 的缓存层，镜像越小冷启动越快
    NPM_CONFIG_UPDATE_NOTIFIER=false

# ffmpeg 同时提供 ffprobe，视频处理两个都要
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR ${LAMBDA_TASK_ROOT}

# 先只拷依赖清单：源码改动不会让这一层失效，构建能命中缓存
# Only the manifests first, so source edits do not invalidate the install layer
COPY src/server/package.json src/server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/server/ ./

# V5 契约是 correlation.mjs 启动时读的唯一真相源。镜像里没有仓库根目录，
# 所以把它拷进 /var/task/spec/，与代码里的第二个候选路径一致。
# The V5 contract is read at startup by correlation.mjs. The image has no repo
# root, so copy it to /var/task/spec/ to match the second candidate path.
COPY spec/v5/contracts/v5-contracts.json ./spec/v5/contracts/v5-contracts.json

# ENTRYPOINT 固定，CMD 就是「哪个 handler」——Lambda 的 image_config.command
# 覆盖的正是 CMD，于是两个函数共用一个镜像不需要任何额外机制。
# ENTRYPOINT is fixed and CMD carries the handler; image_config.command
# overrides CMD, which is what lets two functions share this image.
ENTRYPOINT ["node", "/var/task/runtime.mjs"]
CMD ["auth/handler.handler"]
