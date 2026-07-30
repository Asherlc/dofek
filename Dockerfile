FROM node:26-alpine AS base
RUN apk upgrade --no-cache
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
COPY package.json ./
# Node Alpine omits Corepack; npm is used only to install the pinned bootstrap tools.
RUN npm install -g npm@12.0.1 corepack@0.35.0 && corepack enable && corepack prepare --activate

FROM python:3.14.6-alpine3.24 AS dbt-tools
RUN apk add --no-cache build-base && \
    pip install --no-cache-dir \
    dbt-core==1.11.12 \
    dbt-clickhouse==1.10.1 \
    sqlfluff==4.2.2 \
    sqlfluff-templater-dbt==4.2.2

# ── Native FIT decoder: CMake + vcpkg ────────────────────────────────
FROM alpine:3.24 AS fit-decoder-build
ENV VCPKG_ROOT=/opt/vcpkg
ENV VCPKG_FORCE_SYSTEM_BINARIES=1
ARG VCPKG_COMMIT=ec62869cdd9f80413abb5e4c1d8b68688df932f4
RUN apk add --no-cache \
      bash \
      build-base \
      cmake \
      curl \
      git \
      linux-headers \
      ninja \
      pkgconfig \
      tar \
      unzip \
      zip && \
    git clone https://github.com/microsoft/vcpkg.git "$VCPKG_ROOT" && \
    git -C "$VCPKG_ROOT" checkout "$VCPKG_COMMIT" && \
    "$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
WORKDIR /src/native/fit-decoder
COPY native/fit-decoder ./
COPY src/fit/fixtures/test.fit /src/src/fit/fixtures/test.fit
RUN --mount=type=cache,id=vcpkg-downloads,target=/opt/vcpkg/downloads \
    --mount=type=cache,id=vcpkg-archives,target=/root/.cache/vcpkg/archives \
    cmake --preset release && \
    cmake --build --preset release && \
    ctest --preset release

# ── Source stage: just copy files, no install ─────────────────────────
FROM base AS source
WORKDIR /app
COPY . .

# ── Workspace manifests: package graph without source files ──────────────
FROM base AS workspace-manifests
WORKDIR /app
ENV CYPRESS_INSTALL_BINARY=0
ARG DEPENDENCY_CACHE_BUST
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
COPY packages/peloton-client/package.json ./packages/peloton-client/
COPY packages/xert-client/package.json ./packages/xert-client/
COPY packages/format/package.json ./packages/format/
COPY packages/filter-columns/package.json ./packages/filter-columns/
COPY packages/scoring/package.json ./packages/scoring/
COPY packages/nutrition/package.json ./packages/nutrition/
COPY packages/training/package.json ./packages/training/
COPY packages/stats/package.json ./packages/stats/
COPY packages/onboarding/package.json ./packages/onboarding/
COPY packages/providers-meta/package.json ./packages/providers-meta/
COPY packages/auth/package.json ./packages/auth/
COPY packages/heart-rate-variability/package.json ./packages/heart-rate-variability/
COPY packages/imu/package.json ./packages/imu/
COPY packages/recovery/package.json ./packages/recovery/
COPY packages/zones/package.json ./packages/zones/

# ── Workspace dependencies: full install for web build tooling ───────────
FROM workspace-manifests AS workspace-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    echo "$DEPENDENCY_CACHE_BUST" >/dev/null && \
    pnpm install --force --frozen-lockfile

# ── Server production dependencies: stays cached across source-only changes ──
FROM workspace-manifests AS server-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    echo "$DEPENDENCY_CACHE_BUST" >/dev/null && \
    pnpm install --force --prod --frozen-lockfile --filter dofek-server...

# ── Client build: full source + Vite build (assets copied into server stage)
FROM workspace-deps AS client-build
COPY . .
ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
ARG VITE_ASSET_BASE_URL=/
ENV VITE_ASSET_BASE_URL=${VITE_ASSET_BASE_URL}
ARG REQUIRE_SENTRY_RELEASE_UPLOAD=false
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,required=false \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)" \
    && REQUIRE_SENTRY_AUTH_TOKEN="$REQUIRE_SENTRY_RELEASE_UPLOAD" \
    && export SENTRY_AUTH_TOKEN REQUIRE_SENTRY_AUTH_TOKEN \
    && cd packages/web && pnpm run build

# ── Server image (Express API + sync runner) ────────────────────────────
FROM base AS server
ARG COMMIT_HASH
ENV NODE_ENV=production
ENV SENTRY_RELEASE=${COMMIT_HASH}
WORKDIR /app

RUN apk add --no-cache ca-certificates libbz2 libstdc++
COPY --from=dbt-tools /usr/local/bin/python3.14 /usr/local/bin/python3.14
COPY --from=dbt-tools /usr/local/bin/dbt /usr/local/bin/dbt
COPY --from=dbt-tools /usr/local/bin/sqlfluff /usr/local/bin/sqlfluff
COPY --from=dbt-tools /usr/local/lib/python3.14 /usr/local/lib/python3.14
COPY --from=dbt-tools /usr/local/lib/libpython3.14.so* /usr/local/lib/
COPY --from=fit-decoder-build /src/.build/fit-decoder/bin/dofek-fit-decoder /usr/local/bin/

COPY --from=source --chown=node:node /app/src ./src
COPY --from=source --chown=node:node /app/analytics ./analytics
COPY --from=source --chown=node:node /app/drizzle ./drizzle
COPY --from=source --chown=node:node /app/package.json .
COPY --from=source --chown=node:node /app/pnpm-workspace.yaml .
COPY --from=server-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=server-deps --chown=node:node /app/packages ./packages
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
COPY --from=source --chown=node:node /app/packages/peloton-client/src ./packages/peloton-client/src
COPY --from=source --chown=node:node /app/packages/peloton-client/package.json ./packages/peloton-client/
COPY --from=source --chown=node:node /app/packages/xert-client/src ./packages/xert-client/src
COPY --from=source --chown=node:node /app/packages/xert-client/package.json ./packages/xert-client/
COPY --from=source --chown=node:node /app/packages/format/src ./packages/format/src
COPY --from=source --chown=node:node /app/packages/format/package.json ./packages/format/
COPY --from=source --chown=node:node /app/packages/filter-columns/src ./packages/filter-columns/src
COPY --from=source --chown=node:node /app/packages/filter-columns/package.json ./packages/filter-columns/
COPY --from=source --chown=node:node /app/packages/stats/src ./packages/stats/src
COPY --from=source --chown=node:node /app/packages/stats/package.json ./packages/stats/
COPY --from=source --chown=node:node /app/packages/scoring/src ./packages/scoring/src
COPY --from=source --chown=node:node /app/packages/scoring/package.json ./packages/scoring/
COPY --from=source --chown=node:node /app/packages/nutrition/src ./packages/nutrition/src
COPY --from=source --chown=node:node /app/packages/nutrition/package.json ./packages/nutrition/
COPY --from=source --chown=node:node /app/packages/onboarding/src ./packages/onboarding/src
COPY --from=source --chown=node:node /app/packages/onboarding/package.json ./packages/onboarding/
COPY --from=source --chown=node:node /app/packages/auth/src ./packages/auth/src
COPY --from=source --chown=node:node /app/packages/auth/package.json ./packages/auth/
COPY --from=source --chown=node:node /app/packages/training/src ./packages/training/src
COPY --from=source --chown=node:node /app/packages/training/package.json ./packages/training/
COPY --from=source --chown=node:node /app/packages/heart-rate-variability/src ./packages/heart-rate-variability/src
COPY --from=source --chown=node:node /app/packages/heart-rate-variability/package.json ./packages/heart-rate-variability/
COPY --from=source --chown=node:node /app/packages/imu/src ./packages/imu/src
COPY --from=source --chown=node:node /app/packages/imu/package.json ./packages/imu/
COPY --from=source --chown=node:node /app/packages/recovery/src ./packages/recovery/src
COPY --from=source --chown=node:node /app/packages/recovery/package.json ./packages/recovery/
COPY --from=source --chown=node:node /app/packages/zones/src ./packages/zones/src
COPY --from=source --chown=node:node /app/packages/zones/package.json ./packages/zones/
COPY --from=source --chown=node:node /app/packages/providers-meta/src ./packages/providers-meta/src
COPY --from=source --chown=node:node /app/packages/providers-meta/package.json ./packages/providers-meta/
RUN corepack disable && \
    rm -rf /pnpm /root/.cache/node/corepack /root/.local/share/pnpm /usr/local/lib/node_modules/npm
# Link workspace packages so bare-specifier imports resolve
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
    ln -sfn /app/packages/filter-columns node_modules/@dofek/filter-columns && \
    ln -sfn /app/packages/stats node_modules/@dofek/stats && \
    ln -sfn /app/packages/scoring node_modules/@dofek/scoring && \
    ln -sfn /app/packages/nutrition node_modules/@dofek/nutrition && \
    ln -sfn /app/packages/onboarding node_modules/@dofek/onboarding && \
    ln -sfn /app/packages/training node_modules/@dofek/training && \
    ln -sfn /app/packages/auth node_modules/@dofek/auth && \
    ln -sfn /app/packages/heart-rate-variability node_modules/@dofek/heart-rate-variability && \
    ln -sfn /app/packages/imu node_modules/@dofek/imu && \
    ln -sfn /app/packages/providers-meta node_modules/@dofek/providers && \
    ln -sfn /app/packages/provider-http node_modules/@dofek/provider-http && \
    ln -sfn /app/packages/peloton-client node_modules/@dofek/peloton && \
    ln -sfn /app/packages/xert-client node_modules/@dofek/xert && \
    ln -sfn /app/packages/recovery node_modules/@dofek/recovery && \
    ln -sfn /app/packages/zones node_modules/@dofek/zones

# Seed script for preview/dev environments
COPY --from=source --chown=node:node /app/scripts ./scripts

# Non-secret config (.env)
COPY --from=source --chown=node:node /app/.env .

# Built web shell for Express; Vite assets may be served from the configured CDN base.
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
