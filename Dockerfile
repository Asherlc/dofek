FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies for the whole workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

# Copy source and build everything
COPY . .
RUN pnpm build
RUN cd web && pnpm run build

# ── Production image ──────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# Root package (sync runner)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json .

# Web dashboard
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/package.json ./web/

# Shared node_modules (workspace hoists to root)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/node_modules ./web/node_modules

# Default: sync runner. Override in compose for web.
CMD ["node", "dist/index.js", "sync"]
