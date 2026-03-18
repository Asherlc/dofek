---
name: check-logs
description: Check production logs for errors — queries Axiom (structured logs) and falls back to Docker container logs via SSH.
---

# Check Production Logs

Query production logs to diagnose errors. Two sources are available:

1. **Axiom** (structured OTel logs) — preferred, searchable, persistent
2. **Docker container logs** (SSH) — fallback, ephemeral, reset on container restart

## Arguments

`$ARGUMENTS` should describe what to search for (e.g., "apple health import errors", "OAuth failures", "sync errors for strava"). If not provided, ask the user.

## Steps

### 1. Query Axiom (preferred)

Axiom receives structured logs via OpenTelemetry. The dataset is `dofek-logs`.

Decrypt the read token from the SOPS `.env` on the server:

```bash
ssh root@159.69.3.40 'docker exec dofek-web-1 sh -c "sops -d .env 2>/dev/null | grep AXIOM_READ_TOKEN"'
```

If `AXIOM_READ_TOKEN` is set, query Axiom using APL (Axiom Processing Language):

```bash
# Search for errors in the last 24 hours
curl -s 'https://api.axiom.co/v1/datasets/_apl' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "apl": "['\'dofek-logs\''] | where _time > ago(24h) | search \"<SEARCH_TERM>\" | sort by _time desc | limit 50"
  }'

# Filter by service (dofek-web, dofek-sync, dofek-worker)
curl -s 'https://api.axiom.co/v1/datasets/_apl' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "apl": "['\'dofek-logs\''] | where _time > ago(24h) and ['service.name'] == \"dofek-web\" | where severity_text == \"ERROR\" | sort by _time desc | limit 50"
  }'
```

**Note:** The OTEL ingest token (in `OTEL_EXPORTER_OTLP_HEADERS`) is write-only and cannot query. You need a separate read token (`AXIOM_READ_TOKEN`). If it doesn't exist yet, ask the user to create one in Axiom (Settings > API Tokens > New Token with "Query" permission on `dofek-logs`), then add it to the SOPS `.env`.

### 2. Docker container logs (SSH fallback)

If Axiom isn't available, SSH into the server and read Docker logs directly.

**Server:** `root@159.69.3.40`
**Compose project:** `/opt/dofek`

Container names and what they handle:
- `dofek-web-1` — Express API server (OAuth, file uploads, tRPC, sync triggers)
- `dofek-worker` — BullMQ worker (sync jobs, Apple Health import, CSV import)
- `dofek-sync-1` — Cron-triggered sync runner
- `dofek-client-1` — Nginx serving the SPA
- `dofek-caddy-1` — TLS termination / reverse proxy

```bash
# Recent logs from the web server (filter out noisy polling endpoints)
ssh root@159.69.3.40 'docker logs dofek-web-1 --since 24h 2>&1 | grep -iv "syncStatus\|providers" | tail -100'

# Worker logs (Apple Health import, sync jobs)
ssh root@159.69.3.40 'docker logs dofek-worker --since 24h 2>&1 | tail -100'

# Search for specific errors
ssh root@159.69.3.40 'docker logs dofek-web-1 --since 24h 2>&1 | grep -i "error\|fail\|<SEARCH_TERM>"'

# Follow logs in real-time
ssh root@159.69.3.40 'docker logs dofek-web-1 -f 2>&1'
```

### 3. In-app system logs

The Data Sources page has a "System Logs" panel showing the last 500 log entries from an in-memory ring buffer. This resets on container restart and is accessible in the web UI at the Data Sources page.

### 4. Analyze and report

- Summarize the errors found with timestamps and context
- Identify the root cause if possible
- Suggest a fix or next steps
- If the error is in provider sync logic, check the provider file under `src/providers/`
- If the error is in the API/upload path, check `packages/server/src/routers/`

## Environment details

- **SOPS decryption**: The container's `.env` is SOPS-encrypted and decrypted at runtime via `sops exec-env`. Variables injected by SOPS are NOT visible via `docker exec printenv` — they only exist in the Node process. To see decrypted values, use:
  ```bash
  ssh root@159.69.3.40 'docker exec dofek-web-1 sh -c "sops -d .env 2>/dev/null | grep <VAR_NAME>"'
  ```
- **OTel config**: Endpoint is `https://api.axiom.co`, headers contain the ingest token and dataset (`dofek-logs`). Service names: `dofek-web`, `dofek-worker`, `dofek-sync`.

## Important

- Never print full secret values (tokens, passwords) — only check presence or use them directly in API calls
- Docker logs are ephemeral — they reset when containers restart
- The `syncStatus` and `providers` tRPC endpoints are polled every few seconds and create noise — filter them out when reading web logs
