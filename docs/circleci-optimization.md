# CI Cost Optimization

As of March 2026, we paused CircleCI in favor of GitHub Actions due to credit exhaustion. The CircleCI config is preserved at `.circleci/config.yml` for potential future use. Below is the audit of what was consuming credits, and what to fix before re-enabling.

## GitHub Actions Optimizations (current)

### What we've done
- **Artifacts only on failure**: Coverage, mutation reports, and Cypress screenshots only upload when the job fails, with 7-day retention. This prevents storage bloat from successful runs.
- **Concurrency with cancel-in-progress**: Force-pushes cancel stale runs so we don't pay for abandoned pipelines.
- **E2E gated to main**: The Docker-compose e2e job only runs on main merges, not every PR push.
- **Mutation scoped to changed files**: Stryker only mutates `.ts` files that changed in the PR, with incremental caching.
- **Docker builds gated to main**: Server and client images only build/push after tests pass on main.
- **GHA build cache for Docker**: Uses `cache-from: type=gha` to avoid rebuilding layers.

### Future optimizations if needed
- **ARM runners cost more**: `ubuntu-24.04-arm` is used for Docker builds (needed for arm64 deploy target). If cost becomes an issue, could cross-compile on x64 with QEMU or build less frequently.
- **Consolidate check + test-unit**: These could share a single checkout/install if pnpm cache misses become expensive. Tradeoff: lose separate status checks on PRs.
- **Mutation as non-blocking**: Make mutation `continue-on-error: true` so it doesn't block PRs but still reports. Saves re-run costs when mutation fails on non-critical code.
- **Path filters**: Skip CI entirely for docs-only or config-only changes using `paths-ignore`.

## Usage Breakdown (billing period ending March 2026)

| Resource Class | Minutes | Credits | % of Total |
|----------------|---------|---------|------------|
| machine-medium | 1,264 | 12,743 | 50% |
| docker-medium | 909 | 9,498 | 37% |
| docker-large | 160 | 3,247 | 13% |
| **Total** | **2,333** | **25,488** | |

Storage: 12 GB used (2 GB included) — 4,473 credits in overage.

| Storage Type | Size |
|--------------|------|
| workspace | 8.9 GB |
| cache | 3.1 GB |
| artifact | 40.7 MB |

## Top Cost Drivers

### 1. E2E job on machine executor (50% of credits)

The `test-e2e` job uses `machine: medium` (~10 credits/min) and runs ~35 min per pipeline. It builds Docker images from scratch, installs Node/pnpm/Cypress on each run, and runs docker-compose.

**Fixes:**
- Gate e2e to only run on `main` merges, not every PR push
- Or move Docker builds to `setup_remote_docker` on a Docker executor
- Remove the `docker save` / `docker load` caching — it saves all images on the VM into a single tar, bloating cache storage

### 2. Mutation testing on every PR push (significant docker-medium consumer)

Stryker runs ~25 min per PR push at 10 credits/min. Every force-push or fixup triggers a new run.

**Fixes:**
- Only run mutation on the final PR push (e.g., trigger via label or comment)
- Or run mutation only on `main` (weekly schedule already exists)
- Fix the Stryker cache key: `stryker-v1-{{ .Branch }}-{{ .Revision }}` creates a new cache entry per commit per branch, never cleaned up. Use `stryker-v1-{{ .Branch }}` instead.

### 3. Seven independent jobs, each with full setup

Every job runs `checkout → install pnpm → restore cache → pnpm install`. That's ~2-3 min overhead × 7 = ~15-20 wasted minutes (150-200 credits) per pipeline.

**Fixes:**
- Consolidate `lint`, `typescript`, and `knip` into a single job (they're all fast, all on docker/medium)
- Use workspaces to share the installed `node_modules` across jobs instead of re-installing

### 4. Integration tests on docker-large (13% of credits)

`test-integration` uses `large` (20 credits/min) with 6 GB `NODE_OPTIONS`. May not actually need `large`.

**Fixes:**
- Try `medium` with `--max-old-space-size=3072` — if tests pass, this halves the per-minute cost

### 5. Storage overage (4,473 credits)

- **8.9 GB workspace**: No `persist_to_workspace` in current config — possibly stale from a previous config. Investigate or contact CircleCI support.
- **3.1 GB cache**: Dominated by the Docker image tar (~2 GB) and duplicate pnpm stores (docker + machine).
- **Stryker incremental cache**: One entry per branch per revision, never pruned.

**Fixes:**
- Remove Docker image caching from e2e job
- Eliminate duplicate pnpm store cache (only needed if machine executor is kept)
- Change Stryker cache key to not include `{{ .Revision }}`
