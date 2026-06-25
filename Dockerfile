FROM node:26-alpine AS base
RUN apk upgrade --no-cache
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
COPY package.json ./
RUN npm install -g corepack@0.35.0 && corepack enable && corepack prepare --activate

# dbt 1.10.x is incompatible with Alpine's Python 3.14; install tools on 3.12 instead.
FROM python:3.12-alpine AS dbt-tools
RUN apk add --no-cache build-base && \
    pip install --no-cache-dir \
      dbt-core==1.10.22 \
      dbt-clickhouse==1.10.0 \
      sqlfluff==4.2.1 \
      sqlfluff-templater-dbt==4.2.1

# ── Source stage: just copy files, no install ─────────────────────────
FROM base AS source
WORKDIR /app
COPY . .

# ── Client build: full install + Vite build (assets copied into server stage)
FROM base AS client-build
WORKDIR /app
ENV CYPRESS_INSTALL_BINARY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/whoop-whoop/package.json ./packages/whoop-whoop/
COPY packages/eight-sleep/package.json ./packages/eight-sleep/
COPY packages/zwift-client/package.json ./packages/zwift-client/
COPY packages/zepp-client/package.json ./packages/zepp-client/
COPY packages/trainerroad-client/package.json ./packages/trainerroad-client/
COPY packages/velohero-client/package.json ./packages/velohero-client/
COPY packages/garmin-connect/package.json ./packages/garmin-connect/
COPY packages/trainingpeaks-connect/package.json ./packages/trainingpeaks-connect/
COPY packages/provider-http/package.json ./packages/provider-http/
COPY packages/format/package.json ./packages/format/
COPY packages/scoring/package.json ./packages/scoring/
COPY packages/nutrition/package.json ./packages/nutrition/
COPY packages/training/package.json ./packages/training/
COPY packages/stats/package.json ./packages/stats/
COPY packages/onboarding/package.json ./packages/onboarding/
COPY packages/providers-meta/package.json ./packages/providers-meta/
COPY packages/auth/package.json ./packages/auth/
COPY packages/heart-rate-variability/package.json ./packages/heart-rate-variability/
COPY packages/recovery/package.json ./packages/recovery/
COPY packages/zones/package.json ./packages/zones/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,required=false \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)" \
    && export SENTRY_AUTH_TOKEN \
    && cd packages/web && pnpm run build
RUN pnpm --filter dofek-server deploy --legacy --prod /prod/server

# ── Server image (Express API + sync runner) ────────────────────────────
FROM base AS server
ENV NODE_ENV=production
WORKDIR /app

# Docker CLI for worker container management (startWorker)
RUN apk add --no-cache curl ca-certificates libbz2 && \
    ARCH=$(uname -m) && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-29.5.3.tgz" | \
      tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    apk del curl
COPY --from=dbt-tools /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=dbt-tools /usr/local/bin/dbt /usr/local/bin/dbt
COPY --from=dbt-tools /usr/local/bin/sqlfluff /usr/local/bin/sqlfluff
COPY --from=dbt-tools /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=dbt-tools /usr/local/lib/libpython3.12.so* /usr/local/lib/


COPY --from=source --chown=node:node /app/src ./src
COPY --from=source --chown=node:node /app/analytics ./analytics
COPY --from=source --chown=node:node /app/drizzle ./drizzle
COPY --from=source --chown=node:node /app/package.json .
COPY --from=source --chown=node:node /app/pnpm-workspace.yaml .
COPY --from=source --chown=node:node /app/packages/server/src ./packages/server/src
COPY --from=source --chown=node:node /app/packages/server/package.json ./packages/server/
COPY --from=source --chown=node:node /app/packages/whoop-whoop/src ./packages/whoop-whoop/src
COPY --from=source --chown=node:node /app/packages/whoop-whoop/package.json ./packages/whoop-whoop/
COPY --from=source --chown=node:node /app/packages/eight-sleep/src ./packages/eight-sleep/src
COPY --from=source --chown=node:node /app/packages/eight-sleep/package.json ./packages/eight-sleep/
COPY --from=source --chown=node:node /app/packages/zwift-client/src ./packages/zwift-client/src
COPY --from=source --chown=node:node /app/packages/zwift-client/package.json ./packages/zwift-client/
COPY --from=source --chown=node:node /app/packages/zepp-client/src ./packages/zepp-client/src
COPY --from=source --chown=node:node /app/packages/zepp-client/package.json ./packages/zepp-client/
COPY --from=source --chown=node:node /app/packages/trainerroad-client/src ./packages/trainerroad-client/src
COPY --from=source --chown=node:node /app/packages/trainerroad-client/package.json ./packages/trainerroad-client/
COPY --from=source --chown=node:node /app/packages/velohero-client/src ./packages/velohero-client/src
COPY --from=source --chown=node:node /app/packages/velohero-client/package.json ./packages/velohero-client/
COPY --from=source --chown=node:node /app/packages/garmin-connect/src ./packages/garmin-connect/src
COPY --from=source --chown=node:node /app/packages/garmin-connect/package.json ./packages/garmin-connect/
COPY --from=source --chown=node:node /app/packages/trainingpeaks-connect/src ./packages/trainingpeaks-connect/src
COPY --from=source --chown=node:node /app/packages/trainingpeaks-connect/package.json ./packages/trainingpeaks-connect/
COPY --from=source --chown=node:node /app/packages/provider-http/src ./packages/provider-http/src
COPY --from=source --chown=node:node /app/packages/provider-http/package.json ./packages/provider-http/
COPY --from=source --chown=node:node /app/packages/format/src ./packages/format/src
COPY --from=source --chown=node:node /app/packages/format/package.json ./packages/format/
COPY --from=source --chown=node:node /app/packages/stats/src ./packages/stats/src
COPY --from=source --chown=node:node /app/packages/stats/package.json ./packages/stats/
COPY --from=source --chown=node:node /app/packages/scoring/src ./packages/scoring/src
COPY --from=source --chown=node:node /app/packages/scoring/package.json ./packages/scoring/
COPY --from=source --chown=node:node /app/packages/onboarding/src ./packages/onboarding/src
COPY --from=source --chown=node:node /app/packages/onboarding/package.json ./packages/onboarding/
COPY --from=source --chown=node:node /app/packages/auth/src ./packages/auth/src
COPY --from=source --chown=node:node /app/packages/auth/package.json ./packages/auth/
COPY --from=source --chown=node:node /app/packages/training/src ./packages/training/src
COPY --from=source --chown=node:node /app/packages/training/package.json ./packages/training/
COPY --from=source --chown=node:node /app/packages/heart-rate-variability/src ./packages/heart-rate-variability/src
COPY --from=source --chown=node:node /app/packages/heart-rate-variability/package.json ./packages/heart-rate-variability/
COPY --from=source --chown=node:node /app/packages/recovery/src ./packages/recovery/src
COPY --from=source --chown=node:node /app/packages/recovery/package.json ./packages/recovery/
COPY --from=source --chown=node:node /app/packages/zones/src ./packages/zones/src
COPY --from=source --chown=node:node /app/packages/zones/package.json ./packages/zones/
COPY --from=source --chown=node:node /app/packages/providers-meta/src ./packages/providers-meta/src
COPY --from=source --chown=node:node /app/packages/providers-meta/package.json ./packages/providers-meta/
COPY --from=client-build --chown=node:node /prod/server/node_modules ./node_modules
RUN corepack disable && rm -rf /pnpm /root/.cache/node/corepack /root/.local/share/pnpm
# Link workspace packages so bare-specifier imports resolve
# Use ln -sfn to overwrite any links pnpm deploy may have created
RUN ln -sfn /app node_modules/dofek && \
    ln -sfn /app/packages/eight-sleep node_modules/eight-sleep-client && \
    ln -sfn /app/packages/zwift-client node_modules/zwift-client && \
    ln -sfn /app/packages/zepp-client node_modules/zepp-client && \
    ln -sfn /app/packages/trainerroad-client node_modules/trainerroad-client && \
    ln -sfn /app/packages/velohero-client node_modules/velohero-client && \
    ln -sfn /app/packages/garmin-connect node_modules/garmin-connect && \
    ln -sfn /app/packages/trainingpeaks-connect node_modules/trainingpeaks-connect && \
    ln -sfn /app/packages/whoop-whoop node_modules/whoop-whoop && \
    mkdir -p node_modules/@dofek && \
    ln -sfn /app/packages/format node_modules/@dofek/format && \
    ln -sfn /app/packages/stats node_modules/@dofek/stats && \
    ln -sfn /app/packages/scoring node_modules/@dofek/scoring && \
    ln -sfn /app/packages/onboarding node_modules/@dofek/onboarding && \
    ln -sfn /app/packages/training node_modules/@dofek/training && \
    ln -sfn /app/packages/auth node_modules/@dofek/auth && \
    ln -sfn /app/packages/heart-rate-variability node_modules/@dofek/heart-rate-variability && \
    ln -sfn /app/packages/providers-meta node_modules/@dofek/providers && \
    ln -sfn /app/packages/provider-http node_modules/@dofek/provider-http && \
    ln -sfn /app/packages/recovery node_modules/@dofek/recovery && \
    ln -sfn /app/packages/zones node_modules/@dofek/zones

# Seed script for preview/dev environments
COPY --from=source --chown=node:node /app/scripts ./scripts

# Non-secret config (.env)
COPY --from=source --chown=node:node /app/.env .

# Built web assets for static serving (Express serves these in production)
COPY --from=client-build --chown=node:node /app/packages/web/dist ./packages/web/dist

COPY --chown=node:node entrypoint.sh .

# Create job-files directory for upload chunks (volume mount point)
RUN mkdir -p /app/job-files && chown node:node /app/job-files
# Create updates directory for OTA bundles (bind mount point)
RUN mkdir -p /app/updates && chown node:node /app/updates

# Run as non-root user (node user is built into node:26-alpine, uid 1000)
USER node

ENTRYPOINT ["./entrypoint.sh"]
CMD ["sync"]
