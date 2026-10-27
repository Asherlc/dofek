# Deployment Failure Isolation Design

**Status:** Draft for user review  
**Date:** 2026-09-27

## Problem

The production deployment workflow intentionally scales
`analytics-worker`, the metric-stream ClickHouse sinks, and
`processing-reconciliation` to zero while it applies migrations and verifies
the PeerDB ClickHouse contract. The final stack deploy restores them only after
all prerequisites succeed.

On 2026-09-27, the deploy of commit `f56b4f3` applied the quiesced stack, then
failed web convergence. The attempted web task exited with status 1 and Swarm
rolled the service back to the prior image. GitHub Actions stopped the later
Postgres/CDC steps and skipped the final stack deploy, leaving the processing
services at zero replicas. The [failed production deploy run](https://github.com/Asherlc/dofek/actions/runs/36283808747)
records the rollback and skipped steps.

The app failure was caused by environment propagation. Production startup
requires `MCP_OIDC_COOKIE_KEY`, but `scripts/deploy-service-environment.ts`
does not allowlist it for the web service and
`scripts/validate-deploy-env.ts` does not require it. The Infisical dotenv
renderer therefore cannot pass the key through to `web.env`, even if the key
exists in Infisical. `packages/server/src/mcp/oauth-route.ts` throws when the
key is absent in production.

## Goals

- Pass `MCP_OIDC_COOKIE_KEY` to the web service and fail deploy preparation
  before any service is quiesced when the key is absent.
- Keep an app-only web convergence failure from preventing restoration of
  processing services after the database and CDC safety gates succeed.
- Preserve a failed GitHub Actions result when the requested web version does
  not converge.
- Keep processing services quiesced if stack application, database
  readiness, migrations, or PeerDB CDC verification fails.

## Non-goals

- Automatically restore services after an unsuccessful stack apply or failed
  database/CDC prerequisite.
- Ignore or downgrade failures in `worker`, ClickHouse, PeerDB, or processing
  service convergence.
- Change the processing-service desired replica counts or the deployment
  cadence.

## Design

### Web secret contract

Add `MCP_OIDC_COOKIE_KEY` to the application environment keys delivered to
`web.env` and `web-pre-migration.env`, and make it a required web deployment
key. Also add it to the complete Infisical deploy environment's required-key
validation so a missing key is reported before service environment files are
rendered or production services are changed. The key remains excluded from
worker and analytics service environment files.

Tests for `scripts/deploy-service-environment.ts` will prove that the key is
included in both web artifacts, omitted from unrelated service artifacts, and
that missing configuration fails rendering. The existing web OAuth tests
already prove production startup fails without the key.

### Deployment failure isolation

Keep the current quiesce period and safety gates. After the requested stack
has been applied successfully, classify web convergence separately from the
rest of the required service convergence:

1. A failed `docker stack deploy` command remains fatal and leaves processing
   services quiesced because the applied state is uncertain.
2. A web-only convergence failure after a successful stack apply is recorded
   with its image, task state, and service-task diagnostics, but does not stop
   the later Postgres readiness, provider-connection cutover, ClickHouse,
   PeerDB configuration, finalization, or exact marker-verification steps.
3. Failures in required non-web service convergence or any database/CDC gate
   remain fatal. The final processing-service deploy remains gated on
   successful CDC verification, so those failures leave services quiesced.
4. When all safety gates pass, run the normal full-stack deploy and verify
   processing-service convergence. The job then fails explicitly if the
   requested web version did not converge. This leaves the previous healthy
   web version running while reporting the failed release, and allows healthy
   processing services to run.

This is intentionally not an unconditional `always()` cleanup. A prior web
failure may be deferred; a failed database or CDC gate may not be bypassed.

## Error reporting and observability

When web convergence is deferred, preserve the first failing web state and
`docker service ps --no-trunc` output in the workflow log and summary. The
post-restore failure should state that processing services were restored after
the safety gates passed but the web rollout rolled back. If a safety gate
fails, retain the existing “processing services remain quiesced” report.

## Validation

- Unit tests for service environment rendering and preflight validation.
- Workflow contract coverage for the ordering: quiesced stack apply, deferred
  web convergence outcome, successful database/CDC gates, processing-service
  restoration, and final web failure reporting.
- Run the focused tests and repository workflow validation/lint commands
  available for the changed files.
- After merge/deploy, verify the requested web version is healthy, all
  processing services are at their expected replica counts, and a successful
  analytics and reconciliation cycle is recorded.

## Risks and trade-offs

- A web failure still makes the deployment fail and leaves the previous web
  image serving traffic; restoration is not a release rollback.
- Restoring processing services is safe only after the existing migration and
  exact CDC marker gates pass. Workflow conditions must preserve this ordering
  even while carrying a deferred web failure.
- This design isolates web convergence failures after a successful stack
  apply. Failures before or during stack application and failures in database
  or CDC gates remain fail-closed and may require operator recovery.

## References

- [Production deploy run and rollback evidence](https://github.com/Asherlc/dofek/actions/runs/36283808747)
- [Environment renderer](../../../scripts/deploy-service-environment.ts)
- [Deploy environment validator](../../../scripts/validate-deploy-env.ts)
- [Production cookie-key requirement](../../../packages/server/src/mcp/oauth-route.ts)
- [Deployment workflow](../../../.github/workflows/deploy-web-stack.yml)
- [GitHub Actions status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
- [Docker Swarm service updates and task replacement](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/#tasks-and-scheduling)
