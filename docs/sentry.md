# Sentry Issue Triage Runbook

Use this guide to inspect Sentry issues from the terminal.

## Auth model

- `SENTRY_DSN`, `VITE_SENTRY_DSN`, and `EXPO_PUBLIC_SENTRY_DSN` are ingest DSNs only.
- Issue and event reads require a Sentry auth token with read scopes.
- Sourcemap upload only needs the CI token used by build workflows.

The current CI token is intentionally scoped for artifact upload. If issue
triage fails with `403`, create a separate read-only Sentry token and store it
in Infisical as `SENTRY_READ_AUTH_TOKEN`.

## Setup

```bash
export SENTRY_ORG="east-bay-software"
export SENTRY_PROJECT="dofek-web"
export SENTRY_AUTH_TOKEN="${SENTRY_READ_AUTH_TOKEN}"
```

For mobile issues, use `dofek-mobile` as the project.

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
./scripts/with-env.sh sh -c '
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
