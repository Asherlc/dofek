FROM node:22-slim AS builder
ENV CI=true
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
# Strip devDependencies before copying to production image
RUN pnpm prune --prod && cd web && pnpm prune --prod

# ── Production image ──────────────────────────────────────────────────────
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# Root package (sync runner + source for workspace exports)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json .

# Web dashboard
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/package.json ./web/

# Shared node_modules (workspace hoists to root)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/node_modules ./web/node_modules

COPY entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]
