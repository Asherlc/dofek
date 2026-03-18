---
name: check-logs
description: Check production logs for errors — queries Axiom (structured logs) and falls back to Docker container logs via SSH.
---

# Check Production Logs

Query production logs to diagnose errors. Three sources are available (in priority order):

1. **Axiom MCP tools** — preferred, use `mcp__axiom__*` tools to query directly
2. **Docker container logs** (SSH) — fallback, ephemeral, reset on container restart
3. **In-app system logs** — last 500 entries in the web UI

## Arguments

`$ARGUMENTS` should describe what to search for (e.g., "apple health import errors", "OAuth failures", "sync errors for strava"). If not provided, ask the user.

## Steps

### 1. Query Axiom via MCP tools (preferred)

The Axiom MCP server is configured in `.mcp.json`. Use the `mcp__axiom__*` tools to query logs directly. The dataset is `dofek-logs`. Service names are `dofek-web`, `dofek-worker`, `dofek-sync`.

Use `ToolSearch` to load the Axiom MCP tools, then query with APL (Axiom Processing Language):

```apl
// Search for errors in the last 24 hours
['dofek-logs'] | where _time > ago(24h) | search "<SEARCH_TERM>" | sort by _time desc | limit 50

// Filter by service
['dofek-logs'] | where _time > ago(24h) and ['service.name'] == "dofek-web" | where severity_text == "ERROR" | sort by _time desc | limit 50

// Apple Health import errors
['dofek-logs'] | where _time > ago(7d) | search "apple" or search "health" or search "import" | sort by _time desc | limit 50
```

If the Axiom MCP server is not connected, fall back to step 2.

### 2. Docker container logs (SSH fallback)

If Axiom isn't available, SSH into the server and read Docker logs directly.

**Server:** SSH to your production server (e.g., `ssh root@<SERVER_IP>` or use alias `ssh dofek` if configured)
**Compose project:** `/opt/dofek`

Container names and what they handle:
- `dofek-web-1` — Express API server (OAuth, file uploads, tRPC, sync triggers)
- `dofek-worker` — BullMQ worker (sync jobs, Apple Health import, CSV import)
- `dofek-sync-1` — Cron-triggered sync runner
- `dofek-client-1` — Nginx serving the SPA
- `dofek-caddy-1` — TLS termination / reverse proxy

```bash
# Recent logs from the web server (filter out noisy polling endpoints)
ssh <SERVER> 'docker logs dofek-web-1 --since 24h 2>&1 | grep -iv "syncStatus\|providers" | tail -100'

# Worker logs (Apple Health import, sync jobs)
ssh <SERVER> 'docker logs dofek-worker --since 24h 2>&1 | tail -100'

# Search for specific errors
ssh <SERVER> 'docker logs dofek-web-1 --since 24h 2>&1 | grep -i "error\|fail\|<SEARCH_TERM>"'

# Follow logs in real-time
ssh <SERVER> 'docker logs dofek-web-1 -f 2>&1'
```

Replace `<SERVER>` with your production server address (e.g., `root@159.69.3.40` or the configured SSH alias).

### 3. In-app system logs

The Data Sources page has a "System Logs" panel showing the last 500 log entries from an in-memory ring buffer. This resets on container restart and is accessible in the web UI at the Data Sources page.

### 4. Analyze and report

- Summarize the errors found with timestamps and context
- Identify the root cause if possible
- Suggest a fix or next steps
- If the error is in provider sync logic, check the provider file under `src/providers/`
- If the error is in the API/upload path, check `packages/server/src/routers/`

## Environment details

- **SOPS decryption**: The container's `.env` is SOPS-encrypted and decrypted at runtime via `sops exec-env`. Variables injected by SOPS are NOT visible via `docker exec printenv` — they only exist in the Node process. To check if a variable is set (without displaying the value), use:
  ```bash
  ssh <SERVER> 'docker exec dofek-web-1 sh -c "sops -d .env 2>/dev/null | grep -q <VAR_NAME> && echo present || echo missing"'
  ```
  **Warning:** Do not use `| grep <VAR_NAME>` without `-q` or redirect, as it will print decrypted values to the terminal.
- **OTel config**: Endpoint is `https://api.axiom.co`, headers contain the ingest token and dataset (`dofek-logs`). Service names: `dofek-web`, `dofek-worker`, `dofek-sync`.

## Important

- Never print full secret values (tokens, passwords) — only check presence or use them directly in API calls
- Docker logs are ephemeral — they reset when containers restart
- The `syncStatus` and `providers` tRPC endpoints are polled every few seconds and create noise — filter them out when reading web logs
