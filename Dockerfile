FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Source stage: just copy files, no install ─────────────────────────
FROM base AS source
WORKDIR /app
COPY . .

# ── Prod deps: production-only node_modules (flat, no symlinks) ───────
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --node-linker=hoisted

# ── Client build: full install + Vite build (only needed for client target)
FROM base AS client-build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN cd packages/web && pnpm run build

# ── Server image (Express API + sync runner) ────────────────────────────
FROM base AS server
ENV NODE_ENV=production
WORKDIR /app

# Install SOPS for runtime .env decryption (supports both amd64 and arm64)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/getsops/sops/releases/download/v3.9.4/sops-v3.9.4.linux.${ARCH}" \
      -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=source /app/src ./src
COPY --from=source /app/drizzle ./drizzle
COPY --from=source /app/package.json .
COPY --from=source /app/pnpm-workspace.yaml .
COPY --from=source /app/supplements.json .
COPY --from=source /app/packages/server/src ./packages/server/src
COPY --from=source /app/packages/server/package.json ./packages/server/
COPY --from=prod-deps /app/node_modules ./node_modules
# Link root workspace package so "import from 'dofek/...'" resolves
RUN ln -s /app node_modules/dofek

# SOPS-encrypted .env — decrypted at runtime via SOPS_AGE_KEY env var
COPY --from=source /app/.env .
COPY --from=source /app/.sops.yaml .

COPY entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]

# ── Client image (Nginx serving Vite bundle) ────────────────────────────
FROM nginx:alpine AS client
COPY --from=client-build /app/packages/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
