FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Build stage: install all deps, build client, then create prod node_modules
FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# Full install (with devDeps) for building
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN cd packages/web && pnpm run build

# Separate prod-only install with hoisted linker (flat node_modules, no symlinks)
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --node-linker=hoisted

# ── Server image (Express API + sync runner) ────────────────────────────
FROM base AS server
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json .
COPY --from=build /app/pnpm-workspace.yaml .
COPY --from=build /app/supplements.json .
COPY --from=build /app/packages/server/src ./packages/server/src
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=prod-deps /app/node_modules ./node_modules
# Link root workspace package so "import from 'dofek/...'" resolves
RUN ln -s /app node_modules/dofek

COPY entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]

# ── Client image (Nginx serving Vite bundle) ────────────────────────────
FROM nginx:alpine AS client
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
