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

## Failure modes

- `403`: the token does not have read permissions for issues/events.
- `401`: the token is missing, malformed, or expired.
- `404`: the organization, project, or issue id is wrong, or the token cannot
  access it.
