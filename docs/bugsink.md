# Bugsink Issue Triage Runbook

Use this guide to inspect Bugsink issues/events from the terminal.

## Why this exists

- Our Bugsink instance (`https://ebsoftware.bugsink.com`) requires login for issue pages.
- Sentry-compatible read endpoints under `/api/0/*` are not implemented on this instance for issue/event retrieval.
- The supported read path is the canonical API under `/api/canonical/0/*`.

## Auth model (important)

- **DSN key (`SENTRY_DSN`) is for ingest**, not for reading issues/events.
- **Canonical API requires a Bugsink bearer token** (40 lowercase hex chars).
- A `SENTRY_AUTH_TOKEN` for `sentry.io` will not authenticate against Bugsink.

Create a Bugsink token in the Bugsink UI (`Tokens` in the top menu; superuser access required), then store it in Infisical as `BUGSINK_API_TOKEN`.

## Setup

```bash
export BUGSINK_URL="https://ebsoftware.bugsink.com"
export BUGSINK_API_TOKEN="<40-char-lowercase-hex>"
```

Quick auth check:

```bash
curl -sS \
  -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
  "${BUGSINK_URL}/api/canonical/0/projects/" | jq .
```

## Investigate an issue URL

Example issue URL:

```text
https://ebsoftware.bugsink.com/issues/issue/f5d88783-1c5b-4f43-a0a0-78acfe1fb13c/event/last/
```

Extract the issue UUID:

```bash
ISSUE_ID="f5d88783-1c5b-4f43-a0a0-78acfe1fb13c"
```

Get issue metadata:

```bash
curl -sS \
  -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
  "${BUGSINK_URL}/api/canonical/0/issues/${ISSUE_ID}/" | jq .
```

List events for the issue (newest first):

```bash
curl -sS \
  -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
  "${BUGSINK_URL}/api/canonical/0/events/?issue=${ISSUE_ID}&order=desc" | jq .
```

Get latest event id and fetch full payload:

```bash
EVENT_ID="$(
  curl -sS \
    -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
    "${BUGSINK_URL}/api/canonical/0/events/?issue=${ISSUE_ID}&order=desc" |
  jq -r '.results[0].id'
)"

curl -sS \
  -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
  "${BUGSINK_URL}/api/canonical/0/events/${EVENT_ID}/" | jq .
```

Get rendered stacktrace:

```bash
curl -sS \
  -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
  "${BUGSINK_URL}/api/canonical/0/events/${EVENT_ID}/stacktrace/"
```

## Using repo secrets (`with-env.sh`)

If the token is stored in Infisical, run via:

```bash
./scripts/with-env.sh sh -c '
  export BUGSINK_URL="https://ebsoftware.bugsink.com"
  export BUGSINK_API_TOKEN="$BUGSINK_API_TOKEN"
  curl -sS -H "Authorization: Bearer ${BUGSINK_API_TOKEN}" \
    "${BUGSINK_URL}/api/canonical/0/projects/" | jq .
'
```

## Failure modes

- `302` to `/accounts/login/...`: unauthenticated browser path or missing API auth.
- `401 {"error": "Invalid token"}`: wrong/expired token.
- `401 {"detail":"Malformed Bearer token, must be 40 lowercase hex chars."}`: token format is invalid.
- `404 Unimplemented API endpoint: /api/0/...`: using Sentry-compatible path for unsupported read APIs; use `/api/canonical/0/*`.

## Notes on `sentry-cli`

- `sentry-cli` is still useful for operations Bugsink explicitly supports (for example sourcemap upload).
- For issue/event triage, prefer canonical API calls above.
