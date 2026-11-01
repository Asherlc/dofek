# Sentry Issue Triage Runbook

Use this guide to inspect Sentry issues from the terminal.

## Auth model

- `SENTRY_DSN`, `VITE_SENTRY_DSN`, and `EXPO_PUBLIC_SENTRY_DSN` are ingest DSNs only.
- Issue and event reads require a Sentry auth token with read scopes.
- Release creation, source-map upload, and deploy records use the CI token
  shared by the build and deployment workflows.

The current CI token is intentionally scoped for CI release automation rather
than issue reads. If issue triage fails with `403`, create a separate read-only
Sentry token and store it in Infisical as `SENTRY_READ_AUTH_TOKEN`. Sentry
documents `org:ci` as the scope intended for release automation:
[Sentry API permissions](https://docs.sentry.io/api/permissions/).

## Setup

```bash
export SENTRY_ORG="east-bay-software"
export SENTRY_PROJECT="dofek-server"
export SENTRY_AUTH_TOKEN="${SENTRY_READ_AUTH_TOKEN}"
```

Use `dofek-server` for API and worker issues, `dofek-web` for browser issues,
and `dofek-mobile` for mobile issues.

## Releases

Production web images carry the full source commit SHA in `SENTRY_RELEASE`.
The browser, API server, and background worker therefore report the same
release identifier. The Vite build creates the release and uploads browser
source maps; after the complete Swarm rollout converges, the deploy workflow
records a `production` deploy for both the `dofek-web` and `dofek-server`
projects. Sentry uses matching release identifiers to associate events and
source artifacts, while deploys identify when a release reached an
environment:
[release creation](https://docs.sentry.io/api/releases/create-a-new-release-for-an-organization/),
[deploy creation](https://docs.sentry.io/api/releases/create-a-deploy/).

## List unresolved issues

```bash
sentry-cli issues list \
  --org "${SENTRY_ORG}" \
  --project "${SENTRY_PROJECT}" \
  --status unresolved
```

## Inspect a specific issue

```bash
sentry-cli issues list \
  --org "${SENTRY_ORG}" \
  --project "${SENTRY_PROJECT}" \
  --id "${ISSUE_ID}"
```

For full event payloads and stack traces, use the Sentry API with the same
read token:

```bash
curl -sS \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
  "https://sentry.io/api/0/issues/${ISSUE_ID}/events/latest/" | jq .
```

## Using repo secrets

If the read token is stored in Infisical:

```bash
pnpm tsx scripts/with-env.ts -- sh -c '
  export SENTRY_AUTH_TOKEN="${SENTRY_READ_AUTH_TOKEN}"
  sentry-cli issues list \
    --org east-bay-software \
    --project dofek-web \
    --status unresolved
'
```

## Handled operational failures

Web and mobile count `handled_failure` events in the existing PostHog pipeline
instead of creating exception issues for handled offline requests, cancellations,
and confirmed invalid credentials. Break down event counts by `kind` in
[PostHog Trends](https://posthog.com/docs/product-analytics/insights/trends).
These are counts of reporting observations, not unique requests or guaranteed
data loss. Repeated reports of the same operation can produce multiple events.
No user ID, request URL, or error text is supplied as a custom count property.
The existing SDK identity/consent behavior still applies.

Mobile also records informational logs and breadcrumbs. The existing background
sync policy counts known timeouts and lost connections as `background_transport`;
it includes WHOOP IMU/realtime uploads. This does not promise subsequent delivery.
Inspect retained buffers and sync progress when investigating sustained failure.
Query the existing log destination using its [map-field contract](axiom-observability-runbook.md):

```apl
['dofek-logs']
| where _time > ago(24h)
| where body == '[handled-failure] Handled operational failure'
| summarize reports = count() by kind = tostring(['attributes.custom']['kind'])
```

Provider lifecycle diagnostics emit the OpenTelemetry counter
`provider.auth.events` with only `provider` and `event` labels, including
`sign_in_started`, `sign_in_succeeded`, `sign_in_failed`, and refresh outcomes.
Successful transactional events count only after commit. Failed lifecycle
diagnostics retain their structured logs without manufacturing a second
exception; the caller still reports unexpected failures. OpenTelemetry describes
[counter aggregation](https://opentelemetry.io/docs/specs/otel/metrics/api/#counter).

Classification requires a known transport shape or an explicit credential
marker from Dofek's own password-check rejection. A generic 401/403, BAD_REQUEST,
or vendor credential error class does not establish invalid credentials: existing
Kaya and Zepp classes also represent unexpected response failures. Unknown HTTP authorization diagnostics, malformed responses,
storage failures, and unhandled exceptions remain reportable. Browser console
messages do not independently create PostHog exception issues; explicit reports
and genuine unhandled errors/rejections still do. See PostHog's
[exception capture options](https://posthog.com/docs/error-tracking/installation/web).

For wrapped errors, the underlying cause establishes the outcome. A cancellation
message copied onto an outer wrapper does not make an underlying storage or
authorization failure expected. Parse/schema evidence anywhere in the chain
remains reportable; a generic wrapper around a genuine abort remains a handled
cancellation. See the [shared classifier](../packages/telemetry/src/handled-failure.ts).

## Provider sync failures

Users receive failed-sync status and reconnect/retry guidance through the shared
sync API and the web/mobile history presentation. Per-attempt exception reporting
uses the [provider reporting predicate](../src/lib/provider-error-reporting.ts):
recognized typed auth failures, transport outages/timeouts, rate limits, and
direct cancellation remain in operational status, logs, and metrics. Unexpected
schema, parsing, database, and unexplained authorization failures remain
reportable. A generic HTTP 401/403 alone does not establish an expected account
failure. This preserves Sentry's role for actionable exceptions; see its
[capture API](https://docs.sentry.io/platforms/javascript/guides/node/usage/#capturing-errors).

The [sync-log policy](../src/db/sync-log.ts) separately raises a warning at exactly
two consecutive scheduled overall-sync failures. The
[user notification policy](../src/db/provider-issue-notification.ts) deduplicates
notifications until recovery. Suppressing an expected per-attempt exception does
not disable either persistence escalation or user-facing failure information.

## Access failures

- `403`: the token does not have read permissions for issues/events.
- `401`: the token is missing, malformed, or expired.
- `404`: the organization, project, or issue id is wrong, or the token cannot
  access it.
