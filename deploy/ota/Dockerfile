FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS source
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .

FROM source AS test
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./... -count=1

FROM source AS build
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags '-X xprem/internal/version.Version=3.2.7-dofek.4' -o /out/main ./cmd/api

FROM ghcr.io/mercuretechnologies/xprem:v3.2.7@sha256:fd6998921c343f6151867195cc6373415d4c134b106a97ccebe9e885f848bc26
COPY --from=build /out/main /app/main
COPY --from=build /src/LICENSE.md /usr/share/licenses/xprem/LICENSE.md
COPY --from=build /src/ee/LICENSE /usr/share/licenses/xprem/EE-LICENSE
LABEL org.opencontainers.image.source="https://github.com/Asherlc/dofek" \
      org.opencontainers.image.version="3.2.7-dofek.4" \
      org.opencontainers.image.upstream.revision="071f6d907527d7de1ba21dd0be23a6ba669a2b1c"
