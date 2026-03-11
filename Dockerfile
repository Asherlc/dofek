FROM node:22-slim AS builder
ENV CI=true
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies for the whole workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

# Copy source and build client bundle
COPY . .
RUN cd packages/web && pnpm run build
# Strip devDependencies before copying to production images
RUN pnpm prune --prod

# ── Server image (Express API + sync runner) ────────────────────────────
FROM node:22-slim AS server
ENV NODE_ENV=production
WORKDIR /app

# Root package (sync runner + shared code)
COPY --from=builder /app/src ./src
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json .
COPY --from=builder /app/pnpm-workspace.yaml .

# Server package
COPY --from=builder /app/packages/server/src ./packages/server/src
COPY --from=builder /app/packages/server/package.json ./packages/server/

# Production node_modules (workspace hoists to root)
COPY --from=builder /app/node_modules ./node_modules

COPY entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]

# ── Client image (Nginx serving Vite bundle) ────────────────────────────
FROM nginx:alpine AS client
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
