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
COPY packages/whoop-whoop/package.json ./packages/whoop-whoop/
COPY packages/eight-sleep/package.json ./packages/eight-sleep/
COPY packages/zwift-client/package.json ./packages/zwift-client/
COPY packages/trainerroad-client/package.json ./packages/trainerroad-client/
COPY packages/velohero-client/package.json ./packages/velohero-client/
COPY packages/garmin-connect/package.json ./packages/garmin-connect/
COPY packages/trainingpeaks-connect/package.json ./packages/trainingpeaks-connect/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --node-linker=hoisted

# ── Client build: full install + Vite build (only needed for client target)
FROM base AS client-build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/whoop-whoop/package.json ./packages/whoop-whoop/
COPY packages/eight-sleep/package.json ./packages/eight-sleep/
COPY packages/zwift-client/package.json ./packages/zwift-client/
COPY packages/trainerroad-client/package.json ./packages/trainerroad-client/
COPY packages/velohero-client/package.json ./packages/velohero-client/
COPY packages/garmin-connect/package.json ./packages/garmin-connect/
COPY packages/trainingpeaks-connect/package.json ./packages/trainingpeaks-connect/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN cd packages/web && pnpm run build

# ── Server image (Express API + sync runner) ────────────────────────────
FROM base AS server
ENV NODE_ENV=production
WORKDIR /app

# Install SOPS for runtime .env decryption + Docker CLI for starting worker container
# Skip in test/e2e builds with INSTALL_EXTRAS=false to speed up image builds
ARG INSTALL_EXTRAS=true
RUN if [ "$INSTALL_EXTRAS" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
      ARCH=$(dpkg --print-architecture) && \
      curl -fsSL "https://github.com/getsops/sops/releases/download/v3.9.4/sops-v3.9.4.linux.${ARCH}" \
        -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops && \
      DOCKER_ARCH=$(uname -m) && \
      curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-27.5.1.tgz" | \
        tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
      apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* ; \
    fi

COPY --from=source --chown=node:node /app/src ./src
COPY --from=source --chown=node:node /app/drizzle ./drizzle
COPY --from=source --chown=node:node /app/package.json .
COPY --from=source --chown=node:node /app/pnpm-workspace.yaml .
COPY --from=source --chown=node:node /app/supplements.json .
COPY --from=source --chown=node:node /app/packages/server/src ./packages/server/src
COPY --from=source --chown=node:node /app/packages/server/package.json ./packages/server/
COPY --from=source --chown=node:node /app/packages/whoop-whoop/src ./packages/whoop-whoop/src
COPY --from=source --chown=node:node /app/packages/whoop-whoop/package.json ./packages/whoop-whoop/
COPY --from=source --chown=node:node /app/packages/eight-sleep/src ./packages/eight-sleep/src
COPY --from=source --chown=node:node /app/packages/eight-sleep/package.json ./packages/eight-sleep/
COPY --from=source --chown=node:node /app/packages/zwift-client/src ./packages/zwift-client/src
COPY --from=source --chown=node:node /app/packages/zwift-client/package.json ./packages/zwift-client/
COPY --from=source --chown=node:node /app/packages/trainerroad-client/src ./packages/trainerroad-client/src
COPY --from=source --chown=node:node /app/packages/trainerroad-client/package.json ./packages/trainerroad-client/
COPY --from=source --chown=node:node /app/packages/velohero-client/src ./packages/velohero-client/src
COPY --from=source --chown=node:node /app/packages/velohero-client/package.json ./packages/velohero-client/
COPY --from=source --chown=node:node /app/packages/garmin-connect/src ./packages/garmin-connect/src
COPY --from=source --chown=node:node /app/packages/garmin-connect/package.json ./packages/garmin-connect/
COPY --from=source --chown=node:node /app/packages/trainingpeaks-connect/src ./packages/trainingpeaks-connect/src
COPY --from=source --chown=node:node /app/packages/trainingpeaks-connect/package.json ./packages/trainingpeaks-connect/
COPY --from=source --chown=node:node /app/packages/shared/src ./packages/shared/src
COPY --from=source --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# Link workspace packages so bare-specifier imports resolve
# Use ln -sf to overwrite any links pnpm's hoisted mode may have created
RUN ln -sf /app node_modules/dofek && \
    ln -sf /app/packages/eight-sleep node_modules/eight-sleep-client && \
    ln -sf /app/packages/zwift-client node_modules/zwift-client && \
    ln -sf /app/packages/trainerroad-client node_modules/trainerroad-client && \
    ln -sf /app/packages/velohero-client node_modules/velohero-client && \
    ln -sf /app/packages/garmin-connect node_modules/garmin-connect && \
    ln -sf /app/packages/trainingpeaks-connect node_modules/trainingpeaks-connect && \
    ln -sf /app/packages/whoop-whoop node_modules/whoop-whoop && \
    mkdir -p node_modules/@dofek && \
    ln -sf /app/packages/shared node_modules/@dofek/shared

# SOPS-encrypted .env — decrypted at runtime via SOPS_AGE_KEY env var
COPY --from=source --chown=node:node /app/.env .
COPY --from=source --chown=node:node /app/.sops.yaml .

COPY --chown=node:node entrypoint.sh .

# Create job-files directory for upload chunks (volume mount point)
RUN mkdir -p /app/job-files && chown node:node /app/job-files

# Run as non-root user (node user is built into node:22-slim, uid 1000)
USER node

ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]

# ── Client image (Nginx serving Vite bundle) ────────────────────────────
FROM nginx:alpine AS client
COPY --from=client-build /app/packages/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
