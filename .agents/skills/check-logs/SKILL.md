---
name: check-logs
description: Check production logs for errors — queries Axiom (structured logs) and falls back to Docker Swarm service logs via SSH.
---

# Check Production Logs

Query production logs to diagnose errors. Three sources are available (in priority order):

1. **Axiom MCP tools** — preferred, use `mcp__axiom__*` tools to query directly
2. **Docker Swarm service logs** (SSH) — fallback, ephemeral, limited by Docker log rotation
3. **In-app system logs** — last 500 entries in the web UI

## Arguments

`$ARGUMENTS` should describe what to search for (e.g., "apple health import errors", "OAuth failures", "sync errors for strava"). If not provided, ask the user.

## Steps

### 1. Query Axiom via MCP tools (preferred)

Use the available Axiom MCP tools when connected. Application and infrastructure logs are in `dofek-logs`; HTTP spans are in `dofek-traces`. For most debugging, start with `dofek-logs`. Discover the live `service.name` values before applying a service filter instead of assuming an obsolete service list.

Use `ToolSearch` to load the Axiom MCP tools, then query with APL (Axiom Processing Language):

```apl
// Search for errors in the last 24 hours
['dofek-logs'] | where _time > ago(24h) | search "<SEARCH_TERM>" | sort by _time desc | limit 50

// Filter by service
['dofek-logs'] | where _time > ago(24h) and ['service.name'] == "dofek-web" | where severity_text == "ERROR" | sort by _time desc | limit 50

// Apple Health import errors
['dofek-logs'] | where _time > ago(7d) | search "apple" or "health" or "import" | sort by _time desc | limit 50
```

If the Axiom MCP server is not connected, fall back to step 2.

### 2. Docker Swarm service logs (SSH fallback)

If Axiom isn't available, SSH into the production Swarm manager and read service logs directly. Read `deploy/README.md` first. Prefer the configured `dofek-server` SSH alias. If it is unavailable, resolve the host from the repository's `ORACLE_SERVER_HOST` GitHub Actions variable without printing it and connect as `ubuntu`.

Current Swarm service names use the `<stack>_<service>` form. Production normally uses stack `dofek`, including:

- `dofek_web` — Express API server (OAuth, file uploads, tRPC, sync triggers)
- `dofek_worker` — BullMQ worker (sync jobs, Apple Health import, CSV import)
- `dofek_analytics-worker` — scheduled dbt analytics builds and cache refreshes
- `dofek_cdc-health` — continuous PeerDB/ClickHouse CDC checks
- `dofek_ota` — Expo OTA manifest/update server
- `dofek_traefik` — TLS termination and reverse proxy

```bash
# Recent logs from the web server (filter out noisy polling endpoints)
ssh dofek-server 'docker service logs --raw --timestamps --since 24h dofek_web 2>&1 | grep -iv "syncStatus\|providers" | tail -100'

# Worker logs (Apple Health import, sync jobs)
ssh dofek-server 'docker service logs --raw --timestamps --since 24h dofek_worker 2>&1 | tail -100'

# Search for specific errors. Fetch a fixed log window remotely, then apply the
# operator-provided term locally so it is never interpreted by the SSH shell.
search_term='<SEARCH_TERM>'
target_service='<SERVICE_NAME>'
case "$target_service" in
  dofek_web|dofek_worker|dofek_analytics-worker|dofek_cdc-health|dofek_ota|dofek_traefik) ;;
  *) echo "Unsupported service: $target_service" >&2; exit 1 ;;
esac
if ! log_output=$(ssh dofek-server "docker service logs --raw --timestamps --since 24h --tail 2000 $target_service 2>&1"); then
  echo "Unable to retrieve $target_service logs" >&2
  exit 1
fi
printf '%s\n' "$log_output" \
  | grep -i -e 'error' -e 'fail' -e "$search_term" \
  | tail -100

# Follow logs in real-time
ssh dofek-server 'docker service logs --raw --timestamps --since 10m --follow dofek_web 2>&1'
```

Before reading logs, use `docker service ls` and `docker service ps <service> --no-trunc` to confirm the live service name and task state. Never inspect or print a service's environment because it can contain secrets.

### 3. In-app system logs

The Data Sources page has a "System Logs" panel showing the last 500 log entries from an in-memory ring buffer. This resets on container restart and is accessible in the web UI at the Data Sources page.

### 4. Analyze and report

- Summarize the errors found with timestamps and context
- Identify the root cause if possible
- Suggest a fix or next steps
- If the error is in provider sync logic, check the provider file under `src/providers/`
- If the error is in the API/upload path, check `packages/server/src/routers/`

## Environment details

- **Secret injection**: Secrets are rendered by CI into a temporary deploy environment file and passed to `docker stack deploy`; the file is not stored on the server. Check secret presence through the authorized secret-management workflow, never through `docker service inspect` environment output.
- **OTel config**: The production OTel Collector exports traces to `dofek-traces` and logs to `dofek-logs`.

## Important

- Never print full secret values (tokens, passwords) — only check presence or use them directly in API calls
- Docker logs are rotated and task-local; use Axiom for durable history
- The `syncStatus` and `providers` tRPC endpoints are polled every few seconds and create noise — filter them out when reading web logs
