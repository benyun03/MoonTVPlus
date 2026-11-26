# 与 package.json 的 packageManager 保持一致，避免 pnpm@latest 随时间漂移
# 破坏 lockfile 兼容性与层缓存
ARG PNPM_VERSION=10.14.0

# ---- 第 1 阶段：安装依赖 ----
FROM node:24-alpine AS deps

ARG PNPM_VERSION
# 启用 corepack 并激活 pnpm
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# 仅复制依赖清单，提高构建缓存利用率。
# pnpm-workspace.yaml 必须一并复制：其中 onlyBuiltDependencies 是 pnpm 10 的
# 构建脚本白名单（better-sqlite3 原生模块），缺失会导致安装时跳过其构建脚本、
# 运行时报 Could not locate the bindings file。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 安装所有依赖（含 devDependencies，供构建使用）。
# BuildKit 缓存挂载共享 pnpm store，重复构建无需重新下载全部依赖
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ---- 第 2 阶段：构建项目 ----
FROM node:24-alpine AS builder

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# 在构建阶段显式设置 DOCKER_ENV；关闭 Next 遥测
ENV DOCKER_ENV=true
ENV NEXT_TELEMETRY_DISABLED=1

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
# 复制全部源代码
COPY . .

# 生成生产构建（standalone 输出自带按需追踪的最小 node_modules）
RUN pnpm run build \
    # Next standalone 的文件追踪（NFT）不会包含 next 包内部通过动态 require 加载的
    # dist/compiled 产物（如 compiled/webpack/bundle*.js），运行时报 Cannot find module './bundle5'。
    # 旧镜像靠全量生产依赖覆盖掩盖了该问题；这里在拷贝进最终镜像前，
    # 直接把完整安装中的 dist/compiled 合并进 standalone 的 next 包。
    && standalone_next="$(realpath /app/.next/standalone/node_modules/next)" \
    && cp -a "$(realpath /app/node_modules/next)/dist/compiled/." "$standalone_next/dist/compiled/"

# ---- 第 3 阶段：运行时增量依赖 ----
# 自定义 server.js 依赖的 socket.io 不在 Next standalone 的依赖追踪范围内，
# 只安装这类增量依赖（从 lockfile 提取精确版本），不再把全部生产依赖拷入镜像
# —— react/next/react-icons/vidstack 等数百 MB 与 standalone 内的追踪副本完全冗余。
FROM node:24-alpine AS runtime-deps

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# 从 lockfile 提取 socket.io 的锁定版本并独立安装（hoisted 平铺布局，
# 便于与 standalone 的 node_modules 并存，经 NODE_PATH 参与模块解析）
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    socket_io_version=$(node -e "const m=require('fs').readFileSync('pnpm-lock.yaml','utf8').match(/^  socket\.io@([\d.]+):/m);process.stdout.write(m[1])") \
    && echo "{\"name\":\"runtime-extras\",\"private\":true}" > package.json \
    && rm pnpm-lock.yaml \
    && pnpm add "socket.io@${socket_io_version}" \
      --store-dir /pnpm/store \
      --node-linker=hoisted

# ---- 第 4 阶段：生成运行时镜像 ----
FROM node:24-alpine AS runner

# 安装 su-exec（entrypoint 降权运行用）并创建非 root 用户
RUN apk add --no-cache su-exec \
    && addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S nextjs -G nodejs

# 复制 entrypoint（支持通过 PUID/PGID 环境变量指定运行 UID/GID）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
ENV SQLITE_DB_PATH=/app/.data/moontv.db
ENV OFFLINE_DOWNLOAD_DIR=/data
# 自定义 server.js 专用的增量依赖目录（不污染 standalone 自带的 node_modules）
ENV NODE_PATH=/app/runtime-node-modules

# 从构建器中复制 standalone 输出（含按需追踪的最小 node_modules）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 从构建器中复制 scripts 目录
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# 从构建器中复制 migrations 目录
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
# 从构建器中复制 start.js
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
# 从构建器中复制自定义 server.js（包含 Socket.IO 支持）
COPY --from=builder --chown=nextjs:nodejs /app/server.js ./server.js
# 自定义 server.js 在运行时会 require('./src/lib/tv-remote-hub.js')。
# Next standalone 只会追踪 Next 应用入口，不会自动包含自定义服务器额外 require 的源文件，
# 因此需要显式复制该运行时模块，避免生产镜像启动时报 Cannot find module。
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/tv-remote-hub.js ./src/lib/tv-remote-hub.js
# 从构建器中复制 public 和 .next/static 目录
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 复制运行时增量依赖（socket.io），经 NODE_PATH 参与模块解析
COPY --from=runtime-deps --chown=nextjs:nodejs /app/node_modules /app/runtime-node-modules

# 准备 SQLite 数据目录和默认离线下载目录
RUN mkdir -p /app/.data "$OFFLINE_DOWNLOAD_DIR" \
  && chown -R nextjs:nodejs /app/.data "$OFFLINE_DOWNLOAD_DIR"

# 默认以 root 启动，由 entrypoint 按 PUID/PGID 环境变量调整后降权运行
EXPOSE 3000

# 使用自定义启动脚本，先预加载配置再启动服务器
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "start.js"]
