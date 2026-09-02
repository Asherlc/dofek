FROM mcr.microsoft.com/devcontainers/base:3.0.3-ubuntu24.04

ARG TARGETARCH
ARG MISE_VERSION=2026.7.15
ARG MISE_SHA256_AMD64=9a729bbe121135da0c717d86d3328f21de5efcc6fa27ac8487ef481e428008d3
ARG MISE_SHA256_ARM64=a2e291cec627d2e7aa352f451317e12fc84125d7fe817f0ab9bfe619b1c1d7dd
ARG VCPKG_REF=b9db60d8be5cd434b195da8cffc2ee82e227fac4

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        pkg-config \
        tar \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
        amd64) mise_arch="x64"; mise_sha256="${MISE_SHA256_AMD64}" ;; \
        arm64) mise_arch="arm64"; mise_sha256="${MISE_SHA256_ARM64}" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --show-error \
        --output /usr/local/bin/mise \
        "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}" \
    && echo "${mise_sha256}  /usr/local/bin/mise" | sha256sum --check \
    && chmod 0755 /usr/local/bin/mise

RUN git init /opt/vcpkg \
    && git -C /opt/vcpkg remote add origin https://github.com/microsoft/vcpkg.git \
    && git -C /opt/vcpkg fetch --depth 1 origin "${VCPKG_REF}" \
    && git -C /opt/vcpkg checkout --detach FETCH_HEAD \
    && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics \
    && chown -R vscode:vscode /opt/vcpkg

ENV VCPKG_ROOT=/opt/vcpkg
